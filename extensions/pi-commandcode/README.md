# Dispatch Command Code provider

This is Dispatch's owned Command Code provider fork for its bundled Pi runtime. It is vendored from upstream `pi-commandcode-provider` v0.7.1; see [FORK.md](FORK.md) and [UPSTREAM.md](UPSTREAM.md) for provenance and maintenance rules. The upstream README is retained as `README.upstream.md` and is not the contract for Dispatch's catalog split.

Authenticate once through `/login` → **Command Code** (or `COMMAND_CODE_API_KEY`). The provider entries below share that canonical login, the same upstream model IDs, and the same upstream transport. Choosing a selector is presentation and entitlement guidance; it does not select a funding source or add a billing request option. **Command Code's service decides what each request is charged against**, whatever label Dispatch shows.

## Provider IDs

| ID | Purpose |
| --- | --- |
| `commandcode` | Canonical login. Owns `/login`, stored credentials and the `auth.json` entry. Lists no models. |
| `commandcode-plan` | `free` models (labelled **Free**) and, once an active GOAT plan is verified, `plan` models (labelled **GOAT**). |
| `commandcode-api` | `api` models (labelled **API / extra credits**), live models missing from the classification (labelled **Unclassified**), and `plan` models while the plan is unverified (labelled **Plan unverified**). |

Each live model appears in at most one selector. Use `commandcode-plan/<id>` or `commandcode-api/<id>` with `--model`, in worker/role configuration, and in `settings.json`.

In Dispatch 0.2.1 and earlier the plan-facing selector was `commandcode`. Pi can no longer resolve a saved `commandcode/<id>`, so it falls back to another model; on `session_start` Dispatch handles that as follows:

- **Resumed session whose last model was `commandcode/<id>`:** switched to whichever selector now lists the ID, with a notice — but only when the current model is Pi's fallback. An explicit `--model` is never overridden, and neither is a model other than the default Pi would have fallen back to (for example one passed by a Dispatch worker or another SDK caller).
- **New session whose effective default is `commandcode/<id>`:** a notice naming the new ID; the session model is not changed, because an explicit model from an in-process caller cannot be told apart from Pi's fallback. The effective default is resolved by Pi's own settings manager, so a trusted project `.pi/settings.json` overrides the global one as it does for Pi; untrusted project settings are ignored.
- **Model moved between `commandcode-plan` and `commandcode-api` by a classification edit:** switched to the same ID under its new selector.

Switches are session-level; select the model with `/model` once to persist a new default. `--model commandcode/<id>` on the CLI and worker/role configuration are not rewritten.

## Model classification file

Plan eligibility is not available from the Provider API: `/provider/v1/models` only says which models exist. Dispatch therefore reads a user-owned JSON file:

```
~/.dispatch/agent/commandcode-model-classification.json
```

(`$PI_CODING_AGENT_DIR/commandcode-model-classification.json` in a plain Pi; override with `COMMANDCODE_MODEL_CLASSIFICATION=/path/to/file.json`.)

```json
{
  "version": 1,
  "reviewedOn": "2026-09-25",
  "plan":   ["meta/muse-spark-1.3-contributor", "gpt-5.6-sol", "..."],
  "free":   ["stealth/space-bunny-alpha", "poolside/laguna-s-2.1-free", "inclusionai/ling-3.0-flash-sante:free"],
  "api":    ["claude-opus-5-5", "gpt-6-astra", "..."],
  "hidden": []
}
```

- Use exact, case-sensitive IDs from `https://api.commandcode.ai/provider/v1/models` (not display names or page slugs).
- Every ID must appear **exactly once** across `plan`, `free`, `api` and `hidden`. `hidden` keeps a live ID out of both selectors (for example a headless-only model). Other keys such as `$comment` and `sources` are ignored.
- The file is created from Dispatch's packaged defaults (`config/commandcode-model-classification.json`) the first time it is missing. Dispatch never overwrites it afterwards, including on upgrade; compare against the packaged copy when a new release updates it.

### Edit and refresh

1. Edit the file.
2. Run `/commandcode-refresh`, or start a new session. Both reread the file; no reinstall or restart is needed.
3. Run `/commandcode-status` to see the file path, whether it was used, per-list counts, unclassified live IDs and stale IDs.

Diagnostics (shown on refresh, in `/commandcode-status` and as `[commandcode]` startup warnings):

- **Unclassified**: a live ID in no list. It is shown under `commandcode-api` as **Unclassified** — not assumed to be plan or API — until you classify it.
- **Stale**: a classified ID the live catalog no longer lists. It is ignored; remove it if the model was retired.
- **Invalid file** (bad JSON, wrong `version`, non-string entries, or an ID listed twice): the file is left untouched and every problem is reported. Dispatch keeps the last valid copy read in this process, or falls back to the packaged defaults on a fresh start.
- **Missing and uncreatable**: the packaged defaults are used and the write error is reported.

### Limitations

- Classification is your assertion. Dispatch does not verify per-model entitlement; it only checks that the account has an active GOAT subscription (`/alpha/billing/subscriptions`) before listing `plan` models under `commandcode-plan`. Other plan tiers (Go, Pro, Max) are reported as unverified.
- Plan documentation is never scraped at runtime. The packaged defaults were reviewed on 2026-09-25 against the live Provider API (81 IDs) and <https://commandcode.ai/docs/plans/goat> (60 GOAT entries: 56 plan, 3 free, and Jev, which is headless/Provider-API only and absent from the interactive catalog).
- Plan models can consume purchased credits after plan limits. Displayed prices are pi estimates retained in every selector; they are not a guarantee of what Command Code charges, and there is no hard spend cap.

## Discovery, refresh, and diagnostics

The live catalog is loaded from the Provider API and cached separately in `commandcode-models.json` (machine-written on every refresh, so it is not a place for edits). Startup waits for bounded catalog/plan verification even with a warm cache, so CLI model listing does not exit with an incomplete plan view. If verification fails, cached models remain available with plan models labelled unverified under `commandcode-api`. `/commandcode-refresh` refreshes and re-registers the model catalog, rereads the classification file and reloads plan status, while preserving the last valid catalog if a refresh fails. Neither command changes billing routing.

## Updating

Dispatch owns the fork. Upstream source is pinned to the commit recorded in [UPSTREAM.md](UPSTREAM.md) and licensed MIT (`LICENSE`). Updates are deliberate vendoring changes: pin a specific upstream commit and review the diff manually. Keep `README.upstream.md` as the unmodified upstream reference; update this README and `FORK.md` when Dispatch behavior or the update process changes.

See `src/model-classification.ts`, `src/plan-models.ts`, `src/catalog.ts`, `src/restore.ts` and `src/plan.ts` for the implementation. The extension entrypoint is `index.ts`.
