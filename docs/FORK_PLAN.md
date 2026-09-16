# Fork UI plan and status (pi-web-ui fork)

Approved direction (per reference screenshots in `docs/reference/`): the original visual references are the upstream Codex captures `codex.png` / `codex_empty_sidebar.png`; the generated Dispatch captures are
`astra-01-chat-empty.png`, `astra-02-chooser.png`, `astra-03-files-inline.png`,
`astra-04-terminal.png`, plus `astra-05-empty.png`. (Older generated
`astra-01-initial.png` and `astra-03-files.png` were superseded and removed at
milestone time.) The target is a browser UI with left history/projects, main
chat, optional right chooser (Files / Review / Terminal) and a bottom terminal.
Browser/Side chat variants are deferred. The UI frontend is implemented in the
sibling checkout; the parent-side launcher and integration policy are in place.
This document tracks the parent-side launcher, integration policy and evidence.
The existing CLI delegation flow is unchanged.

## Fork baseline

- Sibling checkout: `../DispatchWeb` (overridable with `DISPATCH_FORK_DIR`,
  legacy `PIASTRA_FORK_DIR`),
  branch `piastra-redesign`.
- Exact baseline: commit **1e54fafa00c754914e58441ee7315f2d15e87bfe**
  (`v0.80.0`, log head on 2026-09-12).
- UI implementation commit: **fe859057f991861780c87b051113f2a6766b7e1e**
  ("feat: add PiAstra chat and optional workspace shell") on `piastra-redesign`.
- Preexisting working-tree modifications (reported, not discarded):
  - `plugins/mermaid/client/vendor/mermaid.bundle.mjs`,
    `plugins/run-trace/client/vendor/vis-timeline.bundle.mjs`,
    `plugins/run-trace/client/vendor/vis-timeline.css` — content-identical to
    HEAD after EOL normalisation (`git diff --stat` is empty; CRLF rewrite only,
    consistent with a local vendor rebuild on Windows). No semantic drift found.
  - `web/src/App.tsx`, `web/src/components/FilePreview.tsx` — owned by the UI
    worker (interrupted setup); out of scope here, untouched and not reverted.
- Build prerequisites verified: Node v22.22.0, TypeScript 5.9.3, `npm run
  build:server` in the fork exits clean and regenerates `dist/server`. The launcher
  requires `<fork>/dist/server/index.js` and `<fork>/web/dist/index.html` and fails
  with the build command otherwise.

## Launcher

```
npm run start:fork [workspace]        # node scripts/start-fork.mjs
```

- Requires `npm run setup` first (checks `.local/agent/settings.json`).
- Runs the fork's built artifacts directly (`node <fork>/dist/server/index.js …`),
  bypassing `bin/pi-web-ui.mjs`'s service-install/version-check layer. `npm start`
  and every other CLI flow are untouched.
- Loopback only (`--host 127.0.0.1`), port `DISPATCH_FORK_PORT` (legacy `PIASTRA_FORK_PORT`, default **8790**;
  8787 = original UI, 3001 = Tau, 30141 = agegr trial, 8789 = occupied by an
  unrelated local DSH server on this machine).
- Isolated agent dir `.local/fork-agent`: settings.json is written fresh with the
  model defaults from `config/agents.json` plus a deliberate absolute path
  reference to this checkout's Dispatch extension (`extensions/piastra/index.ts`,
  loaded through the SDK's `settings.json → extensions` mechanism — no copies of
  extension code). The launcher copies `auth.json` / `models-store.json` /
  `models.json` bytes **only** from the existing local credential path
  `.local/agent`, **once**, when missing; it never prints or commits them and the
  copies stay in ignored `.local/`. Credential refresh state in `fork-agent` is
  therefore a copy (same trade-off as the Tau/agegr trials); re-seeding only
  happens into an empty directory. Tests never use these files: they build
  synthetic auth and a temporary agent dir.
- Isolated UI state `.local/fork-web`: client-state.json is seeded with
  `disabledAgentTools` (see policy below) and Dispatch role subagent templates
  staged disabled, plus the seeded-roster sidecar so the fork does not auto-add
  its six built-in templates.
- Global Pi settings, the user's global extension install and the settings used
  by `npm start` (`.local/agent`, `.local/web`) are not modified. The launcher
  copies credential bytes but never prints or commits them; `.local/` stays
  ignored.

## Single delegation system

1. Fork client state: all upstream inline tools are disabled at the SDK active set
   level (server `tool-manager.ts` `applyAgentToolsGating` on every session
   creation/reload — a real active-set removal, not panel hiding):
   `subagent_spawn`, `subagent_get_result`, `subagent_steer`, `subagent_list`,
   `subagent_stop`, `subagent_wait_all`, `subagent_templates`, `delegate_task`,
   the AI-terminal tools, `edit_soft`.
2. Dispatch extension hard block (defence in depth, active in every Dispatch
   session incl. the CLI): a `tool_call` handler returns
   `{ block: true }` for every upstream delegation tool even if someone
   re-enables them in the fork settings panel. (`extensions/piastra/index.ts`,
   list lives in `extensions/piastra/policy.mjs` — `UPSTREAM_DELEGATION_TOOLS`.)
   The only delegation tool remains the extension's `delegate`.
