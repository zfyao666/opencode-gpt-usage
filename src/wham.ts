import type { WeeklyWindow } from "./types"

/**
 * ChatGPT (Codex) usage integration: the `wham` endpoint.
 * GET https://chatgpt.com/backend-api/wham/usage
 */

export const WHAM_URL = "https://chatgpt.com/backend-api/wham/usage"

/** 7 days in seconds — the real Codex weekly window duration. */
export const WEEK_SECONDS = 7 * 24 * 60 * 60
/** Accept a window as weekly when its duration is between 3 and 14 days. */
export const WEEK_MIN_SECONDS = 3 * 24 * 60 * 60
export const WEEK_MAX_SECONDS = 14 * 24 * 60 * 60

export const FETCH_TIMEOUT_MS = 10_000

export type WhamWindow = {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
  reset_after_seconds?: number
}

export type WhamRateLimit = {
  primary_window?: WhamWindow | null
  secondary_window?: WhamWindow | null
}

export type WhamResponse = {
  rate_limit?: WhamRateLimit | null
  /** e.g. "plus", "pro", "free" — subscription plan, when the API reports it. */
  plan_type?: string | null
}

export type WhamResult =
  | { ok: true; data: WhamResponse }
  | { ok: false; kind: "auth"; status: number }
  | { ok: false; kind: "http"; status: number }
  | { ok: false; kind: "network"; error: unknown }

/**
 * Fetch the usage windows. The access token is sent only to chatgpt.com and
 * is never logged. 401/403 map to an auth failure (the UI tells the user to
 * run `codex login`); other non-2xx map to a generic http failure; thrown
 * errors (DNS, timeout, …) map to a network failure.
 */
export async function fetchWhamUsage(opts: {
  accessToken: string
  accountId?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<WhamResult> {
  const { accessToken, accountId } = opts
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS

  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "user-agent": "codex-cli",
  }
  if (accountId) headers["chatgpt-account-id"] = accountId

  try {
    const res = await fetchImpl(WHAM_URL, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 401 || res.status === 403) return { ok: false, kind: "auth", status: res.status }
    if (!res.ok) return { ok: false, kind: "http", status: res.status }
    const data = (await res.json()) as WhamResponse
    return { ok: true, data }
  } catch (error) {
    return { ok: false, kind: "network", error }
  }
}

/** Parsed window candidate before weekly selection. */
export type ParsedWhamWindow = {
  usedPercent: number
  resetsAt: number
  limitWindowSeconds?: number
}

export function parseWhamWindow(
  w: WhamWindow | null | undefined,
  now: number,
): ParsedWhamWindow | null {
  if (!w) return null
  const usedPercent = w.used_percent
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null

  let resetsAt: number | undefined
  if (typeof w.reset_at === "number" && Number.isFinite(w.reset_at)) resetsAt = w.reset_at * 1000
  else if (typeof w.reset_after_seconds === "number" && Number.isFinite(w.reset_after_seconds)) {
    resetsAt = now + w.reset_after_seconds * 1000
  }
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return null

  const lws = w.limit_window_seconds
  const limitWindowSeconds =
    typeof lws === "number" && Number.isFinite(lws) && lws > 0 ? lws : undefined

  return { usedPercent, resetsAt, limitWindowSeconds }
}

/** 0–100 remaining percent, clamped and rounded. */
export function remainingPercent(usedPercent: number): number {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return 0
  return Math.min(100, Math.max(0, Math.round(100 - usedPercent)))
}

/**
 * Select the weekly window from a wham rate_limit payload.
 *
 * Selection is duration-first: the window whose `limit_window_seconds` is
 * closest to 7 days (accepting 3–14 days) wins, regardless of whether the
 * API reports it as primary or secondary. Windows that declare a duration
 * outside the weekly band are never presented as weekly. Only when a window
 * declares no duration at all do we fall back to position (secondary, then
 * primary). Returns null when no weekly window exists.
 */
export function selectWeeklyWindow(
  rateLimit: WhamRateLimit | null | undefined,
  now: number,
): WeeklyWindow | null {
  if (!rateLimit) return null
  const candidates: ParsedWhamWindow[] = []
  const primary = parseWhamWindow(rateLimit.primary_window, now)
  const secondary = parseWhamWindow(rateLimit.secondary_window, now)
  if (primary) candidates.push(primary)
  if (secondary) candidates.push(secondary)
  if (candidates.length === 0) return null

  const toWeekly = (w: ParsedWhamWindow): WeeklyWindow => ({
    usedPercent: w.usedPercent,
    remaining: remainingPercent(w.usedPercent),
    resetsAt: w.resetsAt,
    limitWindowSeconds: w.limitWindowSeconds,
  })

  // 1) Duration-based: a window in the 3–14 day band, closest to 7 days.
  const byDuration = candidates
    .filter(
      (w) =>
        w.limitWindowSeconds !== undefined &&
        w.limitWindowSeconds >= WEEK_MIN_SECONDS &&
        w.limitWindowSeconds <= WEEK_MAX_SECONDS,
    )
    .sort(
      (a, b) =>
        Math.abs((a.limitWindowSeconds ?? 0) - WEEK_SECONDS) -
        Math.abs((b.limitWindowSeconds ?? 0) - WEEK_SECONDS),
    )
  if (byDuration.length > 0) return toWeekly(byDuration[0])

  // 2) Every window declares a duration and none is weekly — no weekly window.
  const durationless = candidates.filter((w) => w.limitWindowSeconds === undefined)
  if (durationless.length === 0) return null

  // 3) Position fallback among duration-less windows: secondary, then primary.
  return toWeekly(durationless[durationless.length - 1])
}

/** Parse a full wham response into the weekly window, if any. */
export function parseWhamUsage(data: WhamResponse, now: number): WeeklyWindow | null {
  const weekly = selectWeeklyWindow(data.rate_limit, now)
  if (!weekly) return null
  const planType = typeof data.plan_type === "string" && data.plan_type.trim() ? data.plan_type : undefined
  return planType ? { ...weekly, planType } : weekly
}
