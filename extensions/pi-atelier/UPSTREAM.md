# Upstream Provenance

- **Source:** npm registry, published package `pi-atelier@0.10.1`
- **Tarball:** https://registry.npmjs.org/pi-atelier/-/pi-atelier-0.10.1.tgz
- **dist.integrity (sha512):** `sha512-aWD0n/LDSOL+4Drtj4u+LhpYxOwcn+Ym/hkMBeGnxNczTamyFwnOOaHEX2jyBFdWt7TB46sZfuHReEkpRSTo1Q==`
- **dist.shasum (sha1):** `e181519f514ccdcbdc4634eed50f377d44b378f1`
- **Upstream repository:** git+https://github.com/michaelmjhhhh/pi-atelier.git
- **Homepage:** https://github.com/michaelmjhhhh/pi-atelier#readme
- **License:** MIT (upstream, © 2026 Michael)
- **Fetched with:** `npm pack pi-atelier@0.10.1 --ignore-scripts` into a clean temp directory; the tarball was verified against the registry-reported `dist.integrity` and `dist.shasum` before extraction.

## Integrity verification (as recorded at vendoring time)

- Tarball sha512 (computed): `6960f49ff2c348e2fee03aed8f8bbe2e1a58c4ec1c9fe626fe190c05e1a7c4d7334da9b21709ce39a1c45f68f2045756b7b4c1e3ab197ee1d17849294524e8d5`
- This matches `dist.integrity` above (base64 `aWD0n/LDSOL+4Drtj4u+LhpYxOwcn+Ym/hkMBeGnxNczTamyFwnOOaHEX2jyBFdWt7TB46sZfuHReEkpRSTo1Q==` decodes to exactly this hex).
- Tarball sha1 (computed): `e181519f514ccdcbdc4634eed50f377d44b378f1` — matches `dist.shasum`.

## Deliberately not used as source

The locally installed user copy of pi-atelier was **not** used as the vendoring source because it carries a local agent-label patch and therefore does not match any published upstream artifact.
