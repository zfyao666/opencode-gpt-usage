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
