# PiAstra — Design Brief

**Status:** Repository and local UI setup started; delegation integration pending  
**Target machine:** `LEGIONX`  
**Project path:** `C:\Users\micha\Documents\Projects\Personal\PiAstra`  
**WSL equivalent:** `/mnt/c/Users/micha/Documents/Projects/Personal/PiAstra`

## Direction

Use Pi for a fast, lightweight coding-agent runtime and an existing web UI for a comfortable desktop-style chat experience. Reuse `pi-web-ui` before considering UI changes.

Use the existing OpenCode Go and Codex subscriptions together. Astra handles the main conversation, planning, and delegation at Low reasoning, with an independent Astra Medium subagent reviewing meaningful milestones. Go workers absorb investigation, implementation, and routine repair.

The review subagent is invoked inside the main task and reports back to the orchestrator; the user does not need to start a separate review conversation. GLM-5.3-Flash is selected for general work; DeepSeek V4.1 Flash is the provisional fast model. "Astra light" is interpreted as Low reasoning.

## Agents: one orchestrator and three subagent types

```text
pi-web-ui → Pi
└── 0. Orchestrator / planner / delegator     Astra Low, Codex subscription
    ├── 1. General                          Go GLM-5.3-Flash
    ├── 2. Fast × N                         Go DeepSeek V4.1 Flash, provisional
    └── 3. Review                           Astra Medium, Codex subscription
```

Four roles do not mean four agents must run on every task. Spawn only the workers needed. Multiple fast helpers may run concurrently on independent tasks; the concurrency cap remains to be chosen.

| Role | Job | Model decision |
| --- | --- | --- |
| 0. Orchestrator | Talk with the user, plan, delegate, retain decisions, and coordinate completion | Astra Low through Codex |
| 1. General | Handle substantial delegated work, implementation, debugging, tests, and repairs | Go GLM-5.3-Flash |
| 2. Fast | Search code, read docs, research focused questions, or make quick precise edits | Cheap, fast Go model; DeepSeek V4.1 Flash is the current candidate |
| 3. Review | Independently inspect milestone changes against the user's requirements | Astra Medium through Codex |

Astra Low should make decisions from focused evidence instead of loading every file and tool transcript. It can inspect a relevant source when necessary, but delegates bulk reading and execution. It sends workers the task, relevant requirements, and known useful context; workers return concise results with paths, sources, changes, and checks as appropriate. No rigid report schema is required.

The general worker owns tasks that require sustained reasoning or iteration. The fast role handles bounded work with a clear answer or a precise change. If an edit turns into ambiguous debugging or a broader change, it returns that uncertainty to the orchestrator for reassignment rather than expanding its scope.

The fast role has two task-level tool scopes, not two separate agent types: research/read-only and precise edit. Research helpers return sources and relevant excerpts or file locations so their conclusions can be checked. Editing helpers receive explicit target files and a narrow outcome, and run proportionate validation.

Parallel research is a core capability. As a proposed simple starting rule, serialize edits across general and fast workers while allowing independent read-only tasks to run together. Fast helpers still make precise edits, but multiple helpers do not write concurrently until we explicitly choose how to handle overlapping changes. Avoid building a file-locking or merge system for the initial version.

Only the orchestrator spawns subagents. Use fresh, focused child contexts rather than automatically copying the full parent history; allow follow-ups when an existing worker's context is useful. Use completion events or existing wait tools instead of repeated polling. Keep at most one milestone reviewer active.

## Milestone review

A milestone is a coherent result that can be checked, such as a completed login flow or a reproduced and fixed bug. Avoid a review after every edit, and avoid waiting until an entire application is finished.

Give the Astra Medium reviewer:

- The original user requirements, subsequent decisions, and the milestone's intended outcome.
- The milestone's starting commit and any pre-existing working-tree changes.
- Relevant test commands and their actual results.
- A short worker summary for orientation, without copying the full parent transcript.

The reviewer uses Git and file-reading/search tools to inspect the actual work. It checks surrounding code where needed and evaluates the result against the requirements. The summary is supporting context, not proof of correctness.

The comparison must cover committed, staged, unstaged, and new untracked files belonging to the milestone. Plain `git diff` misses staged and committed changes as well as untracked files. Record the starting state so unrelated user edits are not confused with the agent's work. The implementation should use existing Git/session facilities where possible; this does not require automatically committing user files or building a snapshot service.

Keep the review target stable while Astra inspects it. Return concise actionable findings with file locations, explanations, and any unverified assumptions. A review finding is a reason to investigate and fix, not a requirement for the parent to apply suggestions blindly. No findings means no problems were found within the reviewed scope, not a guarantee of correctness.

