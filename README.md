# opencode-gpt-usage

ChatGPT (Codex) weekly quota card for the opencode TUI right sidebar
(`sidebar_content` slot). Reads `~/.codex/auth.json` and shows the ~7-day
weekly window from `chatgpt.com/backend-api/wham/usage`:

```
┌ WEEKLY ──────────┐
│ ▓▓▓▓▓▓▓░░░ 70% left │
│ resets 14:30        │
└─────────────────────┘
```

- **Fresh** data (fetched immediately, then every 120 s): green/amber/red bar
  by remaining share (≥50 / ≥15 / <15 % left).
- **Stale** (age > 15 min, or a refresh failed): `WEEKLY · stale` with the
  data age and retry countdown — stale data is never shown as fresh.
- **Error** (auth/network/HTTP): `WEEKLY · unavailable` with the reason and a
  bounded exponential retry (10 s → 120 s max). Auth errors say
  `run codex login`; no OAuth refresh endpoint is invented.
- The weekly window is selected by `limit_window_seconds` (~7 days), never
  merely by primary/secondary position.
- Tokens are sent only to `chatgpt.com` and are never logged.

## Install

Not published (`"private": true`), so activate it as a local TUI plugin.
Build first:

```sh
bun install
bun run build    # emits dist/index.js (self-contained, only opencode-runtime deps external)
```

Then register the built file in `~/.config/opencode/tui.json` — a plain
string entry; `tui.json` only activates the plugin (see Configuration
below for where the options live):

```jsonc
{
  "plugin": [
    "...existing plugins...",
    "/home/zfyao/opencode-gpt-usage/dist/index.js"
  ]
}
```

Restart opencode. The card appears in the right sidebar of any session.

### Configuration

Options live in a dedicated standard JSON file next to opencode's own
config: `~/.config/opencode/gpt-usage.json` (derived from the process home
config directory; `$XDG_CONFIG_HOME` is honored when set). On this machine
that is `/root/.config/opencode/gpt-usage.json`.

The file is read **once at plugin startup** — edit it and fully restart
opencode to apply changes. The plugin never writes it.

`tui.json` only registers the plugin (path string above); it carries no
options.

Full-default template (no tokens — just the five keys at their defaults):

```json
{
  "pollMs": 120000,
  "staleMs": 900000,
  "retryMaxMs": 120000,
  "authFile": "/root/.codex/auth.json",
  "cardTitle": "OpenCode GPT Usage"
}
```

Strict standard JSON (`JSON.parse`): no comments, no trailing commas — a
malformed file is ignored entirely.

Every key is optional; every value is validated with conservative bounds,
and any missing or invalid value independently falls back to its default
(unknown keys are ignored). A missing, unreadable or malformed file yields
exactly the defaults below.

| Option       | Default                       | Bounds                          | Meaning                                   |
| ------------ | ----------------------------- | ------------------------------- | ----------------------------------------- |
| `pollMs`     | `120000` (2 min)              | `5000` – `3600000` (5 s – 1 h)  | ms between automatic usage refreshes      |
| `staleMs`    | `900000` (15 min)             | `60000` – `86400000` (1 min – 1 d) | ms after which data is shown as stale   |
| `retryMaxMs` | `120000` (2 min)              | `10000` – `3600000` (10 s – 1 h) | cap for the exponential retry backoff    |
| `authFile`   | `~/.codex/auth.json`          | absolute path, ≤ 4096 chars     | Codex credentials file to read            |
| `cardTitle`  | `"OpenCode GPT Usage"`        | 1–40 chars (trimmed)            | card title shown in every state           |

Example with overrides:

```json
{
  "pollMs": 60000,
  "staleMs": 300000,
  "retryMaxMs": 300000,
  "authFile": "/home/you/.codex/auth.json",
  "cardTitle": "My GPT Quota"
}
```

Endpoint URL, weekly-window selection rules, fetch timeout, layout
measurement/bar widths, slot order and health thresholds are internal and
not configurable.

### Why not a `~/.config/opencode/plugins/` symlink?

Local files dropped into `~/.config/opencode/plugins/` are picked up **only by
the server plugin loader** (glob `{plugin,plugins}/*.{ts,js}`, so `.tsx` names
are not even scanned), and that loader requires a `server()` export — a TUI
module (`{ id, tui }`) is rejected with
`must default export an object with server()`. Verified empirically against
opencode 1.18.21: TUI plugin origins come exclusively from the `plugin` array
of `tui.json`. So the reliable activation is the `tui.json` entry above; a
plugins-directory symlink would either be inert (`.tsx`) or log load errors
(`.js`).

## Usage

Requires a Codex CLI login (`codex login`), which writes
`~/.codex/auth.json` (override the path via the `authFile` key in
`gpt-usage.json`). If the credentials are missing or rejected, the card
shows `WEEKLY · unavailable` with `run codex login` and keeps retrying with
backoff. No config file needed; nothing is written by the plugin.

## Develop

```sh
bun install
bun run typecheck   # tsc over src + test
bun test            # bun:test — config load/validation, weekly selection, remaining/clamp, auth, staleness
bun run build       # bun build.ts && tsc → dist/
```

The logic is split into pure, tested modules (`src/config.ts`,
`src/codex-usage.ts`, `src/format.ts`); `src/index.tsx` only wires them to
the TUI slot.

## License

MIT — see `LICENSE`.
