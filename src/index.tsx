/**
 * opencode-gpt-usage — ChatGPT (Codex) weekly quota card for the opencode
 * TUI right sidebar (`sidebar_content` slot).
 *
 * Reads OpenCode's default auth file (`openai.access`, `openai.accountId`),
 * with Codex CLI credentials also supported through `authFile`, then asks
 * `chatgpt.com/backend-api/wham/usage` for the quota windows
 * (5-hour and ~7-day weekly, selected by `limit_window_seconds`, never
 * just position).
 *
 *   ┌ OpenCode GPT Usage ─────────┐
 *   │ OpenCode GPT Usage        Plus │
 *   │                                │
 *   │ 5-hour                         │
 *   │ ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░ 70% left     │
 *   │ reset in 32m · 07:20            │
 *   │                                │
 *   │ 7-day                          │
 *   │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░ 85% left     │
 *   │ reset in 6d 12h · 08-28 02:20   │
 *   └───────────────────────────────┘
 *
 * One bar per usage window in the snapshot (5-hour and/or weekly), each
 * with its own kind label on the row above the bar, remaining %
 * ("N% left"), health color and reset time. Bars are the classic
 * shading pair — medium-shade `▓` for the remaining share, light-shade
 * `░` for the track — rendered in the window's health color (muted
 * when stale). With a single window the label still names the period. The plan type
 * rides in the header row's upper-right corner as a short muted tag
 * ("Plus") — never wrapping, simply omitted when the snapshot reported
 * no plan. Every window ends in the same reset-centric footer line — a
 * countdown, then the concrete reset timestamp, with no bullet glyph
 * and no started row: the 5-hour window keeps a bare clock time
 * ("reset in 32m · 07:20") since it always resets within hours, while
 * the 7-day window keeps month-day but never the year
 * ("reset in 6d 12h · 08-28 02:20"). Narrow cards (below
 * DETAIL_MIN_WIDTH) keep just this actionable footer — when the bar has
 * to stack on its own row there, the percentage moves onto the footer
 * so it is never crowded out.
 *
 * The bar adapts to the real sidebar width: the slot API exposes no
 * width, so the card measures its own content box (a `BoxRenderable`
 * ref). The host re-invokes this slot function — rebuilding the whole
 * subtree — whenever a signal read here changes (at least once per 1 s
 * tick). At that moment the PREVIOUS subtree is still mounted and laid
 * out, so its width is the true rendered width; a freshly created
 * element always measures 0 because Yoga layout only runs in the render
 * pass. Width is therefore sampled from the previous subtree at the top
 * of each invocation and kept in a plain variable — never a signal, and
 * never read off a just-created element. The card is `width="100%"`, so
 * the measured width is parent-driven and the bar can never feed back
 * into its own measurement. Narrow slots stack the bar full-row and
 * move the percentage onto the footer.
 *
 * Fetches immediately, then every pollMs (default 120 s). Failures keep
 * the last-good snapshot but tag it stale (age > staleMs, default 15 min,
 * or failed refresh) — fresh data never silently masquerades as fresh when
 * stale. Failed refreshes retry with bounded exponential backoff (10 s →
 * retryMaxMs, default 120 s max) and the card exposes the error and the
 * retry countdown. Outcome→view/scheduling decisions live in the pure
 * `src/refresh.ts` planner. Auth errors tell the user to run `codex login`;
 * no OAuth refresh endpoint is invented. Tokens are only ever sent to
 * chatgpt.com and never logged.
 *
 * Configuration is loaded ONCE at startup from a dedicated standard JSON
 * file, `~/.config/opencode/gpt-usage.json` (see src/config.ts for the
 * validated keys, bounds and defaults). A missing, unreadable or malformed
 * file yields exactly the defaults; `tui.json` only registers the plugin.
 * Endpoint URL, weekly-window selection, fetch timeout, layout/bar widths,
 * slot order and health thresholds are intentionally internal and not
 * configurable.
 */
