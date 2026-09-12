# PiAstra

A lightweight Pi setup with Astra planning, OpenCode Go workers, and Astra milestone review.

## Use from any directory

With Pi installed and signed in to Codex and OpenCode Go, run `npm run install:cli` once from this checkout. Then open a terminal in any project and run **`pi`**. `/piastra` shows the role configuration. Restart existing Pi sessions after installation.

Use **`/agent`** to open the agent picker, or select directly with `/agent orchestrator`, `/agent general`, `/agent fast`, or `/agent review`. **Ctrl+Shift+A** cycles in that order. The footer shows the active agent. Each selection changes model, reasoning, prompt and available tools, retaining the conversation; the selected model sees the existing history. The chosen role is restored when you resume that session. Switch after the current turn finishes or stop it first.

Only the orchestrator can delegate. General and fast are directly usable coding agents; review has read-only inspection tools. Delegated workers still use fresh isolated contexts regardless of manual switching.

The installer backs up your Pi settings, preserves unrelated fields, sets the default to Astra Low, and installs a standalone extension copy under `~/.pi/agent/piastra/package`. It uses your existing Pi credentials; no keys are copied into the repository. You can switch branches or move this checkout afterward. Re-run the installer to update the installed extension, prompts or model configuration. If `PI_CODING_AGENT_DIR` is set, that directory is used instead of `~/.pi/agent`; clear the variable to use the normal global installation.

Try: “Implement this change using general workers, use fast helpers for investigation, then have the review worker independently inspect the diff against the starting commit.”

One `delegate` tool provides general GLM-5.3-Flash workers, fast DeepSeek V4.1 Flash helpers, and Astra Medium review. Workers receive a fresh context containing the delegated task and project instructions, not the parent transcript. All tasks in a batch start concurrently, including editing workers, with no PiAstra worker-count cap or batch queue. Astra coordinates file ownership and dependencies. Provider rate limits still apply.

**Watch workers:** press **Ctrl+Shift+W** while they run, or use **`/workers`**. In the picker, Up/Down selects a worker and Enter opens it. Inside a worker, Left/Right (or Tab/Shift+Tab) switches siblings, Up returns to the parent, and Down opens the picker. PageUp/PageDown scrolls a page; j/k scrolls a line; Home goes to the start; End follows live output. Escape always returns to the parent. **Ctrl+O** expands or collapses tool details; failed tool output remains visible. Each worker remembers its reading position while you switch siblings; incoming output leaves a paused view in place. The fixed terminal overlay shows themed Markdown, highlighted code blocks and tool arguments, and source highlighting for file reads. Workers continue running while the viewer is open. This is an inspection view, not an input box for messaging children. Saved worker views are available after resuming their parent session. Large individual content blocks are previewed up to 30,000 characters; the displayed transcript path contains the complete record.

The main delegation card also shows each worker's current tool, target file/command, status and elapsed time in the active theme. **Ctrl+O** expands a bounded preview of recent activity and Markdown response excerpts; use **Ctrl+Shift+W** for the full worker view. This UI activity stays out of the orchestrator's final tool-result text; it still receives concise worker results.

Read-only workers have read/find/grep/ls, an argument-restricted Git inspector and URL fetching. They have no shell, edit, write, extensions or nested delegation. General/fast workers with write access also have shell/edit/write and can run tests. Git review accepts a supplied milestone baseline; reviews do not execute tests. These are tool restrictions, not an OS filesystem sandbox. Worker transcripts are saved in `~/.pi/agent/piastra/runs`; the parent receives a capped summary and transcript path. Cancellation propagates to workers, with a 15-minute per-worker timeout. Model errors are returned explicitly, never replaced with Astra. Non-Astra workers request thinking off; Pi clamps this to model-supported levels (GLM currently uses Low).

Validation: `npm run test:cli` checks dispatch policy, worker navigation/progress and Git argument restrictions. `node scripts/smoke-cli.mjs` is an opt-in live test that consumes provider usage, creates a temporary Git project, and exercises a general edit, parallel fast helpers and independent review. Its local transcript is in `.local/cli-smoke.jsonl`.

To uninstall, remove the PiAstra entry from the `extensions` array in your Pi settings and restore your preferred model defaults from the timestamped settings backup. Installed files and worker transcripts can remain until you choose to remove them.

## Preferred UI trial: Tau

Run `npm run start:tau` in a terminal and open http://127.0.0.1:3001. [Tau](https://github.com/deflating/tau) runs as an extension inside Pi and mirrors the active session. Keep that terminal running. It is the preferred trial for a minimal chat interface; historical sessions are read-only in its browser view, unlike agegr's fuller session manager.

The launcher uses ignored `.local/tau-agent` storage, binds explicitly to loopback, and loads only Tau as an extension. It starts offline to avoid startup downloads. Astra is currently accepted as a custom model ID by the bundled catalog; the UI connection is verified, but subscription model access and orchestration are not. No model requests were used for UI verification.

Tau writes its instance registry under the user's `.pi/tau-instances`. Its upstream settings panel also accesses the global Pi settings file, so the trial's isolated agent directory does not isolate every Tau-specific preference. Appearance customization can use `TAU_STATIC_DIR` without changing Pi itself.

## Alternative UI trial: agegr/pi-web

Run `npm run start:agegr` and open http://127.0.0.1:30141 to compare [agegr/pi-web](https://github.com/agegr/pi-web). Select the PiAstra project directory in its sidebar. The original UI remains available through `npm start`; the default has not been switched while evaluating the replacement.

The alternative pins `@agegr/pi-web` 0.9.1, which uses Pi 0.85.1 and Next.js. It has its own ignored `.local/agegr-agent` directory, seeded once from the existing local settings and credentials. It does not import the other UI's templates or implement our delegation workflow. No fork is needed to run the trial. The initial page opened, but project selection was not verified; Tau was selected before completing that evaluation.

A scoped Next.js 16.3.3 override addresses GHSA-p293-qw3h-jr36 and GHSA-2xp9-vwfh-vxw4 in the UI's pinned 16.3.1 dependency. Keep this override until upstream selects a fixed release.

## Architecture

PiAstra is its own repository, not a fork of Pi or pi-web-ui. Both upstream packages are pinned npm dependencies. This repository owns role prompts, configuration, launch scripts, and any small Pi extension needed to connect them. Upgrade dependencies deliberately through the lockfile; do not edit node_modules.

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

Open http://127.0.0.1:8787. To use another workspace: `node scripts/start.mjs /path/to/project`. Set `PIASTRA_PORT` to use a different port.

Setup seeds missing settings and preserves existing files. `--import-auth` copies existing Pi credentials from `PI_CODING_AGENT_DIR` or `~/.pi/agent` only if local credentials do not exist. The copy, sessions, and web UI state stay in ignored `.local/`; existing Pi settings are not modified. This is a separate credential copy, so subsequent sign-in/refresh state is independent. The doctor command checks credential presence, not validity, and never prints secrets.

If no credentials are available, sign in with the installed Pi CLI using `.local/agent` as `PI_CODING_AGENT_DIR`. Subscription availability must be verified before model calls. Normal conversations in the setup preview use Astra Low and consume allowance; the setup smoke check itself sends no model requests.

## Next implementation step

Connect the web UI to the same delegation extension. The CLI workflow is available independently of the UI trials.

See [the design brief](IMPLEMENTATION_BRIEF.md) for the agreed direction and open choices.
