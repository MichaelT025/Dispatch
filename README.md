<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/dispatch-light.png" />
  <img src="assets/dispatch-dark.png" alt="Dispatch logo" width="120" />
</picture>

# Dispatch

Dispatch (formerly PiAstra) is a lightweight Pi setup with Astra planning, OpenCode Go workers, and Astra milestone review.

### Rebrand compatibility

- `/dispatch` is the role-summary command; `/piastra` remains an alias.
- Existing `extensions/piastra` source paths, `<agentDir>/piastra` preferences/transcripts, `.local/` state, `piastra:*` events and the `piastra-agent` status key are unchanged. No user data is moved.
- Launchers prefer `DISPATCH_PORT`, `DISPATCH_FORK_DIR`, `DISPATCH_FORK_PORT`, `DISPATCH_TRIAL_PORT` and `DISPATCH_TAU_PORT`, with the corresponding `PIASTRA_*` names as fallbacks. Empty values count as unset; invalid preferred values report an error instead of falling back.
- GitHub repository names and the `../PiAstra-web-ui` sibling path remain unchanged. Dispatch Web retains its `pi-web-ui` executable/service names, `PI_WEB_*` configuration and browser storage keys.

Package names `@michaelt025/dispatch` and `@michaelt025/dispatch-web` are provisional and unpublished; scope ownership must be confirmed before release. The `dispatch` entry point currently provides **help only** (`--help` / `-h`); setup, full CLI/WebUI launch modes and isolated `~/.dispatch/agent` state are **not implemented yet**. Use the checkout installation below.

## Help

- In Pi with Dispatch loaded: **`/dispatch-help`** opens a read-only guide to commands, keyboard shortcuts and practical usage tips. Use **`/dispatch-help shortcuts`** to jump to a section. `/dispatch` remains the role/model summary.
- Browse with **Up/Down**, **Enter**; scroll with **PgUp/PgDn**, **j/k**, **Home/End**; **Left/b** returns to sections; **Esc/Ctrl+C** closes. Help does not send a model request or add to the conversation.
- The maintained Atelier footer shows **`<model> · <reasoning> · Tip: run /dispatch-help`** only when Dispatch help is registered. The hint yields space on narrow terminals and is absent in standalone Atelier/plain Pi.
- Terminal overview: **`node bin/dispatch.mjs --help`** (or `-h`) from this checkout. The package maps this file to `dispatch`, but it is not published or globally installed yet. With no arguments it also prints help; `dispatch setup` and `dispatch --web` are not available yet.

After pulling these changes, re-run `npm run install:cli` (add `-- --atelier` for the optional Atelier footer) and restart Pi to update the managed copies. This legacy installer changes the selected Pi configuration; it does **not** yet provide the planned separation between plain Pi and Dispatch.

## Use from any directory

With Pi installed and signed in to Codex and OpenCode Go, run `npm run install:cli` once from this checkout. Then open a terminal in any project and run **`pi`**. `/dispatch` shows the role configuration (`/piastra` kept as an alias). Restart existing Pi sessions after installation.

Use **`/agent`** to open the agent picker, or select directly with `/agent orchestrator`, `/agent general`, `/agent fast`, or `/agent review`. **Ctrl+Shift+A** cycles in that order. The footer shows the active agent. Each selection changes model, reasoning, prompt and available tools, retaining the conversation; the selected model sees the existing history. The chosen role is restored when you resume that session. Switch after the current turn finishes or stop it first.
Upstream/in-framework subagent tools are hard-blocked in Dispatch sessions so `delegate` stays the single delegation system.

The installer also adds lightweight syntax highlighting for edit results. For the optional Atelier sidebar with Dispatch workers and TODOs, installation commands, controls, and performance notes, see [Pi CLI appearance and sidebar](docs/pi-ui.md).

**Experiment with models:** select a role with **Ctrl+Shift+A** or `/agent`, then choose a model with **Ctrl+L** (or cycle models with Ctrl+P). **Ctrl+T** cycles reasoning and **Shift+Tab** cycles agents; see [Dispatch editor shortcuts](docs/shortcuts.md) for the full leader-key map. Dispatch remembers these choices per role in the current session, restores them on resume, and uses them for future delegated workers of that role. Running workers keep their launch settings. `/dispatch` shows the current choices.

