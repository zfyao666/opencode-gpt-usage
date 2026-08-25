/**
 * opencode-gpt-usage — ChatGPT (Codex) weekly quota card for the opencode
 * TUI right sidebar (`sidebar_content` slot).
 *
 * Reads `~/.codex/auth.json` (`tokens.access_token`, `tokens.account_id`)
 * and asks `chatgpt.com/backend-api/wham/usage` for the quota windows
 * (5-hour and ~7-day weekly, selected by `limit_window_seconds`, never
 * just position).
 *
 *   ┌ OpenCode GPT Usage ─────────┐
 *   │ ● ChatGPT Plus                 │
 *   │ 5h ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░ 70%     │
 *   │    ● resets  2026-08-26 07:20  │
 *   │ 7d ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░ 85%     │
 *   │    ● started 2026-08-21 02:20  │
 *   │    ● resets  2026-08-28 02:20  │
 *   └───────────────────────────────┘
 *
 * One bar per usage window in the snapshot (5h and/or weekly), each with
 * its own compact kind label, remaining %, health color and reset time.
 * With a single window the label still names the period. Detail rows
 * (plan / started / bulleted resets) appear only when the measured
 * content width fits them (DETAIL_MIN_WIDTH); narrower cards keep just
 * the actionable reset footer so the percentage is never crowded out.
 * The started row exists only when the API reported a real window
 * duration — a position-fallback window has no honest start and renders
 * nothing.
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
  formatResetLocal,
  friendlyPlanName,
  layoutBar,
  periodStart,
  secondsUntil,
  staleness,
} from "./format"
import type { ViewState } from "./types"

/** Fixed initial retry delay — not configurable; only the cap is. */
const RETRY_BASE_MS = 10_000

/**
 * Compact per-window bar labels: "5h" / "7d". Short English tags match
 * the existing UI language and stay readable in narrow sidebars; unknown
 * kinds fall back to their raw name so nothing renders unlabeled.
 */
const WINDOW_KIND_LABELS: Record<string, string> = { "five-hour": "5h", weekly: "7d" }
const windowLabel = (kind: string): string => WINDOW_KIND_LABELS[kind] ?? kind

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

        const plan = friendlyPlanName(snap.planType)
        // Detail bullet rows (plan / started / bulleted resets) only when
        // the measured width fits them; narrower cards stay lean.
        const showDetails = measuredWidth >= DETAIL_MIN_WIDTH

        const windows = snap.windows
        const maxLabel = windows.reduce((n, w) => Math.max(n, windowLabel(w.kind).length), 0)
        const labelCells = maxLabel + 1 // kind label + the flex gap before the bar
        const widestPct = windows.reduce((n, w) => Math.max(n, `${w.remaining}%`.length), 0)
        // One SHARED layout for every bar: the widest pct label decides
        // inline/stacked and the kind-label column is reserved up front
        // (layoutBar only reads pctLabel.length, hence the placeholder),
        // so all bars get the same width and the rows stay aligned.
        const layout = layoutBar(measuredWidth - labelCells, "0".repeat(widestPct))
        const staleSuffix = stale
          ? ` · stale ${formatAge(t - snap.fetchedAt)}` + (retryIn > 0 ? ` · retry ${retryIn}s` : "")
          : ""
        // Color hierarchy: fresh quota/period VALUES use normal readable
        // text; bullets and labels stay muted secondary affordances (via
        // spans). When stale, everything informational drops to muted so
        // nothing reads as fresh, and the LAST resets row carries the
        // explicit warning-colored stale marker. Each window gets its own
        // health color from its own remaining; `resets` is padded to
        // align its timestamp with `started`.
        const valueColor = stale ? theme().textMuted : theme().text
        const labelColor = theme().textMuted
        const healthColor = (remaining: number) =>
          remaining >= 50 ? theme().success : remaining >= 15 ? theme().warning : theme().error
        // Indent detail rows so the bullets sit directly under the bar.
        const indent = " ".repeat(labelCells)

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
              <text fg={stale ? theme().warning : theme().text} wrapMode="none" truncate>
                {stale ? `${cfg.cardTitle} · stale` : cfg.cardTitle}
              </text>
              {showDetails && plan ? (
                <text fg={valueColor} wrapMode="none" truncate>
                  <span {...{ style: { fg: labelColor } }}>{"● "}</span>
                  {plan}
                </text>
              ) : null}
              {windows.map((w, i) => {
                const label = windowLabel(w.kind).padEnd(maxLabel)
                const pctLabel = `${w.remaining}%`
                const bar = formatBar(w.remaining, layout.barWidth)
                const barColor = stale ? theme().textMuted : healthColor(w.remaining)
                const start = periodStart(w.resetsAt, w.limitWindowSeconds)
                // Stacked (narrow) bars keep the bar on its own full row
                // and move the percentage onto the reset footer.
                const stackedPrefix =
                  !showDetails && layout.mode === "stacked" ? `${pctLabel} · ` : null
                const resetsLabel = showDetails ? `${indent}● resets  ` : "resets "
                return (
                  // marginTop on follow-up windows: a one-row breather so
                  // two blocks never read as one crowded stack.
                  <box flexDirection="column" minWidth={0} marginTop={i > 0 ? 1 : 0}>
                    <box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
                      <text fg={labelColor} wrapMode="none">
                        {label}
                      </text>
                      <text fg={barColor}>{bar}</text>
                      {layout.mode === "inline" ? (
                        <text fg={stale ? theme().textMuted : theme().text}>{pctLabel}</text>
                      ) : null}
                    </box>
                    {showDetails && start !== null ? (
                      // marginTop (first window only): slight separation
                      // between the bar and the period detail rows — a
                      // local nudge only, no container gap changes.
                      <text fg={valueColor} wrapMode="none" truncate marginTop={i === 0 ? 1 : 0}>
                        <span {...{ style: { fg: labelColor } }}>{`${indent}● started `}</span>
                        {formatResetLocal(start)}
                      </text>
                    ) : null}
                    <text fg={valueColor} wrapMode="none" truncate>
                      {stackedPrefix ? (
                        <span {...{ style: { fg: valueColor } }}>{stackedPrefix}</span>
                      ) : null}
                      <span {...{ style: { fg: labelColor } }}>{resetsLabel}</span>
                      {formatResetLocal(w.resetsAt)}
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
