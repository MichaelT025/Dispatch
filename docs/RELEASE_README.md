# Dispatch

Pi orchestration with role agents, parallel workers, a maintained extension bundle, and Dispatch Web—all in one npm package. Dispatch vendors the Command Code provider source under `extensions/pi-commandcode/` rather than installing it as a separate runtime dependency; see `THIRD_PARTY_NOTICES.md` and that directory's `UPSTREAM.md` for attribution and provenance.

Requires Node.js 22.19+ and Git (including Git Bash on Windows).

## Install and set up

```sh
npm install -g @michaelt025/dispatch
dispatch setup
```

To try a development build instead, install a packed tarball with `npm install -g <path-to-dispatch.tgz>`.

Setup is explicit: installation and ordinary launch never start authentication automatically. Setup checks for a plain `pi` command and offers to install supported Pi if absent; it never silently upgrades an existing Pi. Dispatch itself uses pinned Pi 0.87.1.

- **Codex login is required.** Choose browser login or device-code login.
- **OpenCode Go is optional.** Choose Skip to start General and Fast on `openai-codex/gpt-5.6-luna`, both with Medium reasoning. Otherwise their Go defaults remain. Orchestrator uses Astra Low; Review uses Astra Medium.
- Repeated setup retains stored credentials, the saved Go choice and existing role/model preferences. Missing required credentials can be configured again. Use `/agent` and `/model` to change role models later.

Credentials stay in the isolated Pi credential store, never in command arguments or conversations. Setup does not copy your plain Pi credentials or send inference requests to validate them.

## Command Code provider

Dispatch vendors the `pi-commandcode-provider` 0.7.1 source; no separate `pi install` is needed. The copy is owned in `extensions/pi-commandcode/` and retains its upstream MIT license.
In Dispatch, run `/login`, choose **Use a subscription → Command Code**, then
select a model with `/model`. Alternatively set `COMMAND_CODE_API_KEY`.
This is an unofficial integration requiring your own Command Code account and
eligible plan. The provider can also read existing credentials from
`~/.commandcode/auth.json`, `~/.pi/agent/auth.json`, or `~/.omp/agent/auth.json`.
Bundling does not change Dispatch's default models or setup requirements.
The provider refreshes its catalog from Command Code on load, independently of
Dispatch/Pi update-check offline flags. Without a cached catalog, this can wait
up to 10 seconds; if discovery fails, Dispatch still loads but Command Code
models remain unavailable until a successful `/commandcode-refresh`.

## Launch

```sh
dispatch                              # Interactive CLI
dispatch --web                        # Foreground Dispatch Web
dispatch --web --port 9000 --no-open    # Do not open the browser automatically
dispatch --help
dispatch --version
```

Web defaults to `http://127.0.0.1:8790` and always binds loopback. `DISPATCH_PORT` changes the default port. Keep the terminal open: closing a browser tab does not stop the server; **Ctrl+C** stops it and disposes owned runtime workers/terminals. CLI and WebUI share saved sessions, not one mirrored live conversation.

Ordinary Pi CLI options can follow `dispatch`, for example `dispatch --continue` or `dispatch --name "My task"`.

## Help and agents

Run **`/dispatch-help`** for commands, keyboard shortcuts and practical tips. `/dispatch` shows role/model choices; `/agent` selects a role; Shift+Tab cycles roles and Ctrl+T cycles reasoning. Ask the orchestrator to delegate independent work, and use `/workers` to inspect it. `/worktree` (`/wt`) manages worktree sessions. `/q` queues follow-ups; `/st` steers. TODO and Atelier are included.

Worker permissions are tool restrictions, not a security sandbox. Review workers can run configured checks; those trusted commands may mutate files.

## Updating

On interactive CLI/Web startup, Dispatch checks for newer stable releases in the background. If one is available, a dismissible notice says:

> A Dispatch update is available. Run dispatch update.

Close **all** running Dispatch sessions, then:

```sh
dispatch update
```

This updates the same npm installation, including its bundled WebUI/extensions, while retaining settings and credentials. There are no automatic installations. Ambiguous, linked, npx-cache, pnpm/yarn/bun or checkout installations receive manual guidance instead of changing another installation. A failed npm update reports an error and recovery guidance; it does not claim rollback or success.

- `DISPATCH_SKIP_VERSION_CHECK=1`: disable startup checks (explicit update remains available).
- `DISPATCH_OFFLINE=1` or `PI_OFFLINE=1`: disable update network access. CLI `--offline` also disables Pi startup network operations.

When running a development tarball whose version is newer than the published release, the startup check stays silent.

## Development tarball test

From the parent checkout, build, pack and run the packaged integration test:

```sh
npm run build:release -- --web-dir <maintained-webui-checkout>
npm pack ./.release/package --pack-destination .release
DISPATCH_TEST_TARBALL="$PWD/.release/michaelt025-dispatch-<version>.tgz" npm run test:package
```

That test installs the tarball into an isolated prefix and makes no real authentication request and no global install. Nothing is published.

## Configuration and compatibility

By default, `~/.dispatch` contains `agent/` (Pi settings, auth, sessions and `piastra/` role preferences/transcripts), `web/` (browser state), and `state.json`. Override the root with `DISPATCH_HOME`. Inherited `PI_CODING_AGENT_DIR` and session-directory overrides do not redirect Dispatch. This is configuration isolation, not filesystem sandboxing.

Plain Pi settings are not modified by the new launcher. Existing legacy PiAstra/Dispatch registrations are not removed automatically; if you used the old `install:cli` script, remove those registrations separately to unbundle your existing plain Pi setup. Legacy `/piastra` remains an alias for `/dispatch`.

To uninstall, remove the npm package with the same package manager and installation scope you used to install it. Your Dispatch state remains until you explicitly delete it. Keep it if you intend to reinstall.

See `THIRD_PARTY_NOTICES.md`, the root MIT `LICENSE`, and each included upstream license for maintained-fork attribution. Releases are published to npm as `@michaelt025/dispatch`.
