import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

/**
 * Plugin configuration, loaded ONCE at startup from a dedicated standard
 * JSON file next to opencode's own config directory:
 * `~/.config/opencode/gpt-usage.json` — derived from the process home
 * config directory (honoring `XDG_CONFIG_HOME` when set).
 *
 * The file is strict standard JSON (`JSON.parse`): no comments, no
 * trailing commas. A missing, unreadable or malformed file safely yields
 * exactly the defaults below; per-key validation means an invalid value
 * only resets its own key. The plugin never writes this file and never
 * reads anything but the validated values.
 */
export const CONFIG_FILE_NAME = "gpt-usage.json"

/** Options accepted in `gpt-usage.json`; every key is optional. */
export type GptUsageOptions = {
  /** ms between automatic usage refreshes (default 120 000 = 2 min). */
  pollMs?: unknown
  /** ms after which a snapshot is shown as stale (default 900 000 = 15 min). */
  staleMs?: unknown
  /** upper bound for the exponential retry backoff in ms (default 120 000). */
  retryMaxMs?: unknown
  /** absolute path to the OpenCode or Codex credentials file. */
  authFile?: unknown
  /** card title shown in every state (default "OpenCode GPT Usage"). */
  cardTitle?: unknown
}

/** Fully resolved, validated plugin configuration. */
export type GptUsageConfig = {
  pollMs: number
  staleMs: number
  retryMaxMs: number
  authFile: string
  cardTitle: string
}

/** Defaults — exactly the pre-configuration behavior of the plugin. */
export const DEFAULTS: GptUsageConfig = {
  pollMs: 120_000,
  staleMs: 15 * 60 * 1000,
  retryMaxMs: 120_000,
  authFile: defaultOpenCodeAuthPath(),
  cardTitle: "OpenCode GPT Usage",
}

/** OpenCode's auth store: `$XDG_DATA_HOME/opencode/auth.json`, or the Linux default. */
function defaultOpenCodeAuthPath(): string {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.trim() ? xdg.trim() : join(homedir(), ".local", "share")
  return join(base, "opencode", "auth.json")
}

/**
 * Default config file path for this installation: the process home config
 * directory (`$XDG_CONFIG_HOME` or `~/.config`) plus `opencode/` and the
 * config file name — i.e. `~/.config/opencode/gpt-usage.json`.
 */
export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() ? xdg.trim() : join(homedir(), ".config")
  return join(base, "opencode", CONFIG_FILE_NAME)
}

/**
 * Conservative, hard-coded bounds. These are NOT configuration: they keep
 * a bad value from breaking the card (e.g. a poll of 1 ms would hammer the
 * wham endpoint, a 0-ms stale threshold would flag every snapshot stale).
 */
const POLL_MS_MIN = 5_000 // 5 s — never poll faster than this
const POLL_MS_MAX = 3_600_000 // 1 h
const STALE_MS_MIN = 60_000 // 1 min
const STALE_MS_MAX = 86_400_000 // 24 h
/** Never below the fixed 10 s initial retry delay, so backoff stays bounded. */
const RETRY_MAX_MS_MIN = 10_000
const RETRY_MAX_MS_MAX = 3_600_000 // 1 h
const CARD_TITLE_MAX_LENGTH = 40
const AUTH_FILE_MAX_LENGTH = 4096

/** Safe finite integer ms within [min, max]; anything else → fallback. */
function finiteMs(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fallback
  if (value < min || value > max) return fallback
  return value
}

/**
 * Nonempty trimmed string within [1, maxLength]; anything else → fallback.
 * The accepted value is trimmed before use. `authFile` additionally has to
 * be an absolute path — a relative path would resolve against opencode's
 * working directory, which no caller can rely on.
 */
function nonemptyString(
  value: unknown,
  maxLength: number,
  fallback: string,
  absolute = false,
): string {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return fallback
  if (absolute && !isAbsolute(trimmed)) return fallback
  return trimmed
}

/**
 * Validate the raw parsed config into a fully resolved config. Unknown
 * keys are ignored; invalid values independently fall back to that key's
 * default, so a single bad field never disables the rest of the config.
 */
export function parseOptions(raw: unknown): GptUsageConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULTS }
  const o = raw as Record<string, unknown>
  return {
    pollMs: finiteMs(o.pollMs, POLL_MS_MIN, POLL_MS_MAX, DEFAULTS.pollMs),
    staleMs: finiteMs(o.staleMs, STALE_MS_MIN, STALE_MS_MAX, DEFAULTS.staleMs),
    retryMaxMs: finiteMs(o.retryMaxMs, RETRY_MAX_MS_MIN, RETRY_MAX_MS_MAX, DEFAULTS.retryMaxMs),
    authFile: nonemptyString(o.authFile, AUTH_FILE_MAX_LENGTH, DEFAULTS.authFile, true),
    cardTitle: nonemptyString(o.cardTitle, CARD_TITLE_MAX_LENGTH, DEFAULTS.cardTitle),
  }
}

/**
 * Load and validate the config file once at plugin startup. Strict JSON
 * via `JSON.parse` (comments/trailing commas are syntax errors). Any
 * failure — missing file, unreadable file, malformed JSON, non-object
 * content — returns exactly the defaults; valid content is validated
 * per key via `parseOptions`.
 */
export async function loadConfig(path: string = defaultConfigPath()): Promise<GptUsageConfig> {
  try {
    const raw = await readFile(path, "utf8")
    return parseOptions(JSON.parse(raw))
  } catch {
    return { ...DEFAULTS }
  }
}
