import { describe, expect, test } from "bun:test"
import {
  fetchWhamUsage,
  parseWhamUsage,
  remainingPercent,
  selectWeeklyWindow,
  type WhamResponse,
} from "../src/wham"
import { getAccessCredentials } from "../src/auth"

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0)

/** A weekly window (limit_window_seconds = 7 days). */
function weekly(
  over: Partial<Record<"used_percent" | "limit_window_seconds" | "reset_at", number>> = {},
) {
  return {
    used_percent: 65,
    limit_window_seconds: 7 * 24 * 60 * 60,
    reset_at: NOW / 1000 + 86_400,
    ...over,
  }
}

/** The 5-hour session window (non-weekly duration). */
function session() {
  return {
    used_percent: 20,
    limit_window_seconds: 18_000,
    reset_at: NOW / 1000 + 3_600,
  }
}

describe("selectWeeklyWindow", () => {
  test("weekly window wins by duration whether primary or secondary (not position)", () => {
    const asPrimary = selectWeeklyWindow(
      { primary_window: weekly(), secondary_window: session() },
      NOW,
    )
    const asSecondary = selectWeeklyWindow(
      { primary_window: session(), secondary_window: weekly() },
      NOW,
    )
    expect(asPrimary?.limitWindowSeconds).toBe(7 * 24 * 60 * 60)
    expect(asSecondary?.limitWindowSeconds).toBe(7 * 24 * 60 * 60)
    expect(asPrimary?.remaining).toBe(35)
    expect(asSecondary?.remaining).toBe(35)
  })

  test("no weekly window when every window declares a non-weekly duration", () => {
    expect(selectWeeklyWindow({ primary_window: session(), secondary_window: session() }, NOW)).toBeNull()
    expect(selectWeeklyWindow({ primary_window: session(), secondary_window: null }, NOW)).toBeNull()
    expect(selectWeeklyWindow(null, NOW)).toBeNull()
    expect(selectWeeklyWindow({}, NOW)).toBeNull()
  })
})

describe("remainingPercent", () => {
  test("derives remaining from used_percent, clamped 0–100; non-finite → 0", () => {
    expect(remainingPercent(65)).toBe(35)
    expect(remainingPercent(12.4)).toBe(88)
    expect(remainingPercent(150)).toBe(0)
    expect(remainingPercent(-50)).toBe(100)
    expect(remainingPercent(99.6)).toBe(0)
    expect(remainingPercent(NaN)).toBe(0)
  })
})

describe("parseWhamUsage", () => {
  test("extracts the weekly window and plan_type from a full response", () => {
    const data: WhamResponse = {
      rate_limit: { primary_window: session(), secondary_window: weekly() },
      plan_type: "plus",
    }
    const w = parseWhamUsage(data, NOW)
    expect(w?.remaining).toBe(35)
    expect(w?.planType).toBe("plus")
    expect(parseWhamUsage({}, NOW)).toBeNull()
  })
})

describe("fetchWhamUsage — error mapping", () => {
  test("401/403 map to auth, other non-2xx to http", async () => {
    const respond = (status: number) =>
      (async () => new Response("x", { status })) as unknown as typeof fetch
    expect(await fetchWhamUsage({ accessToken: "t", fetchImpl: respond(401) })).toEqual({
      ok: false,
      kind: "auth",
      status: 401,
    })
    expect(await fetchWhamUsage({ accessToken: "t", fetchImpl: respond(403) })).toEqual({
      ok: false,
      kind: "auth",
      status: 403,
    })
    expect(await fetchWhamUsage({ accessToken: "t", fetchImpl: respond(429) })).toEqual({
      ok: false,
      kind: "http",
      status: 429,
    })
  })

  test("thrown errors and non-JSON bodies map to network failure", async () => {
    const thrower = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    expect(await fetchWhamUsage({ accessToken: "t", fetchImpl: thrower })).toEqual({
      ok: false,
      kind: "network",
      error: expect.any(TypeError),
    })

    const badJson = (async () => new Response("html", { status: 200 })) as unknown as typeof fetch
    expect(await fetchWhamUsage({ accessToken: "t", fetchImpl: badJson })).toEqual({
      ok: false,
      kind: "network",
      error: expect.any(SyntaxError),
    })
  })

  test("expired id_token + valid access_token still sends the request (no client-side gating)", async () => {
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
})
