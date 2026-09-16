# Dispatch release package contract

Implementation contract for `@michaelt025/dispatch`. Publishing remains disabled until separately approved. The npm account/scope `michaelt025` is confirmed; no npm tokens belong in the repository.

## Phases

All three implementation phases are complete as of `af34c51`:

- [x] Phase 1 — Pin and verify Pi 0.85.1, isolated state helpers, and a single generated npm artifact.
- [x] Phase 2 — CLI/Web launcher and explicit authentication/setup wizard.
- [x] Phase 3 — Startup update notices, explicit self-update, clean-install/upgrade verification, and release help/docs.

Two release gates remain closed and are not implementation work:

- **Publishing** — no npm publish has been performed; publication requires separate approval.
- **User approval** — the artifact, version and release notes need explicit user sign-off.

Original Dispatch code is licensed under MIT in the root `LICENSE`; retained
third-party MIT licenses remain in place.

Do not publish, install globally, or run real authentication during automated tests.

## Local build, pack and test

Build and verify the artifact from this checkout. The maintained WebUI checkout is a **build-time** input only; installed packages do not need it:

```sh
npm run build:release -- --web-dir <path>       # stages .release/package
npm pack ./.release/package --pack-destination .release
DISPATCH_TEST_TARBALL="$PWD/.release/michaelt025-dispatch-<version>.tgz" npm run test:package
```

`npm run test:package` installs the packed tarball into an isolated prefix and exercises the real installed launcher, the packaged WebUI lifecycle, and a local-tarball upgrade that preserves user state. It is explicit and opt-in and never runs under root `npm test`. These steps make **no global install and perform no real authentication**; the package stays `private: true` until publication is separately approved.

## Package and runtime

- Build a staging package at `.release/package` from this checkout and the maintained WebUI checkout (build-time input only). Copy runtime sources, all seven maintained extensions, role/config files, help/artwork, and upstream notices. Copy the built WebUI with its relative layout into `vendor/web-ui/`.
- Its manifest exposes only `dispatch`. Pi 0.85.1 is a pinned normal dependency, shared with the WebUI. Production dependencies combine the extension runtime and WebUI dependencies; legacy upstream WebUI/Tau/agegr trials and development tooling are excluded.
- Keep `private: true` in generated packages during development. Local npm pack/install works; publication is an explicit later gate. The root project does not yet declare a license for original code; preserve all existing third-party licenses and do not invent one.
- `dispatch setup` checks whether a plain `pi` executable exists. If absent, offer to install pinned Pi through npm (explicit interactive consent, never during package installation). If another Pi version exists, leave it untouched; Dispatch always uses its own pinned dependency. This avoids silently upgrading the user's plain Pi.
- Existing legacy global Dispatch/PiAstra installations are not removed automatically. Users who previously ran the legacy installer must remove those old registrations themselves if they want their existing plain Pi configuration unbundled. New Dispatch installs do not register anything in `~/.pi/agent`.

## State and configuration

- `DISPATCH_HOME` (default `~/.dispatch`) contains `agent/`, `web/`, and `state.json`. Ignore inherited `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` for Dispatch launches; set child/runtime configuration to the isolated directories before importing Pi.
- Preserve existing `~/.pi`, `.local`, and legacy `piastra` IDs. Under the isolated agent directory, role preferences/transcripts continue using `piastra/`.
- Setup seeds missing settings, registers all seven maintained extensions, and preserves unrelated settings, extensions, auth, and role preferences. Never overwrite malformed existing JSON or silently reset it.
- Track exact managed extension paths so moving/updating an installation can replace old registered paths while preserving user additions and intentional removals. Ordinary launch never runs onboarding; missing completion state prints `Run dispatch setup`.
- First-run setup: mandatory stored Codex OAuth; optional Go API key with an explicit saved skip. If skipped, seed both General and Fast to `openai-codex/gpt-5.6-luna` with `medium` thinking. Otherwise retain Go defaults. Orchestrator Astra Low and Review Astra Medium remain unchanged. Later per-role choices survive repeated setup and updates.
- Use Pi's credential store and OAuth implementation. Secret/API-key/manual authorization-code inputs are not echoed; no credentials in argv, chat/history, logs, browser state, or copied from existing Pi without consent. No inference-based credential validation.

## Launch and lifecycle

- `dispatch` runs the pinned Pi CLI in-process after setting isolation, retaining Pi's native TUI/signal lifecycle. Normal Pi CLI arguments may follow; Dispatch owns `setup`, `update`, `--help/-h`, `--version`, and web flags.
- `dispatch --web [--port N] [--no-open]` runs the packaged WebUI foreground, always on `127.0.0.1`, default port 8790. `DISPATCH_PORT` is the corresponding environment default for this new launcher (legacy trial launchers keep their existing port defaults).
- Import the packaged server in-process to retain graceful Ctrl+C behavior on Windows as well as Unix. Only open the browser after the server's health response identifies this process. Closing the browser leaves the server running. Ctrl+C stops owned runtime workers and terminals through WebUI disposal; no killing arbitrary port occupants.
- Set `PI_WEB_MANAGED=1` to prevent the WebUI from trying to update itself independently; Dispatch owns the whole artifact. Do not modify standalone WebUI behavior. CLI and WebUI sessions share storage but do not mirror one live conversation.

## Updates

- Nonblocking, bounded startup check against the public npm registry for the latest stable Dispatch version. Honor offline and update-check opt-outs. An unpublished package/timeout/network failure never blocks launch.
- Present a dismissible UI notice: `A Dispatch update is available. Run dispatch update.` No auto-install or model-history entry.
- `dispatch update` checks an exact validated version and updates the entire installed package. Prove npm global/local installation identity before choosing a prefix. Refuse ambiguous installs (checkout, linked package, pnpm/yarn layout, npx cache) with appropriate manual guidance rather than modifying another installation.
- The update command must not import Pi or native WebUI modules before replacing files. Keep settings/credentials outside the install tree. Verify installed version before claiming success; failed updates report actionable errors without touching user state.

## Internal interfaces

`lib/state.mjs` owns pure path/config operations:
- `resolveDispatchPaths({ env = process.env, home, packageRoot } = {})` returns `{ home, agentDir, webDir, stateFile, packageRoot }`.
- `managedExtensionPaths(packageRoot)` returns the seven maintained entry points in their established order.
- `readDispatchState(paths)` returns parsed state or `null` for a missing file; malformed state throws.
- `seedDispatchConfiguration(paths)` seeds missing settings, synchronizes already-registered managed paths after an install move, and returns state without declaring setup complete.
- `completeDispatchSetup(paths, { go })` records `go: 'configured'|'skipped'` and `setupComplete: true`, seeding only absent role preferences according to the chosen defaults.

`lib/cli.mjs` coordinates commands; helpers are dependency-injectable for tests. No module import should inspect actual user auth or start a network operation. Tests always supply temporary Dispatch homes and synthetic providers/process adapters.
