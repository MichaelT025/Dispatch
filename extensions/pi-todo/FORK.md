# FORK.md — PiAstra vendored fork of @juicesharp/rpiv-todo

This directory (`extensions/pi-todo/`) is a **vendored fork** of
`@juicesharp/rpiv-todo@2.9.0`, maintained by PiAstra as part of the PiAstra package.

## Baseline

- The initial import came byte-for-byte from the upstream npm tarball (see
  `UPSTREAM.md` for provenance and integrity hashes).
- Upstream `LICENSE`, `README.md`, `docs/`, `locales/`, and all
  `state/`, `tool/`, `view/`, `todo.ts`, `todo-overlay.ts` runtime modules are
  preserved as shipped. Package metadata changes are listed below.

## PiAstra-specific files

- `UPSTREAM.md` — npm provenance and integrity record (also covers the vendored
  dependency below).
- `FORK.md` — this file.
- `tests/*.test.mjs` — local baseline regression tests (Node built-in `node:test`
  with the real Pi extension loader; no dev dependencies, never shipped upstream).
  For PiAstra development only; the installer excludes them from managed copies.
- `vendor/rpiv-config/` — pristine `@juicesharp/rpiv-config@2.9.0` runtime,
  vendored because upstream declares it as a plain (non-aliased, non-optional)
  runtime dependency. Its only divergence from the npm tarball is the **added**
  `LICENSE` file (the tarball ships none; see `UPSTREAM.md` for the fetched
  source). Its `typebox` dependency is satisfied by Pi's loader alias.

## Purpose of the fork

PiAstra keeps the `todo` tool, the `/todos` dialog, validation, dependencies
(blockedBy graph), replay, session isolation, state persistence, tool result
schemas, and i18n fallback behavior fully functional — but disables the
persistent **above-editor overlay widget**, which conflicts with PiAstra's own
layout chrome. Three narrowly-scoped seams in `index.ts` implement this; the
tool/state subsystem is untouched and `setWidget` is not globally intercepted.

## Runtime divergences from the 2.9.0 baseline

1. `config.ts` — the single `@juicesharp/rpiv-config` import (one type import,
   one value import) is redirected to the relative vendor path
   `./vendor/rpiv-config/index.js`. No other change.
2. `index.ts` — one explicit constant plus three guards:
   - `const TODO_OVERLAY_DISABLED = true;` (documented at the definition);
   - `updateTodoOverlay()` returns immediately, so `TodoOverlay` is never
     loaded/constructed and no `rpiv-todos` widget is ever registered or
     removed (empty-list teardown included);
   - the collapse/expand shortcut registration is skipped;
   - the `setTimeout(PREWARM_DELAY_MS)` overlay pre-warm timer is not scheduled.
3. `package.json` — upstream-verbatim except that the
   `@juicesharp/rpiv-config` entry was removed from `dependencies` (it is
   satisfied by the in-tree vendor copy; `typebox` stays because Pi aliases it,
   and the optional `@juicesharp/rpiv-i18n` peer stays optional as upstream).

Everything else — including the `session_start` / `session_compact` /
`session_tree` / `session_shutdown` / `tool_execution_end` / `agent_start`
lifecycle handlers — is upstream code. With the overlay disabled the overlay
references simply stay `undefined`, so those handlers' overlay paths are
inert no-ops while replay/eviction semantics remain intact.

## Installation

The PiAstra installer (`npm run install:cli`) copies this tree recursively into
the managed package (excluding `tests/`), registers `extensions/pi-todo/index.ts`,
and disables any enabled upstream `npm:@juicesharp/rpiv-todo…` settings entries
while preserving their package and config objects. Per-install config is read
from the XDG/legacy rpiv-config layer (`~/.config/rpiv-todo/config.json` and
friends), unchanged from upstream — the vendored copy resolves it identically.

## Vendor policy

- Commands, configuration surface, tool name (`todo`), widget key (`rpiv-todos`),
  and schemas are unchanged from upstream.
- If further runtime changes are ever needed, they must be added as clearly
  documented divergences here so future re-vendors of newer rpiv-todo releases
  remain traceable.
- **No remote GitHub fork created.** In-tree vendored fork only; upstream
  remains https://github.com/juicesharp/rpiv-mono (`packages/rpiv-todo`).
