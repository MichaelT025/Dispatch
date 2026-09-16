# Dispatch

Pi orchestration with role agents, parallel workers, a maintained extension bundle, and Dispatch Web—all in one npm package.

Requires Node.js 22.19+ and Git (including Git Bash on Windows).

## Install and set up

During development, install the supplied tarball with `npm install -g <path-to-dispatch.tgz>`. Once a release is published, use `npm install -g @michaelt025/dispatch`.

```sh
dispatch setup
```

Setup is explicit: installation and ordinary launch never start authentication automatically. Setup checks for a plain `pi` command and offers to install supported Pi if absent; it never silently upgrades an existing Pi. Dispatch itself uses pinned Pi 0.85.1.

- **Codex login is required.** Choose browser login or device-code login.
- **OpenCode Go is optional.** Choose Skip to start General and Fast on `openai-codex/gpt-5.6-luna`, both with Medium reasoning. Otherwise their Go defaults remain. Orchestrator uses Astra Low; Review uses Astra Medium.
- Repeated setup retains stored credentials, the saved Go choice and existing role/model preferences. Missing required credentials can be configured again. Use `/agent` and `/model` to change role models later.

Credentials stay in the isolated Pi credential store, never in command arguments or conversations. Setup does not copy your plain Pi credentials or send inference requests to validate them.

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

The package may be unpublished while testing a development tarball; in that case the startup check stays silent and explicit update reports that no published release is available.

## Configuration and compatibility

By default, `~/.dispatch` contains `agent/` (Pi settings, auth, sessions and `piastra/` role preferences/transcripts), `web/` (browser state), and `state.json`. Override the root with `DISPATCH_HOME`. Inherited `PI_CODING_AGENT_DIR` and session-directory overrides do not redirect Dispatch. This is configuration isolation, not filesystem sandboxing.

Plain Pi settings are not modified by the new launcher. Existing legacy PiAstra/Dispatch registrations are not removed automatically; if you used the old `install:cli` script, remove those registrations separately to unbundle your existing plain Pi setup. Legacy `/piastra` remains an alias for `/dispatch`.

To uninstall, remove the npm package with the same package manager and installation scope you used to install it. Your Dispatch state remains until you explicitly delete it. Keep it if you intend to reinstall.

See `THIRD_PARTY_NOTICES.md` and each included upstream license for maintained-fork attribution. This development artifact remains private until release approval and selection of the original-code license.
