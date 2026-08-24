/**
 * Pure formatting/derivation helpers — no I/O, fully unit-testable.
 */

/** 15 minutes: data older than this is never shown as fresh. */
export const STALE_MS = 15 * 60 * 1000

/** Clamp any number (NaN/infinity → 0) to an integer 0–100. */
export function clampPct(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, Math.round(n)))
}

/**
 * "▓▓▓▓▓▓░░░" progress bar for the *remaining* share of the window.
 * Width is clamped to 1–40; remaining to 0–100.
 */
export function formatBar(remaining: number, width: number): string {
  const w = Math.min(40, Math.max(1, Math.floor(width)))
  const pct = clampPct(remaining)
  const filled = Math.round((pct / 100) * w)
  return "▓".repeat(filled) + "░".repeat(w - filled)
}

/** Smallest bar that still reads as a bar when sharing a row with the pct label. */
export const MIN_BAR_WIDTH = 6
/** Never let a very wide sidebar grow an absurd bar. */
export const MAX_BAR_WIDTH = 40
/**
 * Bar width used only before the first layout measurement lands (initial
 * frame). This is a pre-measurement default, not a fixed layout width —
 * the measured width replaces it on the next tick.
 */
export const DEFAULT_BAR_WIDTH = 10

export type BarLayout =
  /** Bar and "N% left" share one row. */
  | { mode: "inline"; barWidth: number }
  /** Bar takes the full row; "N% left" moves to the footer line. */
  | { mode: "stacked"; barWidth: number }

/**
 * Choose the bar width and row arrangement for a *measured* content width
 * (the space inside the card's border and padding).
 *
 * - `contentWidth <= 0` / non-finite means "not measured yet" → the
 *   pre-measurement default, rendered inline.
 * - Inline when the bar keeps at least MIN_BAR_WIDTH cells beside the
 *   label and the 1-cell gap; the bar soaks up all remaining width,
 *   capped at MAX_BAR_WIDTH.
 * - Otherwise stack: the bar gets the full row and the percentage moves
 *   to the footer, so neither ever wraps or truncates awkwardly.
 */
export function layoutBar(contentWidth: number, pctLabel: string): BarLayout {
  const w = Math.floor(contentWidth)
  if (!Number.isFinite(w) || w <= 0) return { mode: "inline", barWidth: DEFAULT_BAR_WIDTH }
  const inline = w - pctLabel.length - 1 // 1 = flex row gap
  if (inline >= MIN_BAR_WIDTH) return { mode: "inline", barWidth: Math.min(inline, MAX_BAR_WIDTH) }
  return { mode: "stacked", barWidth: Math.min(Math.max(w, 1), MAX_BAR_WIDTH) }
}

/** Local wall-clock reset time, e.g. "14:30". "" when the timestamp is invalid. */
export function formatResetLocal(resetsAtMs: number): string {
  const d = new Date(resetsAtMs)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
}

/** Compact age for stale labels: "12m", "2h", "2h 5m". Minimum 1m. */
export function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  return `${mins}m`
}

export type Staleness = "fresh" | "stale"

/**
 * A snapshot is stale when a refresh has failed since it was captured, or
 * when its age exceeds the 15-minute threshold. Fresh data must never
 * silently masquerade as fresh when stale — callers render the stale
 * variant whenever this returns "stale".
 */
export function staleness(
  snapshot: { fetchedAt: number; refreshError?: unknown },
  now: number,
): Staleness {
  if (snapshot.refreshError) return "stale"
  return now - snapshot.fetchedAt > STALE_MS ? "stale" : "fresh"
}

/** Whole seconds until a retry fires, never negative. */
export function secondsUntil(epochMs: number, now: number): number {
  return Math.max(0, Math.ceil((epochMs - now) / 1000))
}
