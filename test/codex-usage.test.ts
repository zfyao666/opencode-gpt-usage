import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  collectUsageOutcome,
  FIVE_HOUR_BAND_MAX_SECONDS,
  FIVE_HOUR_BAND_MIN_SECONDS,
  FIVE_HOUR_LENGTH_SECONDS,
  reduceUsageWindows,
  reduceWeeklyWindow,
  shareRemaining,
  USAGE_ENDPOINT_URL,
  USAGE_TIMEOUT_MS,
  WEEK_BAND_MAX_SECONDS,
  WEEK_BAND_MIN_SECONDS,
  WEEK_LENGTH_SECONDS,
  type UsageOutcome,
} from "../src/codex-usage"

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0)
const SECRET = "at-super-secret-token"

/** A weekly window report (limit_window_seconds = 7 days). */
function weeklyReport(
  over: Partial<
    Record<"used_percent" | "limit_window_seconds" | "reset_at" | "reset_after_seconds", number>
  > = {},
) {
  return {
    used_percent: 65,
    limit_window_seconds: WEEK_LENGTH_SECONDS,
    reset_at: NOW / 1000 + 86_400,
    ...over,
  }
}

/** A five-hour window report (limit_window_seconds = 5 h). */
function fiveHourReport(
  over: Partial<
    Record<"used_percent" | "limit_window_seconds" | "reset_at" | "reset_after_seconds", number>
  > = {},
) {
  return {
    used_percent: 20,
    limit_window_seconds: FIVE_HOUR_LENGTH_SECONDS,
    reset_at: NOW / 1000 + 3_600,
    ...over,
  }
}

/** A window whose duration is outside both the five-hour and weekly bands. */
function outOfBandReport(durationSeconds: number) {
  return {
    used_percent: 30,
    limit_window_seconds: durationSeconds,
    reset_at: NOW / 1000 + 86_400,
  }
}

