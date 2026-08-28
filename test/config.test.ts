import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { CONFIG_FILE_NAME, DEFAULTS, defaultConfigPath, loadConfig, parseOptions } from "../src/config"

const DEFAULT_AUTH_FILE = join(
  process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"),
  "opencode",
  "auth.json",
)

describe("parseOptions — defaults", () => {
  test("undefined / null / non-object input yields every default", () => {
    for (const raw of [undefined, null, 0, "nope", true, [], [1, 2]]) {
      expect(parseOptions(raw)).toEqual(DEFAULTS)
    }
  })

  test("empty object yields every default", () => {
    expect(parseOptions({})).toEqual(DEFAULTS)
  })

  test("defaults use OpenCode's auth store", () => {
    expect(DEFAULTS).toEqual({
      pollMs: 120_000,
      staleMs: 15 * 60 * 1000,
      retryMaxMs: 120_000,
      authFile: DEFAULT_AUTH_FILE,
      cardTitle: "OpenCode GPT Usage",
    })
  })
})

describe("parseOptions — valid overrides", () => {
  test("applies every exposed option", () => {
    const cfg = parseOptions({
      pollMs: 60_000,
      staleMs: 5 * 60 * 1000,
      retryMaxMs: 300_000,
      authFile: "/tmp/creds.json",
      cardTitle: "My Quota",
    })
    expect(cfg).toEqual({
      pollMs: 60_000,
      staleMs: 300_000,
      retryMaxMs: 300_000,
      authFile: "/tmp/creds.json",
      cardTitle: "My Quota",
    })
  })

  test("partial objects keep defaults for the untouched keys", () => {
    expect(parseOptions({ pollMs: 30_000 })).toEqual({
      ...DEFAULTS,
      pollMs: 30_000,
    })
    expect(parseOptions({ cardTitle: "Tight" })).toEqual({
      ...DEFAULTS,
      cardTitle: "Tight",
    })
  })

  test("boundary values inside the conservative bounds are accepted", () => {
    const cfg = parseOptions({
      pollMs: 5_000, // min
      staleMs: 86_400_000, // max
      retryMaxMs: 10_000, // min (== fixed initial retry delay)
      authFile: "/a",
      cardTitle: "x".repeat(40), // max length
    })
    expect(cfg.pollMs).toBe(5_000)
    expect(cfg.staleMs).toBe(86_400_000)
    expect(cfg.retryMaxMs).toBe(10_000)
    expect(cfg.authFile).toBe("/a")
    expect(cfg.cardTitle).toHaveLength(40)
  })

  test("strings are trimmed before use; unknown keys are ignored", () => {
    const cfg = parseOptions({
      cardTitle: "  Padded Title  ",
      pollMs: "120000", // wrong type → default
      unrelated: { anything: true },
    })
    expect(cfg.cardTitle).toBe("Padded Title")
    expect(cfg.pollMs).toBe(DEFAULTS.pollMs)
  })
})

describe("parseOptions — invalid fallbacks", () => {
  test("non-finite / non-number ms values fall back per key", () => {
    const bad = [NaN, Infinity, -Infinity, "120000", null, true, {}, [], 120_000.5, undefined]
    for (const v of bad) {
      expect(parseOptions({ pollMs: v }).pollMs).toBe(DEFAULTS.pollMs)
      expect(parseOptions({ staleMs: v }).staleMs).toBe(DEFAULTS.staleMs)
      expect(parseOptions({ retryMaxMs: v }).retryMaxMs).toBe(DEFAULTS.retryMaxMs)
    }
  })

  test("ms values outside the conservative bounds fall back per key", () => {
    expect(parseOptions({ pollMs: 4_999 }).pollMs).toBe(DEFAULTS.pollMs) // < 5 s
    expect(parseOptions({ pollMs: 3_600_001 }).pollMs).toBe(DEFAULTS.pollMs) // > 1 h
    expect(parseOptions({ pollMs: 0 }).pollMs).toBe(DEFAULTS.pollMs)
    expect(parseOptions({ pollMs: -5_000 }).pollMs).toBe(DEFAULTS.pollMs)
    expect(parseOptions({ staleMs: 59_999 }).staleMs).toBe(DEFAULTS.staleMs)
    expect(parseOptions({ staleMs: 86_400_001 }).staleMs).toBe(DEFAULTS.staleMs)
    expect(parseOptions({ retryMaxMs: 9_999 }).retryMaxMs).toBe(DEFAULTS.retryMaxMs)
    expect(parseOptions({ retryMaxMs: 3_600_001 }).retryMaxMs).toBe(DEFAULTS.retryMaxMs)
  })

  test("invalid authFile falls back to the default path", () => {
    const bad = ["", "   ", "relative/path.json", "~/creds.json", 42, null, "x".repeat(4097)]
    for (const v of bad) {
      expect(parseOptions({ authFile: v }).authFile).toBe(DEFAULT_AUTH_FILE)
    }
    // Absolute but valid → accepted (overriding path is intentional).
    expect(parseOptions({ authFile: "/home/u/.codex/auth.json" }).authFile).toBe(
      "/home/u/.codex/auth.json",
    )
  })

  test("invalid cardTitle falls back to the default title", () => {
    const bad = ["", "   ", 42, null, {}, "x".repeat(41)]
    for (const v of bad) {
      expect(parseOptions({ cardTitle: v }).cardTitle).toBe(DEFAULTS.cardTitle)
    }
  })
})

