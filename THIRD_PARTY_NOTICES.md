# Third-party notices

This file records third-party code vendored in the Dispatch checkout and in
the generated single-artifact release package (`.release/package`). It does
not grant or invent a license for original Dispatch code: the publishing
license for original code is pending and no root `LICENSE` is claimed here.

## Vendored extension forks (MIT, retained in place)

Each path below keeps its upstream `LICENSE` (and `README.md`/`FORK.md` /
`UPSTREAM.md` where present) in both the checkout and the staged package.
The `extensions/` copies are runtime sources, not development tooling.

- `extensions/pi-worktree/` — fork of `@thisux/pi-worktree` 1.2.0 (MIT).
- `extensions/pi-queue/` — fork of `pi-queue-steer-factory` 0.17.1 (MIT).
- `extensions/pi-compact-transcript/` — fork of `pi-compact-transcript`
  0.10.1 (MIT, Alan Hagedorn).
- `extensions/pi-atelier/` — fork of `pi-atelier` 0.10.1 (MIT).
- `extensions/pi-todo/` — fork of `@juicesharp/rpiv-todo` 2.9.0 (MIT,
  juicesharp), including the vendored essential dependency
  `extensions/pi-todo/vendor/rpiv-config/` (`@juicesharp/rpiv-config` 2.9.0,
  MIT).
- `extensions/piastra/` and `extensions/pi-ui/` are original Dispatch code
  (publishing license pending); they ship alongside the forks above.

## Vendored WebUI build (build-time input only)

The release builder copies the already-built WebUI checkout into
`vendor/web-ui/`, preserving its relative layout (`package.json`,
`dist/server/`, `web/dist/`, `web/public/` where present, plus its
`LICENSE*` and `README*`). The WebUI retains its own upstream license files;
no WebUI license is re-stated here. The sibling checkout is a build-time
input only and is never published as a dependent `dispatch-web` package.

## npm production dependencies (own licenses retained)

The staged package manifest declares pinned Pi `0.85.1` (shared runtime and
Web SDK requirement) plus `html-to-text`, `ipaddr.js`, `proper-lockfile`,
`minimatch`, `cross-spawn`, `semver`, and the WebUI's production
dependencies (with Pi forced to `0.85.1`). Excluded from the artifact:
legacy/trial packages `@agegr/pi-web`, `pi-web-ui`, `tau-mirror`, and all
development tooling. Each npm dependency retains its own published license,
resolved from its package at install time; no npm license text is duplicated
here.