/** Minimal fake fetch that records the request it received. */
function captureFetch(
  reply: () => Promise<Response> | Response,
): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return reply()
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe("collectUsageOutcome — outcome union shape", () => {
  test("every outcome variant carries only its declared public fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gpt-usage-shape-"))
    try {
      const missing = join(dir, "missing.json")
      const have = join(dir, "auth.json")
      await writeFile(have, JSON.stringify({ tokens: { access_token: SECRET } }))

      const login = await collectUsageOutcome({ credentialsPath: missing })
      expect(login).toEqual({ state: "login-required" })

      const unauthorized = await collectUsageOutcome({
        credentialsPath: have,
        fetchImpl: captureFetch(() => new Response("denied", { status: 401 })).fetchImpl,
      })
      expect(unauthorized).toEqual({ state: "unauthorized" })

      const http = await collectUsageOutcome({
        credentialsPath: have,
        fetchImpl: captureFetch(() => new Response("busy", { status: 503 })).fetchImpl,
      })
      expect(http).toEqual({ state: "http", status: 503 })

      const thrower = (async () => {
        throw new Error("socket hang up")
      }) as unknown as typeof fetch
      const network = await collectUsageOutcome({ credentialsPath: have, fetchImpl: thrower })
      expect(network).toEqual({ state: "network" })

      const invalid = await collectUsageOutcome({
        credentialsPath: have,
        fetchImpl: captureFetch(() => okJson(null)).fetchImpl,
      })
      expect(invalid).toEqual({ state: "invalid-or-no-window" })

      const available = await collectUsageOutcome({
        credentialsPath: have,
        fetchImpl: captureFetch(() => okJson({ rate_limit: { primary_window: weeklyReport() } }))
          .fetchImpl,
      })
      expect(available.state).toBe("available")
      if (available.state === "available") {
        expect(available.windows).toHaveLength(1)
        expect(available.windows[0].kind).toBe("weekly")
        expect(available.windows[0].remaining).toBe(35)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("collectUsageOutcome — credentials", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gpt-usage-creds-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const credsPath = () => join(dir, "auth.json")

  test("missing or malformed credential file → login-required, no request issued", async () => {
    let called = 0
    const fetchImpl = (async () => {
      called += 1
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    expect(
      await collectUsageOutcome({ credentialsPath: join(dir, "missing.json"), fetchImpl }),
    ).toEqual({ state: "login-required" })

    await writeFile(credsPath(), "{ not json")
    expect(await collectUsageOutcome({ credentialsPath: credsPath(), fetchImpl })).toEqual({
      state: "login-required",
    })

    await writeFile(credsPath(), JSON.stringify([]))
    expect(await collectUsageOutcome({ credentialsPath: credsPath(), fetchImpl })).toEqual({
      state: "login-required",
    })
    expect(called).toBe(0)
  })

  test("expired id_token does not gate the request (nonempty access_token suffices)", async () => {
    // id_token exp = Jan 2023 (long expired); the usage endpoint does not
    // consume it, so it must not block the request.
    await writeFile(
      credsPath(),
      JSON.stringify({
        tokens: {
          access_token: SECRET,
          id_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjE2NzI1MzQ0MDB9.",
          account_id: "acc-42",
        },
      }),
    )
    const { fetchImpl, calls } = captureFetch(() => okJson({ rate_limit: { primary_window: weeklyReport() } }))
    const outcome = await collectUsageOutcome({ credentialsPath: credsPath(), fetchImpl })
    expect(outcome.state).toBe("available")
    expect(calls).toHaveLength(1)
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(headers["chatgpt-account-id"]).toBe("acc-42")
  })

  test("account id is optional and only forwarded when present and nonempty", async () => {
    await writeFile(credsPath(), JSON.stringify({ tokens: { access_token: SECRET } }))
    const { fetchImpl, calls } = captureFetch(() => okJson({ rate_limit: { primary_window: weeklyReport() } }))
    await collectUsageOutcome({ credentialsPath: credsPath(), fetchImpl })
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers["chatgpt-account-id"]).toBeUndefined()
  })
})

describe("collectUsageOutcome — OpenCode OAuth credentials", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gpt-usage-opencode-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const credsPath = () => join(dir, "auth.json")

  test("valid OpenCode OAuth maps access → Bearer token and accountId → account header", async () => {
    await writeFile(
      credsPath(),
      JSON.stringify({ openai: { type: "oauth", access: SECRET, accountId: "oc-7" } }),
    )
    const { fetchImpl, calls } = captureFetch(() =>
      okJson({ rate_limit: { primary_window: weeklyReport() } }),
    )
    const outcome = await collectUsageOutcome({ credentialsPath: credsPath(), fetchImpl })
    expect(outcome.state).toBe("available")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(USAGE_ENDPOINT_URL) // endpoint unchanged for OpenCode creds
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(headers["chatgpt-account-id"]).toBe("oc-7")
  })

  test("OpenCode OAuth without accountId (or with a non-string one) sends no account header", async () => {
    await writeFile(credsPath(), JSON.stringify({ openai: { type: "oauth", access: SECRET } }))
    const { fetchImpl: fetchNoAccount, calls: callsNoAccount } = captureFetch(() =>
      okJson({ rate_limit: { primary_window: weeklyReport() } }),
    )
    expect(
      (await collectUsageOutcome({ credentialsPath: credsPath(), fetchImpl: fetchNoAccount })).state,
    ).toBe("available")
    expect((callsNoAccount[0].init?.headers as Record<string, string>)["chatgpt-account-id"]).toBeUndefined()

    // A non-string accountId is treated as absent, not as a credential failure.
    await writeFile(
      credsPath(),
      JSON.stringify({ openai: { type: "oauth", access: SECRET, accountId: 7 } }),
    )
    const { fetchImpl: fetchBadAccount, calls: callsBadAccount } = captureFetch(() =>
      okJson({ rate_limit: { primary_window: weeklyReport() } }),
    )
    expect(
      (await collectUsageOutcome({ credentialsPath: credsPath(), fetchImpl: fetchBadAccount })).state,
    ).toBe("available")
    expect((callsBadAccount[0].init?.headers as Record<string, string>)["chatgpt-account-id"]).toBeUndefined()
  })

  test("API-key / non-OAuth / malformed OpenCode shapes → login-required, no request issued", async () => {
    let called = 0
    const fetchImpl = (async () => {
      called += 1
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    const rejected: unknown[] = [
      // API-key shape: openai present but type is "api" — never a credential.
      { openai: { type: "api", key: "sk-proj-123" } },
      // OAuth with missing or empty access.
      { openai: { type: "oauth" } },
      { openai: { type: "oauth", access: "" } },
      // openai absent, non-object, or not oauth-typed.
      {},
      { openai: "oauth" },
      { openai: 42 },
      { openai: { type: "custom", access: SECRET } },
    ]
    for (const doc of rejected) {
      await writeFile(credsPath(), JSON.stringify(doc))
      expect(await collectUsageOutcome({ credentialsPath: credsPath(), fetchImpl })).toEqual({
        state: "login-required",
      })
    }
    expect(called).toBe(0)
  })

  test("regression: the Codex credential shape resolves exactly as before", async () => {
    await writeFile(
      credsPath(),
      JSON.stringify({ tokens: { access_token: SECRET, account_id: "acc-42" } }),
    )
    const { fetchImpl, calls } = captureFetch(() =>
      okJson({ rate_limit: { primary_window: weeklyReport() } }),
    )
    const outcome = await collectUsageOutcome({ credentialsPath: credsPath(), fetchImpl })
    expect(outcome.state).toBe("available")
    if (outcome.state === "available") {
      expect(outcome.windows.map((w) => w.kind)).toEqual(["weekly"])
      expect(outcome.windows[0].remaining).toBe(35)
    }
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(headers["chatgpt-account-id"]).toBe("acc-42")
  })
})

describe("collectUsageOutcome — request shape", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gpt-usage-req-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("GETs the usage endpoint with the expected headers and an abort signal", async () => {
    const credsPath = join(dir, "auth.json")
    await writeFile(credsPath, JSON.stringify({ tokens: { access_token: SECRET, account_id: "a7" } }))
    const { fetchImpl, calls } = captureFetch(() => okJson({ rate_limit: { primary_window: weeklyReport() } }))
    await collectUsageOutcome({ credentialsPath: credsPath, fetchImpl })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(USAGE_ENDPOINT_URL)
    expect(calls[0].init?.method).toBeUndefined() // fetch default = GET
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(headers["user-agent"]).toBe("codex-cli")
    expect(headers["chatgpt-account-id"]).toBe("a7")
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
    expect(calls[0].init?.signal?.aborted).toBe(false)
  })

  test("default timeout constant is 10 s", () => {
    expect(USAGE_TIMEOUT_MS).toBe(10_000)
  })
})

describe("collectUsageOutcome — status mapping", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gpt-usage-status-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("401/403 → unauthorized; other non-2xx → http with the status", async () => {
    const credsPath = join(dir, "auth.json")
    await writeFile(credsPath, JSON.stringify({ tokens: { access_token: SECRET } }))
    for (const status of [401, 403]) {
      const { fetchImpl } = captureFetch(() => new Response("denied", { status }))
      expect(await collectUsageOutcome({ credentialsPath: credsPath, fetchImpl })).toEqual({
        state: "unauthorized",
      })
    }
    for (const status of [429, 500, 302]) {
      const { fetchImpl } = captureFetch(() => new Response("x", { status }))
      expect(await collectUsageOutcome({ credentialsPath: credsPath, fetchImpl })).toEqual({
        state: "http",
        status,
      })
    }
  })

  test("thrown transport errors → network without the raw error crossing", async () => {
    const credsPath = join(dir, "auth.json")
    await writeFile(credsPath, JSON.stringify({ tokens: { access_token: SECRET } }))
    const boom = new TypeError("fetch failed")
    const thrower = (async () => {
      throw boom
    }) as unknown as typeof fetch
    const outcome = await collectUsageOutcome({ credentialsPath: credsPath, fetchImpl: thrower })
    expect(outcome).toEqual({ state: "network" })
  })

  test("non-JSON / malformed bodies → network (safe failure)", async () => {
    const credsPath = join(dir, "auth.json")
    await writeFile(credsPath, JSON.stringify({ tokens: { access_token: SECRET } }))
    for (const body of ["html", "{ oops", ""]) {
      const { fetchImpl } = captureFetch(() => new Response(body, { status: 200 }))
      expect(await collectUsageOutcome({ credentialsPath: credsPath, fetchImpl })).toEqual({
        state: "network",
      })
    }
  })
})

describe("collectUsageOutcome — payload shapes are ordinary safe failures", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gpt-usage-payload-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("valid-JSON null / primitives / arrays / empty object → invalid-or-no-window", async () => {
    const credsPath = join(dir, "auth.json")
    await writeFile(credsPath, JSON.stringify({ tokens: { access_token: SECRET } }))
    for (const body of ["null", "42", '"text"', "true", "[1,2,3]", "{}", '{"rate_limit": null}']) {
      const { fetchImpl } = captureFetch(() => new Response(body, { status: 200 }))
      expect(await collectUsageOutcome({ credentialsPath: credsPath, fetchImpl })).toEqual({
        state: "invalid-or-no-window",
      })
    }
  })

  test("windows declaring durations outside both bands → invalid-or-no-window", async () => {
    const credsPath = join(dir, "auth.json")
    await writeFile(credsPath, JSON.stringify({ tokens: { access_token: SECRET } }))
    for (const duration of [2 * 60 * 60, 20 * 24 * 60 * 60]) {
      const { fetchImpl } = captureFetch(() =>
        okJson({ rate_limit: { primary_window: outOfBandReport(duration) } }),
      )
      expect(await collectUsageOutcome({ credentialsPath: credsPath, fetchImpl })).toEqual({
        state: "invalid-or-no-window",
      })
    }
  })
})

describe("collectUsageOutcome — window kinds", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gpt-usage-kinds-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const credsPath = () => join(dir, "auth.json")

  test("five-hour only → available with just the five-hour window", async () => {
    await writeFile(credsPath(), JSON.stringify({ tokens: { access_token: SECRET } }))
    const outcome = await collectUsageOutcome({
      credentialsPath: credsPath(),
      fetchImpl: captureFetch(() => okJson({ rate_limit: { primary_window: fiveHourReport() } }))
        .fetchImpl,
    })
    expect(outcome.state).toBe("available")
    if (outcome.state === "available") {
      expect(outcome.windows.map((w) => w.kind)).toEqual(["five-hour"])
      expect(outcome.windows[0].remaining).toBe(80)
    }
  })

  test("both windows → available, five-hour first then weekly", async () => {
    await writeFile(credsPath(), JSON.stringify({ tokens: { access_token: SECRET } }))
    const outcome = await collectUsageOutcome({
      credentialsPath: credsPath(),
      fetchImpl: captureFetch(() =>
        okJson({ rate_limit: { primary_window: fiveHourReport(), secondary_window: weeklyReport() } }),
      ).fetchImpl,
    })
    expect(outcome.state).toBe("available")
    if (outcome.state === "available") {
      expect(outcome.windows.map((w) => w.kind)).toEqual(["five-hour", "weekly"])
      expect(outcome.windows[0].remaining).toBe(80)
      expect(outcome.windows[1].remaining).toBe(35)
    }
  })

  test("plan_type rides at the outcome level, not on the windows", async () => {
    await writeFile(credsPath(), JSON.stringify({ tokens: { access_token: SECRET } }))
    const outcome = await collectUsageOutcome({
      credentialsPath: credsPath(),
      fetchImpl: captureFetch(() =>
        okJson({ plan_type: "plus", rate_limit: { primary_window: weeklyReport() } }),
      ).fetchImpl,
    })
    expect(outcome.state).toBe("available")
    if (outcome.state === "available") {
      expect(outcome.planType).toBe("plus")
      expect("planType" in outcome.windows[0]).toBe(false)
    }
  })
})

