import { describe, expect, test } from "bun:test"
import {
  createRetryBackoff,
  outcomeToFailure,
  planRefresh,
} from "../src/refresh"
import type { UsageOutcome } from "../src/codex-usage"
import type { UsageSnapshot } from "../src/types"

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0)

const available = (
  over: Partial<UsageSnapshot> = {},
): Extract<UsageOutcome, { state: "available" }> => ({
  state: "available",
  weekly: {
    usedPercent: 65,
    remaining: 35,
    resetsAt: NOW + 86_400_000,
    limitWindowSeconds: 7 * 24 * 60 * 60,
  },
  ...over,
})

const snapshot = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  usedPercent: 65,
  remaining: 35,
  resetsAt: NOW + 86_400_000,
  limitWindowSeconds: 7 * 24 * 60 * 60,
  fetchedAt: NOW - 60_000,
  ...over,
})

describe("outcomeToFailure — UI result → failure mapping", () => {
  test("maps every failure state to the exact kind and copy", () => {
    expect(outcomeToFailure({ state: "login-required" })).toEqual({
      kind: "auth",
      message: "codex login required — run `codex login`",
    })
    expect(outcomeToFailure({ state: "unauthorized" })).toEqual({
      kind: "auth",
      message: "auth rejected — run `codex login`",
    })
    expect(outcomeToFailure({ state: "http", status: 503 })).toEqual({
      kind: "http",
      message: "usage endpoint error (HTTP 503)",
    })
    expect(outcomeToFailure({ state: "network" })).toEqual({
      kind: "network",
      message: "network error — retrying",
    })
    expect(outcomeToFailure({ state: "invalid-or-no-weekly" })).toEqual({
      kind: "no-window",
      message: "no weekly usage window from API",
    })
  })
})

describe("planRefresh — success path", () => {
  test("available → fresh data snapshot, poll delay, backoff reset", () => {
    const plan = planRefresh({
      outcome: available(),
      previous: snapshot(),
      now: NOW,
      pollMs: 120_000,
      backoffDelayMs: 40_000,
    })
    expect(plan).toEqual({
      view: { kind: "data", snapshot: { ...available().weekly, fetchedAt: NOW } },
      nextDelayMs: 120_000,
      backoffReset: true,
    })
  })
})

describe("planRefresh — failure paths", () => {
  test("failure without a previous snapshot → error card with retryAt", () => {
    const plan = planRefresh({
      outcome: { state: "login-required" },
      previous: undefined,
      now: NOW,
      pollMs: 120_000,
      backoffDelayMs: 10_000,
    })
    expect(plan).toEqual({
      view: {
        kind: "error",
        error: {
          kind: "auth",
          message: "codex login required — run `codex login`",
          retryAt: NOW + 10_000,
        },
      },
      nextDelayMs: 10_000,
      backoffReset: false,
    })
  })

  test("failure with a previous snapshot → stale-last-good data view (refreshError tagged)", () => {
    const previous = snapshot({ fetchedAt: NOW - 60_000 })
    const plan = planRefresh({
      outcome: { state: "http", status: 429 },
      previous,
      now: NOW,
      pollMs: 120_000,
      backoffDelayMs: 20_000,
    })
    expect(plan.backoffReset).toBe(false)
    expect(plan.nextDelayMs).toBe(20_000)
    if (plan.view.kind !== "data") throw new Error("expected stale data view")
    expect(plan.view.snapshot.usedPercent).toBe(previous.usedPercent)
    expect(plan.view.snapshot.fetchedAt).toBe(previous.fetchedAt)
    expect(plan.view.snapshot.refreshError).toEqual({
      kind: "http",
      message: "usage endpoint error (HTTP 429)",
      retryAt: NOW + 20_000,
    })
  })

  test("network and no-window outcomes carry their exact copy", () => {
    const network = planRefresh({
      outcome: { state: "network" },
      previous: undefined,
      now: NOW,
      pollMs: 120_000,
      backoffDelayMs: 10_000,
    })
    if (network.view.kind !== "error") throw new Error("expected error view")
    expect(network.view.error.message).toBe("network error — retrying")

    const noWindow = planRefresh({
      outcome: { state: "invalid-or-no-weekly" },
      previous: undefined,
      now: NOW,
      pollMs: 120_000,
      backoffDelayMs: 10_000,
    })
    if (noWindow.view.kind !== "error") throw new Error("expected error view")
    expect(noWindow.view.error.kind).toBe("no-window")
    expect(noWindow.view.error.message).toBe("no weekly usage window from API")
  })
})

