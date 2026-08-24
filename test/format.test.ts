import { describe, expect, test } from "bun:test"
import {
  clampPct,
  formatBar,
  formatResetLocal,
  friendlyPlanName,
  staleness,
  STALE_MS,
} from "../src/format"

process.env.TZ = "UTC"

describe("clampPct", () => {
  test("clamps to 0–100 and rounds; non-finite → 0", () => {
    expect(clampPct(12.4)).toBe(12)
    expect(clampPct(12.6)).toBe(13)
    expect(clampPct(150)).toBe(100)
    expect(clampPct(-5)).toBe(0)
    expect(clampPct(NaN)).toBe(0)
    expect(clampPct(Infinity)).toBe(0)
  })
})

describe("formatBar", () => {
  test("fills by remaining share; width clamped to 1–40", () => {
    expect(formatBar(70, 10)).toBe("▓▓▓▓▓▓▓░░░")
    expect(formatBar(35, 6)).toBe("▓▓░░░░")
    expect(formatBar(0, 10)).toBe("░░░░░░░░░░")
    expect(formatBar(100, 10)).toBe("▓▓▓▓▓▓▓▓▓▓")
    expect(formatBar(50, 0)).toBe("▓")
    expect(formatBar(50, 99)).toHaveLength(40)
    expect(formatBar(NaN, 10)).toBe("░░░░░░░░░░")
  })
})

describe("formatResetLocal", () => {
  test("renders local ISO-style YYYY-MM-DD HH:mm, zero-padded; '' for invalid", () => {
    process.env.TZ = "UTC"
    expect(formatResetLocal(Date.UTC(2026, 7, 28, 2, 20))).toBe("2026-08-28 02:20")
    expect(formatResetLocal(Date.UTC(2026, 11, 31, 23, 59))).toBe("2026-12-31 23:59")
    expect(formatResetLocal(NaN)).toBe("")
  })
})

describe("friendlyPlanName", () => {
  test("known plan types map to friendly ChatGPT names; missing/blank → null", () => {
    expect(friendlyPlanName("plus")).toBe("ChatGPT Plus")
    expect(friendlyPlanName("chatgpt_pro")).toBe("ChatGPT Pro")
    expect(friendlyPlanName("free")).toBe("ChatGPT Free")
    expect(friendlyPlanName("mega_plan")).toBe("ChatGPT Mega Plan")
    expect(friendlyPlanName("")).toBeNull()
    expect(friendlyPlanName("  ")).toBeNull()
    expect(friendlyPlanName(undefined)).toBeNull()
  })
})

describe("staleness", () => {
  test("fresh within 15 min, stale after", () => {
    const snap = { fetchedAt: 1_000_000 }
    expect(staleness(snap, snap.fetchedAt + 10 * 60_000)).toBe("fresh")
    expect(staleness(snap, snap.fetchedAt + STALE_MS)).toBe("fresh")
    expect(staleness(snap, snap.fetchedAt + STALE_MS + 1)).toBe("stale")
  })

  test("failed refresh forces stale even when young", () => {
    expect(staleness({ fetchedAt: 1_000_000, refreshError: { message: "x" } }, 1_001_000)).toBe(
      "stale",
    )
  })
})
