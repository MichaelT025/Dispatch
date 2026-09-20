# Native agent tools

Dispatch uses the same custom-tool factory for the main agent and delegated workers. No MCP server or skill is required. Role switching replaces tool allowlists; workers receive only their permitted tools.

## Web research

- `web_search({query, max_results?})`: Tavily search; 1–10 results (default 5), titles, URLs and snippets. Set `TAVILY_API_KEY` in the environment before launching Dispatch. Without it, search returns a clear configuration error. Queries go to Tavily: do not send secrets. API charges/limits are separate from model subscriptions.
- `fetch_url({url})`: native HTTP(S), HTML-to-text conversion preserving blocks, code and links. Supports text, JSON and XML, not PDF or browser/JavaScript rendering. No key required. Public-IP-only DNS resolution is pinned to the connection; each redirect is revalidated. Private, loopback, link-local and reserved addresses are rejected. There is a 30-second total deadline, five-redirect limit, 2MB response limit and 40,000-character output limit, with explicit truncation notices.

Fetched pages, search results and notes are **untrusted reference material**, never instructions. Network proxies/browser cookies are not used.

## Check evidence

`run_checks({})` lists named checks. `run_checks({name: "test"})` runs one. Available to all roles, including review and read-access workers, without enabling `bash`.

The catalog belongs to the **current trusted workspace**, at `config/checks.json`:

```json
{
  "checks": [
    { "name": "test", "command": ["npm", "test"] },
    { "name": "test-cli", "command": ["npm", "run", "test:cli"], "timeoutMs": 180000 }
  ]
}
```

An absent catalog defaults to the two commands above; malformed catalogs fail rather than falling back. An empty list disables all checks. Only Pi-trusted workspaces may execute checks. The model supplies a name, **not** shell text, arguments, cwd or environment overrides. Node/npm are resolved to executable scripts, including on Windows. Other catalog executables must be directly executable (not `.cmd` shell wrappers). Default deadline: 180 seconds; catalog deadlines capped at 600 seconds. Timeout/cancellation terminates the process group on POSIX. On Windows a fixed PowerShell supervisor puts a waiting Node runner in a kill-on-close Job Object before releasing it, containing descendants even if their launcher exits. The supervisor accepts only encoded catalog arguments, never model-supplied PowerShell. Windows PowerShell and Add-Type must be available; setup failure prevents the check from starting.

**This is not a sandbox or a guarantee of read-only behavior.** Approved commands, npm lifecycle scripts and tests execute repository code with process permissions and may write files or contact services. Trust the catalog and reviewed code; avoid concurrent editing while verifying. Inspect Git status after checks. A check's allowlist does not make a malicious test safe.

Results include command, cwd, duration, exit status, bounded TAP failure diagnostics (including nested failures), stderr and a saved log path under `<agentDir>/piastra/runs/<parent-session>/checks/`. Output capture is bounded; truncation is marked. Failed checks are returned as structured evidence (`details.status`/`exitCode`) rather than throwing away the result. Configuration errors throw. Logs may contain repository output/secrets; keep them local.

## Git inspection

`inspect_git` supports `status`, `diff`, `stat`, `log`, `show`, `blame`.

- `stat` = `git diff --stat <baseline-or-HEAD>` including staged/unstaged changes.
- `blame` requires `path` (repo-relative, including dotfiles, spaces and Unicode); optional `revision` defaults to HEAD.
- `path` is only accepted for blame; status accepts no revision.
- External diff/textconv helpers are disabled. Inspect untracked files separately.

## Shared session notes

- `write_note({name: "api-audit.md", text: "Sources and findings..."})`: only write-capable agents.
- `read_note({name: "api-audit.md"})` and `list_notes({})`: all roles.

Stored at `<agentDir>/piastra/runs/<parent-session-id>/notes/`, not in the repository or worker transcript. **All delegation batches in the parent session share the same notes**; resume keeps them, new/forked sessions get separate stores. Identity is supplied by the runtime, not the model. Notes are not branch-versioned: navigating within the same session retains them, so check recorded baselines for staleness.

Names are simple letters/numbers/dashes/underscores with optional `.md`. Notes are capped at 40KB UTF-8 and published atomically, create-only: use a new name to update findings, avoiding sibling overwrites. Include sources and Git baseline, never credentials. Read-only workers cannot publish notes; the orchestrator can save their returned findings. Assign note ownership and order dependent tasks rather than expecting concurrent readers to wait for writers. Notes/logs persist until you delete their session run directory; no automatic retention policy is imposed.

## Installation and verification

`npm install` installs the parser/IP-validation dependencies. `npm run install:cli` updates the standalone extension and its complete runtime dependency closure. Reload/restart Pi after installation to expose new tools.

`npm test` and `npm run test:cli` include offline web transport tests, real subprocess/check execution (including Windows npm and process-tree cancellation), Git temp-repository tests, session-note/role/SDK tests, and standalone installed-runtime tests. Real Tavily search still requires an API key and is not part of the offline suite.

## Worker tools (orchestrator only)

| Tool | Purpose |
| --- | --- |
| `delegate({tasks})` | Starts one worker per task and returns immediately with their ids. Each result arrives later as a `[dispatch-worker-result]` message. |
| `await_workers({ids?})` | Blocks until the listed workers (default: all running) finish and returns their results. Results returned this way are not delivered again as a message. |
| `cancel_worker({id})` | Aborts one running worker and returns its final state. |
| `continue_worker({id, task})` | Re-prompts a finished worker in its existing session (same role and access), keeping its context. Unavailable once the parent session has been resumed. |

Result messages are persisted custom messages, so a resumed session still contains every worker result; workers that were still running when the session ended restore as `interrupted`. Compaction and branch summaries defer result delivery until they finish.
