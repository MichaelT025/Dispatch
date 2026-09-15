# Dispatch editor shortcuts

Dispatch installs a small set of keyboard shortcuts by replacing pi's main input
editor with a `CustomEditor` subclass (`extensions/piastra/shortcuts.ts`). All
interception lives inside that editor's own `handleInput`, so nothing outside
the main editor is affected.

## Find help in the TUI

Run **`/dispatch-help`** for commands, shortcuts and practical tips, or
**`/dispatch-help shortcuts`** to open that section directly. This is a
read-only overlay: it never sends a prompt or appends to the conversation.

- Sections: **Up/Down** or **j/k**, **Enter/Right** to open.
- Reading: **Up/Down/j/k**, **PgUp/PgDn**, **Home/End** to scroll;
  **Enter/Right/Tab** next section, **Shift+Tab** previous, **Left/b** back.
- **Esc/Ctrl+C** closes from either view. Text wraps on narrow terminals.

The maintained Atelier footer appends `Tip: run /dispatch-help` immediately
after model/reasoning when Dispatch help is available. It is hidden if the
model segment is disabled, the terminal is too narrow, or Dispatch is absent.
Standalone Atelier/plain Pi never gains this hint from a legacy Agent status.
Re-run the managed installer and restart Pi to update installed copies.

`dispatch --help` (or `node bin/dispatch.mjs -h` from this checkout) provides
a short terminal overview without starting Pi. `dispatch setup` performs
explicit authentication/configuration, `dispatch` starts the CLI, and
`dispatch --web` starts the packaged WebUI in the foreground.

## Design constraints

- **No global config writes** — `keybindings.json` is never read or modified.
- **No global input listeners** — no `process.stdin` or TUI-wide listeners are
  registered; interception happens only while the main editor has focus.
- **No `registerShortcut` override** — pi's extension shortcut registry is left
  untouched. The existing `ctrl+shift+a` (cycle agent) and `ctrl+shift+w`
  (worker overlay) aliases keep working through pi's default
  `onExtensionShortcut` wiring, which `CustomEditor.handleInput` consults
  before anything else.
- **Overlays keep their own keys** — the worker viewer (`worker-view.ts`) and
  every `ctx.ui.custom()` dialog receive input while the main editor is
  unfocused, so its own Shift+Tab sibling navigation is preserved.

## Mappings

| Key | Effect |
| --- | --- |
| `Shift+Tab` | Cycle the primary Dispatch agents (orchestrator → general → fast → review) |
| `Ctrl+T` | Native `app.thinking.cycle` (cycle the thinking level) |
| `Ctrl+O` | Toggle tool output expansion — the compact-transcript plugin claims the toggle when compact mode is on; otherwise native `app.tools.expand` |
| `Ctrl+V` | Native clipboard paste — clipboard images show as `[Image #1]`, `[Image #2]`, … |
| `Alt+V` | Same native clipboard paste (fallback when the terminal intercepts `Ctrl+V`) |
| `Ctrl+X` | Arm the leader key for 2 seconds; a small hint (` x→ t y a w m `) appears on the editor border |
| `Ctrl+X` then `t` | Native `app.thinking.toggle` (collapse/expand thinking blocks) |
| `Ctrl+X` then `y` | Native `app.message.copy` (copy last assistant message) |
| `Ctrl+X` then `a` | Dispatch agent picker (same list as `/agent`) |
| `Ctrl+X` then `w` | Worker overlay (same view as `/workers`) |
| `Ctrl+X` then `m` | Native model picker (same as `Ctrl+L` / `/model`) |
| `Ctrl+X` then `Esc` | Cancel the leader without aborting the agent |
| `Ctrl+X` then other key | Disarm and fall through — the key does its normal thing |
| `Ctrl+X` then `Ctrl+X` | Rearm; the 2-second timer restarts |

The leader also disarms itself after 2 seconds, when the editor loses focus
(dialogs, overlays), and on session changes (`session_start`, `session_tree`,
`session_shutdown`).

`Shift+Tab` previously cycled the thinking level (`app.thinking.cycle`). That
native action is intentionally shadowed by agent cycling; the thinking level
is still available via `Ctrl+T` (`app.thinking.cycle`), while `Ctrl+X` then
`t` toggles the thinking display (`app.thinking.toggle`).

