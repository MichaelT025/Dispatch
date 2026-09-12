# PiAstra

A lightweight Pi setup with Astra planning, OpenCode Go workers, and Astra milestone review.

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

**The multi-agent workflow is not active yet.** Templates are deliberately disabled. Inspection of pi-web-ui 0.80.0 found that template normalization does not retain per-role reasoning settings, and unavailable worker models can fall back to the parent model. Tool scopes also need runtime enforcement; a read-only prompt alone is insufficient. These must be covered by a small integration and verified before enabling delegation. No upstream fork is currently planned.

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

Implement and verify per-role effort, explicit model selection without fallback, reviewer read/Git access, child spawning restrictions, and concurrent fast helpers with serialized writes. Reuse upstream subagent lifecycle and UI wherever possible. A full milestone run is the acceptance check; the installed UI alone does not prove orchestration works.

See [the design brief](IMPLEMENTATION_BRIEF.md) for the agreed direction and open choices.
# DSH-style UI prototype

Run `npm run start:dsh` from this repository, then open http://127.0.0.1:8789.
Run `npm run setup -- --import-auth` first if the local Pi credentials have not been seeded yet.

This is the current UI direction on `feat/dsh-pi-webui`: a small React shell connected directly to Pi's SDK, with DSH design tokens and DSH-better-sidebar's real syntax-highlighted file/diff renderer. Upstream attribution and pinned source revisions are in `web/vendor/README.md`. No fork of Pi or DSH's runtime is required.

Available now:
- Streaming chat, stop, model selection for new chats, and reopening saved Pi conversations.
- Project file browsing with read-only text previews.
- Combined staged/unstaged changes against HEAD, plus untracked text files, with line numbers and inline change highlighting.

The server binds to loopback, checks Host/Origin, and uses the ignored `.local/agent` credentials and `.local/dsh-sessions` store. Browser previews are constrained to the repository and omit private state, environment files, binaries and files over 500 KB. Pi's coding tools retain their normal host permissions; this is a trusted local development UI, not an agent sandbox or a remote multi-user service. Extensions and skills are disabled for this first adapter.

Still to add: delegation, file editing, per-file review comments, expanded tool transcripts, rich image/PDF previews, and Git context-fold expansion. The Git pane currently shows the net change against HEAD, not separate index/worktree patches. Restart the launcher to rebuild after source edits. The earlier UI launchers below remain available for comparison.

Validation: `npm run test:web`. The first live smoke test successfully returned a short Astra response through Pi; model-heavy coding and multi-agent flows are not yet validated.
