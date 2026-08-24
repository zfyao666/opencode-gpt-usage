/**
 * End-to-end layout test: runs the real plugin (src/index.tsx) inside a
 * faithful replica of the opencode host sidebar — same SlotRegistry + Slot
 * primitives from @opentui/solid that the host uses, and the same chrome
 * (extracted from the opencode binary): sidebar box width=42, paddingX=2,
 * containing scrollbox flexGrow=1, containing a column box flexShrink=0
 * gap=1 paddingRight=1 that hosts the sidebar_content slot.
 *
 * HOME and fetch are stubbed so the plugin reaches the data state with
 * 70% remaining.
 *
 * Key regression covered: the bar must reach the measured card width
 * (24 cells at the production sidebar width of 42), not sit at the
 * pre-measurement default of 10 — the bug where a freshly created
 * element was measured before Yoga layout and always read 0.
 *
 * Scenarios run SEQUENTIALLY, one mount at a time: the plugin holds a
 * single content ref (the production host mounts exactly one sidebar),
 * so two simultaneous mounts would share the measured width.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createSlot, createSolidSlotRegistry, render } from "@opentui/solid"

/** Sidebar outer width hardcoded in the opencode host. */
const SIDEBAR_OUTER = 42
/** Empirical card content width at SIDEBAR_OUTER (border + paddingX removed). */
const CONTENT_WIDE = 33
/** Compact replica width; its card content width is 13. */
const SIDEBAR_COMPACT = 22
const CONTENT_COMPACT = 13
/** Very narrow replica; card content width 9, forcing the stacked fallback. */
const SIDEBAR_TINY = 18
const CONTENT_TINY = 9

const PCT_LABEL = "70%"
const BAR_WIDE = CONTENT_WIDE - PCT_LABEL.length - 1 // 29
const BAR_COMPACT = CONTENT_COMPACT - PCT_LABEL.length - 1 // 9 (inline holds: label is short)
const BAR_TINY = CONTENT_TINY // 9, stacked: full row

let homeDir: string
let prevHome: string | undefined
let realFetch: typeof fetch
const disposers: Array<() => void> = []
let slotsPlugin: Record<string, unknown> | undefined
const scenarios: TestRendererSetup[] = []

/** Drive real time and render passes so the plugin's 1 s tick fires. */
async function pump(setup: TestRendererSetup, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100))
    await setup.renderOnce()
  }
}

/** Mount the captured slot plugin into a fresh host replica of the given
 *  sidebar width and return its test renderer. */
async function mountScenario(sidebarWidth: number): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width: Math.max(80, sidebarWidth + 10), height: 24 })
  scenarios.push(setup)
  const theme = {
    current: {
      border: "#555555",
      text: "#eeeeee",
      textMuted: "#888888",
      success: "#22c55e",
      warning: "#f59e0b",
      error: "#ef4444",
    },
  }
  const registry = createSolidSlotRegistry(setup.renderer as never, { theme } as never)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Slot: any = createSlot(registry as never)
  registry.register({ id: `quota-${sidebarWidth}`, ...(slotsPlugin as object) } as never)

  await render(
    (() => (
      <box width={sidebarWidth} height="100%" paddingLeft={2} paddingRight={2}>
        <scrollbox flexGrow={1}>
          <box flexShrink={0} gap={1} paddingRight={1}>
            <Slot name="sidebar_content" session_id="e2e" />
          </box>
        </scrollbox>
      </box>
    )) as never,
    setup.renderer as never,
  )
  return setup
}

beforeAll(async () => {
  prevHome = process.env.HOME
  realFetch = globalThis.fetch

  homeDir = mkdtempSync(join(tmpdir(), "quota-e2e-home-"))
  mkdirSync(join(homeDir, ".codex"), { recursive: true })
  writeFileSync(
    join(homeDir, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "fake-token", account_id: "acct-1" } }),
  )
  process.env.HOME = homeDir

  const resetAt = Math.floor(Date.now() / 1000) + 3 * 24 * 3600
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 30, limit_window_seconds: 7 * 24 * 3600, reset_at: resetAt },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch

  // Imported dynamically: the module resolves ~/.codex/auth.json at load
  // time, so HOME must already point at the stub.
  const { default: plugin } = await import("../src/index")
  const api = {
    slots: {
      register: (p: Record<string, unknown>) => {
        slotsPlugin = p
        return "quota-under-test"
      },
    },
    lifecycle: {
      onDispose: (fn: () => void) => {
        disposers.push(fn)
        return () => {}
      },
    },
  }
  await plugin.tui(api as never, undefined, {} as never)
})

