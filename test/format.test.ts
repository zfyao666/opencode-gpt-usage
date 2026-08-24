import { describe, expect, test } from "bun:test"
import {
  clampPct,
  DEFAULT_BAR_WIDTH,
  formatAge,
  formatBar,
  formatResetLocal,
  friendlyPlanName,
  layoutBar,
  MAX_BAR_WIDTH,
  MIN_BAR_WIDTH,
  secondsUntil,
  staleness,
  STALE_MS,
} from "../src/format"

process.env.TZ = "UTC"

describe("clampPct", () => {
  test("clamps to 0–100 and rounds", () => {
    expect(clampPct(12.4)).toBe(12)
    expect(clampPct(12.6)).toBe(13)
    expect(clampPct(0)).toBe(0)
    expect(clampPct(100)).toBe(100)
    expect(clampPct(150)).toBe(100)
    expect(clampPct(-5)).toBe(0)
  })

  test("non-finite input → 0", () => {
    expect(clampPct(NaN)).toBe(0)
    expect(clampPct(Infinity)).toBe(0)
  })
})

describe("formatBar", () => {
  test("fills by remaining share", () => {
    expect(formatBar(70, 10)).toBe("▓▓▓▓▓▓▓░░░")
    expect(formatBar(35, 6)).toBe("▓▓░░░░")
    expect(formatBar(0, 10)).toBe("░░░░░░░░░░")
    expect(formatBar(100, 10)).toBe("▓▓▓▓▓▓▓▓▓▓")
  })

  test("clamps the width to 1–40", () => {
    expect(formatBar(50, 0)).toBe("▓")
    expect(formatBar(50, -3)).toBe("▓")
    expect(formatBar(50, 99)).toHaveLength(40)
    expect(formatBar(50, 40)).toHaveLength(40)
  })

  test("non-finite remaining renders an empty bar", () => {
    expect(formatBar(NaN, 10)).toBe("░░░░░░░░░░")
  })
})

describe("layoutBar", () => {
  test("unmeasured width (0, negative, NaN) → pre-measurement default, stacked (never wraps the label)", () => {
    for (const w of [0, -5, NaN, Infinity, -Infinity]) {
      expect(layoutBar(w, "70% left")).toEqual({ mode: "stacked", barWidth: DEFAULT_BAR_WIDTH })
    }
  })

  test("inline mode soaks up the row minus label and 1-cell gap", () => {
    // "70% left" is 8 cells: 30 - 8 - 1 = 21
    expect(layoutBar(30, "70% left")).toEqual({ mode: "inline", barWidth: 21 })
    // "100% left" is 9 cells: 30 - 9 - 1 = 20
    expect(layoutBar(30, "100% left")).toEqual({ mode: "inline", barWidth: 20 })
    // fractional widths floor first
    expect(layoutBar(30.9, "70% left")).toEqual({ mode: "inline", barWidth: 21 })
  })

  test("inline bar is capped at MAX_BAR_WIDTH on very wide sidebars", () => {
    expect(layoutBar(80, "5% left")).toEqual({ mode: "inline", barWidth: MAX_BAR_WIDTH })
    expect(layoutBar(10_000, "5% left")).toEqual({ mode: "inline", barWidth: MAX_BAR_WIDTH })
  })

  test("boundary: inline holds at exactly MIN_BAR_WIDTH, stacks one cell below", () => {
    // 15 - 8 - 1 = 6 = MIN_BAR_WIDTH → inline
    expect(layoutBar(15, "70% left")).toEqual({ mode: "inline", barWidth: MIN_BAR_WIDTH })
    // 14 - 8 - 1 = 5 < MIN_BAR_WIDTH → stacked, bar gets the full row
    expect(layoutBar(14, "70% left")).toEqual({ mode: "stacked", barWidth: 14 })
  })

  test("narrow stacked bars track the full width, clamped to ≥ 1", () => {
    expect(layoutBar(8, "100% left")).toEqual({ mode: "stacked", barWidth: 8 })
    expect(layoutBar(1, "100% left")).toEqual({ mode: "stacked", barWidth: 1 })
  })

  test("label length decides the breakpoint: wider labels stack sooner", () => {
    // "100% left" (9) needs 9 + 1 + 6 = 16 for inline
    expect(layoutBar(16, "100% left")).toEqual({ mode: "inline", barWidth: MIN_BAR_WIDTH })
    expect(layoutBar(15, "100% left")).toEqual({ mode: "stacked", barWidth: 15 })
  })
})

