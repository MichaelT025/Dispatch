# Development

Working on Dispatch itself. Users should follow [Getting started](GETTING_STARTED.md) instead.

## Repository layout

| Path | Contents |
| --- | --- |
| `bin/dispatch.mjs` | The `dispatch` executable. |
| `lib/` | Launcher internals: CLI dispatch, setup wizard, isolated state paths, update check/`dispatch update`, browser open, terminal prompts. Pure and dependency-injected for tests. |
| `extensions/piastra/` | The core Pi extension: roles, `delegate`, worker viewer, help overlay, shortcuts, session titling. |
| `extensions/pi-worktree/`, `pi-queue/`, `pi-compact-transcript/`, `pi-atelier/`, `pi-todo/`, `pi-ui/` | Maintained forks of upstream Pi extensions, each with its own `LICENSE`/`FORK.md`. |
| `extensions/pi-usage/` | Standalone account-level subscription usage extension for Codex, OpenCode Go, and Command Code; adapted provider parsing retains its Apache-2.0 `LICENSE` and README. |
| `roles/` | System prompts per role. |
| `config/agents.json`, `config/checks.json` | Default model/reasoning per role; trusted `run_checks` commands. |
| `scripts/build-release.mjs` | Stages the publishable package under `.release/package`. |
| `scripts/install-cli.mjs` | Registers the extensions from this checkout into a plain Pi (`~/.pi/agent`) for development. |
| `tests/release/` | Opt-in packaged-install test. |
| `docs/` | This documentation. |

