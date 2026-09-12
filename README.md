# PiAstra

A lightweight Pi setup with Astra planning, OpenCode Go workers, and Astra milestone review.

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
