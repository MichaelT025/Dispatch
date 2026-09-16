# Development

Working on Dispatch itself. Users should follow [Getting started](GETTING_STARTED.md) instead.

## Repository layout

| Path | Contents |
| --- | --- |
| `bin/dispatch.mjs` | The `dispatch` executable. |
| `lib/` | Launcher internals: CLI dispatch, setup wizard, isolated state paths, update check/`dispatch update`, browser open, terminal prompts. Pure and dependency-injected for tests. |
| `extensions/piastra/` | The core Pi extension: roles, `delegate`, worker viewer, help overlay, shortcuts, session titling. |
| `extensions/pi-worktree/`, `pi-queue/`, `pi-compact-transcript/`, `pi-atelier/`, `pi-todo/`, `pi-ui/` | Maintained forks of upstream Pi extensions, each with its own `LICENSE`/`FORK.md`. |
| `roles/` | System prompts per role. |
| `config/agents.json`, `config/checks.json` | Default model/reasoning per role; trusted `run_checks` commands. |
| `scripts/build-release.mjs` | Stages the publishable package under `.release/package`. |
| `scripts/install-cli.mjs` | Registers the extensions from this checkout into a plain Pi (`~/.pi/agent`) for development. |
| `tests/release/` | Opt-in packaged-install test. |
| `docs/` | This documentation. |

Dispatch Web lives in the sibling repository [pi-web-ui](https://github.com/MichaelT025/pi-web-ui), expected at `../PiAstra-web-ui`. It is a build-time input only; installed packages bundle its output under `vendor/web-ui/`.

## Setup

Requires Node 22.19+ and Git.

```sh
npm ci
```

There are two ways to run your working copy:

**As the packaged launcher** — `node bin/dispatch.mjs` behaves like the installed `dispatch` (setup, `--web`, update) using the checkout's sources. Set `DISPATCH_HOME` to a scratch directory to keep test state away from your real `~/.dispatch`. `dispatch update` refuses to modify a checkout.

**Inside your plain Pi** — `npm run install:cli` (add `-- --atelier` for the Atelier footer) backs up your Pi settings, registers the extensions from this checkout under `~/.pi/agent/piastra/package`, and sets Astra Low as default. Then run `pi` in any project. Re-run after pulling and fully restart Pi (`/reload` is not enough for worktree commands). This modifies your plain Pi configuration; to undo it, remove the Dispatch entries from the `extensions` array in Pi's settings and restore the timestamped backup. `PI_CODING_AGENT_DIR` redirects the target directory.

Running Dispatch Web from source: build the sibling checkout (`npm ci && npm run build` there), then `npm run start:fork` serves it on http://127.0.0.1:8790 with isolated state under `.local/`. `DISPATCH_FORK_DIR` overrides the sibling path.

## Tests

```sh
npm test               # offline unit tests: extensions, launcher lib, release builder
npm run test:cli       # extension suites plus the installer test
npm run test:release   # lib/*.test.mjs only
npm run test:integration   # fork SDK integration; needs the built sibling checkout
```

`npm test` makes no model requests and needs no credentials. It covers delegation policy, worker navigation and progress, Git argument restrictions, compaction/branch-summary guarding, worktree installation and session switching (using real local Git repositories), queue delivery, transcript rendering, setup/state/update logic and release staging.

`test:integration` uses synthetic credentials and no provider calls but fails with instructions if the sibling build is missing; it is not a CI gate.

`node scripts/smoke-cli.mjs` is an opt-in **live** test that spends provider usage: it creates a temporary Git project and exercises a general edit, parallel fast helpers and a review. Its transcript goes to `.local/cli-smoke.jsonl`.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `npm ci && npm test` on every PR and push to `main`: Linux on Node 22.19.0 (the declared minimum) and Node 24, plus Windows on Node 22. No credentials, provider calls or sibling checkout. The `main` ruleset should require all three `Tests (...)` checks.

Before opening a PR:

```sh
npm ci && npm test
```

## Dependencies

Pi (`@earendil-works/pi-coding-agent`) is pinned to an exact version in `package.json` and in `PINNED_PI_VERSION` inside `scripts/build-release.mjs`; the build refuses to stage if they disagree. Bump both together and re-run the packaged test.

Two `overrides` in `package.json` address upstream advisories (Next.js 16.3.3 for `@agegr/pi-web`, `qs` 6.16.0 for Express). Remove each when its upstream picks up a fixed version.

## Building and publishing a release

The release artifact is `@michaelt025/dispatch`, generated under `.release/package` — never the checkout root, which stays `private: true` so `npm publish` from the root is refused. The full contract (isolation, setup, updates, package contents) is in [RELEASE_PACKAGE.md](RELEASE_PACKAGE.md); [RELEASE_README.md](RELEASE_README.md) is the README shipped inside the package.

1. Merge and tag the web UI in `../PiAstra-web-ui`, then `npm ci && npm run build` there.
2. Bump `version` in the root `package.json` and merge to `main`.
3. From a clean `main`:

   ```sh
   npm ci
   npm run build:release -- --web-dir ../PiAstra-web-ui
   npm pack ./.release/package --pack-destination .release
   DISPATCH_TEST_TARBALL="$PWD/.release/michaelt025-dispatch-<version>.tgz" npm run test:package
   ```

   `test:package` installs the tarball into an isolated prefix and exercises the real launcher, the packaged Web lifecycle and a local-tarball upgrade. It never installs globally or authenticates.

4. Publish and tag:

   ```sh
   npm publish ./.release/package --dry-run   # inspect first
   npm publish ./.release/package
   git tag v<version> && git push --tags
   gh release create v<version> .release/michaelt025-dispatch-<version>.tgz --generate-notes
   ```

5. Verify on a clean prefix: `npm install -g @michaelt025/dispatch`, `dispatch setup`, `dispatch`, `dispatch --web`. The startup notice and `dispatch update` can only be exercised end-to-end once a second version is published.

## Design notes

- [IMPLEMENTATION_BRIEF.md](IMPLEMENTATION_BRIEF.md) — original design direction for the Dispatch Web fork.
- [FORK_PLAN.md](FORK_PLAN.md) — fork baseline and settings layout for the web UI.
- [WEBUI_POLISH.md](WEBUI_POLISH.md) — web UI polish backlog.