describe("collectUsageOutcome — token confinement", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gpt-usage-leak-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const expectTokenConfined = (outcome: UsageOutcome) => {
    expect(JSON.stringify(outcome)).not.toContain(SECRET)
  }

  test("no public outcome field ever contains the token", async () => {
    const credsPath = join(dir, "auth.json")
    await writeFile(credsPath, JSON.stringify({ tokens: { access_token: SECRET } }))

    const scenarios: (() => Promise<UsageOutcome>)[] = [
      () => collectUsageOutcome({ credentialsPath: join(dir, "nope.json") }),
      () =>
        collectUsageOutcome({
          credentialsPath: credsPath,
          fetchImpl: captureFetch(() => new Response("denied", { status: 401 })).fetchImpl,
        }),
      () =>
        collectUsageOutcome({
          credentialsPath: credsPath,
          fetchImpl: captureFetch(() => new Response("busy", { status: 500 })).fetchImpl,
        }),
      () =>
        collectUsageOutcome({
          credentialsPath: credsPath,
          fetchImpl: (async () => {
            throw new Error(`boom ${SECRET}`)
          }) as unknown as typeof fetch,
        }),
      () =>
        collectUsageOutcome({
          credentialsPath: credsPath,
          fetchImpl: captureFetch(() => new Response(`echo ${SECRET}`, { status: 200 })).fetchImpl,
        }),
      () =>
        collectUsageOutcome({
          credentialsPath: credsPath,
          fetchImpl: captureFetch(() =>
            okJson({ leak: SECRET, rate_limit: { primary_window: null } }),
          ).fetchImpl,
        }),
      () =>
        collectUsageOutcome({
          credentialsPath: credsPath,
          fetchImpl: captureFetch(() => okJson({ rate_limit: { primary_window: weeklyReport() } }))
            .fetchImpl,
        }),
    ]

    for (const run of scenarios) {
      expectTokenConfined(await run())
    }
  })

  test("the token appears only in the outgoing authorization header", async () => {
    const credsPath = join(dir, "auth.json")
    await writeFile(credsPath, JSON.stringify({ tokens: { access_token: SECRET, account_id: "a1" } }))
    const { fetchImpl, calls } = captureFetch(() => okJson({ rate_limit: { primary_window: weeklyReport() } }))
    await collectUsageOutcome({ credentialsPath: credsPath, fetchImpl })
    const headers = JSON.stringify(calls[0].init?.headers)
    expect(headers).toContain(SECRET)
    expect(headers).toBe(JSON.stringify({ authorization: `Bearer ${SECRET}`, "user-agent": "codex-cli", "chatgpt-account-id": "a1" }))
  })
})

