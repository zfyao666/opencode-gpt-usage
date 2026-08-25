/**
 * Codex/usage integration boundary.
 *
 * Design: everything the card needs from the outside world funnels through
 * one entry point, `collectUsageOutcome`, which returns a small UI-oriented
 * outcome union. The boundary treats every external input — the credential
 * file, the response body — as untrusted data and reads it only through
 * generic record/finite-number access helpers, so malformed input can
 * never escape as a thrown error or an exotic value.
 *
 * The credential representation is private to this module; callers only
 * ever see outcome states. Raw `Error` objects and raw error text never
 * cross the boundary (a transport failure collapses to the "network"
 * state). The bearer token appears only in the outgoing Authorization
 * header and in no returned value.
 *
 * Weekly-window reduction (`reduceWeeklyWindow`) selects the best window in
 * a single pass over the two rate-limit slots: the in-band window closest
 * to seven days wins (ties keep the primary slot); failing that, the last
 * duration-less slot (the secondary, when both are duration-less) is the
 * fallback; out-of-band durations are never selectable. A successful but
 * unusable payload — null, primitive, array, `{}`, no weekly window — is an
 * ordinary "invalid-or-no-weekly" outcome, never a rejected refresh.
 *
 * Protocol facts (endpoint URL, header names, GET, timeout, status
 * handling) are literal.
 */
import type { WeeklyWindow } from "./types"
import { readFile } from "node:fs/promises"

/** ChatGPT/Codex usage status endpoint. */
export const USAGE_ENDPOINT_URL = "https://chatgpt.com/backend-api/wham/usage"

/** How long a status request may take before it is aborted. */
export const USAGE_TIMEOUT_MS = 10_000

/** The real Codex weekly window length (7 days, in seconds). */
export const WEEK_LENGTH_SECONDS = 7 * 24 * 60 * 60
/** A window counts as weekly only inside this band (3–14 days). */
export const WEEK_BAND_MIN_SECONDS = 3 * 24 * 60 * 60
export const WEEK_BAND_MAX_SECONDS = 14 * 24 * 60 * 60

/** UI-facing result of one refresh attempt. No raw errors, no raw messages. */
export type UsageOutcome =
  | { state: "available"; weekly: WeeklyWindow }
  | { state: "login-required" }
  | { state: "unauthorized" }
  | { state: "http"; status: number }
  | { state: "network" }
  | { state: "invalid-or-no-weekly" }

export type UsageSourceOptions = {
  credentialsPath: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Injectable clock for deterministic tests (defaults to Date.now). */
  now?: number
}

// ---------------------------------------------------------------------------
// Untrusted-data access helpers (generic, safe by construction)
// ---------------------------------------------------------------------------

/** A plain object (non-null, non-array); anything else is not a record. */
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A finite number; anything else (including NaN/Infinity/strings) is not. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** A non-blank string, returned raw (untrimmed); anything else is not. */
function nonBlankText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

/** JSON.parse that never throws; malformed input becomes null. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Credentials (private)
// ---------------------------------------------------------------------------

/** Minimal credential subset — never exported, never leaves this module. */
type Credentials = {
  token: string
  account?: string
}

/**
 * Read + extract credentials from the Codex CLI auth file. Any failure —
 * missing/unreadable file, malformed JSON, non-object document, missing or
 * empty `access_token` — yields null. Only a nonempty `access_token` is
 * required: the `id_token` has an independent lifetime and the usage
 * endpoint does not consume it, so no expiry gating is applied.
 */
async function readCredentials(path: string): Promise<Credentials | null> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return null
  }
  const document = recordOf(parseJson(text))
  const tokens = recordOf(document?.tokens)
  const token = tokens?.access_token
  if (typeof token !== "string" || token.length === 0) return null
  const account = tokens?.account_id
  return {
    token,
    account: typeof account === "string" && account.length > 0 ? account : undefined,
  }
}

// ---------------------------------------------------------------------------
// Status request
// ---------------------------------------------------------------------------

type StatusReply =
  | { ok: true; body: unknown }
  | { ok: false; code: "auth-rejected" }
  | { ok: false; code: "http"; status: number }
  | { ok: false; code: "unreachable" }

/**
 * Issue the status request. GET with `authorization: Bearer <token>`,
 * `user-agent: codex-cli`, optional `chatgpt-account-id`, and an abort
 * timeout. 401/403 answer "auth-rejected"; other non-2xx answer "http"
 * with the status; any thrown failure (DNS, abort, non-JSON body, …) is
 * swallowed and answered "unreachable" — the original error never crosses
 * this boundary.
 */
