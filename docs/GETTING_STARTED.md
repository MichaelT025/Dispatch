# Getting started

The supported way to use Dispatch is the npm package `@michaelt025/dispatch`. It bundles the CLI launcher, Dispatch Web, the maintained extensions and a pinned copy of Pi, so nothing else needs to be installed. (Developers working from a checkout: see [Development](DEVELOPMENT.md).)

## Requirements

- Node.js 22.19+
- Git (Git Bash on Windows)
- A Codex (OpenAI) account
- Optionally an OpenCode Go API key

## Install

```sh
npm install -g @michaelt025/dispatch
```

The install itself does nothing else — no login, no configuration.

## Setup

```sh
dispatch setup
```

Setup is the only thing that authenticates. Ordinary launches never start onboarding; if setup has not been completed they print `Run dispatch setup` and stop.

1. **Pi check.** If no plain `pi` command exists, setup offers to install a supported version globally. If a Pi is already installed it is left as-is. Either way Dispatch always runs its own pinned Pi (currently 0.85.1).
2. **Codex login (required).** Choose browser login or device-code login. Codex powers the Astra orchestrator and reviewer.
3. **OpenCode Go (optional).** Enter a Go API key, or choose *Skip*. With Go configured, General workers use GLM-5.3-Flash and Fast workers use DeepSeek V4.1 Flash. When skipped, both use `openai-codex/gpt-5.6-luna` at Medium reasoning. The Orchestrator (Astra Low) and Review (Astra Medium) roles are the same either way.

Secrets are never echoed, never passed on the command line, and never written to sessions or logs. They live in Dispatch's own Pi credential store. Setup does not copy credentials from an existing Pi install and does not send inference requests to validate them.

Re-run `dispatch setup` any time: it keeps stored credentials, the saved Go choice and any per-role model preferences, and only asks for what is missing.

## Launch

```sh
dispatch                              # interactive CLI in the current directory
dispatch --web                        # Dispatch Web, foreground
dispatch --web --port 9000 --no-open  # custom port, don't auto-open the browser
dispatch --help
dispatch --version
```

Anything Dispatch does not recognise is passed to Pi, so `dispatch --continue`, `dispatch --name "My task"` and the rest of Pi's CLI work as usual.

Dispatch Web binds to `127.0.0.1` only, default port 8790 (`DISPATCH_PORT` changes the default). The browser opens once the server is up. Closing the tab does not stop the server; **Ctrl+C** in the terminal does, and it also disposes any worker processes and terminals the Web session owned.

The CLI and Web read and write the same saved sessions, so you can resume in either. They do not mirror one live conversation.

Once you are in a session, [How Dispatch works](OVERVIEW.md) explains roles, delegation and the worker viewer, and `/dispatch-help` gives the same from inside the TUI.

## Updating

On startup Dispatch does a short, non-blocking check of the npm registry for a newer stable release. If there is one you see a dismissible notice:

> A Dispatch update is available. Run dispatch update.

Nothing is installed automatically. To update, close **all** running Dispatch sessions (CLI and Web), then:

```sh
dispatch update
```

This replaces the same npm installation you launched from — CLI, Web and extensions together — and leaves `~/.dispatch` untouched. It first proves the install is a plain npm global or local install; a repository checkout, `npm link`, an `npx` cache, or a pnpm/yarn/bun layout gets printed instructions instead of being modified. A failed update reports the error and does not claim success.

Environment variables:

| Variable | Effect |
| --- | --- |
| `DISPATCH_SKIP_VERSION_CHECK=1` | No startup check; `dispatch update` still works. |
| `DISPATCH_OFFLINE=1` or `PI_OFFLINE=1` | No update network access at all. |
| `DISPATCH_PORT` | Default port for `dispatch --web`. |
| `DISPATCH_HOME` | Where Dispatch keeps its state (default `~/.dispatch`). |
| `TAVILY_API_KEY` | Enables the `web_search` tool ([agent tools](agent-tools.md)). |

## Where things live

`~/.dispatch` (or `DISPATCH_HOME`) contains:

- `agent/` — Dispatch's isolated Pi directory: settings, credentials, sessions, and `piastra/` with per-role preferences and worker transcripts.
- `web/` — Dispatch Web browser-side state.
- `state.json` — setup completion and managed-extension registration.

Inherited `PI_CODING_AGENT_DIR` / session-directory variables are ignored so Dispatch never redirects into, or modifies, your plain Pi configuration. This is configuration isolation, not an OS sandbox: workers' tool restrictions limit what they can do, but trusted checks they run can still touch your files.

## Uninstall

```sh
npm uninstall -g @michaelt025/dispatch
```

`~/.dispatch` is left in place so a reinstall picks up where you left off. Delete it yourself if you want a clean slate.