afterAll(() => {
  for (const fn of disposers) fn()
  for (const s of scenarios) (s.renderer as unknown as { destroy?: () => void }).destroy?.()
  globalThis.fetch = realFetch
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  rmSync(homeDir, { recursive: true, force: true })
})

describe("sidebar_content layout in a faithful host replica", () => {
  test("production sidebar width 42: bar fills the measured card width, inline with the label", async () => {
    const setup = await mountScenario(SIDEBAR_OUTER)
    // Let refresh resolve and at least one 1 s tick pass so the width
    // sampled from the first laid-out subtree takes effect.
    await pump(setup, 2200)
    const frame = setup.captureCharFrame()

    expect(frame).toContain("OpenCode GPT Usage")
    expect(frame).toContain("ChatGPT Plus") // plan_type: "plus" from the stub
    expect(frame).toContain(PCT_LABEL)
    // ISO-style local reset timestamp.
    expect(frame).toMatch(/resets \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    // The literal word "left" is gone; the percentage itself remains.
    expect(frame).not.toContain("left")

    // 70% of 29 cells -> 20 filled, 9 empty, inline with the label and
    // flush against the card's right padding — never the stuck default
    // 10-cell bar from the pre-layout measurement bug.
    expect(BAR_WIDE).toBe(29)
    const wideRow = `${"▓".repeat(20)}${"░".repeat(9)} ${PCT_LABEL}`
    expect(frame).toContain(wideRow)

    // The bar row must be flush: its right border column equals the top
    // border's right edge (no slack, no overflow).
    const lines = frame.split("\n")
    const top = lines.find((l) => l.includes("┌"))
    const row = lines.find((l) => l.includes("▓"))
    expect(top).toBeDefined()
    expect(row).toBeDefined()
    expect(row!.indexOf("│", row!.indexOf("▓"))).toBe(top!.lastIndexOf("┐") )
  }, 15_000)

  test("compact sidebar width 22: short label keeps bar and percentage inline", async () => {
    const setup = await mountScenario(SIDEBAR_COMPACT)
    await pump(setup, 2200)
    const frame = setup.captureCharFrame()

    // Dropping the literal "left" shrank the label to 3 cells, so the
    // inline arrangement now holds at content width 13: 13 - 3 - 1 = 9
    // bar cells -> 6 filled, 3 empty, with "70%" beside it (no wrap).
    expect(BAR_COMPACT).toBe(9)
    expect(frame).toContain(`${"▓".repeat(6)}${"░".repeat(3)} ${PCT_LABEL}`)
    expect(frame).not.toMatch(/▓+\d/)
  }, 15_000)

  test("tiny sidebar width 18: stacked fallback, full-row bar, percentage in footer, no wrap", async () => {
    const setup = await mountScenario(SIDEBAR_TINY)
    await pump(setup, 2200)
    const frame = setup.captureCharFrame()

    expect(BAR_TINY).toBe(9)
    // 70% of 9 cells -> 6 filled, 3 empty, alone on its row.
    const tinyRow = `${"▓".repeat(6)}${"░".repeat(3)}`
    const barLine = frame.split("\n").find((l) => l.includes(tinyRow))
    expect(barLine).toBeDefined()
    // The bar row contains only bar glyphs between the borders — the
    // label must not wrap beside it or onto a second line.
    expect(barLine).toMatch(/│\s[▓░]+\s│/)
    expect(frame).not.toMatch(/▓+\d/)
    // Percentage survives in the (truncating) footer of the tiny card.
    expect(frame).toContain(PCT_LABEL)
  }, 15_000)
})