import type { TuiPlugin, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui"
import type { BoxRenderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { collectUsageOutcome } from "./codex-usage"
import { loadConfig } from "./config"
import { createRetryBackoff, planRefresh } from "./refresh"
import {
  DETAIL_MIN_WIDTH,
  formatAge,
  formatBar,
  friendlyPlanName,
  layoutBar,
  secondsUntil,
  staleness,
} from "./format"
import type { ViewState } from "./types"

/** Fixed initial retry delay — not configurable; only the cap is. */
const RETRY_BASE_MS = 10_000

/**
 * Per-window quota labels rendered on the row ABOVE each bar: "5-hour" /
 * "7-day". Unknown kinds fall back to their raw name so nothing renders
 * unlabeled.
 */
const WINDOW_KIND_LABELS: Record<string, string> = { "five-hour": "5-hour", weekly: "7-day" }
const windowLabel = (kind: string): string => WINDOW_KIND_LABELS[kind] ?? kind

const pad2 = (n: number): string => String(n).padStart(2, "0")

/**
 * Local clock time only — "HH:mm" (24h), e.g. "03:52". Paired with the
 * "reset in Nm" countdown on the 5-hour window, where the window always
 * resets within hours and the full date adds nothing. "" when the
 * timestamp is invalid.
 */
const formatClockLocal = (epochMs: number): string => {
  const d = new Date(epochMs)
  if (Number.isNaN(d.getTime())) return ""
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * Local reset timestamp without the year — "MM-DD HH:mm" (24h), e.g.
 * "08-28 02:20". Used on the 7-day window, where the reset is days away
 * so a bare clock time is ambiguous, but the year is always implied by
 * the countdown beside it. Built field-by-field so it is locale-stable
 * and reads the same in every environment. "" when invalid.
 */
const formatResetLocalShort = (epochMs: number): string => {
  const d = new Date(epochMs)
  if (Number.isNaN(d.getTime())) return ""
  return (
    `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  )
}

/**
 * Compact countdown for the reset rows: "32m", "2h 5m", "6d 12h".
 * formatAge tops out at hours, which would render the weekly window as
 * "150h" — this adds a days tier. Minimum 1m so a just-about-to-reset
 * window never reads "0m".
 */
const formatCountdown = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const days = Math.floor(minutes / (60 * 24))
  const hours = Math.floor((minutes % (60 * 24)) / 60)
  const mins = minutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  return `${mins}m`
}

const tui: TuiPlugin = async (api) => {
  // Read + validate the config file once, before anything else runs. Any
  // missing/unreadable/malformed file already yielded the defaults.
  const cfg = await loadConfig()
  const [view, setView] = createSignal<ViewState>({ kind: "loading" })
  const [now, setNow] = createSignal(Date.now())

  // Last measured content width of the card (inside border + padding);
  // 0 means "not measured yet". Deliberately NOT a signal: writing it
  // must not retrigger the slot, and it is only ever read at the top of
  // a slot invocation, where the host has already decided to rebuild.
  // It is sampled from the PREVIOUS subtree (still mounted and laid out
  // at that point) — a freshly created element measures 0 until the next
  // render pass runs Yoga layout, which is exactly the trap that made
  // the first version of this render the default 10-cell bar forever.
  let contentRef: BoxRenderable | undefined
  let measuredWidth = 0
  const sampleWidth = () => {
    const w = contentRef?.width ?? 0
    if (w > 0) measuredWidth = w
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  // Retry backoff: starts at RETRY_BASE_MS, doubles on each failure up to
  // cfg.retryMaxMs, resets to base after a successful refresh.
  const backoff = createRetryBackoff(RETRY_BASE_MS, cfg.retryMaxMs)

  const schedule = (ms: number) => {
    if (disposed) return
    timer = setTimeout(() => void refresh(), ms)
  }

  const refresh = async () => {
    const current = view()
    const previous = current.kind === "data" ? current.snapshot : undefined

    const outcome = await collectUsageOutcome({ credentialsPath: cfg.authFile })
    const plan = planRefresh({
      outcome,
      previous,
      now: Date.now(),
      pollMs: cfg.pollMs,
      backoffDelayMs: backoff.current(),
    })
    setView(plan.view)
    if (plan.backoffReset) backoff.reset()
    else backoff.advance()
    schedule(plan.nextDelayMs)
  }

  api.lifecycle.onDispose(() => {
    disposed = true
    if (timer) clearTimeout(timer)
  })

  // The 1 s clock tick also drives width refreshes indirectly: each
  // tick re-invokes the slot, which re-samples the laid-out width (see
  // above) — so terminal resizes and sidebar toggles are picked up
  // within a second without touching renderer internals.
  const tick = setInterval(() => setNow(Date.now()), 1_000)
  api.lifecycle.onDispose(() => clearInterval(tick))

  void refresh()

  api.slots.register({
    order: 10,
    slots: {
      sidebar_content(ctx: TuiSlotContext) {
        // Sample the previous subtree's real laid-out width before this
        // rebuild replaces it; fresh elements would read 0 here.
        sampleWidth()
        const theme = () => ctx.theme.current
        const state = view()
        const t = now()

        if (state.kind === "loading") {
          return (
            <box border borderColor={theme().border} paddingX={1} width="100%">
              <text fg={theme().textMuted} wrapMode="none" truncate>
                {`${cfg.cardTitle} · loading…`}
              </text>
            </box>
          )
        }

        if (state.kind === "error") {
          const err = state.error
          const auth = err.kind === "auth"
          return (
            <box border borderColor={auth ? theme().error : theme().warning} paddingX={1} width="100%">
              <box flexDirection="column" minWidth={0}>
                <text fg={auth ? theme().error : theme().warning} wrapMode="none" truncate>
                  {`${cfg.cardTitle} · unavailable`}
                </text>
                <text fg={theme().text} wrapMode="none" truncate>
                  {err.message}
                </text>
                <text fg={theme().textMuted}>retry in {secondsUntil(err.retryAt, t)}s</text>
              </box>
            </box>
          )
        }

        // Data (fresh or stale).
        const snap = state.snapshot
        const stale = staleness(snap, t, cfg.staleMs) === "stale"
        const retryIn = snap.refreshError ? secondsUntil(snap.refreshError.retryAt, t) : 0

        // Short plan tag for the header row's upper-right corner: "Plus",
        // "Pro", … (friendlyPlanName yields "ChatGPT Plus"; the card
        // title already carries the product context). null when the
        // snapshot reported no usable plan_type — the tag is then simply
        // omitted and the title keeps the full row.
        const plan = friendlyPlanName(snap.planType)
        const planTag = plan?.replace(/^ChatGPT\s+/, "") || null
        // Narrow cards (below DETAIL_MIN_WIDTH) stay lean: when the bar
        // has to stack on its own full row there, the percentage moves
        // onto the reset footer instead of crowding the bar row.
        const showDetails = measuredWidth >= DETAIL_MIN_WIDTH

        const windows = snap.windows
        const widestPct = windows.reduce((n, w) => Math.max(n, `${w.remaining}% left`.length), 0)
        // One SHARED layout for every bar: the widest pct label decides
        // inline/stacked (layoutBar only reads pctLabel.length, hence the
        // placeholder), so all bars get the same width and the rows stay
        // aligned. Kind labels sit on their own rows ABOVE the bars, so
        // each bar can claim the full measured width.
        const layout = layoutBar(measuredWidth, "0".repeat(widestPct))
        const staleSuffix = stale
          ? ` · stale ${formatAge(t - snap.fetchedAt)}` + (retryIn > 0 ? ` · retry ${retryIn}s` : "")
          : ""
        // Color hierarchy: fresh quota/period VALUES use normal readable
        // text — including the "5-hour"/"7-day" kind labels above the
        // bars, which are primary content, not secondary chrome. Only
        // the header's plan tag, separators and the reset-row
        // "reset in"/" · " affordances stay muted (via spans). When
        // stale, everything informational drops
        // to muted so nothing reads as fresh, and the LAST window's
        // reset row carries the explicit warning-colored stale marker.
        // Each window gets its own health color from its own remaining.
        const valueColor = stale ? theme().textMuted : theme().text
        const labelColor = theme().textMuted
        const healthColor = (remaining: number) =>
          remaining >= 50 ? theme().success : remaining >= 15 ? theme().warning : theme().error

        return (
          <box border borderColor={stale ? theme().warning : theme().border} paddingX={1} width="100%">
            <box
              flexDirection="column"
              minWidth={0}
              ref={(el) => {
                // Assignment only — do NOT measure here. This element was
                // just created and has not been through Yoga layout yet,
                // so el.width is 0; measuring now would pin the bar at
                // the pre-measurement default forever.
                contentRef = el
              }}
            >
              {/* Header row: title on the left, plan tag pinned to the
                  upper-right. The title shrinks and truncates first; the
                  tag never wraps or is squeezed, and when it is absent
                  the title simply keeps the full row. */}
              <box flexDirection="row" justifyContent="space-between" minWidth={0}>
                <text
                  fg={stale ? theme().warning : theme().text}
                  wrapMode="none"
                  truncate
                  flexShrink={1}
                  minWidth={0}
                >
                  {stale ? `${cfg.cardTitle} · stale` : cfg.cardTitle}
                </text>
                {planTag ? (
                  <text fg={labelColor} wrapMode="none" flexShrink={0}>
                    {planTag}
                  </text>
                ) : null}
              </box>
              {windows.map((w, i) => {
                const label = windowLabel(w.kind)
                const pctLabel = `${w.remaining}% left`
                // Original bar style: one string — medium-shade `▓` for
                // the remaining share, light-shade `░` for the track —
                // in this window's health color (muted when stale, so a
                // stale bar never reads as a fresh health signal).
                const bar = formatBar(w.remaining, layout.barWidth)
                const barColor = stale ? theme().textMuted : healthColor(w.remaining)
                // Both windows use the SAME reset-centric line — a
                // countdown, then the concrete reset timestamp, with no
                // bullet glyph and no started row. The 5-hour window
                // always resets within hours, so a bare clock time
                // suffices ("reset in 32m · 07:20"); the 7-day window
                // spans days, so its timestamp keeps month-day but never
                // the year ("reset in 6d 12h · 08-28 02:20").
                const isFiveHour = w.kind === "five-hour"
                const resetWhen = isFiveHour
                  ? formatClockLocal(w.resetsAt)
                  : formatResetLocalShort(w.resetsAt)
                // Stacked (narrow) bars keep the bar on its own full row
                // and move the percentage onto the reset footer.
                const stackedPrefix =
                  !showDetails && layout.mode === "stacked" ? `${pctLabel} · ` : null
                return (
                  // Module-level rhythm: exactly ONE full blank row
                  // between the title/plan header and the FIRST window
                  // block, and one full blank row above each FOLLOW-UP
                  // block so consecutive modules stay clearly separated.
                  <box flexDirection="column" minWidth={0} marginTop={1}>
                    {/* Kind label is primary content: normal text color
                        (valueColor), dropping to muted only when stale —
                        same treatment as the percentage. */}
                    <text fg={valueColor} wrapMode="none" truncate>
                      {label}
                    </text>
                    <box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
                      <text fg={barColor} wrapMode="none">
                        {bar}
                      </text>
                      {layout.mode === "inline" ? (
                        <text fg={stale ? theme().textMuted : theme().text}>{pctLabel}</text>
                      ) : null}
                    </box>
                    <text fg={valueColor} wrapMode="none" truncate>
                      {stackedPrefix ? (
                        <span {...{ style: { fg: valueColor } }}>{stackedPrefix}</span>
                      ) : null}
                      <span {...{ style: { fg: labelColor } }}>{"reset in "}</span>
                      {formatCountdown(w.resetsAt - t)}
                      <span {...{ style: { fg: labelColor } }}>{" · "}</span>
                      {resetWhen}
                      {stale && i === windows.length - 1 ? (
                        <span {...{ style: { fg: theme().warning } }}>{staleSuffix}</span>
                      ) : null}
                    </text>
                  </box>
                )
              })}
            </box>
          </box>
        )
      },
    },
  })
}

const plugin = { id: "opencode-gpt-usage", tui } satisfies TuiPluginModule

export default plugin