The orchestrator delegates valid findings to the general worker or a fast editor for repair and relevant checks. Repeat Astra Medium review only when the findings or subsequent changes warrant it. Avoid an unconditional review-until-approved loop.

Use an independent child context and the existing completion/wait mechanism. Keep review transcripts available for inspection without injecting them into the parent's context. Start with Git/read/search access; targeted test execution is a capability to decide during setup, since test commands can write files even when the reviewer does not edit source.

## OpenCode Go candidates — model selection still open

Public allowance snapshot checked **2026-09-11**. These are published allowances, not the account's remaining usage. Source: [OpenCode Go usage documentation](https://opencode.ai/docs/go/#usage-limits).

| Model | Included monthly usage | Estimated requests / 5 hours |
| --- | ---: | ---: |
| Kimi K3 | $15 | 110 |
| Kimi K2.7 Code | $60 | 1,350 |
| MiniMax M3 | $60 | 3,200 |
| GLM-5.2 | $60 | 880 |
| GLM-5.3-Flash | $60 | 6,320 |
| MiMo-V2.5 | $60 | 30,100 |
| DeepSeek V4 Pro | $15 | 1,050 |
| DeepSeek V4 Flash | $30 | 13,000 |
| Qwen3.8 Flash | $30 | 5,400 |
| Qwen3.7 Plus | $60 | 4,300 |

Limits are per model: 20% of its monthly allowance per five hours, 50% weekly, and 100% monthly. Request estimates assume different, heavily cached workloads; they are not comparable task counts or speed benchmarks. Input, output, and cache prices matter.

[Go's landing page](https://opencode.ai/go) advertises temporary 4× usage for DeepSeek V4.1 Flash: $60/month and 26,000 estimated requests per five hours. The detailed docs still list $15 and 6,500. Confirm the applicable promotion in the account before relying on it.

This table is an allowance comparison, not a quality ranking. GLM-5.3-Flash is selected for general delegated work; DeepSeek V4.1 Flash is the provisional fast model. Evaluate useful completed work, responsiveness, tool reliability, and allowance consumption on our tasks. A model with more advertised requests can still require more repairs or take longer. Multiple helpers using the same model share its allowance; spawning more helpers does not create extra capacity.

Questions for the next design discussion:

- What reasoning setting should GLM-5.3-Flash use, if its provider exposes a choice?
- Should DeepSeek V4.1 Flash be the fast model, after checking responsiveness and precise-edit reliability?
- How many fast helpers should be allowed at once, and is serializing writes sufficient initially?

## Quality and savings expectations

Moving the same Astra model to Pi does not inherently weaken its reasoning. Harness behavior, tools, reasoning settings, state retention, and compaction can affect results. Quality parity with official Codex is unverified; a quality downgrade is also not established. See [Astra guidance](https://developers.openai.com/api/docs/guides/latest-model).

The reviewer reduces dependence on potentially misleading worker summaries by checking evidence directly. It can still miss defects, and a late review cannot recover time spent following the wrong approach.

The goal is more successful work from the subscriptions already paid for. Subscription limits still apply. Both Astra Low orchestration and Astra Medium review consume Codex allowance. The expected saving comes from offloading bulk reading and execution, not merely a smaller UI or prompt. Excessive coordination, repeated reviews, and worker repairs can consume the benefit. Context, reasoning, tools, and caching all affect Codex usage; see [Codex pricing and usage](https://learn.chatgpt.com/docs/pricing).

Before investing in custom infrastructure, try a few representative tasks and compare correctness, elapsed time, user corrections, and allowance consumed. A small record of real outcomes is sufficient initially; a benchmark framework is not required.

## Keep the implementation small

The current [pi-web-ui README](https://github.com/xing-shuyin/pi-web-ui) documents subagent spawning, model overrides/templates, result collection, steering, and cancellation. Verify those features with the installed version and configure them first. Add glue only for a demonstrated gap.

When implementation is requested:

1. Verify Pi, the UI, Go access, and Astra subscription access with the intended reasoning setting.
2. Configure Astra Low as the parent and general, fast, and Astra Medium review templates using existing facilities once worker models are selected.
3. Verify independent fast helpers can run together, and a fast helper can make a narrowly scoped edit under the agreed write rule.
4. Complete one real milestone with delegated work, review its full changes, and delegate any valid repairs.
5. Check whether the result is useful, responsive, and economical before adding infrastructure or UI features.

Keep the UI local, bound to loopback, with credentials on the server. Confirm actual tool permissions during setup rather than assuming a role prompt enforces read-only access.

Use these four roles as simple prompts/templates and existing subagent tools. No custom orchestration framework, rigid report schema, automatic model-market router, recursive agent tree, custom agent dashboard, or separate Quick/Orchestrated profile system is needed. Worker models, concurrency, and write rules remain design decisions to settle before implementation begins.