describe("reduceWeeklyWindow — window validation", () => {
  test("reset_at (epoch seconds) takes priority over reset_after_seconds", () => {
    const weekly = reduceWeeklyWindow(
      { rate_limit: { primary_window: weeklyReport({ reset_at: 5_000, reset_after_seconds: 99_999 }) } },
      NOW,
    )
    expect(weekly?.resetsAt).toBe(5_000 * 1000)
  })

  test("reset_after_seconds is applied relative to now when reset_at is absent", () => {
    const weekly = reduceWeeklyWindow(
      { rate_limit: { primary_window: weeklyReport({ reset_at: undefined, reset_after_seconds: 3_600 }) } },
      NOW,
    )
    expect(weekly?.resetsAt).toBe(NOW + 3_600 * 1000)
  })

  test("non-finite or non-positive reset times reject the window", () => {
    const bad: unknown[] = [0, -5, NaN, Infinity, "soon", null]
    for (const reset_at of bad) {
      const weekly = reduceWeeklyWindow(
        { rate_limit: { primary_window: weeklyReport({ reset_at: reset_at as number }) } },
        NOW,
      )
      expect(weekly).toBeNull()
    }
  })

  test("missing or non-finite used_percent rejects the window", () => {
    for (const used_percent of [undefined, NaN, Infinity, "65", null]) {
      const weekly = reduceWeeklyWindow(
        { rate_limit: { primary_window: weeklyReport({ used_percent: used_percent as number }) } },
        NOW,
      )
      expect(weekly).toBeNull()
    }
  })

  test("limit_window_seconds kept only when finite and positive; 0 makes it duration-less", () => {
    const withDuration = reduceWeeklyWindow({ rate_limit: { primary_window: weeklyReport() } }, NOW)
    expect(withDuration?.limitWindowSeconds).toBe(WEEK_LENGTH_SECONDS)

    // 0 → no duration → duration-less fallback path still yields a window.
    const zeroDuration = reduceWeeklyWindow(
      { rate_limit: { primary_window: weeklyReport({ limit_window_seconds: 0 }) } },
      NOW,
    )
    expect(zeroDuration?.limitWindowSeconds).toBeUndefined()
    expect(zeroDuration?.remaining).toBe(35)
  })
})

