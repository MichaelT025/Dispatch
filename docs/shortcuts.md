# PiAstra editor shortcuts

PiAstra installs a small set of keyboard shortcuts by replacing pi's main input
editor with a `CustomEditor` subclass (`extensions/piastra/shortcuts.ts`). All
interception lives inside that editor's own `handleInput`, so nothing outside
the main editor is affected.

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
| `Shift+Tab` | Cycle the primary PiAstra agents (orchestrator → general → fast → review) |
| `Ctrl+T` | Native `app.thinking.cycle` (cycle the thinking level) |
| `Ctrl+O` | Toggle tool output expansion — the compact-transcript plugin claims the toggle when compact mode is on; otherwise native `app.tools.expand` |
| `Ctrl+V` | Native clipboard paste — clipboard images show as `[Image #1]`, `[Image #2]`, … |
| `Alt+V` | Same native clipboard paste (fallback when the terminal intercepts `Ctrl+V`) |
| `Ctrl+X` | Arm the leader key for 2 seconds; a small hint (` x→ t y a w `) appears on the editor border |
| `Ctrl+X` then `t` | Native `app.thinking.toggle` (collapse/expand thinking blocks) |
| `Ctrl+X` then `y` | Native `app.message.copy` (copy last assistant message) |
| `Ctrl+X` then `a` | PiAstra agent picker (same list as `/agent`) |
| `Ctrl+X` then `w` | Worker overlay (same view as `/workers`) |
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
images. The original temp image path stays registered and expands back for
submission, so the model still receives the image.

Caveat: Windows Terminal may intercept `Ctrl+V` for its own paste. Allow the
key through to pi or keep using `Alt+V`. No global `keybindings.json` writes
are involved — both bindings live inside the editor's own `handleInput`.

## How native actions are invoked

When pi installs a custom editor, `setCustomEditorComponent` copies the app's
native action handlers into the editor's public `actionHandlers` map for any
editor that duck-types as a `CustomEditor`. PiAstra's editor therefore invokes
`app.thinking.cycle`, `app.thinking.toggle` and `app.message.copy` **by action
id** from that map — `Ctrl+T` and the leader `t` deliberately hit different
action ids — instead of simulating raw keystrokes, so user keybinding
customisations and future pi changes keep working. If an action id has no
handler (for example in unit tests), the key falls back to normal editor
handling.

## Foreign editors

`installShortcuts` captures `ctx.ui.getEditorComponent()` before installing
its own factory:

- **PiAstra's own factory** (found again after `/reload` or a session switch)
  is replaced outright, marked with a brand property, so repeated reloads
  never nest editors and stale session contexts are dropped.
- **Foreign factories** (another extension owns the editor) are left untouched:
  installation is skipped and a warning notification is shown. Composing would
  either construct-and-discard the foreign editor (leaking its state) or
  clobber its behavior, and the repo currently has no foreign editor, so the
  graceful skip is the safe default.

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
- `extensions/piastra/index.ts` — installs the shortcuts and shares the agent
  picker between `/agent` and the leader `a` action.

## Tests

```bash
node --experimental-strip-types --test extensions/piastra/shortcuts.test.mjs
```