Explicit role overrides (a model or reasoning change while the role is active) are also remembered across sessions in `~/.pi/agent/piastra/agents.json` under `PI_CODING_AGENT_DIR` when set. On the next session they seed the same role; role switching, restore and tree navigation only reapply known choices and never rewrite that file. A session's later branch choice still wins over the stored override for that session, and a new session starts from the branch-free defaults plus stored overrides, never modifying `config/agents.json`. Saving a change for one role never discards overrides other roles hold on disk; a failed write shows an error notice while the in-session choice stays active. Invalid or unreadable entries are ignored and self-heal on the next saved change. To forget a stored override, edit or delete that role's entry in the file; it is shared across all projects because roles are global.

Only the orchestrator can delegate. General and fast are directly usable coding agents; review has read-only inspection tools. Delegated workers still use fresh isolated contexts regardless of manual switching.

The installer backs up your Pi settings, preserves unrelated fields, sets the default to Astra Low, and installs a standalone extension copy under `~/.pi/agent/piastra/package`. It uses your existing Pi credentials; no keys are copied into the repository. You can switch branches or move this checkout afterward. Re-run the installer to update the installed extension, prompts or model configuration. When `npm:@juicesharp/rpiv-todo` is enabled, the installer also migrates it to the self-contained `extensions/pi-todo` fork (details in [Pi CLI appearance and sidebar](docs/pi-ui.md)); without an enabled upstream entry, todo settings are left alone. If `PI_CODING_AGENT_DIR` is set, that directory is used instead of `~/.pi/agent`; clear the variable to use the normal global installation.

### CLI worktrees

For worktree commands in global Pi and the installed Dispatch CLI, run `npm run install:cli`; the managed installer provides its standalone plugin copy, so installing the upstream package separately is not required. If `npm:@thisux/pi-worktree@1.2.0` is already installed, the installer preserves its package but disables its pinned extension in favor of the managed, license-retaining copy, so updates remain durable. New worktrees use `~/.pi/worktrees/<repo>/<branch-slug>` (for example `C:/Users/micha/.pi/worktrees/PiAstra/feat-piastra-cli`); existing worktrees remain discoverable and openable through Git's worktree list. Fully restart Pi after installation (observed `/reload` is insufficient) to enable `/worktree ls`, `/worktree add`, `/worktree open`, `/worktree rm`, and `/worktree pr`. The package is CLI-only here: Dispatch Web settings, launchers, and seeding remain unchanged and do not load it.

`/wt` is a shorthand alias for `/worktree`, with the same subcommands and autocomplete (for example, `/wt add feat/shortcut-issues`).

`/worktree resume` (`/wt resume`) lists every session of the repository across all of its checkouts in one picker — Pi's own `/resume` only sees the current directory's sessions. Sessions are grouped under their checkout (main first, then the current one, then the rest by recency; newest first within a checkout), labelled by their name or first message with a message count and age, and the live session is marked. Picking a session switches the CLI to it in that session's own checkout, with the same guards as `/worktree open`; picking a checkout header starts a fresh session there. Sessions that never received a message are not listed and are deleted on the way (see below).

Fresh sessions started by `/worktree add|open|ls` (and by the web UI) must write their session file up front, so leaving one without sending anything used to leave a "(no messages)" session behind in every list. Dispatch now removes such a session file when its runtime shuts down (switching away, quitting) — a session with any message, or one named with `/name`, is never touched — and `/worktree resume` sweeps older leftovers in the repository's checkouts.

Sessions are titled automatically: after the first assistant reply of an unnamed session, Dispatch asks the `fast` role's model for a 3–6 word title and stores it exactly as `/name` would (a `session_info` entry), so `/resume`, `/worktree resume` and the web UI sidebar show it. It runs once per session, never blocks a turn, fails silently (the first message stays the fallback), never overwrites a name you set with `/name`, and skips delegated worker transcripts. Set `"autoTitle": false` in `config/agents.json` to turn it off.

In the interactive CLI, `/worktree add <branch>` (new or already existing), `/worktree open <branch>`, a worktree picked from `/worktree ls`, and the PR flow each start a brand-new empty session in the target worktree and switch the running CLI to it instead of only printing a path. Nothing from the current conversation is copied: the new session gets its own file in the standard per-cwd session directory, so it appears in `/resume` like any other session, and the previous session stays saved and untouched. Pi rebuilds the runtime there, so tools, extensions, resources, trust and Dispatch worker launches use the worktree; `process.cwd` itself is unchanged. The switch is refused, before any Git worktree is created or session file written, while the agent is busy, queued messages are waiting, Dispatch workers are still running, or a context compaction/branch summary is in progress (Dispatch observes the session lifecycle events because `ctx.isIdle()` does not cover those phases). Explicitly opening the worktree already in use also starts a fresh session in place. Ephemeral (`--no-session`) and not-yet-saved sessions can still switch because no source session file is required; when the outgoing conversation was unsaved, the command says so before switching. WebUI/RPC hosts never switch and keep the path-copy output. A cancelled switch leaves the original session active and removes the unused new session file; if the replacement runtime fails to start, both the original and the new session file paths are reported. A Git worktree is never deleted because its session switch was refused, cancelled, or failed: the created path and manual recovery commands (`cd <path> && pi`, or `/worktree open <branch>`) are reported instead.

