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
 * header and in no returned value. The credential reader auto-detects
 * two auth-file shapes — the Codex CLI `tokens.access_token` layout and
 * the OpenCode `openai.type: "oauth"` layout — without exposing which
 * one supplied the credential.
 *
 * Window reduction (`reduceUsageWindows`) selects, in a single pass over
 * the two rate-limit slots, the best window of each kind: a five-hour
 * window is an in-band (3–7 h) duration closest to 5 h, a weekly window
 * an in-band (3–14 d) duration closest to 7 d, and ties keep the primary
 * slot. A kind with no in-band window is simply absent. The duration-less
 * fallback is never duplicated across kinds: it is a single weekly
 * compatibility window, used only when no window declared a usable
 * duration. A successful but unusable payload — null, primitive, array,
 * `{}`, no recognizable window — is an ordinary "invalid-or-no-window"
 * outcome, never a rejected refresh.
 *
 * Protocol facts (endpoint URL, header names, GET, timeout, status
 * handling) are literal.
 */
import type { UsageWindow, UsageWindowKind, WeeklyWindow } from "./types"
import { readFile } from "node:fs/promises"

/** ChatGPT/Codex usage status endpoint. */
export const USAGE_ENDPOINT_URL = "https://chatgpt.com/backend-api/wham/usage"

/** How long a status request may take before it is aborted. */
export const USAGE_TIMEOUT_MS = 10_000

/** The real Codex five-hour window length (5 h, in seconds). */
export const FIVE_HOUR_LENGTH_SECONDS = 5 * 60 * 60
/** A window counts as five-hour only inside this band (3–7 h). */
export const FIVE_HOUR_BAND_MIN_SECONDS = 3 * 60 * 60
export const FIVE_HOUR_BAND_MAX_SECONDS = 7 * 60 * 60

/** The real Codex weekly window length (7 days, in seconds). */
export const WEEK_LENGTH_SECONDS = 7 * 24 * 60 * 60
/** A window counts as weekly only inside this band (3–14 days). */
export const WEEK_BAND_MIN_SECONDS = 3 * 24 * 60 * 60
export const WEEK_BAND_MAX_SECONDS = 14 * 24 * 60 * 60

/** UI-facing result of one refresh attempt. No raw errors, no raw messages. */
export type UsageOutcome =
  | { state: "available"; windows: UsageWindow[]; planType?: string }
  | { state: "login-required" }
  | { state: "unauthorized" }
  | { state: "http"; status: number }
  | { state: "network" }
  | { state: "invalid-or-no-window" }

/** Result of one payload reduction: recognized windows + the plan label. */
export type UsageReduction = {
  /** Recognized quota windows, ordered five-hour first, then weekly. */
  windows: UsageWindow[]
  /** Raw WHAM plan_type ("plus", "pro", …), when the API reported one. */
  planType?: string
}

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
 * Read + extract credentials from the configured auth file, auto-detecting
 * two shapes:
 *
 *  (A) Codex CLI — `tokens.access_token` (required nonempty) plus the
 *      optional `tokens.account_id`. Unchanged legacy behavior.
 *
 *  (B) OpenCode — an `openai` entry with `type: "oauth"` carries the
 *      credential: `openai.access` (required nonempty) maps to the token
 *      and the optional `openai.accountId` maps to the account id.
 *      Anything else under `openai` — `type: "api"` (API-key shape),
 *      absent, non-object, or oauth with a missing/empty `access` — is
 *      not a usable credential.
 *
 * Codex wins when both shapes are present, so existing files behave
 * exactly as before. Any failure — missing/unreadable file, malformed
 * JSON, non-object document, or no recognizable credential pair — yields
 * null. Only a nonempty access token is required: the `id_token` has an
 * independent lifetime and the usage endpoint does not consume it, so no
 * expiry gating is applied.
 */
async function readCredentials(path: string): Promise<Credentials | null> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return null
  }
  const document = recordOf(parseJson(text))
  if (!document) return null

  // (A) Codex CLI shape — first, unchanged.
  const tokens = recordOf(document.tokens)
  const token = tokens?.access_token
  if (typeof token === "string" && token.length > 0) {
    const account = tokens?.account_id
    return {
      token,
      account: typeof account === "string" && account.length > 0 ? account : undefined,
    }
  }

  // (B) OpenCode shape — only a `type: "oauth"` entry is a credential.
  const openai = recordOf(document.openai)
  if (openai?.type === "oauth") {
    const access = openai.access
    if (typeof access === "string" && access.length > 0) {
      const account = openai.accountId
      return {
        token: access,
        account: typeof account === "string" && account.length > 0 ? account : undefined,
      }
    }
  }

  return null
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
// Window reduction (one pass, no intermediate collections)
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
 * Best in-band window of one kind, single pass over the two slots: the
 * window closest to `targetSeconds` wins; strict improvement keeps the
 * primary slot on ties; windows declaring an out-of-band duration are
 * never selectable.
 */
