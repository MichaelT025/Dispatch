# How Dispatch works

Dispatch is its own project, not a fork of Pi: Pi is a pinned dependency, and this repository owns the role prompts (`roles/`), model configuration (`config/agents.json`), the `delegate` tool, and the extensions that tie them together. This page describes what you get inside a session. For install and launch see [Getting started](GETTING_STARTED.md).

## Roles

Every session has one active role. `/agent` opens the picker (`/agent orchestrator|general|fast|review` selects directly), **Shift+Tab** cycles, and the footer shows the current one. Switching changes the model, reasoning level, system prompt and tool set while keeping the conversation; the new model sees the existing history. The chosen role is restored when you resume the session. Switch after the current turn finishes, or stop it first.

| Role | Model | Owns | Access |
| --- | --- | --- | --- |
| Orchestrator | Astra, Low | Your conversation, planning, delegation, milestone review, final verification | Read tools, bash/edit/write, `delegate`, `await_workers`, `cancel_worker`, `continue_worker` |
| General worker | GLM-5.3-Flash (or Codex when Go is skipped) | Implementation, debugging, repair, running tests | Read/write, shell |
| Fast worker | DeepSeek V4.1 Flash (or Codex when Go is skipped) | Bounded research, code search, precise edits | Read/write, shell |
| Review worker | Astra, Medium | Independent Git review of a milestone against its baseline | Read-only tools plus `run_checks` |

`/dispatch` (alias `/piastra`) shows the current role/model choices.

**Choosing models.** With a role active, **Ctrl+L** picks a model (Ctrl+P cycles) and **Ctrl+T** cycles reasoning. Dispatch remembers these per role for the session, restores them on resume, and uses them for future workers of that role. An explicit override is also saved to `<agent dir>/piastra/agents.json` so the next session starts from it; roles are global, so this applies across projects. Delete a role's entry there to forget it. `config/agents.json` in the package is never rewritten.

## Delegation

Only the orchestrator can delegate; it is your main collaborator and the only role that spawns workers. It keeps the conversation and your decisions, plans the work, assigns file ownership, orders dependencies, and decides when a milestone is ready for review. It may read a file itself when a decision depends on it, but bulk investigation and execution go to workers to keep the main context focused. It never reports completion or passing tests from a worker's summary alone.

Try: *"Implement this change using general workers, use fast helpers for investigation, then have the review worker independently inspect the diff against the starting commit."*

How workers behave:

- Each worker gets a **fresh context** containing only its task and the project instructions — never the parent transcript — and none may delegate further.
- All tasks in a batch start **concurrently**, editing workers included; there is no worker cap or queue. The orchestrator coordinates file ownership. Provider rate limits still apply.
- Delegation is **asynchronous**: `delegate` returns as soon as the workers start, and each result comes back into the conversation as a `[dispatch-worker-result]` message that wakes the orchestrator (mid-turn between tool calls, or as a new turn when it is idle). Results finishing within a few hundred milliseconds travel together. The orchestrator can keep working, start more workers, or end its turn while workers run; `await_workers` blocks for specific results when the next step genuinely needs them.
- `continue_worker` re-prompts a finished worker inside its existing session, so a fix-up or follow-up keeps everything it already read. Worker sessions stay attached until the parent session is resumed or closed. `cancel_worker` stops one running worker; edits it already made stay on disk.
- Access is enforced by **tool set**: read-only workers have read/find/grep/ls, an argument-restricted Git inspector, web research, shared-note reading and `run_checks`, but no shell, edit or write. Write-capable workers add shell/edit/write. See [Agent tools](agent-tools.md).
- Stopping the orchestrator's turn does not stop its workers. Cancel with `/cancel <id>` (`/cancel all`, or bare `/cancel` to pick), `x` twice in `/workers`, the Web UI's cancel button, or by asking the orchestrator (`cancel_worker`). Each worker task has a 15-minute timeout. Model errors are returned as-is, never silently swapped to another model.
- Transcripts are saved under `<agent dir>/piastra/runs`; the parent receives a capped summary and the transcript path.
- Review findings go back to general/fast workers for repair; another review happens only when the findings or later changes justify it. There is no automatic review-until-approved loop.
- Upstream/in-framework subagent tools are blocked so `delegate` is the single delegation system.