describe("reduceWeeklyWindow — weekly selection", () => {
  test("weekly window wins by duration whether primary or secondary (not position)", () => {
    const asPrimary = reduceWeeklyWindow(
      { rate_limit: { primary_window: weeklyReport(), secondary_window: fiveHourReport() } },
      NOW,
    )
    const asSecondary = reduceWeeklyWindow(
      { rate_limit: { primary_window: fiveHourReport(), secondary_window: weeklyReport() } },
      NOW,
    )
    expect(asPrimary?.limitWindowSeconds).toBe(WEEK_LENGTH_SECONDS)
    expect(asSecondary?.limitWindowSeconds).toBe(WEEK_LENGTH_SECONDS)
    expect(asPrimary?.remaining).toBe(35)
    expect(asSecondary?.remaining).toBe(35)
  })

  test("closest to 7 days wins inside the 3–14 day band", () => {
    const sixDays = weeklyReport({ limit_window_seconds: 6 * 24 * 60 * 60 })
    const fiveDays = weeklyReport({ limit_window_seconds: 5 * 24 * 60 * 60 })
    const weekly = reduceWeeklyWindow(
      { rate_limit: { primary_window: fiveDays, secondary_window: sixDays } },
      NOW,
    )
    expect(weekly?.limitWindowSeconds).toBe(6 * 24 * 60 * 60)
  })

  test("ties keep the primary slot", () => {
    const sixDays = weeklyReport({ limit_window_seconds: 6 * 24 * 60 * 60 })
    const eightDays = weeklyReport({ limit_window_seconds: 8 * 24 * 60 * 60 })
    const weekly = reduceWeeklyWindow(
      { rate_limit: { primary_window: sixDays, secondary_window: eightDays } },
      NOW,
    )
    expect(weekly?.limitWindowSeconds).toBe(6 * 24 * 60 * 60)
  })

  test("band edges are accepted; just-outside durations are never weekly", () => {
    const atMin = reduceWeeklyWindow(
      { rate_limit: { primary_window: weeklyReport({ limit_window_seconds: WEEK_BAND_MIN_SECONDS }) } },
      NOW,
    )
    expect(atMin?.limitWindowSeconds).toBe(WEEK_BAND_MIN_SECONDS)

    const atMax = reduceWeeklyWindow(
      { rate_limit: { primary_window: weeklyReport({ limit_window_seconds: WEEK_BAND_MAX_SECONDS }) } },
      NOW,
    )
    expect(atMax?.limitWindowSeconds).toBe(WEEK_BAND_MAX_SECONDS)

    for (const duration of [WEEK_BAND_MIN_SECONDS - 1, WEEK_BAND_MAX_SECONDS + 1]) {
      const weekly = reduceWeeklyWindow(
        { rate_limit: { primary_window: weeklyReport({ limit_window_seconds: duration }) } },
        NOW,
      )
      expect(weekly).toBeNull()
    }
  })

  test("no weekly window when nothing matches the weekly band or the fallback", () => {
    // Out of both bands → nothing recognizable at all.
    expect(
      reduceWeeklyWindow(
        { rate_limit: { primary_window: outOfBandReport(2 * 60 * 60), secondary_window: outOfBandReport(2 * 60 * 60) } },
        NOW,
      ),
    ).toBeNull()
    // Five-hour windows are real windows — but they are not weekly.
    expect(reduceWeeklyWindow({ rate_limit: { primary_window: fiveHourReport() } }, NOW)).toBeNull()
    expect(reduceWeeklyWindow({ rate_limit: {} }, NOW)).toBeNull()
    expect(reduceWeeklyWindow({}, NOW)).toBeNull()
    expect(reduceWeeklyWindow({ rate_limit: null }, NOW)).toBeNull()
    expect(reduceWeeklyWindow(null, NOW)).toBeNull()
  })

  test("duration-less windows fall back by position, preferring secondary", () => {
    const primary = weeklyReport({ limit_window_seconds: undefined, reset_at: 5_000 })
    const secondary = weeklyReport({ limit_window_seconds: undefined, reset_at: 9_000 })
    const both = reduceWeeklyWindow({ rate_limit: { primary_window: primary, secondary_window: secondary } }, NOW)
    expect(both?.resetsAt).toBe(9_000 * 1000) // secondary wins when both lack duration

    const primaryOnly = reduceWeeklyWindow({ rate_limit: { primary_window: primary } }, NOW)
    expect(primaryOnly?.resetsAt).toBe(5_000 * 1000)
  })

  test("a duration-less window wins over an out-of-band duration", () => {
    const mixed = reduceWeeklyWindow(
      { rate_limit: { primary_window: outOfBandReport(2 * 60 * 60), secondary_window: weeklyReport({ limit_window_seconds: undefined }) } },
      NOW,
    )
    expect(mixed?.limitWindowSeconds).toBeUndefined()
  })
})

