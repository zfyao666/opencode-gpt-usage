import { describe, expect, test } from "bun:test"
import {
  clampPct,
  formatAge,
  formatBar,
  formatResetLocal,
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

describe("formatResetLocal", () => {
  test("renders local HH:MM", () => {
    process.env.TZ = "UTC"
    expect(formatResetLocal(Date.UTC(2026, 7, 24, 14, 30))).toBe("14:30")
    expect(formatResetLocal(Date.UTC(2026, 7, 24, 0, 5))).toBe("00:05")
  })

  test("returns empty string for invalid timestamps", () => {
    expect(formatResetLocal(NaN)).toBe("")
    expect(formatResetLocal(Infinity)).toBe("")
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
