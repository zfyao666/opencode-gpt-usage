import { describe, expect, test } from "bun:test"
import {
  fetchWhamUsage,
  parseWhamUsage,
  remainingPercent,
  selectWeeklyWindow,
  WHAM_URL,
  type WhamRateLimit,
  type WhamResponse,
} from "../src/wham"
import { getAccessCredentials } from "../src/auth"

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0)

/** A weekly window (limit_window_seconds = 7 days). */
function weekly(
  over: Partial<Record<"used_percent" | "limit_window_seconds" | "reset_at" | "reset_after_seconds", number>> = {},
) {
  return {
    used_percent: 65,
    limit_window_seconds: 7 * 24 * 60 * 60,
    reset_at: NOW / 1000 + 86_400,
    ...over,
  }
}

/** The 5-hour session window. */
function session() {
  return {
    used_percent: 20,
    limit_window_seconds: 18_000,
    reset_at: NOW / 1000 + 3_600,
  }
}

function rateLimit(p: unknown, s: unknown): WhamRateLimit {
  return { primary_window: p as never, secondary_window: s as never }
}

describe("selectWeeklyWindow — duration-based weekly selection", () => {
  test("weekly window wins by duration even when it is primary", () => {
    const w = selectWeeklyWindow(rateLimit(weekly(), session()), NOW)
    expect(w).not.toBeNull()
    expect(w?.limitWindowSeconds).toBe(7 * 24 * 60 * 60)
    expect(w?.remaining).toBe(35)
  })

  test("weekly window wins by duration even when it is secondary (not position)", () => {
    const w = selectWeeklyWindow(rateLimit(session(), weekly()), NOW)
    expect(w).not.toBeNull()
    expect(w?.limitWindowSeconds).toBe(7 * 24 * 60 * 60)
    expect(w?.remaining).toBe(35)
  })

  test("session-only windows yield no weekly window", () => {
    expect(selectWeeklyWindow(rateLimit(session(), null), NOW)).toBeNull()
    expect(selectWeeklyWindow(rateLimit(session(), session()), NOW)).toBeNull()
  })

  test("closest-to-7d window wins when both are weekly-duration", () => {
    const w = selectWeeklyWindow(
      rateLimit(
        weekly({ limit_window_seconds: 3 * 24 * 60 * 60 }),
        weekly({ limit_window_seconds: 7 * 24 * 60 * 60 }),
      ),
      NOW,
    )
    expect(w?.limitWindowSeconds).toBe(7 * 24 * 60 * 60)
  })

  test("durations outside the weekly band yield no weekly window", () => {
    // 3h and 5h windows both declare durations; neither is ~7 days.
    expect(
      selectWeeklyWindow(rateLimit(weekly({ limit_window_seconds: 3 * 60 * 60 }), session()), NOW),
    ).toBeNull()
  })

  test("duration-less window falls back to position even beside a non-weekly duration", () => {
    const w = selectWeeklyWindow(
      rateLimit(session(), { used_percent: 40, reset_at: NOW / 1000 + 86_400 }),
      NOW,
    )
    expect(w?.usedPercent).toBe(40)
  })

  test("no durations at all: position fallback prefers secondary", () => {
    const w = selectWeeklyWindow(
      rateLimit(
        { used_percent: 10, reset_at: NOW / 1000 + 1000 },
        { used_percent: 80, reset_at: NOW / 1000 + 2000 },
      ),
      NOW,
    )
    expect(w?.usedPercent).toBe(80)
  })

  test("null/empty rate_limit yields null", () => {
    expect(selectWeeklyWindow(null, NOW)).toBeNull()
    expect(selectWeeklyWindow(undefined, NOW)).toBeNull()
    expect(selectWeeklyWindow({}, NOW)).toBeNull()
  })

  test("invalid windows are skipped", () => {
    expect(selectWeeklyWindow(rateLimit({ used_percent: NaN }, weekly()), NOW)?.remaining).toBe(35)
    expect(
      selectWeeklyWindow(rateLimit(weekly({ reset_at: undefined, reset_after_seconds: undefined }), weekly()), NOW),
    ).not.toBeNull()
    expect(
      selectWeeklyWindow(rateLimit(weekly({ reset_at: "2026-08-24" as never }), null), NOW),
    ).toBeNull()
  })

  test("reset_after_seconds derives a resetsAt", () => {
    const w = selectWeeklyWindow(
      rateLimit(weekly({ reset_at: undefined, reset_after_seconds: 7200 }), null),
      NOW,
    )
    expect(w?.resetsAt).toBe(NOW + 7200 * 1000)
  })
})