describe("reduceUsageWindows — window kinds and order", () => {
  test("weekly only → a single weekly window", () => {
    const reduction = reduceUsageWindows({ rate_limit: { primary_window: weeklyReport() } }, NOW)
    expect(reduction?.windows.map((w) => w.kind)).toEqual(["weekly"])
    expect(reduction?.windows[0].remaining).toBe(35)
    expect(reduction?.windows[0].limitWindowSeconds).toBe(WEEK_LENGTH_SECONDS)
  })

  test("five-hour only → a single five-hour window", () => {
    const reduction = reduceUsageWindows({ rate_limit: { primary_window: fiveHourReport() } }, NOW)
    expect(reduction?.windows.map((w) => w.kind)).toEqual(["five-hour"])
    expect(reduction?.windows[0].remaining).toBe(80)
    expect(reduction?.windows[0].limitWindowSeconds).toBe(FIVE_HOUR_LENGTH_SECONDS)
  })

  test("both kinds → five-hour first, weekly second, regardless of slot position", () => {
    const weekly = weeklyReport()
    const fiveHour = fiveHourReport()
    const asPrimary = reduceUsageWindows(
      { rate_limit: { primary_window: weekly, secondary_window: fiveHour } },
      NOW,
    )
    const asSecondary = reduceUsageWindows(
      { rate_limit: { primary_window: fiveHour, secondary_window: weekly } },
      NOW,
    )
    expect(asPrimary?.windows.map((w) => w.kind)).toEqual(["five-hour", "weekly"])
    expect(asSecondary?.windows.map((w) => w.kind)).toEqual(["five-hour", "weekly"])
    expect(asPrimary?.windows[0].usedPercent).toBe(20) // five-hour slot values
    expect(asPrimary?.windows[1].usedPercent).toBe(65) // weekly slot values
  })

  test("only the best window of each kind is kept", () => {
    // Two in-band five-hour candidates → the closer-to-5 h one survives.
    const fourHours = fiveHourReport({ limit_window_seconds: 4 * 60 * 60 })
    const sixHours = fiveHourReport({ limit_window_seconds: 6 * 60 * 60 })
    const fiveHourOnly = reduceUsageWindows(
      { rate_limit: { primary_window: fourHours, secondary_window: sixHours } },
      NOW,
    )
    expect(fiveHourOnly?.windows.map((w) => w.kind)).toEqual(["five-hour"])
    // Two in-band weekly candidates → the closer-to-7 d one survives.
    const sixDays = weeklyReport({ limit_window_seconds: 6 * 24 * 60 * 60 })
    const eightDays = weeklyReport({ limit_window_seconds: 8 * 24 * 60 * 60 })
    const weeklyOnly = reduceUsageWindows(
      { rate_limit: { primary_window: sixDays, secondary_window: eightDays } },
      NOW,
    )
    expect(weeklyOnly?.windows.map((w) => w.kind)).toEqual(["weekly"])
  })

  test("five-hour selection: closest to 5 h wins inside the 3–7 h band", () => {
    const threeHours = fiveHourReport({ limit_window_seconds: 3 * 60 * 60 })
    const sixHours = fiveHourReport({ limit_window_seconds: 6 * 60 * 60 })
    const reduction = reduceUsageWindows(
      { rate_limit: { primary_window: threeHours, secondary_window: sixHours } },
      NOW,
    )
    expect(reduction?.windows[0].limitWindowSeconds).toBe(6 * 60 * 60)
  })

  test("five-hour ties keep the primary slot", () => {
    const fourHours = fiveHourReport({ limit_window_seconds: 4 * 60 * 60 })
    const sixHours = fiveHourReport({ limit_window_seconds: 6 * 60 * 60 })
    const reduction = reduceUsageWindows(
      { rate_limit: { primary_window: fourHours, secondary_window: sixHours } },
      NOW,
    )
    expect(reduction?.windows[0].limitWindowSeconds).toBe(4 * 60 * 60)
  })

  test("five-hour band edges are accepted; just-outside durations are not", () => {
    const atMin = reduceUsageWindows(
      { rate_limit: { primary_window: fiveHourReport({ limit_window_seconds: FIVE_HOUR_BAND_MIN_SECONDS }) } },
      NOW,
    )
    expect(atMin?.windows[0].limitWindowSeconds).toBe(FIVE_HOUR_BAND_MIN_SECONDS)

    const atMax = reduceUsageWindows(
      { rate_limit: { primary_window: fiveHourReport({ limit_window_seconds: FIVE_HOUR_BAND_MAX_SECONDS }) } },
      NOW,
    )
    expect(atMax?.windows[0].limitWindowSeconds).toBe(FIVE_HOUR_BAND_MAX_SECONDS)

    for (const duration of [FIVE_HOUR_BAND_MIN_SECONDS - 1, FIVE_HOUR_BAND_MAX_SECONDS + 1]) {
      const reduction = reduceUsageWindows(
        { rate_limit: { primary_window: fiveHourReport({ limit_window_seconds: duration }) } },
        NOW,
      )
      // Single out-of-band slot → nothing recognizable at all (no fallback:
      // the window declared a duration), so the reduction is null.
      expect(reduction).toBeNull()
    }
  })

  test("no recognizable window → null", () => {
    expect(
      reduceUsageWindows(
        { rate_limit: { primary_window: outOfBandReport(2 * 60 * 60) } },
        NOW,
      ),
    ).toBeNull()
    expect(
      reduceUsageWindows(
        { rate_limit: { primary_window: outOfBandReport(20 * 24 * 60 * 60), secondary_window: outOfBandReport(2 * 60 * 60) } },
        NOW,
      ),
    ).toBeNull()
    expect(reduceUsageWindows({ rate_limit: {} }, NOW)).toBeNull()
    expect(reduceUsageWindows({}, NOW)).toBeNull()
    expect(reduceUsageWindows({ rate_limit: null }, NOW)).toBeNull()
    expect(reduceUsageWindows(null, NOW)).toBeNull()
  })
})