3. Role tools are exact allowlists (`agentTools(role)`), not a union: each
   switch replaces the active set with that role's fixed list, so foreign/unknown
   tools — fork extras (`todo_list`, terminal tools, `edit_soft`), upstream
   delegation, anything arbitrary — cannot leak into any role. Read side for all
   roles: read/grep/find/ls/inspect_git/fetch_url/web_search/run_checks plus
   note reading (read_note/list_notes); run_checks executes only allowlisted
   commands from the trusted workspace's config/checks.json. Review can run
   checks but cannot edit source; test execution is not a filesystem sandbox.
   Shared notes are scoped to the parent session (not one delegation batch).
   See [agent-tools.md](agent-tools.md) for configuration and trust boundaries.
   Orchestrator adds bash/edit/write/write_note + delegate. General and fast
   add bash/edit/write/write_note. Review gets the read side only (no bash,
   edit, write, write_note, terminal, delegate). Verified by extension unit
   tests and a live-SDK role switch test.

## Environment / coordination notes for the UI worker

- Server env always available upstream: `PI_WEB_TABS` (already used conceptually
  for hiding deferred tabs later), `PI_WEB_HOST`, `PI_WEB_TOKEN`, etc. No fork
  server source edits were needed; none of the new behaviour depends on fork
  server changes.
- New parent-side env: `DISPATCH_FORK_PORT` (legacy `PIASTRA_FORK_PORT`, number, default 8790),
  `DISPATCH_FORK_DIR` (legacy `PIASTRA_FORK_DIR`, fork checkout path). Launcher CLI: first positional
  argument is the workspace, same as `npm start`.
- The fork session or model panel can freely switch models; Dispatch role
  switching rides on top via the `/agent` slash command (extension commands are
  surfaced by the fork's slash-command picker; `/dispatch` canonical, `/piastra` alias).

## Verification evidence (no model requests used)

- `npm run test:cli` — 10/10 pass (baseline tests, incl. updated role-tool tests).
- `npm run test:fork` — 15/15 pass: launcher artifact/port/seeding tests plus
  extension tool-policy tests. Credential/agent fixtures are synthetic and use
  temporary directories; no real secrets are read and no provider request is
  made.
- Fork UI browser checks in the sibling checkout: the final typecheck,
  `build:web` and Astra-shell browser runs **all pass** (twice, after the
  terminal fixes) at sibling commit `fe859057f991861780c87b051113f2a6766b7e1e`.
  The shell E2E runs against the real empty state and locally created
  conversations, no fixture route and no provider calls. An earlier run hit a
  startup empty-state timing flake (assertion raced the rendered empty state);
  it did not reproduce in the final passes and is recorded here as a known
  timing sensitivity, not a functional failure.
- Live SDK integration (`tests/integration/fork-runtime.test.mjs`, runs against
  the fork's own SDK via `npm run test:integration`; now explicitly fails with
  setup instructions when the checkout is absent): extension loads in a
  fork session with zero load errors, `delegate` active and subagent tools
  absent after bind; `/agent general` switches the session model to
  `opencode-go/glm-5.3-flash` (no model request).
- End-to-end smoke: `start:fork` booted the fork server
  (`/api/health` → ok, piVersion 0.84.4, engine pi), a raw WebSocket hello
  received `slash_commands` containing `agent`, `piastra`, `model`, `resume`
  with no error notices; server then stopped cleanly.

## Assumed / not yet verified

- Fork-side `applyToolGating` on session creation is verified in the fork source
  (`agent-service.ts` line ~1805 calls it right after session creation); a live
  protocol-level inspection of the model-visible tool list was not done.
- The fork UI frontend is implemented in the sibling checkout and its final
  typecheck, `build:web` and browser runs all passed at sibling commit
  `fe859057f991861780c87b051113f2a6766b7e1e`. Subscription-model availability in
  fork sessions remains unverified — no provider/model requests were made, so
  model access/subscription is unconfirmed.
- Fork auth copy will not track future `.local/agent` credential refreshes until
  re-seeded into an empty `fork-agent` (deliberate isolation trade-off).

## TODO (approved plan)

- [x] Fork baseline verified, build prerequisites confirmed
- [x] `npm run start:fork` launcher (loopback, isolated state, seeded settings)
- [x] Dispatch extension loads in fork sessions (settings-managed path)
- [x] Upstream subagent/delegation tools disabled (seed + hard block)
- [x] Role switching verified over SDK (`/agent`)
- [x] UI frontend implemented in sibling checkout (chat, chooser, inline files,
      bottom terminal); final typecheck/`build:web`/browser runs all pass at
      sibling commit `fe85905`
- [x] Re-run browser checks after the terminal bug fixes (all pass twice)
- [ ] Browser/Side chat tabs deferred
- [x] End-of-plan: doctor + docs updated for the milestone
