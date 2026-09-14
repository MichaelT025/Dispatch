# FORK.md — PiAstra vendored fork of pi-atelier

This directory (`extensions/pi-atelier/`) is a **vendored fork** of
`pi-atelier@0.10.1`, maintained by PiAstra as part of the PiAstra package.

## Baseline

- The initial import came byte-for-byte from the upstream npm tarball. Runtime
  divergences since that baseline are recorded below.
- Upstream `package.json`, `LICENSE`, `README.md`, `CHANGELOG.md` are preserved as shipped.
- Provenance and integrity hashes: see `UPSTREAM.md`.

## PiAstra-specific files

- `UPSTREAM.md` — npm provenance and integrity record.
- `FORK.md` — this file.
- `tests/*.test.mjs` — local baseline regression tests (Node built-in `node:test`,
  no dev dependencies, never shipped in the upstream tarball). They are excluded
  from the upstream `package.json` `files` list and are for PiAstra development only.

## Installation and checks

Opt in with `npm run install:cli -- --atelier` from the repository root, then
restart Pi or `/reload`. This replaces the enabled upstream npm extension with
the managed copy, preserving `pi-atelier.json`. Future ordinary installer runs
keep it updated. See [UI documentation](../../docs/pi-ui.md) for rollback and
non-npm installations. The development checkout alone does not change your live
installation.

Run `npm test` or `npm run test:cli` at the repository root for PiAstra's checks,
including baseline and installed-fork loader tests. The upstream npm tarball
omits its Vitest tests and build/lint configuration; the preserved nested
`package.json` scripts are not a runnable upstream development checkout.
These checks do not exercise interactive scrolling or terminal rendering.

## Vendor policy

- Commands, configuration surface, and the sidebar protocol are **unchanged** from upstream.
- If runtime changes are ever needed, they must be applied as clearly documented
  divergences from the upstream baseline (and recorded here), so future re-vendors
  of newer `pi-atelier` releases remain traceable.

## Runtime divergences / TODO status

- `src/editor.ts` now exposes versioned factory presentation cooperation with
  PiAstra. Atelier supplies the rounded frame; a single PiAstra editor retains
  shortcut input handling. No runtime import of PiAstra is required.
- `extensions/index.ts` installs/removes its frame through those helpers rather
  than unconditionally replacing/restoring the input editor. Unknown foreign
  editors are preserved. Startup in either order, repeated enable/disable,
  reload and shutdown are covered by regression tests. See
  [the protocol](../../docs/shortcuts.md#atelier-cooperation-and-foreign-editors).
- **Needs reproduction:** the user's sidebar scrolling issue; its cause may be
  in Atelier or Pi's terminal renderer. No scrolling fix is claimed here.
- `src/footer.ts` ports the pre-fork agent-label customization: live PiAstra
  `Agent: <role>` status replaces READY/WORKING with the uppercase role name.
  Activity colors and working animation remain; warnings/errors stay explicit.
  Without a recognized PiAstra role, standalone Atelier keeps its original label.
  The old npm installation was compared with the integrity-verified 0.10.1
  tarball: this was its only source patch (the extra footer file was a backup).
  User sidebar/layout preferences remain in `pi-atelier.json`, not vendored code.
- **No remote GitHub fork created.** This is an in-tree vendored fork only;
  upstream remains https://github.com/michaelmjhhhh/pi-atelier.