describe("reduceUsageWindows — duration-less fallback", () => {
  test("duration-less slots fall back by position, preferring secondary, as one weekly window", () => {
    const primary = weeklyReport({ limit_window_seconds: undefined, reset_at: 5_000 })
    const secondary = weeklyReport({ limit_window_seconds: undefined, reset_at: 9_000 })
    const both = reduceUsageWindows({ rate_limit: { primary_window: primary, secondary_window: secondary } }, NOW)
    expect(both?.windows.map((w) => w.kind)).toEqual(["weekly"])
    expect(both?.windows[0].resetsAt).toBe(9_000 * 1000)

    const primaryOnly = reduceUsageWindows({ rate_limit: { primary_window: primary } }, NOW)
    expect(primaryOnly?.windows[0].resetsAt).toBe(5_000 * 1000)
  })

  test("the fallback is never duplicated into a five-hour window", () => {
    const reduction = reduceUsageWindows(
      { rate_limit: { primary_window: weeklyReport({ limit_window_seconds: undefined }) } },
      NOW,
    )
    expect(reduction?.windows.map((w) => w.kind)).toEqual(["weekly"])
  })

  test("a duration-less window wins over an out-of-both-bands duration", () => {
    const mixed = reduceUsageWindows(
      { rate_limit: { primary_window: outOfBandReport(2 * 60 * 60), secondary_window: weeklyReport({ limit_window_seconds: undefined }) } },
      NOW,
    )
    expect(mixed?.windows.map((w) => w.kind)).toEqual(["weekly"])
    expect(mixed?.windows[0].limitWindowSeconds).toBeUndefined()
  })

  test("a recognized five-hour window wins over a duration-less secondary", () => {
    const mixed = reduceUsageWindows(
      { rate_limit: { primary_window: fiveHourReport(), secondary_window: weeklyReport({ limit_window_seconds: undefined }) } },
      NOW,
    )
    expect(mixed?.windows.map((w) => w.kind)).toEqual(["five-hour"])
  })
})