describe("formatResetLocal", () => {
  test("renders local ISO-style `YYYY-MM-DD HH:mm`", () => {
    process.env.TZ = "UTC"
    expect(formatResetLocal(Date.UTC(2026, 7, 24, 14, 30))).toBe("2026-08-24 14:30")
    expect(formatResetLocal(Date.UTC(2026, 7, 24, 0, 5))).toBe("2026-08-24 00:05")
    expect(formatResetLocal(Date.UTC(2026, 7, 28, 2, 20))).toBe("2026-08-28 02:20")
  })

  test("zero-pads month, day, hour and minute; rolls over year-end", () => {
    process.env.TZ = "UTC"
    expect(formatResetLocal(Date.UTC(2026, 0, 1, 2, 20))).toBe("2026-01-01 02:20")
    expect(formatResetLocal(Date.UTC(2026, 11, 31, 23, 59))).toBe("2026-12-31 23:59")
  })

  test("uses local wall-clock, not UTC", () => {
    process.env.TZ = "UTC"
    const instant = Date.UTC(2026, 7, 28, 2, 20)
    expect(formatResetLocal(instant)).toBe("2026-08-28 02:20")
    process.env.TZ = "America/New_York" // UTC-4 in August
    expect(formatResetLocal(instant)).toBe("2026-08-27 22:20")
    process.env.TZ = "UTC"
  })

  test("returns empty string for invalid timestamps", () => {
    expect(formatResetLocal(NaN)).toBe("")
    expect(formatResetLocal(Infinity)).toBe("")
  })
})

describe("friendlyPlanName", () => {
  test("known plan_type values map to friendly ChatGPT names", () => {
    expect(friendlyPlanName("plus")).toBe("ChatGPT Plus")
    expect(friendlyPlanName("pro")).toBe("ChatGPT Pro")
    expect(friendlyPlanName("free")).toBe("ChatGPT Free")
    expect(friendlyPlanName("go")).toBe("ChatGPT Go")
    expect(friendlyPlanName("team")).toBe("ChatGPT Team")
    expect(friendlyPlanName("business")).toBe("ChatGPT Business")
    expect(friendlyPlanName("enterprise")).toBe("ChatGPT Enterprise")
  })

  test("normalizes case, separators and an existing chatgpt prefix", () => {
    expect(friendlyPlanName("PLUS")).toBe("ChatGPT Plus")
    expect(friendlyPlanName(" plus ")).toBe("ChatGPT Plus")
    expect(friendlyPlanName("chatgpt_pro")).toBe("ChatGPT Pro")
    expect(friendlyPlanName("ChatGPT-Pro")).toBe("ChatGPT Pro")
  })

  test("unknown values are title-cased with the ChatGPT prefix", () => {
    expect(friendlyPlanName("trial")).toBe("ChatGPT Trial")
    expect(friendlyPlanName("pro_max")).toBe("ChatGPT Pro Max")
  })

  test("missing, blank or non-string values return null (UI omits the row)", () => {
    expect(friendlyPlanName(undefined)).toBeNull()
    expect(friendlyPlanName(null)).toBeNull()
    expect(friendlyPlanName("")).toBeNull()
    expect(friendlyPlanName("   ")).toBeNull()
    expect(friendlyPlanName(42)).toBeNull()
  })
})

describe("formatAge", () => {
  test("compact durations", () => {
    expect(formatAge(5 * 60_000)).toBe("5m")
    expect(formatAge(30_000)).toBe("1m") // minimum 1m
    expect(formatAge(2 * 3_600_000)).toBe("2h")
    expect(formatAge(125 * 60_000)).toBe("2h 5m")
  })
})

describe("staleness", () => {
  const base = { fetchedAt: 1_000_000 }

  test("fresh within 15 minutes", () => {
    expect(staleness(base, base.fetchedAt + 10 * 60_000)).toBe("fresh")
    expect(staleness(base, base.fetchedAt + STALE_MS)).toBe("fresh")
  })

  test("stale after 15 minutes", () => {
    expect(staleness(base, base.fetchedAt + STALE_MS + 1)).toBe("stale")
    expect(staleness(base, base.fetchedAt + 60 * 60_000)).toBe("stale")
  })

  test("failed refresh forces stale even when young", () => {
    expect(staleness({ fetchedAt: base.fetchedAt, refreshError: { message: "x" } }, base.fetchedAt + 1_000)).toBe(
      "stale",
    )
  })
})

describe("secondsUntil", () => {
  test("ceil, never negative", () => {
    expect(secondsUntil(10_500, 10_000)).toBe(1)
    expect(secondsUntil(10_000, 10_000)).toBe(0)
    expect(secondsUntil(9_000, 10_000)).toBe(0)
  })
})
