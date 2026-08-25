/**
 * Pure refresh-state derivation for the TUI card.
 *
 * Turns a usage outcome into the next ViewState plus the scheduling
 * decision — how long until the next refresh and whether the retry
 * backoff resets. Free of I/O and rendering, so the UI result→view
 * mapping, the backoff progression, and the stale-last-good tagging can
 * be characterized deterministically in tests.
 */
import type { UsageOutcome } from "./codex-usage"
import type { UsageError, UsageSnapshot, ViewState } from "./types"

export type RefreshPlan = {
  view: ViewState
  /** Delay before the next automatic refresh attempt. */
  nextDelayMs: number
  /** True when the refresh succeeded and the retry backoff must reset. */
  backoffReset: boolean
}

export type RefreshInput = {
  outcome: UsageOutcome
  /** The last-good snapshot, when the current view is data. */
  previous: UsageSnapshot | undefined
  now: number
  pollMs: number
  backoffDelayMs: number
}

/** Map a failure outcome to the exact failure kind + copy the UI shows. */
export function outcomeToFailure(
  outcome: Exclude<UsageOutcome, { state: "available" }>,
): Omit<UsageError, "retryAt"> {
  switch (outcome.state) {
    case "login-required":
      return { kind: "auth", message: "codex login required — run `codex login`" }
    case "unauthorized":
      return { kind: "auth", message: "auth rejected — run `codex login`" }
    case "http":
      return { kind: "http", message: `usage endpoint error (HTTP ${outcome.status})` }
    case "network":
      return { kind: "network", message: "network error — retrying" }
    case "invalid-or-no-weekly":
      return { kind: "no-window", message: "no weekly usage window from API" }
  }
}

/**
 * Derive the next view and scheduling decision for one refresh result.
 *
 * Success: replace the view with a fresh data snapshot, schedule the
 * regular poll interval, and reset the backoff. Failure: keep the last-good
 * snapshot tagged stale via `refreshError` when one exists (stale-last-good),
 * otherwise show the error card; schedule the current backoff delay — the
 * caller advances the backoff when `backoffReset` is false.
 */
export function planRefresh(input: RefreshInput): RefreshPlan {
  if (input.outcome.state === "available") {
    return {
      view: { kind: "data", snapshot: { ...input.outcome.weekly, fetchedAt: input.now } },
      nextDelayMs: input.pollMs,
      backoffReset: true,
    }
  }

  const failure = outcomeToFailure(input.outcome)
  const retryAt = input.now + input.backoffDelayMs
  const view: ViewState = input.previous
    ? {
        kind: "data",
        snapshot: { ...input.previous, refreshError: { ...failure, retryAt } },
      }
    : { kind: "error", error: { ...failure, retryAt } }
  return { view, nextDelayMs: input.backoffDelayMs, backoffReset: false }
}

/**
 * Retry backoff state machine: starts at `baseMs`, doubles on each
 * advance, caps at `maxMs`, and resets to base after a success.
 */
export function createRetryBackoff(baseMs: number, maxMs: number) {
  let delayMs = baseMs
  return {
    current: (): number => delayMs,
    advance: (): void => {
      delayMs = Math.min(delayMs * 2, maxMs)
    },
    reset: (): void => {
      delayMs = baseMs
    },
  }
}