## Ctrl+O and the compact transcript

`Ctrl+O` is wired through an optional `toggleTools` shortcut action that answers
**synchronously** (the editor needs the handled flag before deciding on the
fallback):

1. The editor invokes `toggleTools(ctx)`, which `installShortcuts` implements by
   emitting a mutable envelope `{ handled: false, ctx }` on the shared extension
   event bus channel `piastra:compact-transcript:toggle`.
2. The compact-transcript plugin's listener runs synchronously inside `emit`
   and, only when compact mode is enabled, flips the per-session expansion
   state and sets `handled = true`.
3. Back in the editor: if the action returned `true`, nothing else happens. If
   it returned `false` (or the action is absent, throws, or the event bus is
   unavailable), the native `app.tools.expand` handler is invoked instead —
   falling back to plain editor input when that action id has no handler.

Errors from the action never escape input handling: they are surfaced through
`ctx.ui.notify` and treated as "not handled".

## Clipboard image paste (`Ctrl+V` / `Alt+V`)

Both keys invoke the same native clipboard paste path: ordinary text and
bracketed multiline pastes behave exactly as before, while a clipboard image
pastes as a compact `[Image #1]` placeholder. Each sequential clipboard paste
adds the next placeholder (`[Image #2]`, …) — numbering covers multiple
sequential clipboard pastes, not a simultaneous collection of clipboard
images. The original temporary image path stays registered and expands back
into the submitted text, matching Pi's native clipboard behavior. This does
not create an image attachment; the model receives the path and can use its
file-reading tools to inspect the image.

Caveat: Windows Terminal may intercept `Ctrl+V` for its own paste. Allow the
key through to pi or keep using `Alt+V`. No global `keybindings.json` writes
are involved — both bindings live inside the editor's own `handleInput`.

The placeholder adapter uses Pi's native paste registry (tested with Pi
0.84.4); if that registry API is unavailable, pastes fall back to raw paths.
An image marker cut off by the viewport on a very narrow terminal may show
part of its internal paste label until it is fully visible. Reload and draft
restoration preserve image paths, but may display the raw paths again.

## How native actions are invoked

When pi installs a custom editor, `setCustomEditorComponent` copies the app's
native action handlers into the editor's public `actionHandlers` map for any
editor that duck-types as a `CustomEditor`. Dispatch's editor therefore invokes
`app.thinking.cycle`, `app.thinking.toggle`, `app.message.copy` and
`app.model.select` **by action
id** from that map — `Ctrl+T` and the leader `t` deliberately hit different
action ids — instead of simulating raw keystrokes, so user keybinding
customisations and future pi changes keep working. If an action id has no
handler (for example in unit tests), the key falls back to normal editor
handling.

## Atelier cooperation and foreign editors

The **Dispatch-maintained Atelier fork** cooperates with these shortcuts. Enable
it with `npm run install:cli -- --atelier`, then restart Pi or `/reload`. Merely
editing this checkout does not update your installed extension copies. The
upstream npm Atelier editor does not implement this cooperation protocol.

`installShortcuts` captures `ctx.ui.getEditorComponent()` before installing
its own factory:

- **Dispatch's own factory** is rebuilt with fresh session context. Its previous
  instance is disposed, cancelling the leader and pending shortcut actions.
- **The fork's Atelier factory** publishes a version-1 `editorCapability` with
  ID `piastra.atelier-frame`. Dispatch preserves its frame presentation while
  creating a single `PiastraEditor`. If Dispatch starts first, its capability
  (`piastra.shortcuts`) lets Atelier compose the same frame onto that editor.
  The frame renders before the leader hint, so the hint stays visible.
- **Unrecognized foreign factories** are left untouched. Dispatch warns and
  skips installation; Atelier also declines to replace an unknown editor.

Factory capabilities provide `readPresentations`, and Dispatch additionally
provides `composePresentation` and `withoutPresentationsFor`. Entries carry a
session-owned token, chrome width, minimum width and rendering function. No
cross-package runtime imports, global input listeners or registry overrides
are needed. Repeated enable operations do not nest frames.

`/atelier disable` removes only its own frame, leaving shortcuts active;
`/atelier enable` restores it. Cleanup checks the current factory's ownership,
not a stale saved factory. Retired Dispatch factories cannot recreate an editor
after shutdown. Both startup orders and shutdown orders are tested.

