<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/dispatch-light.png" />
  <img src="assets/dispatch-dark.png" alt="Dispatch logo" width="120" />
</picture>

# Dispatch

Dispatch is a coding-agent setup built on [Pi](https://github.com/earendil-works/pi-coding-agent). An **orchestrator** (Astra) talks to you, plans the work, and delegates it to parallel **workers** — general coders, fast helpers, and an independent **reviewer** — each running in its own isolated context. It ships as one npm package with a terminal CLI, a browser UI (Dispatch Web), and a bundle of maintained Pi extensions (worktree sessions, message queueing, TODOs, the Atelier sidebar, and more).

Docs:

- [Getting started](docs/GETTING_STARTED.md) — install, first-run setup, launching, updating, uninstalling.
- [How Dispatch works](docs/OVERVIEW.md) — roles, delegation, watching workers, sessions and worktrees, Dispatch Web.
- [Keyboard shortcuts](docs/shortcuts.md) · [Agent tools](docs/agent-tools.md) · [Terminal appearance and sidebar](docs/pi-ui.md)
- [Development](docs/DEVELOPMENT.md) — repository layout, tests, CI, building and publishing a release.

## Requirements

- Node.js 22.19 or newer
- Git (Git Bash on Windows)
- A Codex (OpenAI) account — required
- An OpenCode Go API key — optional, for the default General/Fast worker models

## Install

```sh
npm install -g @michaelt025/dispatch
```

## First run

```sh
dispatch setup
```

Setup is explicit and only runs when you ask for it. It will:

1. Check for a plain `pi` command and offer to install a supported version if none exists (an existing Pi is never touched — Dispatch uses its own pinned copy).
2. Sign you in to **Codex** with browser or device-code login. Required.
3. Ask for an **OpenCode Go** key. Optional — choose *Skip* and the General and Fast workers use `openai-codex/gpt-5.6-luna` at Medium reasoning instead.

Credentials go into Dispatch's own store under `~/.dispatch`; nothing is copied from or written to your plain Pi configuration. Re-running setup keeps stored credentials and your role/model choices.

## Run

```sh
dispatch              # interactive CLI in the current project
dispatch --web        # Dispatch Web at http://127.0.0.1:8790
```

Normal Pi options can follow `dispatch`, e.g. `dispatch --continue`. The CLI and Web share saved sessions.

Inside a session:

- `/dispatch-help` — commands, shortcuts and tips.
- `/agent` — pick a role (orchestrator, general, fast, review); **Shift+Tab** cycles them, **Ctrl+T** cycles reasoning.
- Ask the orchestrator to delegate: *"Implement this with general workers, use fast helpers for investigation, then have the review worker inspect the diff."*
- `/workers` or **Ctrl+Shift+W** — watch workers as they run.
- `/wt` — worktree sessions; `/q` queues a follow-up; `/st` steers the current turn.

## Update

Dispatch checks for a newer release on startup and shows a dismissible notice. Nothing updates on its own:

```sh
dispatch update
```

Close running Dispatch sessions first. See [Getting started](docs/GETTING_STARTED.md#updating) for offline and opt-out variables.

## License

Original Dispatch code is MIT ([LICENSE](LICENSE)). Bundled upstream extensions keep their own MIT licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