async function fetchStatus(input: {
  creds: Credentials
  fetchImpl: typeof fetch
  timeoutMs: number
}): Promise<StatusReply> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.creds.token}`,
    "user-agent": "codex-cli",
  }
  if (input.creds.account) headers["chatgpt-account-id"] = input.creds.account

  try {
    const response = await input.fetchImpl(USAGE_ENDPOINT_URL, {
      headers,
      signal: AbortSignal.timeout(input.timeoutMs),
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: "auth-rejected" }
    }
    if (!response.ok) return { ok: false, code: "http", status: response.status }
    return { ok: true, body: await response.json() }
  } catch {
    return { ok: false, code: "unreachable" }
  }
}

// ---------------------------------------------------------------------------
// Weekly-window reduction (one pass, no intermediate collections)
// ---------------------------------------------------------------------------

type Candidate = {
  used: number
  resetsAt: number
  duration: number | undefined
}

/** Reset time in ms: `reset_at` (epoch s) wins; else `reset_after_seconds`
 *  applied to `now`; non-finite/non-positive results reject the window. */
function resetMoment(record: Record<string, unknown>, now: number): number | null {
  const absolute = finiteNumber(record.reset_at)
  if (absolute !== null) {
    const ms = absolute * 1000
    return Number.isFinite(ms) && ms > 0 ? ms : null
  }
  const relative = finiteNumber(record.reset_after_seconds)
  if (relative !== null) {
    const ms = now + relative * 1000
    return Number.isFinite(ms) && ms > 0 ? ms : null
  }
  return null
}

/** Type guard: the candidate declares a duration inside the weekly band. */
function isWeeklyBand(candidate: Candidate): candidate is Candidate & { duration: number } {
  return (
    candidate.duration !== undefined &&
    candidate.duration >= WEEK_BAND_MIN_SECONDS &&
    candidate.duration <= WEEK_BAND_MAX_SECONDS
  )
}

/** Validate one raw window slot; null when not a usable window. */
function windowCandidate(slot: unknown, now: number): Candidate | null {
  const record = recordOf(slot)
  if (!record) return null
  const used = finiteNumber(record.used_percent)
  if (used === null) return null
  const resetsAt = resetMoment(record, now)
  if (resetsAt === null) return null
  const duration = finiteNumber(record.limit_window_seconds)
  return {
    used,
    resetsAt,
    duration: duration !== null && duration > 0 ? duration : undefined,
  }
}

/** Remaining share: 100 − used, rounded, clamped to 0–100; non-finite → 0. */
export function shareRemaining(usedPercent: unknown): number {
  const used = finiteNumber(usedPercent)
  if (used === null) return 0
  return Math.min(100, Math.max(0, Math.round(100 - used)))
}

/**
 * Reduce an untrusted usage payload to the weekly quota window, if any.
 *
 * Selection in one pass over the primary/secondary slots: the in-band
 * (3–14 day) window closest to exactly 7 days wins, ties keeping the
 * primary slot; if nothing is in band, the last duration-less slot wins
 * (secondary preferred); windows declaring an out-of-band duration are
 * never selectable. The plan label is attached raw when non-blank.
 */
export function reduceWeeklyWindow(payload: unknown, now: number): WeeklyWindow | null {
  const root = recordOf(payload)
  if (!root) return null
  const envelope = recordOf(root.rate_limit)
  if (!envelope) return null

  const primary = windowCandidate(envelope.primary_window, now)
  const secondary = windowCandidate(envelope.secondary_window, now)

  // Single pass over the two slots, explicit sequential state (no
  // collections): in-band window closest to 7 days wins; strict
  // improvement keeps the primary slot on ties; windows declaring an
  // out-of-band duration are never selectable.
  let best: Candidate | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  if (primary !== null && isWeeklyBand(primary)) {
    best = primary
    bestDistance = Math.abs(primary.duration - WEEK_LENGTH_SECONDS)
  }
  if (secondary !== null && isWeeklyBand(secondary)) {
    const distance = Math.abs(secondary.duration - WEEK_LENGTH_SECONDS)
    if (best === null || distance < bestDistance) {
      best = secondary
      bestDistance = distance
    }
  }

  const winner =
    best ??
    // Duration-less fallback: last duration-less slot wins (secondary
    // preferred); duration-less means the window declared no usable one.
    (secondary !== null && secondary.duration === undefined ? secondary : null) ??
    (primary !== null && primary.duration === undefined ? primary : null)
  if (winner === null) return null

  const weekly: WeeklyWindow = {
    usedPercent: winner.used,
    remaining: shareRemaining(winner.used),
    resetsAt: winner.resetsAt,
    limitWindowSeconds: winner.duration,
  }
  const plan = nonBlankText(root.plan_type)
  return plan ? { ...weekly, planType: plan } : weekly
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * One-shot refresh pipeline: resolve credentials from the configured file,
 * query the endpoint, reduce the payload, and answer with a UI outcome.
 * Missing credentials skip the request entirely ("login-required" without
 * a doomed network call). Every path is a safe, ordinary outcome — this
 * function never rejects.
 */
export async function collectUsageOutcome(opts: UsageSourceOptions): Promise<UsageOutcome> {
  const creds = await readCredentials(opts.credentialsPath)
  if (!creds) return { state: "login-required" }

  const reply = await fetchStatus({
    creds,
    fetchImpl: opts.fetchImpl ?? fetch,
    timeoutMs: opts.timeoutMs ?? USAGE_TIMEOUT_MS,
  })
  if (!reply.ok) {
    if (reply.code === "auth-rejected") return { state: "unauthorized" }
    if (reply.code === "http") return { state: "http", status: reply.status }
    return { state: "network" }
  }

  const weekly = reduceWeeklyWindow(reply.body, opts.now ?? Date.now())
  return weekly === null
    ? { state: "invalid-or-no-weekly" }
    : { state: "available", weekly }
}
