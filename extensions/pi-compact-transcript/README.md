# PiAstra compact transcript (vendored fork)

PiAstra-managed fork of [pi-compact-transcript](https://github.com/avhagedorn/pi-compact-transcript) **0.10.1**
(MIT, © Alan Hagedorn <avhagedorn@gmail.com>; original license retained in [LICENSE](./LICENSE)).
Display-only extension: tool execution is still handled by pi and other extensions.

This repository vendors the upstream extension instead of installing the npm
package so the fork's PiAstra-specific render/expansion rules can evolve with the
`delegate` tool without a separate release. The installer/launcher loads this
copy; do not install the upstream package alongside it.

## Fork changes (vs upstream 0.10.1)

- **`delegate` always uses the native rich renderer, fully expanded.** PiAstra
  delegation rows are never compacted into one-line previews, never hidden, and
  never grouped into bursts, even while ordinary tools are collapsed. The rich
  worker preview remains bounded by the tool's own renderer (upstream behavior
  of `delegate`'s `renderResult` on expanded paths).
- **A single persisted global compact setting.** `/compact-transcript on|off`
  writes `enabled` into the user-wide `~/.pi/agent/compact-transcript.json`
  (other fields preserved). Ordinary tools (`inspect_git`, `grep`, `bash`, …)
  follow this setting across sessions; legacy session-branch
  `compact-transcript-config` entries no longer override the enabled state,
  while their `summaryStyle`/`highlightToolActions` preferences still merge.
  Trusted-project config still overrides the user-wide file as before.
- **Expansion toggle is driven by a cross-extension event, not a registered
  shortcut.** pi's extension runner reserves `app.tools.expand` (`ctrl+o`) and
  silently skips extension shortcut overrides, so this fork does not call
  `registerShortcut`. Instead it listens on the shared extension event bus for
  `piastra:compact-transcript:toggle`: the sender emits a mutable envelope
  `{ handled: false, ctx }` via `pi.events.emit(...)`; when compact mode is on,
  the plugin synchronously flips its per-session expansion state and sets
  `envelope.handled = true` (sender must then NOT run pi's native expand
  toggle). When compact is off the envelope stays unclaimed and pi's native
  `ctrl+o` (app.tools.expand) controls expanded rendering directly.
  Every session still starts with ordinary tool output collapsed (per-session
  initial state), regardless of pi's inherited `toolOutputExpanded` state from
  a previous session — no forcibly expanded scrollback after `/resume`, `/tree`
  or worktree switches; deliberate expansion works in both compact and
  non-compact settings and is never permanently locked.

Everything else (commentary rail, burst grouping, write/edit stats, run
summary, thinking ticker, `/compact-transcript` command and legacy aliases) is
unchanged from upstream.

## Source layout

- `extensions/compact-transcript.ts` — the forked extension (header comment
  records the fork provenance).
- `index.ts` — auto-discovery entry point re-exporting the extension default.
- `compact-transcript.test.mjs` — unit tests against the real
  `ToolExecutionComponent` (`node --experimental-strip-types --test`).

## Configuration example (`~/.pi/agent/compact-transcript.json`)

```json
{
  "enabled": true,
  "summaryStyle": "plain",
  "highlightToolActions": false
}
```