Dispatch Web lives in the sibling repository [DispatchWeb](https://github.com/MichaelT025/DispatchWeb), expected at `../DispatchWeb`. It is a build-time input only; installed packages bundle its output under `vendor/web-ui/`.

## Setup

Requires Node 22.19+ and Git.

```sh
npm ci
```

There are two ways to run your working copy:

**As the packaged launcher** — `node bin/dispatch.mjs` behaves like the installed `dispatch` (setup, `--web`, update) using the checkout's sources. Set `DISPATCH_HOME` to a scratch directory to keep test state away from your real `~/.dispatch`. `dispatch update` refuses to modify a checkout.

**Inside your plain Pi** — `npm run install:cli` (add `-- --atelier` for the Atelier footer) backs up your Pi settings, registers the extensions from this checkout under `~/.pi/agent/piastra/package`, and sets Astra Low as default. Then run `pi` in any project. Re-run after pulling and fully restart Pi (`/reload` is not enough for worktree commands). This modifies your plain Pi configuration; to undo it, remove the Dispatch entries from the `extensions` array in Pi's settings and restore the timestamped backup. `PI_CODING_AGENT_DIR` redirects the target directory.

Running Dispatch Web from source: build the sibling checkout (`npm ci && npm run build` there), then `npm run start:fork` serves it on http://127.0.0.1:8790 with isolated state under `.local/`. `DISPATCH_FORK_DIR` overrides the sibling path.

### Subscription usage extension

`extensions/pi-usage/` is a standalone Pi extension, not a Dispatch Web or
Usage-Dashboard dependency. Register its `index.ts` when developing the
extension in a plain Pi. It supports Codex, OpenCode Go, and Command Code,
contributes `dispatch:subscriptions` for Atelier, and limits polling to
interactive `ctx.mode === 'tui'` sessions; worker sessions are not polled.
Refreshes begin immediately and repeat every three minutes, with in-memory
stale/error state and rate-limit cooldowns. `DISPATCH_USAGE_DISABLED=1`
disables collection. See its [README](../extensions/pi-usage/README.md) for
provider auth and the `/usage` commands.

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

### Automated release (tag push, no manual publishing)

Pushing a `v*` tag runs [`.github/workflows/release.yml`](../.github/workflows/release.yml). No manual `npm publish`, push of build output, or version bump from CI is needed: the tag itself selects the version, and the workflow publishes the exact tarball it tested.

What it does:

- Checks out this tag plus public `MichaelT025/DispatchWeb` at the immutable SHA pinned in [`config/release.json`](../config/release.json). No token is required for the public web checkout.
- Validates (`scripts/release-metadata.mjs`) that the tag is exactly `v` + the root `package.json` version, that `package-lock.json` agrees, that the version is stable semver (prereleases are rejected for now so `latest` never accidentally becomes a prerelease), and that the web SHA is a full 40-hex commit.
- Installs both locked dependency trees (`npm ci` here and in the web checkout), runs `npm test`, stages with `npm run build:release -- --web-dir <checked-out web>`, packs with `npm pack`, and runs `npm run test:package` against the absolute tarball path.
- Transfers the exact tested `.tgz` between jobs as an artifact, then publishes that same file with npm OIDC trusted publishing (Node 24, npm 11.6.2, which satisfies the npm `>=11.5.1` OIDC requirement). After npm succeeds, it attaches the `.tgz` to a GitHub release with the `gh` CLI.

Safety properties: GitHub-hosted `ubuntu-latest`; top-level `contents: read`; the build/test job is read-only (`contents: read`); only the publish job has `environment: npm` with `id-token: write` plus `contents: write` (needed for OIDC minting and the GitHub release). Concurrency is `release-${{ github.ref }}` with `cancel-in-progress: false` so a release is never cancelled midway. All GitHub actions are pinned to verified commit SHAs (checkout v4.3.1, setup-node v4.4.0, upload-artifact v4.6.2, download-artifact v4.3.0).

One-time npm setup (package owner): register npm trusted publishing for exact values owner `MichaelT025`, repository `Dispatch`, workflow `release.yml`, environment `npm`. In the publisher's **Allowed actions**, explicitly enable **npm publish** (the staged-publication default is insufficient). Create the matching GitHub `npm` environment under repository Settings → Environments (no secrets needed); optionally require approval and restrict deployment tags to `v*`. Keep the `latest` dist-tag behaviour default; prerelease versions stay rejected until a prerelease channel is designed.

To cut a release:

1. Verify the web pin: `git ls-remote https://github.com/MichaelT025/DispatchWeb.git HEAD` and commit that SHA into `config/release.json` if the web UI moved. The web checkout must already be merged and built by the workflow (`npm ci` there, no prebuilt sibling needed locally).
2. Run `npm version <version> --no-git-tag-version`, commit both `package.json` and `package-lock.json`, and merge to `main`. `npm ci` does not update the lockfile.
3. From clean `main` at that commit: `git tag v<version> && git push origin v<version>`. The workflow runs from that tag.

First-publication bootstrap: npm trusted publishers are configured in an **existing package's settings**. If `@michaelt025/dispatch` does not exist yet, use the manual fallback below to publish the tested tarball with `npm login` authentication first, keeping the Release workflow disabled during the bootstrap tag push. Then register the trusted publisher and re-enable the workflow. Use a **new version** for the first automated release; never re-tag or republish the bootstrap version.

Rerun caveat: npm versions are immutable. If the workflow fails after `npm publish` succeeded (for example the GitHub release step), do not re-run the same tag expecting a second publish — it will fail with a version-taken error. Download the original tested artifact and attach it manually (replace placeholders):

```sh
gh run download <run-id> --name release-tarball --dir .release/recovery
gh release create v<version> .release/recovery/michaelt025-dispatch-<version>.tgz --generate-notes
# If the GitHub release already exists, use this instead:
gh release upload v<version> .release/recovery/michaelt025-dispatch-<version>.tgz --clobber
```

Do not rerun the publish job or move the tag. If the published files were wrong, bump to a new patch version and tag again.

Changing pins: update the web SHA in `config/release.json` (verify with `git ls-remote` first), or the action SHAs at the top of `release.yml` (verify each against `git ls-remote https://github.com/<owner>/<repo>.git refs/tags/<tag>`). `scripts/release-metadata.mjs` and its tests (`scripts/release-metadata.test.mjs`, run under `npm test`) cover the metadata rules; update them together if the policy changes.

### Manual release fallback (preserved)

Disable automation first with `gh workflow disable release.yml` (or Actions → Release → Disable workflow). Otherwise the manual tag push triggers a duplicate npm publication. Re-enable with `gh workflow enable release.yml` **after** the manual publication and tag push have finished.

1. Merge and tag the web UI in `../DispatchWeb`, then `npm ci && npm run build` there.
2. Bump `version` in the root `package.json` and merge to `main`.
3. From a clean `main`:

   ```sh
   npm ci
   npm run build:release -- --web-dir ../DispatchWeb
   npm pack ./.release/package --pack-destination .release
   DISPATCH_TEST_TARBALL="$PWD/.release/michaelt025-dispatch-<version>.tgz" npm run test:package
   ```

   `test:package` installs the tarball into an isolated prefix and exercises the real launcher, the packaged Web lifecycle and a local-tarball upgrade. It never installs globally or authenticates.

4. Publish and tag:

   ```sh
   npm login
   npm publish .release/michaelt025-dispatch-<version>.tgz --dry-run
   npm publish .release/michaelt025-dispatch-<version>.tgz
   git tag v<version> && git push --tags
   gh release create v<version> .release/michaelt025-dispatch-<version>.tgz --generate-notes
   ```

5. Verify on a clean prefix: `npm install -g @michaelt025/dispatch`, `dispatch setup`, `dispatch`, `dispatch --web`. The startup notice and `dispatch update` can only be exercised end-to-end once a second version is published.

## Design notes

- [IMPLEMENTATION_BRIEF.md](IMPLEMENTATION_BRIEF.md) — original design direction for the Dispatch Web fork.
- [FORK_PLAN.md](FORK_PLAN.md) — fork baseline and settings layout for the web UI.
- [WEBUI_POLISH.md](WEBUI_POLISH.md) — web UI polish backlog.
