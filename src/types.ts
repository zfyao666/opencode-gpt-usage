/**
 * Shared types for the opencode-gpt-usage TUI plugin.
 */

/** Stable identity of a quota window: the 5-hour or the 7-day one. */
export type UsageWindowKind = "five-hour" | "weekly"

/** A parsed ChatGPT (Codex) usage window. */
export type UsageWindow = {
  /** stable kind: "five-hour" (5 h quota) or "weekly" (7 d quota). */
  kind: UsageWindowKind
  /** 0–100, percent of the window already used (clamped, rounded). */
  usedPercent: number
  /** 0–100, percent remaining (100 − used, clamped, rounded). */
  remaining: number
  /** epoch ms when the window resets. */
  resetsAt: number
  /** window duration in seconds, when the API provided one. */
  limitWindowSeconds?: number
}

/** A weekly usage window — the compatibility view `reduceWeeklyWindow` returns. */
export type WeeklyWindow = UsageWindow & { kind: "weekly" }

export type UsageErrorKind = "auth" | "network" | "http" | "no-window"

export type UsageError = {
  kind: UsageErrorKind
  message: string
  /** epoch ms after which the next automatic retry fires. */
  retryAt: number
}

/** Last-good snapshot plus when it was captured. */
export type UsageSnapshot = {
  /** Recognized quota windows, ordered five-hour first, then weekly. */
  windows: UsageWindow[]
  /** raw WHAM plan_type ("plus", "pro", …), reported once per snapshot. */
  planType?: string
  /** epoch ms when this snapshot was fetched successfully. */
  fetchedAt: number
  /** present when a refresh failed after this snapshot; forces the stale state. */
  refreshError?: UsageError
}

export type ViewState =
  | { kind: "loading" }
  | { kind: "data"; snapshot: UsageSnapshot }
  | { kind: "error"; error: UsageError }