These are tool restrictions, not an OS sandbox. `run_checks` executes trusted workspace commands from `config/checks.json`, which may write files.

## Watching workers

While workers run, the main chat shows a single aggregate line (`Workers · … · /workers for details`) that tracks live status, and a **Subagents** panel above the editor lists each worker with status and elapsed time (up to 12 rows). The panel stays open while any worker is still running, even after the orchestrator's turn ends, and finished rows stay until the next run. Each result lands in the transcript as a **Worker results** card (Ctrl+O expands the full text).

Press **Ctrl+Shift+W** or run **`/workers`** to open the viewer:

- Picker: Up/Down selects, Enter opens.
- Inside a worker: Left/Right (or Tab/Shift+Tab) switch siblings, Up returns to the parent, Down reopens the picker, Esc returns.
- PageUp/PageDown scroll a page, j/k a line, Home to the start, End follows live output.
- **Ctrl+O** expands or collapses tool details; failed tool output always stays visible.

Each worker remembers its scroll position; incoming output leaves a paused view alone. Workers keep running while the viewer is open. It is an inspection view, not an input — you cannot message workers. Saved views remain available after resuming the parent session.

With the Atelier sidebar enabled, workers also appear in its `piastra:workers` panel; see [Terminal appearance and sidebar](pi-ui.md). Dispatch Web renders the same data in its Workers pane.

## Sessions and worktrees

`/worktree` (alias `/wt`) manages Git worktrees and the sessions in them. New worktrees are created under `~/.pi/worktrees/<repo>/<branch-slug>`; existing ones are found through Git's own worktree list.

- `/wt ls` — pick a worktree and switch to it.
- `/wt add <branch>` — create (or reuse) a worktree for the branch and switch.
- `/wt open <branch>` — switch to an existing worktree.
- `/wt rm` — remove a worktree.
- `/wt pr <number>` — fetch a GitHub PR into a dedicated `piastra/pr/<number>` branch (verified against the PR's head commit; never resets a diverged local branch) and open it.
- `/wt resume` — one picker for every session of the repository across all its checkouts, grouped by checkout with title, message count and age. Pi's own `/resume` only sees the current directory.

Switching starts a brand-new empty session in the target worktree and moves the running CLI there; nothing from the current conversation is copied, and the previous session stays saved. The switch is refused while the agent is busy, messages are queued, workers are running, or a compaction/branch summary is in progress. A created Git worktree is never deleted because a switch was refused or cancelled — the path and recovery commands are printed instead. In Dispatch Web the commands print paths instead of switching.

Housekeeping:

- **Auto-titles.** After the first assistant reply of an unnamed session, the `fast` role's model produces a 3–6 word title, stored exactly as `/name` would. It never overwrites a name you set and skips worker transcripts. Set `"autoTitle": false` in `config/agents.json` to turn it off.
- **No empty sessions.** A session that never received a message is deleted when its runtime shuts down; `/wt resume` sweeps older leftovers.

## Other commands

- `/dispatch-help` (`/dispatch-help shortcuts` jumps to a section) — read-only guide; sends no model request.
- `/q` — queue a follow-up message to send after the current turn.
- `/st` — steer the current turn.
- `/todo` and the Atelier sidebar — see [Terminal appearance and sidebar](pi-ui.md).
- Full leader-key map: [Keyboard shortcuts](shortcuts.md).

## Dispatch Web

`dispatch --web` serves a browser UI for the same sessions, with the agent picker, Workers pane, file and terminal views. It runs the Pi SDK in-process on loopback only; the CLI extension publishes worker state to it over an in-process event channel (`piastra:workers`), so nothing polls. Its source lives in the sibling repository [MichaelT025/DispatchWeb](https://github.com/MichaelT025/DispatchWeb) and is built into the package at release time.
