# Upstream Provenance

- **Source:** npm registry, published package `@juicesharp/rpiv-todo@2.9.0`
- **Tarball:** https://registry.npmjs.org/@juicesharp/rpiv-todo/-/rpiv-todo-2.9.0.tgz
- **dist.integrity (sha512):** `sha512-kETvX1ysqm2ff8OQU/FvDlT/9oVGgIki5Z5WeolNqVd/YCA+TOL3n0l5FDOsm4rJKPPKjJ1xHNBdgsC2XngZIQ==`
- **dist.shasum (sha1):** `fac084c025ec4184d0ce9feda995140a398b3e65`
- **Upstream repository:** git+https://github.com/juicesharp/rpiv-mono.git (`packages/rpiv-todo`)
- **Homepage:** https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo#readme
- **License:** MIT (upstream, © 2026 juicesharp) — preserved as shipped in `LICENSE`.
- **Fetched with:** `npm pack @juicesharp/rpiv-todo@2.9.0 --ignore-scripts` into a clean
  temp directory on 2026-09-15; the tarball was verified against the registry-reported
  `dist.integrity` and `dist.shasum` before extraction.

## Integrity verification (as recorded at vendoring time)

- Tarball sha512 (computed): `9044ef5f5cacaa6d9f7fc39053f16f0e54fff68546808922e59e567a894da9577f60203e4ce2f79f49791433ac9b8ac928f3ca8c9d711cd05d82c0b65e781921`
  — matches `dist.integrity` above (base64 `kETvX1ysqm2ff8OQU/FvDlT/9oVGgIki5Z5WeolNqVd/YCA+TOL3n0l5FDOsm4rJKPPKjJ1xHNBdgsC2XngZIQ==` decodes to exactly this hex).
- Tarball sha1 (computed): `fac084c025ec4184d0ce9feda995140a398b3e65` — matches `dist.shasum`.

## Vendored dependency: @juicesharp/rpiv-config@2.9.0

Upstream `rpiv-todo` declares a plain runtime dependency on
`@juicesharp/rpiv-config@^2.9.0`. To keep the fork self-contained (no external
`@juicesharp/rpiv-config` package on disk), the pristine runtime of that package is
vendored under `vendor/rpiv-config/`.

- **Tarball:** https://registry.npmjs.org/@juicesharp/rpiv-config/-/rpiv-config-2.9.0.tgz
- **dist.integrity (sha512):** `sha512-/7iFmG40bTsQaOwK5z44ZTAc0V0RI/X+Lr5N3f1rWjkdx1ZsiHBAzMcWO+5kMgjUuQAcyVbDkt19pmriIG2E7A==`
- **dist.shasum (sha1):** `224ac58253a821d7ef715962d1ce53ae23ca0887`
- Fetched with `npm pack @juicesharp/rpiv-config@2.9.0 --ignore-scripts` at the same
  time, verified the same way.
- Tarball sha512 (computed): `ffb885986e346d3b1068ec0ae73e3865301cd15d1123f5fe2ebe4dddfd6b5a391dc7566c887040ccc7163bee643208d4b9001cc956c392dd7da66ae2206d84ec`
- Tarball sha1 (computed): `224ac58253a821d7ef715962d1ce53ae23ca0887` — matches `dist.shasum`.
- Shipped files: `index.ts`, `config.ts`, `CHANGELOG.md`, `README.md`, `package.json` —
  byte-for-byte as published (the upstream `files` list).
- **LICENSE source:** the `@juicesharp/rpiv-config@2.9.0` npm tarball ships **no**
  LICENSE file. The MIT license text in `vendor/rpiv-config/LICENSE` was fetched from
  the upstream monorepo root
  (https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/LICENSE,
  "Copyright (c) 2026 juicesharp"), which covers all `packages/*` in that repository.
  It is identical to the LICENSE shipped in the `rpiv-todo` tarball.

## Deliberately not used as source

The npm registry tarballs are the sole source. No locally installed user copy of
rpiv-todo or rpiv-config was consulted, and no upstream git working tree was used.
