/**
 * Shared types for the opencode-gpt-usage TUI plugin.
 */

/** A parsed ChatGPT (Codex) usage window, the weekly one being what we render. */
export type WeeklyWindow = {
  /** 0–100, percent of the window already used (clamped, rounded). */
  usedPercent: number
  /** 0–100, percent remaining (100 − used, clamped, rounded). */
  remaining: number
  /** epoch ms when the window resets. */
  resetsAt: number
  /** window duration in seconds, when the API provided one. */
  limitWindowSeconds?: number
}

export type UsageErrorKind = "auth" | "network" | "http" | "no-window"

export type UsageError = {
  kind: UsageErrorKind
  message: string
  /** epoch ms after which the next automatic retry fires. */
  retryAt: number
}

/** Last-good snapshot plus when it was captured. */
export type UsageSnapshot = WeeklyWindow & {
  /** epoch ms when this snapshot was fetched successfully. */
  fetchedAt: number
  /** present when a refresh failed after this snapshot; forces the stale state. */
  refreshError?: UsageError
}

export type ViewState =
  | { kind: "loading" }
  | { kind: "data"; snapshot: UsageSnapshot }
  | { kind: "error"; error: UsageError }