The input component still inherits Pi's native submit, autocomplete, paste and
extension-shortcut wiring. Overlays receive their own input; blur cancels the
leader. This does not change the sidebar's scrolling behavior.

Errors from shortcut actions never escape input handling: they are reported
through `ctx.ui.notify`. In particular, cycling agents while the agent is busy
surfaces the guard message ("Wait for the current turn to finish…") instead of
switching.

## Worker viewer layout (`/workers`, `Ctrl+X` then `w`)

The worker overlay (`extensions/piastra/worker-view.ts`) keeps the selected
subagent's task prompt fully readable at the top and pushes identity info to
the bottom:

- **Pinned prompt (top)** — the full task text, word-wrapped inside a padded
  panel using the theme's user-message background, with a gap before the
  transcript. Padding shrinks on small terminals. The prompt
  occupies its full wrapped height whenever it fits while reserving at least
  four rows for the transcript on normal terminals. Longer prompts become an
  independently scrollable prompt pane (never truncated; a `Task a–b/c` range
  row marks the overflow), so every prompt line stays reachable.
- **Transcript pane (middle)** — the live message stream scrolls independently
  of the prompt, with the transcript file path pinned above it, `Ctrl+O`
  toggling tool expansion, and per-worker scroll/follow positions preserved
  across sibling cycling. The transcript's own copy of the initial task is
  dropped when it exactly matches the pinned prompt; every other user message
  is retained.
- **Identity footer (bottom)** — `#id role · model · status` is always the last
  row. Controls wrap above it so scrolling and sibling navigation stay
  discoverable. On short screens hints and the transcript path yield space
  to the prompt and output; a one-row terminal shows only identity.

In the worker picker, `↑` on the first entry wraps to the last worker, so
recent workers are one keypress away even in long sessions. `Esc` or `←`
returns to the parent. Inside an individual worker, `↑` still returns to the
parent instead of wrapping.

Keys while a worker is open:

| Key | Effect |
| --- | --- |
| `←`/`→`/`Tab`/`Shift+Tab` | Cycle sibling workers (prompt returns to its beginning; each worker's transcript position is preserved) |
| `↑` | Return to the parent view |
| `↓` | Back to the worker picker (↑/↓ select, Enter/`→` open, `←` close) |
| `p` | Switch scroll focus between prompt and output panes (output focused by default) |
| `PgUp`/`PgDn`, `j`/`k`, `Home`/`End` | Page/line/edge scrolling for the focused pane; `End` re-enables output follow |
| `Ctrl+O` | Toggle transcript tool expansion |
| `Esc`/`Ctrl+C` | Close the viewer |

## Files

- `extensions/piastra/shortcuts.ts` — `PiastraEditor` and `installShortcuts`.
- `extensions/piastra/image-paste.ts` — clipboard-image placeholder adapter (`insertClipboardImage`, render as `[Image #N]`, expand temp paths on submit).
- `extensions/piastra/shortcuts.test.mjs` — editor integration tests (distinct
  Ctrl+T/leader-t action ids, native handlers, Ctrl+O handled vs. unhandled
  native fallback, leader timeout/cancel/unmatched, pass-through,
  foreign-editor skip, lifecycle, busy guard).
- `extensions/pi-atelier/src/editor.ts` — optional frame presentation and
  ownership-safe composition/removal.
- `extensions/pi-atelier/tests/editor-cooperation.test.mjs` and
  `shortcut-lifecycle.test.mjs` — composed editor and real extension lifecycle checks.
- `extensions/piastra/index.ts` — installs the shortcuts and shares the agent
  picker between `/agent` and the leader `a` action; registers `/dispatch-help`.
- `extensions/piastra/help.mjs` — shared help sections and terminal formatter.
- `extensions/piastra/help-view.ts` — section picker and scrollable help viewer.
- `bin/dispatch.mjs` — terminal entry point for help, setup and launching.

## Tests

```bash
node --experimental-strip-types --test extensions/piastra/shortcuts.test.mjs extensions/piastra/image-paste.test.mjs extensions/piastra/image-editor.test.mjs extensions/piastra/worker-view.test.mjs
```
