# Dispatch fork policy

`extensions/pi-commandcode` is Dispatch-owned integration code vendored from `pi-commandcode-provider` v0.7.1. The upstream source is pinned to commit `6fd0ac75345c3fd9c94aa1638c0e00fe963041b8` (annotated tag `v0.7.1`); provenance, repository, and license are recorded in [UPSTREAM.md](UPSTREAM.md). The fork is MIT-licensed; see [LICENSE](LICENSE).

## Ownership and boundaries

Dispatch owns `index.ts` and the catalog/plan implementation in `src/catalog.ts`, `src/plan.ts`, `src/plan-models.ts`, `src/model-classification.ts` and `src/restore.ts`, the packaged `config/commandcode-model-classification.json`, as well as this documentation. The upstream baseline is retained in `README.upstream.md`. Do not edit the upstream README to document Dispatch behavior.

The catalog split is deliberately conservative:

- `commandcode` is the canonical login and lists no models.
- `commandcode-plan` and `commandcode-api` split the live catalog by the user-owned classification file (`plan`, `free`, `api`, `hidden`; each ID exactly once). Live IDs missing from the file are shown as Unclassified under `commandcode-api`, never assumed plan or API.
- All entries use the canonical shared login, upstream IDs, and upstream transport. None selects a payment source.
- Unknown, unsupported, or inactive plans keep `plan` models out of `commandcode-plan`; they are labelled Plan unverified under `commandcode-api`.

This is not a billing enforcement layer. The server may use purchased credits for GOAT usage after windows or limits; the API view does not force PAYG, and the extension promises no hard spend cap. Pi price metadata is an estimate and remains intact in both views rather than being zeroed for the plan view.

## Update process

1. Pin the upstream commit and retain the provenance in `UPSTREAM.md`.
2. Vendor changes as a reviewed diff; preserve unrelated Dispatch changes.
3. Manually review the live model catalog and plan documentation before changing `config/commandcode-model-classification.json`. Use exact Provider API IDs, not display names.
4. Update its `reviewedOn` date and `sources`, and the count assertions in `tests/model-classification.test.mjs`. Existing users keep their own copy; call out classification changes in release notes.
5. Run the focused plan/catalog tests and check documentation against the actual exports and commands.

Plan documentation is never scraped at runtime. `/commandcode-refresh` rereads the classification file and reloads both the live model catalog and plan status; `/commandcode-status` exposes redacted diagnostics, classification diagnostics and the catalog summary.

On `session_start`, a resumed session's legacy `commandcode/<id>` choice is moved to whichever selector now lists the ID only when the current model is Pi's fallback (never over an explicit `--model` or a non-default model); a legacy default model (global or trusted project settings) only produces a notice. CLI `--model commandcode/<id>` and worker/role configuration that names `commandcode/...` must be updated to `commandcode-plan/...` or `commandcode-api/...` explicitly.