`/worktree pr <number>` fetches the PR into a private ref, verifies its commit against GitHub's `headRefOid`, and creates or reuses the exact local branch `piastra/pr/<number>`. The PR's source branch name (even `main`) is never used as a local checkout target. Fetch failures or mismatched commits stop the command without opening a worktree. If the dedicated branch already differs from the current PR head, it is preserved and the command refuses to switch—no reset or overwrite. To keep that work and create a fresh PR checkout, rename the existing branch and move its worktree away from the managed path before retrying. Existing local changes in a matching checkout are kept.

Try: “Implement this change using general workers, use fast helpers for investigation, then have the review worker independently inspect the diff against the starting commit.”

One `delegate` tool provides general GLM-5.3-Flash workers, fast DeepSeek V4.1 Flash helpers, and Astra Medium review. Workers receive a fresh context containing the delegated task and project instructions, not the parent transcript. All tasks in a batch start concurrently, including editing workers, with no Dispatch worker-count cap or batch queue. Astra coordinates file ownership and dependencies. Provider rate limits still apply.

### How work is divided

The orchestrator is the user's main collaborator and the only role that may spawn workers. It keeps the conversation and the user's decisions, plans the work, assigns clear file ownership, orders dependencies, and decides when a milestone is ready for review. It can read a source itself when a decision depends on it, but bulk investigation and execution are delegated to keep the main context focused. It never claims completion or passing tests from a worker summary alone.

| Role | Owns | Access |
| --- | --- | --- |
| Orchestrator | User dialogue, planning, delegation, milestone review, final verification | Read tools plus bash/edit/write and `delegate` |
| General worker | Implementation, debugging, repair, running tests and checks | Read/write |
| Fast worker | Bounded research, code/documentation search, precise edits | Read/write |
| Review worker | Independent Git review of a milestone against its baseline | Read-only tools plus constrained checks |

Workers are isolated: each sees only its supplied task and project instructions, not the parent conversation, and none may delegate further. Task access is enforced by tool set — read-only workers have no shell, edit or write, but can run trusted workspace checks through `run_checks`; write-capable workers can also run commands directly. Valid review findings are routed back to general or fast workers for repair, and another review is requested only when the findings or later changes justify it. There is no automatic review-until-approved loop.

**Watch workers:** press **Ctrl+Shift+W** while they run, or use **`/workers`**. In the picker, Up/Down selects a worker and Enter opens it. Inside a worker, Left/Right (or Tab/Shift+Tab) switches siblings, Up returns to the parent, and Down opens the picker. PageUp/PageDown scrolls a page; j/k scrolls a line; Home goes to the start; End follows live output. Escape always returns to the parent. **Ctrl+O** expands or collapses tool details; failed tool output remains visible. Each worker remembers its reading position while you switch siblings; incoming output leaves a paused view in place. The fixed terminal overlay shows themed Markdown, highlighted code blocks and tool arguments, and source highlighting for file reads. Workers continue running while the viewer is open. This is an inspection view, not an input box for messaging children. Saved worker views are available after resuming their parent session. Large individual content blocks are previewed up to 30,000 characters; the displayed transcript path contains the complete record.

A **Subagents** panel above the editor tracks the current orchestrator run's workers across delegate batches and retries, in the TODO overlay's style (heading, tree rows, trailing spacer): one row per worker with status icon, agent role and elapsed time. Completed, failed and cancelled rows stay visible until the next run or session reset. The panel shows at most 12 content lines and points overflow to `/workers`; it reuses the existing 250ms delegate updates with no new polling.

The main delegation result is now a single aggregate line (`Workers · … · /workers for details`), even with **Ctrl+O**; full worker conversations and model outputs remain in `/workers`. Use **Ctrl+Shift+W** for the full worker view. This UI activity stays out of the orchestrator's final tool-result text; it still receives concise worker results.

**Web UI workers:** the extension also publishes workers on the `piastra:workers` extension event channel (version 1): a deduplicated `workers` list on every progress update and a `transcript` event with the live worker session messages, plus `discover`, `transcript_request` and per-worker `cancel` requests from viewers. The Dispatch Web fork subscribes in-process to render its Workers pane; nothing polls, and the TUI viewer and Atelier panel are unchanged. Each saved worker now records the `toolCallId` of the delegate call that started it.

