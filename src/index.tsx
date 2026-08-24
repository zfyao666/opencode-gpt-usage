/**
 * opencode-gpt-usage — ChatGPT (Codex) weekly quota card for the opencode
 * TUI right sidebar (`sidebar_content` slot).
 *
 * Reads `~/.codex/auth.json` (`tokens.access_token`, `tokens.account_id`)
 * and asks `chatgpt.com/backend-api/wham/usage` for the ~7-day weekly
 * window (selected by `limit_window_seconds`, never just position).
 *
 *   ┌ WEEKLY ─────────────────┐
 *   │ ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░ 70% left │
 *   │ resets 14:30              │
 *   └───────────────────────────┘
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
 * Fetches immediately, then every 120 s. Failures keep the last-good
 * snapshot but tag it stale (age > 15 min or failed refresh) — fresh data
 * never silently masquerades as fresh when stale. Failed refreshes retry
 * with bounded exponential backoff (10 s → 120 s max) and the card exposes
 * the error and the retry countdown. Auth errors tell the user to run
 * `codex login`; no OAuth refresh endpoint is invented. Tokens are only
 * ever sent to chatgpt.com and never logged.
 */
import type { TuiPlugin, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui"
import type { BoxRenderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { homedir } from "node:os"
import { join } from "node:path"
import { getAccessCredentials, readCodexAuth } from "./auth"
import { fetchWhamUsage, parseWhamUsage } from "./wham"
import { formatAge, formatBar, formatResetLocal, layoutBar, secondsUntil, staleness } from "./format"
import type { UsageError, UsageSnapshot, ViewState } from "./types"

const POLL_MS = 120_000
const RETRY_BASE_MS = 10_000
const RETRY_MAX_MS = 120_000

const AUTH_FILE = join(homedir(), ".codex", "auth.json")

const tui: TuiPlugin = async (api) => {
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
  let backoffMs = RETRY_BASE_MS
  let disposed = false

  const schedule = (ms: number) => {
    if (disposed) return
    timer = setTimeout(() => void refresh(), ms)
  }

  /** Record a failure: keep the last-good snapshot (tagged stale) if we have
   *  one, otherwise switch to the error state. Retry with bounded backoff. */
  const fail = (error: Omit<UsageError, "retryAt">, previous?: UsageSnapshot) => {
    const retryAt = Date.now() + backoffMs
    if (previous) {
      setView({ kind: "data", snapshot: { ...previous, refreshError: { ...error, retryAt } } })
    } else {
      setView({ kind: "error", error: { ...error, retryAt } })
    }
    schedule(backoffMs)
    backoffMs = Math.min(backoffMs * 2, RETRY_MAX_MS)
  }

  const refresh = async () => {
    const current = view()
    const previous = current.kind === "data" ? current.snapshot : undefined

    const auth = await readCodexAuth(AUTH_FILE)
    const creds = getAccessCredentials(auth)
    if (!creds) {
      fail({ kind: "auth", message: "codex login required — run `codex login`" }, previous)
      return
    }

    const res = await fetchWhamUsage({
      accessToken: creds.accessToken,
      accountId: creds.accountId,
    })
    if (!res.ok) {
      if (res.kind === "auth") {
        fail({ kind: "auth", message: "auth rejected — run `codex login`" }, previous)
      } else if (res.kind === "http") {
        fail({ kind: "http", message: `usage endpoint error (HTTP ${res.status})` }, previous)
      } else {
        fail({ kind: "network", message: "network error — retrying" }, previous)
      }
      return
    }

    const weekly = parseWhamUsage(res.data, Date.now())
    if (!weekly) {
      fail({ kind: "no-window", message: "no weekly usage window from API" }, previous)
      return
    }

    backoffMs = RETRY_BASE_MS
    setView({ kind: "data", snapshot: { ...weekly, fetchedAt: Date.now() } })
    schedule(POLL_MS)
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
              <text fg={theme().textMuted}>WEEKLY · loading…</text>
            </box>
          )
        }

        if (state.kind === "error") {
          const err = state.error
          const auth = err.kind === "auth"
          return (
            <box border borderColor={auth ? theme().error : theme().warning} paddingX={1} width="100%">
              <box flexDirection="column" minWidth={0}>
                <text fg={auth ? theme().error : theme().warning}>WEEKLY · unavailable</text>
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
        const stale = staleness(snap, t) === "stale"
        const retryIn = snap.refreshError ? secondsUntil(snap.refreshError.retryAt, t) : 0

        const pctLabel = `${snap.remaining}% left`
        const layout = layoutBar(measuredWidth, pctLabel)
        const bar = formatBar(snap.remaining, layout.barWidth)
        const barColor = stale
          ? theme().textMuted
          : snap.remaining >= 50
            ? theme().success
            : snap.remaining >= 15
              ? theme().warning
              : theme().error
        const reset = formatResetLocal(snap.resetsAt)
        const footerCore = stale
          ? `resets ${reset} · stale ${formatAge(t - snap.fetchedAt)}` +
            (retryIn > 0 ? ` · retry ${retryIn}s` : "")
          : `resets ${reset}`
        // Stacked (narrow) mode keeps the percentage visible by leading
        // the footer with it; the footer truncates from the right, so the
        // percentage is the last thing ever cut.
        const footer = layout.mode === "stacked" ? `${pctLabel} · ${footerCore}` : footerCore

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
              <text fg={stale ? theme().warning : theme().text}>
                {stale ? "WEEKLY · stale" : "WEEKLY"}
              </text>
              <box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
                <text fg={barColor}>{bar}</text>
                {layout.mode === "inline" ? (
                  <text fg={stale ? theme().textMuted : theme().text}>{pctLabel}</text>
                ) : null}
              </box>
              <text fg={theme().textMuted} wrapMode="none" truncate>
                {footer}
              </text>
            </box>
          </box>
        )
      },
    },
  })
}

const plugin = { id: "opencode-gpt-usage", tui } satisfies TuiPluginModule

export default plugin
