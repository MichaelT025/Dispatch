# Dispatch Command Code provider

This is Dispatch's owned Command Code provider fork for its bundled Pi runtime. It is vendored from upstream `pi-commandcode-provider` v0.7.1; see [FORK.md](FORK.md) and [UPSTREAM.md](UPSTREAM.md) for provenance and maintenance rules. The upstream README is retained as `README.upstream.md` and is not the contract for Dispatch's catalog split.

Authenticate once through `/login` → **Command Code** (or `COMMAND_CODE_API_KEY`). The API / Extra credits entry directs you back to this shared login rather than storing a second credential. The two provider entries below share that canonical login, the same upstream model IDs, and the same upstream transport. Choosing a catalog entry is presentation and entitlement guidance; it does not select a funding source or add a billing request option.

## `commandcode`: verified GOAT subset

`commandcode` is the verified GOAT view. It is the intersection of the live Provider API catalog with Dispatch's dated, exact allowlist in `src/plan-models.ts` (`GOAT_VERIFIED_ON`, source: <https://commandcode.ai/docs/plans/goat>). The allowlist is manually reviewed and is not inferred from names, prices, prefixes, or availability. Known free models are retained in this primary view:

- `poolside/laguna-s-2.1-free`
- `inclusionai/ling-3.0-flash-sante:free`

An active, recognized GOAT plan is required before premium allowlist entries are shown as verified. Missing, unknown, unsupported, or inactive plan information fails closed to the known free primary models. Models omitted from that verified subset are not silently asserted to be GOAT.

## `commandcode-api`: full API / extra credits catalog

`commandcode-api` exposes the full live catalog as **API / extra credits**, including the same known free models. Models here remain API-unverified for GOAT coverage rather than being falsely labeled as GOAT. This view does not force PAYG: Command Code's server chooses the applicable balance. There is no request option in this extension that forces a funding source, and the server may spill GOAT usage into purchased credits after usage windows or limits. This provider makes no hard-spend-cap claim.

Both views preserve model IDs and transport. Displayed prices are estimates used by pi; they are retained for both views and are not zeroed for the plan view. They do not guarantee what Command Code will charge, and catalog grouping is not payment routing.

## Discovery, refresh, and diagnostics

The live catalog is loaded from the Provider API and cached by the extension. Startup waits for bounded catalog/plan verification even with a warm cache, so CLI model listing does not exit with an incomplete GOAT view. If verification fails, cached models remain available in the API view without a GOAT coverage claim. `/commandcode-refresh` refreshes and re-registers the model catalog **and reloads plan status**, while preserving the last valid catalog if a refresh fails. `/commandcode-status` reports redacted discovery diagnostics (source, count, timestamps, cache/endpoint details, warnings) plus the current plan/catalog summary. Neither command changes billing routing.

On session restoration, legacy premium Command Code IDs are moved to `commandcode-api` when they are outside the verified GOAT subset. Update worker or configuration provider IDs when they explicitly refer to the old premium `commandcode` entries.

## Updating

Dispatch owns the fork. Upstream source is pinned to the commit recorded in [UPSTREAM.md](UPSTREAM.md) and licensed MIT (`LICENSE`). Updates are deliberate vendoring changes: pin a specific upstream commit, review the diff manually, and update the exact catalog allowlist manually when plan documentation changes. Never scrape plan documentation at runtime. Keep `README.upstream.md` as the unmodified upstream reference; update this README and `FORK.md` when Dispatch behavior or the update process changes.

See `src/catalog.ts`, `src/plan.ts`, and `src/plan-models.ts` for the implemented catalog registration, fail-closed plan lookup, and reviewed split. The extension entrypoint is `index.ts`.