describe("createRetryBackoff — bounded exponential backoff", () => {
  test("advances by doubling up to the cap, reset restores the base", () => {
    const backoff = createRetryBackoff(1, 8)
    expect(backoff.current()).toBe(1)
    backoff.advance()
    expect(backoff.current()).toBe(2)
    backoff.advance()
    expect(backoff.current()).toBe(4)
    backoff.advance()
    expect(backoff.current()).toBe(8)
    backoff.advance()
    expect(backoff.current()).toBe(8) // capped
    backoff.reset()
    expect(backoff.current()).toBe(1)
  })

  test("mirrors the production policy: 10 s base, 120 s cap", () => {
    const backoff = createRetryBackoff(10_000, 120_000)
    const sequence: number[] = []
    for (let i = 0; i < 6; i++) {
      sequence.push(backoff.current())
      backoff.advance()
    }
    expect(sequence).toEqual([10_000, 20_000, 40_000, 80_000, 120_000, 120_000])
  })
})

describe("refresh loop characterization — failures then success", () => {
  test("schedules growing retries, then resets to the poll interval on success", () => {
    const backoff = createRetryBackoff(10_000, 120_000)
    const outcomes: UsageOutcome[] = [
      { state: "login-required" },
      { state: "http", status: 500 },
      { state: "network" },
      available(),
    ]

    const delays: number[] = []
    const views: string[] = []
    let lastGood: UsageSnapshot | undefined = undefined

    for (const outcome of outcomes) {
      const plan = planRefresh({
        outcome,
        previous: lastGood,
        now: NOW,
        pollMs: 120_000,
        backoffDelayMs: backoff.current(),
      })
      views.push(plan.view.kind === "data" ? "data" : "error")
      if (plan.backoffReset) backoff.reset()
      else backoff.advance()
      delays.push(plan.nextDelayMs)
      if (plan.view.kind === "data") lastGood = plan.view.snapshot
    }

    // login → error (10 s), http → error (20 s), network → error (40 s),
    // success → data, next refresh at the poll interval.
    expect(views).toEqual(["error", "error", "error", "data"])
    expect(delays).toEqual([10_000, 20_000, 40_000, 120_000])
    expect(backoff.current()).toBe(10_000) // reset by the success
  })

  test("stale-last-good: failures after a success keep the last snapshot tagged", () => {
    const backoff = createRetryBackoff(10_000, 120_000)
    const first = planRefresh({
      outcome: available(),
      previous: undefined,
      now: NOW,
      pollMs: 120_000,
      backoffDelayMs: backoff.current(),
    })
    backoff.reset()
    const lastGood = first.view.kind === "data" ? first.view.snapshot : undefined
    expect(lastGood).toBeDefined()

    const failed = planRefresh({
      outcome: { state: "network" },
      previous: lastGood,
      now: NOW + 5_000,
      pollMs: 120_000,
      backoffDelayMs: backoff.current(),
    })
    if (failed.view.kind !== "data") throw new Error("expected stale data view")
    expect(failed.view.snapshot.refreshError?.retryAt).toBe(NOW + 15_000)
    expect(failed.view.snapshot.fetchedAt).toBe(lastGood!.fetchedAt)
  })
})