Read-only workers have read/find/grep/ls, an argument-restricted Git inspector, web research, shared-note reading, and `run_checks`. They have no shell, edit, write, extensions or nested delegation. General/fast workers with write access also have shell/edit/write and can run commands directly. Git review accepts a supplied milestone baseline; review workers can execute configured checks through `run_checks`. Those checks run trusted workspace code and may write artifacts or mutate files. These are tool restrictions, not an OS filesystem sandbox. Worker transcripts are saved in `~/.pi/agent/piastra/runs`; the parent receives a capped summary and transcript path. Cancellation propagates to workers, with a 15-minute per-worker timeout. Model errors are returned explicitly, never replaced with Astra. Non-Astra workers request thinking off; Pi clamps this to model-supported levels (GLM currently uses Low).

Validation: `npm test` runs the offline extension and launcher unit tests across the piastra, worktree, queue and compact-transcript plugins; `npm run test:cli` runs the same extension suites plus the installer test. Together they cover dispatch policy, worker navigation/progress and Git argument restrictions, worker guard release after failed initialization and all-settled batch failure, compaction/branch-summary phase guarding, managed worktree installation and fresh-session switching, verified PR-specific refs/branches and collision/fetch-failure regressions using local Git repositories, acknowledged queue delivery, and compact assistant status rendering — all without model requests. See [Contributing and CI](#contributing-and-ci) for the required checks and separate integration tests. `node scripts/smoke-cli.mjs` is an opt-in live test that consumes provider usage, creates a temporary Git project, and exercises a general edit, parallel fast helpers and independent review. Its local transcript is in `.local/cli-smoke.jsonl`.

To uninstall, remove the Dispatch extension entry from the `extensions` array in your Pi settings and restore your preferred model defaults from the timestamped settings backup. Installed files and worker transcripts can remain until you choose to remove them.

## Preferred UI trial: Tau

Run `npm run start:tau` in a terminal and open http://127.0.0.1:3001. [Tau](https://github.com/deflating/tau) runs as an extension inside Pi and mirrors the active session. Keep that terminal running. It is the preferred trial for a minimal chat interface; historical sessions are read-only in its browser view, unlike agegr's fuller session manager.

The launcher uses ignored `.local/tau-agent` storage, binds explicitly to loopback, and loads only Tau as an extension. It starts offline to avoid startup downloads. Astra is currently accepted as a custom model ID by the bundled catalog; the UI connection is verified, but subscription model access and orchestration are not. No model requests were used for UI verification.

Tau writes its instance registry under the user's `.pi/tau-instances`. Its upstream settings panel also accesses the global Pi settings file, so the trial's isolated agent directory does not isolate every Tau-specific preference. Appearance customization can use `TAU_STATIC_DIR` without changing Pi itself.

## Alternative UI trial: agegr/pi-web

Run `npm run start:agegr` and open http://127.0.0.1:30141 to compare [agegr/pi-web](https://github.com/agegr/pi-web). Select the Dispatch project directory in its sidebar. The original UI remains available through `npm start`; the default has not been switched while evaluating the replacement.

The alternative pins `@agegr/pi-web` 0.9.1, which uses Pi 0.85.1 and Next.js. It has its own ignored `.local/agegr-agent` directory, seeded once from the existing local settings and credentials. It does not import the other UI's templates or implement our delegation workflow. No fork is needed to run the trial. The initial page opened, but project selection was not verified; Tau was selected before completing that evaluation.

A scoped Next.js 16.3.3 override addresses GHSA-p293-qw3h-jr36 and GHSA-2xp9-vwfh-vxw4 in the UI's pinned 16.3.1 dependency. Keep this override until upstream selects a fixed release.

## Fork UI

`npm run start:fork` runs the Dispatch Web fork of pi-web-ui from a **separate sibling checkout** (`../PiAstra-web-ui`, overridable with `DISPATCH_FORK_DIR`, legacy `PIASTRA_FORK_DIR`) on http://127.0.0.1:8790, using built artifacts only, with isolated agent/UI state and the delegation extension active. The sibling is a local fork branch (`piastra-redesign`, UI commit `fe859057f991861780c87b051113f2a6766b7e1e`) that is **not published to GitHub**; the launcher requires its `dist/server/index.js` and `web/dist/index.html` to be built first. See [FORK_PLAN.md](docs/FORK_PLAN.md) for the approved plan, exact fork baseline, settings layout and current evidence. The launcher copies credential bytes from the existing local path once and never prints or commits them.

## Architecture

Dispatch is its own repository, not a fork of Pi or pi-web-ui. Both upstream packages are pinned npm dependencies. This repository owns role prompts, configuration, launch scripts, and any small Pi extension needed to connect them. Upgrade dependencies deliberately through the lockfile; do not edit node_modules.

The Express dependency has a scoped `qs` 6.16.0 override for GHSA-x5fp-wj9c-mxmx and GHSA-4mjr-xmp4-gh2g. Remove the override when upstream Express selects a fixed version itself.

| Role | Model | Reasoning |
| --- | --- | --- |
| Orchestrator / planner / delegator | Astra | Low |
| General worker | GLM-5.3-Flash | Provider default |
| Fast helpers, multiple concurrent instances | DeepSeek V4.1 Flash, provisional | Not selected |
| Milestone reviewer | Astra | Medium |

## Current state

Repository setup is implemented. The upstream web UI runs locally with isolated settings and authentication. Role prompts are prepared in `roles/`; model choices are in `config/agents.json`.

**CLI delegation is active through the user extension described above.** The older UI templates remain disabled; they are a separate integration. No upstream fork is required.

## Run

Requires Node 22.19+ and Git.

```sh
npm ci
node scripts/setup.mjs --import-auth
npm run doctor
npm start
```

Open http://127.0.0.1:8787. To use another workspace: `node scripts/start.mjs /path/to/project`. Set `DISPATCH_PORT` (`PIASTRA_PORT` alias) to use a different port.

Setup seeds missing settings and preserves existing files. `--import-auth` copies existing Pi credentials from `PI_CODING_AGENT_DIR` or `~/.pi/agent` only if local credentials do not exist. The copy, sessions, and web UI state stay in ignored `.local/`; existing Pi settings are not modified. This is a separate credential copy, so subsequent sign-in/refresh state is independent. The doctor command checks credential presence, not validity, and never prints secrets.

If no credentials are available, sign in with the installed Pi CLI using `.local/agent` as `PI_CODING_AGENT_DIR`. Subscription availability must be verified before model calls. Normal conversations in the setup preview use Astra Low and consume allowance; the setup smoke check itself sends no model requests.

## Contributing and CI

Before opening a PR, run:

```sh
npm ci
npm test
```

[CI](.github/workflows/ci.yml) runs on every PR and pushes to `main`, with no path filters. It checks Linux on Node 22.19.0 (the declared minimum) and Node 24, plus Windows on Node 22. Each job installs from the lockfile and runs the offline tests without credentials, provider calls, or a sibling checkout. npm downloads are cached; `node_modules` is not. Superseded runs are cancelled, and jobs time out after 15 minutes. The workflow can also be dispatched manually.

`npm run test:fork` remains an alias for `npm test`. Fork SDK integration is separate: build the sibling `../PiAstra-web-ui` checkout (or set `DISPATCH_FORK_DIR`, legacy `PIASTRA_FORK_DIR`), then run `npm run test:integration`. It uses synthetic credentials and makes no provider requests, but deliberately fails with setup instructions when the required fork artifacts or SDK are missing. It is not a required CI check. The paid, credential-dependent `node scripts/smoke-cli.mjs` also remains manual. Lint/format migrations and blocking dependency audits are not part of this initial gate.

After the first green GitHub run, configure the `main` branch ruleset to require PRs and these status checks before merging (this is a GitHub setting, not enabled by the workflow file):

- `Tests (ubuntu-latest, Node 22.19.0)`
- `Tests (windows-latest, Node 22)`
- `Tests (ubuntu-latest, Node 24)`

## Fork UI status

The fork UI frontend is implemented in the sibling checkout at commit `fe85905`; the reference images pair the original upstream Codex captures (`codex.png`, `codex_empty_sidebar.png`) with generated Dispatch captures (`astra-01-chat-empty.png`, `astra-02-chooser.png`, `astra-03-files-inline.png`, `astra-04-terminal.png`, `astra-05-empty.png`). The parent-side launcher and integration policy are in place (`npm run test:fork` 15/15, `npm run test:cli` 10/10). The sibling's final typecheck, `build:web` and browser shell runs all pass; an earlier run had a startup empty-state timing flake that did not reproduce in the final passes. No provider/model requests were made, so subscription access in fork sessions is unverified. The CLI workflow and the tau/agegr trials remain available independently.

See [the design brief](docs/IMPLEMENTATION_BRIEF.md) for the agreed direction and open choices.