describe("reduceUsageWindows — plan type at the reduction level", () => {
  test("plan_type is attached raw when non-blank, omitted otherwise", () => {
    const base = { rate_limit: { primary_window: weeklyReport() } }
    expect(reduceUsageWindows({ ...base, plan_type: "plus" }, NOW)?.planType).toBe("plus")
    expect(reduceUsageWindows({ ...base, plan_type: "  plus  " }, NOW)?.planType).toBe("  plus  ")
    for (const plan_type of ["", "   ", null, 42]) {
      expect(reduceUsageWindows({ ...base, plan_type: plan_type as never }, NOW)?.planType).toBeUndefined()
    }
  })

  test("the plan label never lands on individual windows", () => {
    const reduction = reduceUsageWindows(
      { plan_type: "plus", rate_limit: { primary_window: weeklyReport() } },
      NOW,
    )
    expect(reduction?.planType).toBe("plus")
    expect("planType" in reduction!.windows[0]).toBe(false)
  })
})

describe("shareRemaining — clamp and round", () => {
  test("derives remaining from used, clamped 0–100; non-finite or non-number → 0", () => {
    expect(shareRemaining(65)).toBe(35)
    expect(shareRemaining(12.4)).toBe(88)
    expect(shareRemaining(150)).toBe(0)
    expect(shareRemaining(-50)).toBe(100)
    expect(shareRemaining(99.6)).toBe(0)
    expect(shareRemaining(NaN)).toBe(0)
    expect(shareRemaining(Infinity)).toBe(0)
    expect(shareRemaining("65")).toBe(0)
    expect(shareRemaining(undefined)).toBe(0)
  })
})
