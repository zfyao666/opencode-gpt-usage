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
 *   pre-measurement default, rendered STACKED: an inline guess could be
 *   too wide for a narrow slot and wrap the label awkwardly, while a
 *   stacked bar at the default width never collides with the label.
 * - Inline when the bar keeps at least MIN_BAR_WIDTH cells beside the
 *   label and the 1-cell gap; the bar soaks up all remaining width,
 *   capped at MAX_BAR_WIDTH.
 * - Otherwise stack: the bar gets the full row and the percentage moves
 *   to the footer, so neither ever wraps or truncates awkwardly.
 */
export function layoutBar(contentWidth: number, pctLabel: string): BarLayout {
  const w = Math.floor(contentWidth)
  if (!Number.isFinite(w) || w <= 0) return { mode: "stacked", barWidth: DEFAULT_BAR_WIDTH }
  const inline = w - pctLabel.length - 1 // 1 = flex row gap
  if (inline >= MIN_BAR_WIDTH) return { mode: "inline", barWidth: Math.min(inline, MAX_BAR_WIDTH) }
  return { mode: "stacked", barWidth: Math.min(Math.max(w, 1), MAX_BAR_WIDTH) }
}

const pad2 = (n: number): string => String(n).padStart(2, "0")

/**
 * Local reset timestamp in ISO style: "YYYY-MM-DD HH:mm" (24h), e.g.
 * "2026-08-28 02:20". Built field-by-field so it is locale-stable and
 * reads the same in every environment (and in tests). "" when the
 * timestamp is invalid.
 */
export function formatResetLocal(resetsAtMs: number): string {
  const d = new Date(resetsAtMs)
  if (Number.isNaN(d.getTime())) return ""
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  )
}

/** Known WHAM plan_type values → friendly suffixes. */
const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
}

/**
 * Map a raw WHAM `plan_type` ("plus", "chatgpt_pro", …) to a friendly
 * label: "ChatGPT Plus", "ChatGPT Pro", … Unknown non-empty values are
 * title-cased and prefixed the same way; missing/blank/non-string values
 * return null so the UI can simply omit the plan row.
 */
export function friendlyPlanName(planType: unknown): string | null {
  if (typeof planType !== "string") return null
  const norm = planType
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
  if (!norm) return null
  const bare = norm.replace(/^chatgpt\s+/, "")
  if (!bare) return "ChatGPT"
  const name = PLAN_NAMES[bare] ?? bare.replace(/\b\w/g, (c) => c.toUpperCase())
  return `ChatGPT ${name}`
}

/** Compact age for stale labels: "12m", "2h", "2h 5m". Minimum 1m. */
export function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  return `${mins}m`
}

/**
 * Derive the period start from the reset time and the window duration.
 * Returns null when the API gave no usable duration — a weekly window
 * selected by position fallback has no honest start, so the UI must omit
 * the row rather than fabricate one.
 */
export function periodStart(resetsAtMs: number, limitWindowSeconds?: number): number | null {
  if (
    typeof limitWindowSeconds !== "number" ||
    !Number.isFinite(limitWindowSeconds) ||
    limitWindowSeconds <= 0
  ) {
    return null
  }
  const start = resetsAtMs - limitWindowSeconds * 1000
  return Number.isFinite(start) && start > 0 ? start : null
}

/**
 * Minimum measured content width for the muted detail bullet rows
 * (`● ChatGPT Plus`, `● started …`, `● resets  …`). The longest of these
 * is `● resets  YYYY-MM-DD HH:mm` = 25 cells; below this the card keeps
 * only the actionable footer so narrow slots stay uncluttered and the
 * percentage is never crowded out.
 */
export const DETAIL_MIN_WIDTH = 25

export type Staleness = "fresh" | "stale"

/**
 * A snapshot is stale when a refresh has failed since it was captured, or
 * when its age exceeds the stale threshold (default STALE_MS = 15 min; the
 * TUI plugin may override it via the `staleMs` option). Fresh data must
 * never silently masquerade as fresh when stale — callers render the stale
 * variant whenever this returns "stale".
 */
export function staleness(
  snapshot: { fetchedAt: number; refreshError?: unknown },
  now: number,
  staleMs: number = STALE_MS,
): Staleness {
  if (snapshot.refreshError) return "stale"
  return now - snapshot.fetchedAt > staleMs ? "stale" : "fresh"
}

/** Whole seconds until a retry fires, never negative. */
export function secondsUntil(epochMs: number, now: number): number {
  return Math.max(0, Math.ceil((epochMs - now) / 1000))
}
