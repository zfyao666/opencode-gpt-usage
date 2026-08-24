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

> **Attribution:** this is a private, MIT-licensed reimplementation of the
> ChatGPT/Codex integration from
> [satas20/opencode-usage-bar](https://github.com/satas20/opencode-usage-bar)
> (MIT, Copyright (c) 2026 satas20) — same credentials and usage endpoint,
> different UI and state handling. See `LICENSE`.

## Install

Not published (`"private": true`), so activate it as a local TUI plugin.
Build first:

```sh
bun install
bun run build    # emits dist/index.js (self-contained, only opencode-runtime deps external)
```

Then add the built file to `~/.config/opencode/tui.json`:

```jsonc
{
  "plugin": [
    "...existing plugins...",
    "/home/zfyao/opencode-gpt-usage/dist/index.js"
  ]
}
```

Restart opencode. The card appears in the right sidebar of any session.

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
`~/.codex/auth.json`. If the credentials are missing or rejected, the card
shows `WEEKLY · unavailable` with `run codex login` and keeps retrying with
backoff. No config file needed; nothing is written by the plugin.

## Develop

```sh
bun install
bun run typecheck   # tsc over src + test
bun test            # bun:test — weekly selection, remaining/clamp, auth, staleness
bun run build       # bun build.ts && tsc → dist/
```

The logic is split into pure, tested modules (`src/auth.ts`, `src/wham.ts`,
`src/format.ts`); `src/index.tsx` only wires them to the TUI slot.

## License

MIT — see `LICENSE`. Upstream: [satas20/opencode-usage-bar](https://github.com/satas20/opencode-usage-bar) (MIT).
