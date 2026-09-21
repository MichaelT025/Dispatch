# Dispatch fork policy

`extensions/pi-commandcode` is Dispatch-owned integration code vendored from `pi-commandcode-provider` v0.7.1. The upstream source is pinned to commit `6fd0ac75345c3fd9c94aa1638c0e00fe963041b8` (annotated tag `v0.7.1`); provenance, repository, and license are recorded in [UPSTREAM.md](UPSTREAM.md). The fork is MIT-licensed; see [LICENSE](LICENSE).

## Ownership and boundaries

Dispatch owns `index.ts` and the catalog/plan implementation in `src/catalog.ts`, `src/plan.ts`, and `src/plan-models.ts`, as well as this documentation. The upstream baseline is retained in `README.upstream.md`. Do not edit the upstream README to document Dispatch behavior.

The catalog split is deliberately conservative:

- `commandcode` is a live-catalog intersection with a dated, exact, manually reviewed GOAT allowlist.
- `commandcode-api` is the full live API catalog and includes the same known free models.
- Both entries use the canonical shared login, upstream IDs, and upstream transport. Neither entry selects a payment source.
- Unknown, unsupported, or inactive plans fail closed to known free primary models; other models remain API-unverified instead of being claimed as GOAT.

This is not a billing enforcement layer. The server may use purchased credits for GOAT usage after windows or limits; the API view does not force PAYG, and the extension promises no hard spend cap. Pi price metadata is an estimate and remains intact in both views rather than being zeroed for the plan view.

## Update process

1. Pin the upstream commit and retain the provenance in `UPSTREAM.md`.
2. Vendor changes as a reviewed diff; preserve unrelated Dispatch changes.
3. Manually review the live model catalog and plan documentation before changing `src/plan-models.ts`.
4. Record the allowlist's verification date and exact source in its exported constants.
5. Run the focused plan/catalog tests and check documentation against the actual exports and commands.

Plan documentation is never scraped at runtime. `/commandcode-refresh` reloads both the live model catalog and plan status; `/commandcode-status` exposes redacted diagnostics and the catalog summary.

When restoring sessions, legacy premium `commandcode` model IDs are placed under `commandcode-api`. Any worker or configuration that names an old premium `commandcode` provider ID may need to be updated explicitly.
