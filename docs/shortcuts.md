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
| `Ctrl+X` | Arm the leader key for 2 seconds; a small hint (` x→ t y a w m `) appears on the editor border |
| `Ctrl+X` then `t` | Native `app.thinking.toggle` (collapse/expand thinking blocks) |
| `Ctrl+X` then `y` | Native `app.message.copy` (copy last assistant message) |
| `Ctrl+X` then `a` | PiAstra agent picker (same list as `/agent`) |
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

## How native actions are invoked

When pi installs a custom editor, `setCustomEditorComponent` copies the app's
native action handlers into the editor's public `actionHandlers` map for any
editor that duck-types as a `CustomEditor`. PiAstra's editor therefore invokes
`app.thinking.cycle`, `app.thinking.toggle`, `app.message.copy` and
`app.model.select` **by action
id** from that map — `Ctrl+T` and the leader `t` deliberately hit different
action ids — instead of simulating raw keystrokes, so user keybinding
customisations and future pi changes keep working. If an action id has no
handler (for example in unit tests), the key falls back to normal editor
handling.

## Atelier cooperation and foreign editors

The **PiAstra-maintained Atelier fork** cooperates with these shortcuts. Enable
it with `npm run install:cli -- --atelier`, then restart Pi or `/reload`. Merely
editing this checkout does not update your installed extension copies. The
upstream npm Atelier editor does not implement this cooperation protocol.

`installShortcuts` captures `ctx.ui.getEditorComponent()` before installing
its own factory:

- **PiAstra's own factory** is rebuilt with fresh session context. Its previous
  instance is disposed, cancelling the leader and pending shortcut actions.
- **The fork's Atelier factory** publishes a version-1 `editorCapability` with
  ID `piastra.atelier-frame`. PiAstra preserves its frame presentation while
  creating a single `PiastraEditor`. If PiAstra starts first, its capability
  (`piastra.shortcuts`) lets Atelier compose the same frame onto that editor.
  The frame renders before the leader hint, so the hint stays visible.
- **Unrecognized foreign factories** are left untouched. PiAstra warns and
  skips installation; Atelier also declines to replace an unknown editor.

Factory capabilities provide `readPresentations`, and PiAstra additionally
provides `composePresentation` and `withoutPresentationsFor`. Entries carry a
session-owned token, chrome width, minimum width and rendering function. No
cross-package runtime imports, global input listeners or registry overrides
are needed. Repeated enable operations do not nest frames.

`/atelier disable` removes only its own frame, leaving shortcuts active;
`/atelier enable` restores it. Cleanup checks the current factory's ownership,
not a stale saved factory. Retired PiAstra factories cannot recreate an editor
after shutdown. Both startup orders and shutdown orders are tested.

The input component still inherits Pi's native submit, autocomplete, paste and
extension-shortcut wiring. Overlays receive their own input; blur cancels the
leader. This does not change the sidebar's scrolling behavior.

Errors from shortcut actions never escape input handling: they are reported
through `ctx.ui.notify`. In particular, cycling agents while the agent is busy
surfaces the guard message ("Wait for the current turn to finish…") instead of
switching.

## Files

- `extensions/piastra/shortcuts.ts` — `PiastraEditor` and `installShortcuts`.
- `extensions/piastra/shortcuts.test.mjs` — editor integration tests (distinct
  Ctrl+T/leader-t action ids, native handlers, Ctrl+O handled vs. unhandled
  native fallback, leader timeout/cancel/unmatched, pass-through,
  foreign-editor skip, lifecycle, busy guard).
- `extensions/pi-atelier/src/editor.ts` — optional frame presentation and
  ownership-safe composition/removal.
- `extensions/pi-atelier/tests/editor-cooperation.test.mjs` and
  `shortcut-lifecycle.test.mjs` — composed editor and real extension lifecycle checks.
- `extensions/piastra/index.ts` — installs the shortcuts and shares the agent
  picker between `/agent` and the leader `a` action.

## Tests

```bash
node --experimental-strip-types --test extensions/piastra/shortcuts.test.mjs
```