describe("remainingPercent", () => {
  test("derives remaining from used_percent", () => {
    expect(remainingPercent(65)).toBe(35)
    expect(remainingPercent(12.4)).toBe(88)
    expect(remainingPercent(0)).toBe(100)
    expect(remainingPercent(100)).toBe(0)
  })

  test("clamps out-of-range values", () => {
    expect(remainingPercent(150)).toBe(0)
    expect(remainingPercent(-50)).toBe(100)
    expect(remainingPercent(99.6)).toBe(0)
  })

  test("non-finite input → 0", () => {
    expect(remainingPercent(NaN)).toBe(0)
    expect(remainingPercent(Infinity)).toBe(0)
  })
})

describe("parseWhamUsage", () => {
  test("extracts the weekly window from a full response", () => {
    const data: WhamResponse = { rate_limit: rateLimit(session(), weekly()) }
    const w = parseWhamUsage(data, NOW)
    expect(w?.limitWindowSeconds).toBe(7 * 24 * 60 * 60)
    expect(w?.remaining).toBe(35)
  })

  test("returns null when the response has no rate_limit", () => {
    expect(parseWhamUsage({}, NOW)).toBeNull()
    expect(parseWhamUsage({ rate_limit: null }, NOW)).toBeNull()
  })
})

describe("fetchWhamUsage", () => {
  test("sends access token and account id to the wham endpoint only", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      seen = { url, headers: init?.headers ?? {} }
      return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 })
    }
    const res = await fetchWhamUsage({
      accessToken: "at-secret",
      accountId: "acc-7",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(res.ok).toBe(true)
    expect(seen?.url).toBe(WHAM_URL)
    expect(seen?.headers.authorization).toBe("Bearer at-secret")
    expect(seen?.headers["chatgpt-account-id"]).toBe("acc-7")
    expect(seen?.headers["user-agent"]).toBe("codex-cli")
  })

  test("expired id_token + valid access_token still sends the request (no client-side gating)", async () => {
    // Real flow: credentials are picked (id_token expiry ignored), then the
    // request goes out with the access token.
    const creds = getAccessCredentials({
      tokens: {
        access_token: "at-valid",
        id_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjE2NzI1MzQ0MDB9.", // expired
      },
    })
    expect(creds).not.toBeNull()

    let authorization: string | undefined
    const fetchImpl = async (_url: string, init?: { headers?: Record<string, string> }) => {
      authorization = init?.headers?.authorization
      return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 })
    }
    const res = await fetchWhamUsage({
      accessToken: creds!.accessToken,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(res.ok).toBe(true)
    expect(authorization).toBe("Bearer at-valid")
  })

  test("401 maps to an auth failure", async () => {
    const res = await fetchWhamUsage({
      accessToken: "bad",
      fetchImpl: (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
    })
    expect(res).toEqual({ ok: false, kind: "auth", status: 401 })
  })

  test("403 maps to an auth failure", async () => {
    const res = await fetchWhamUsage({
      accessToken: "bad",
      fetchImpl: (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch,
    })
    expect(res).toEqual({ ok: false, kind: "auth", status: 403 })
  })

  test("other non-2xx maps to an http failure with status", async () => {
    const res = await fetchWhamUsage({
      accessToken: "x",
      fetchImpl: (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch,
    })
    expect(res).toEqual({ ok: false, kind: "http", status: 429 })
  })

  test("thrown fetch errors map to a network failure", async () => {
    const res = await fetchWhamUsage({
      accessToken: "x",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed")
      }) as unknown as typeof fetch,
    })
    expect(res.ok).toBe(false)
    if (!res.ok && res.kind === "network") {
      expect(res.error).toBeInstanceOf(TypeError)
    } else {
      throw new Error(`expected network failure, got ${JSON.stringify(res)}`)
    }
  })

  test("non-JSON 200 bodies map to a network failure (parse error)", async () => {
    const res = await fetchWhamUsage({
      accessToken: "x",
      fetchImpl: (async () => new Response("html", { status: 200 })) as unknown as typeof fetch,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.kind).toBe("network")
  })
})
