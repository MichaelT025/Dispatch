# Third-party notices

This file records third-party code vendored in the Dispatch checkout and in
the generated single-artifact release package (`.release/package`).

## Original Dispatch code (MIT)

Original Dispatch code in this repository is licensed under the MIT License;
see the root `LICENSE` file. The license applies only to original Dispatch
code and does not replace or relicense retained third-party code. The
third-party licenses below apply only to the code they name.

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
  under MIT; they ship alongside the forks above.

## Contributed subscription-usage extension (Apache-2.0, retained in place)

- `extensions/pi-usage/` includes provider parsing adapted from
  **Usage-Dashboard**, upstream commit
  `e128b1aac3b63590241722c95bbb30951c13f6a3`, under the Apache License 2.0.
  The extension is substantially modified for standalone Pi use: Dispatch
  provider adapters, native authentication, TUI-only polling, in-memory
  stale/error handling, and the `dispatch:subscriptions` sidebar protocol.
  Its complete Apache-2.0 license is retained at
  `extensions/pi-usage/LICENSE`.

## Vendored Command Code provider (MIT)

- Command Code provider source from `pi-commandcode-provider` 0.7.1 —
  [upstream](https://github.com/patlux/pi-commandcode-provider), MIT, pinned to
  upstream source commit `6fd0ac75345c3fd9c94aa1638c0e00fe963041b8` (tag `v0.7.1`). Dispatch owns and
  ships the maintained copy under `extensions/pi-commandcode/`; it is not an
  npm runtime dependency. The upstream `LICENSE` and provenance are retained
  there.

## Vendored WebUI build (build-time input only)

The release builder copies the already-built WebUI checkout into
`vendor/web-ui/`, preserving its relative layout (`package.json`,
`dist/server/`, `web/dist/`, `web/public/` where present, plus its
`LICENSE*` and `README*`). The WebUI retains its own upstream license files;
no WebUI license is re-stated here. The sibling checkout is a build-time
input only and is never published as a dependent `@michaelt025/dispatch-web`
package. Its upstream MIT license is retained.

## npm production dependencies (own licenses retained)

The staged package manifest declares pinned Pi `0.87.1` and its `pi-ai`,
`pi-agent-core` and `pi-tui` packages (shared runtime and Web SDK requirement) plus `html-to-text`, `ipaddr.js`, `proper-lockfile`,
`minimatch`, `cross-spawn`, `semver`, and the WebUI's production
dependencies (with Pi forced to `0.87.1`). Excluded from the artifact:
legacy/trial packages `@agegr/pi-web`, `pi-web-ui`, `tau-mirror`, and all
development tooling. Each npm dependency retains its own published license,
resolved from its package at install time; no npm license text is duplicated
here.