function bestInBand(
  primary: Candidate | null,
  secondary: Candidate | null,
  minSeconds: number,
  maxSeconds: number,
  targetSeconds: number,
): Candidate | null {
  let best: Candidate | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const slot of [primary, secondary]) {
    if (slot === null) continue
    const duration = slot.duration
    if (duration === undefined || duration < minSeconds || duration > maxSeconds) continue
    const distance = Math.abs(duration - targetSeconds)
    if (best === null || distance < bestDistance) {
      best = slot
      bestDistance = distance
    }
  }
  return best
}

/** Wrap a candidate into a public window of the given kind. */
function windowOf(candidate: Candidate, kind: UsageWindowKind): UsageWindow {
  const window: UsageWindow = {
    kind,
    usedPercent: candidate.used,
    remaining: shareRemaining(candidate.used),
    resetsAt: candidate.resetsAt,
  }
  if (candidate.duration !== undefined) window.limitWindowSeconds = candidate.duration
  return window
}

/**
 * Reduce an untrusted usage payload to the recognized quota windows, if
 * any. Each kind keeps only its single best in-band window — five-hour
 * durations (3–7 h) closest to 5 h, weekly durations (3–14 d) closest to
 * 7 d, ties keeping the primary slot — and the recognized windows come
 * back in fixed order, five-hour first then weekly, so the UI can render
 * one entry per present kind. The duration-less fallback is NOT
 * duplicated across kinds: it is a single weekly compatibility window,
 * used only when no window declared a usable (in-band) duration, with
 * the secondary slot preferred. The plan label rides at the reduction
 * level, not per window.
 */
export function reduceUsageWindows(payload: unknown, now: number): UsageReduction | null {
  const root = recordOf(payload)
  if (!root) return null
  const envelope = recordOf(root.rate_limit)
  if (!envelope) return null

  const primary = windowCandidate(envelope.primary_window, now)
  const secondary = windowCandidate(envelope.secondary_window, now)

  const fiveHour = bestInBand(
    primary,
    secondary,
    FIVE_HOUR_BAND_MIN_SECONDS,
    FIVE_HOUR_BAND_MAX_SECONDS,
    FIVE_HOUR_LENGTH_SECONDS,
  )
  const weekly = bestInBand(
    primary,
    secondary,
    WEEK_BAND_MIN_SECONDS,
    WEEK_BAND_MAX_SECONDS,
    WEEK_LENGTH_SECONDS,
  )

  const windows: UsageWindow[] = []
  if (fiveHour !== null) windows.push(windowOf(fiveHour, "five-hour"))
  if (weekly !== null) windows.push(windowOf(weekly, "weekly"))

  if (windows.length === 0) {
    // Single weekly compatibility fallback: last duration-less slot wins
    // (secondary preferred); duration-less means the window declared no
    // usable duration. Never duplicated into a second kind.
    const fallback =
      (secondary !== null && secondary.duration === undefined ? secondary : null) ??
      (primary !== null && primary.duration === undefined ? primary : null)
    if (fallback === null) return null
    windows.push(windowOf(fallback, "weekly"))
  }

  const plan = nonBlankText(root.plan_type)
  return plan === null ? { windows } : { windows, planType: plan }
}

/**
 * Weekly-only compatibility view of `reduceUsageWindows`: the single
 * weekly window of the reduction, if any. Kept so callers that reason
 * about the weekly quota alone keep working unchanged.
 */
export function reduceWeeklyWindow(payload: unknown, now: number): WeeklyWindow | null {
  const reduction = reduceUsageWindows(payload, now)
  if (reduction === null) return null
  const weekly = reduction.windows.find(
    (window): window is WeeklyWindow => window.kind === "weekly",
  )
  return weekly === undefined ? null : weekly
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

  const reduction = reduceUsageWindows(reply.body, opts.now ?? Date.now())
  if (reduction === null) return { state: "invalid-or-no-window" }
  const outcome: UsageOutcome = { state: "available", windows: reduction.windows }
  return reduction.planType !== undefined
    ? { ...outcome, planType: reduction.planType }
    : outcome
}