describe("loadConfig — file loading (temp dirs, never the real config)", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gpt-usage-config-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const cfgPath = () => join(dir, CONFIG_FILE_NAME)

  test("missing file yields exactly the defaults", async () => {
    expect(await loadConfig(cfgPath())).toEqual(DEFAULTS)
    expect(await loadConfig(join(dir, "does-not-exist.json"))).toEqual(DEFAULTS)
  })

  test("unreadable path (a directory) yields exactly the defaults", async () => {
    expect(await loadConfig(dir)).toEqual(DEFAULTS)
  })

  test("malformed JSON yields exactly the defaults", async () => {
    const bad = [
      "{ this is not json",
      '{"pollMs": 60000,}', // trailing comma — strict JSON rejects it
      '{"pollMs": 60000 /* comment */}',
      "",
      "   ",
    ]
    for (const body of bad) {
      await writeFile(cfgPath(), body)
      expect(await loadConfig(cfgPath())).toEqual(DEFAULTS)
    }
  })

  test("valid JSON with the wrong shape yields defaults", async () => {
    for (const body of ["[]", '"text"', "42", "null", "true"]) {
      await writeFile(cfgPath(), body)
      expect(await loadConfig(cfgPath())).toEqual(DEFAULTS)
    }
  })

  test("valid full override file is applied", async () => {
    await writeFile(
      cfgPath(),
      JSON.stringify({
        pollMs: 60_000,
        staleMs: 300_000,
        retryMaxMs: 300_000,
        authFile: "/tmp/creds.json",
        cardTitle: "My Quota",
      }),
    )
    expect(await loadConfig(cfgPath())).toEqual({
      pollMs: 60_000,
      staleMs: 300_000,
      retryMaxMs: 300_000,
      authFile: "/tmp/creds.json",
      cardTitle: "My Quota",
    })
  })

  test("partial file: overrides applied, missing keys default", async () => {
    await writeFile(cfgPath(), JSON.stringify({ pollMs: 30_000 }))
    expect(await loadConfig(cfgPath())).toEqual({ ...DEFAULTS, pollMs: 30_000 })
  })

  test("invalid values in an otherwise valid file fall back per key", async () => {
    await writeFile(
      cfgPath(),
      JSON.stringify({
        pollMs: 1, // below the 5 s floor
        staleMs: "soon", // wrong type
        retryMaxMs: 9_999, // below the 10 s floor
        authFile: "relative.json", // not absolute
        cardTitle: "   ", // blank after trim
      }),
    )
    expect(await loadConfig(cfgPath())).toEqual(DEFAULTS)
  })
})

describe("defaultConfigPath — derived from the process home config dir", () => {
  test("defaults to ~/.config/opencode/gpt-usage.json", () => {
    const prev = process.env.XDG_CONFIG_HOME
    try {
      delete process.env.XDG_CONFIG_HOME
      expect(defaultConfigPath()).toBe(join(homedir(), ".config", "opencode", CONFIG_FILE_NAME))
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
    }
  })

  test("honors XDG_CONFIG_HOME when set", () => {
    const prev = process.env.XDG_CONFIG_HOME
    try {
      process.env.XDG_CONFIG_HOME = "/tmp/xdg-cfg"
      expect(defaultConfigPath()).toBe(join("/tmp/xdg-cfg", "opencode", CONFIG_FILE_NAME))
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prev
    }
  })
})
