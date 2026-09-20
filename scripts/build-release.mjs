/**
 * Single-artifact release builder (phase 1).
 *
 * Stages a generated npm package at `.release/package` from this checkout
 * plus the maintained WebUI checkout (build-time input only). The output is
 * generated and git-ignored; this script never edits the source checkout.
 *
 * Testable entry point: `buildRelease({ root, webRoot, outDir,
 * buildWeb = true, run })`. The CLI wrapper only resolves defaults and
 * delegates to it. `run` is an injectable build executor so tests can avoid
 * real builds, network, and global writes.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');
export const DEFAULT_OUT_DIR_NAME = join('.release', 'package');
export const DEFAULT_FORK_SIBLING = join('..', 'DispatchWeb');

/** Marker identifying owned release output; guards destructive replacement. */
export const RELEASE_MARKER_FILE = '.dispatch-release.json';
export const RELEASE_MARKER_VERSION = 1;

/** Runtime dependency allowlist pinned into the staged manifest. */
export const RUNTIME_DEPS = {
  '@earendil-works/pi-coding-agent': '0.85.1',
  'cross-spawn': '7.0.6',
  semver: '7.8.0',
  'html-to-text': '10.0.1',
  'ipaddr.js': '2.5.0',
  minimatch: '10.2.6',
  'proper-lockfile': '^4.1.2',
  'pi-commandcode-provider': '0.7.1',
};

/** Canonical Pi runtime version pinned into the staged manifest. */
export const PINNED_PI_VERSION = '0.85.1';
export const PI_RUNTIME_DEP = '@earendil-works/pi-coding-agent';

/** Legacy/trial packages that must never enter the artifact. */
export const EXCLUDED_DEPS = ['@agegr/pi-web', 'pi-web-ui', 'tau-mirror'];

/** Managed extension entry points, in established order. */
export const MANAGED_ENTRIES = [
  'extensions/piastra/index.ts',
  'extensions/pi-ui/index.ts',
  'extensions/pi-worktree/git-worktree.ts',
  'extensions/pi-queue/index.ts',
  'extensions/pi-compact-transcript/index.ts',
  'extensions/pi-atelier/extensions/index.ts',
  'extensions/pi-todo/index.ts',
  'extensions/pi-commandcode/index.ts',
];

/** Extension trees copied recursively (filtered, see runtimeFilter). */
export const MANAGED_TREES = [
  'extensions/piastra',
  'extensions/pi-ui',
  'extensions/pi-worktree',
  'extensions/pi-queue',
  'extensions/pi-compact-transcript',
  'extensions/pi-atelier',
  'extensions/pi-todo',
  'extensions/pi-commandcode',
];

/** Maintained fork licenses that must exist and ship. */
export const FORK_LICENSES = [
  'extensions/pi-worktree/LICENSE',
  'extensions/pi-queue/LICENSE',
  'extensions/pi-compact-transcript/LICENSE',
  'extensions/pi-atelier/LICENSE',
  'extensions/pi-todo/LICENSE',
];

/** WebUI files preserved with their relative layout under vendor/web-ui/. */
export const WEB_LAYOUT = [
  'package.json',
  'dist/server',
  'web/dist',
  'web/public',
  'LICENSE',
  'LICENSE.md',
  'README.md',
];

export function resolveDefaultWebRoot(root, env = process.env) {
  // Preferred DISPATCH_FORK_DIR first, legacy PIASTRA_FORK_DIR fallback, then sibling.
  const raw =
    env.DISPATCH_FORK_DIR !== undefined && env.DISPATCH_FORK_DIR !== ''
      ? env.DISPATCH_FORK_DIR
      : env.PIASTRA_FORK_DIR !== undefined && env.PIASTRA_FORK_DIR !== ''
        ? env.PIASTRA_FORK_DIR
        : null;
  return raw !== null ? resolve(raw) : resolve(root, DEFAULT_FORK_SIBLING);
}

function fail(message) {
  throw new Error(message);
}

export function isAncestor(ancestor, target) {
  const a = resolve(ancestor);
  const t = resolve(target);
  const rel = relative(a, t);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false; // cross-drive / different root
  return true;
}

/** Nearest existing ancestor (or self) for canonicalization. */
function nearestExisting(target) {
  let current = resolve(target);
  while (true) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** Canonical path: realpath the nearest existing ancestor, re-append rest. */
function canonical(target) {
  const abs = resolve(target);
  const base = nearestExisting(abs);
  let real;
  try {
    real = realpathSync(base);
  } catch {
    real = base;
  }
  const rest = relative(base, abs);
  return rest ? join(real, rest) : real;
}

function isCanonicalAncestor(ancestor, target) {
  const rel = relative(ancestor, target);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function guardOutDir(root, webRoot, outDir) {
  const r = resolve(root);
  const o = resolve(outDir);
  const w = resolve(webRoot);
  // Reject a symlinked out target itself: canonicalization would hide it.
  try {
    if (lstatSync(o).isSymbolicLink()) fail(`Refusing to stage through symlinked outDir: ${o}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const rc = canonical(r);
  const oc = canonical(o);
  const wc = canonical(w);
  if (oc === rc) fail(`Refusing to overwrite source checkout: ${o}`);
  if (isCanonicalAncestor(oc, rc)) fail(`Refusing to stage inside an ancestor of the source checkout: ${o}`);
  if (isCanonicalAncestor(rc, oc)) {
    // Inside the source tree only the generated .release subtree is allowed.
    const releaseRoot = join(rc, '.release');
    if (!(oc === releaseRoot || isCanonicalAncestor(releaseRoot, oc))) {
      fail(`Refusing to stage inside the source checkout outside .release: ${o}`);
    }
  }
  if (oc === wc || isCanonicalAncestor(oc, wc) || isCanonicalAncestor(wc, oc)) {
    fail(`Refusing to stage over the WebUI checkout: ${o}`);
  }
}

function defaultRun(cmd, args, opts) {
  // cross-spawn, Windows-safe, no shell strings. Root devDependencies
  // provide it (plus semver); no bare-spawn fallback.
  const require = createRequire(import.meta.url);
  const spawn = require('cross-spawn').sync;
  return spawn(cmd, args, { stdio: 'inherit', ...opts });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`Cannot read JSON ${path}: ${error.message}`);
  }
}

function readMarker(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, RELEASE_MARKER_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function isOwnedReleaseOutput(dir) {
  const marker = readMarker(dir);
  return (
    marker !== null &&
    typeof marker === 'object' &&
    marker.marker === 'dispatch-release' &&
    marker.version === RELEASE_MARKER_VERSION
  );
}

/** Required source files that must exist before any output is replaced. */
export function sourceArtifactErrors(root) {
  const required = [
    'bin/dispatch.mjs',
    'lib/install-notice.mjs',
    'lib/state.mjs',
    'extensions/piastra/help.mjs',
    'extensions/piastra/help-view.ts',
    'config/agents.json',
    'config/checks.json',
    'roles/orchestrator.md',
    'roles/general.md',
    'roles/fast.md',
    'roles/review.md',
    'README.md',
    'LICENSE',
    'docs/RELEASE_README.md',
    'THIRD_PARTY_NOTICES.md',
    'package.json',
    ...MANAGED_ENTRIES,
    ...FORK_LICENSES,
  ];
  return required.filter((rel) => !existsSync(join(root, rel)));
}

/** Required built WebUI artifacts. */
export function webArtifactErrors(webRoot) {
  const required = [
    join(webRoot, 'package.json'),
    join(webRoot, 'dist', 'server', 'index.js'),
    join(webRoot, 'web', 'dist', 'index.html'),
    join(webRoot, 'LICENSE'),
  ];
  return required.filter((path) => !existsSync(path));
}

/** Filter for recursive runtime copies: drop tests/fixtures/tooling/secrets. */
export function runtimeFilter(sourceRoot) {
  return (source) => {
    // Never carry symlinked content (external targets) into the pack.
    try {
      if (lstatSync(source).isSymbolicLink()) return false;
    } catch {
      return false;
    }
    const rel = relative(sourceRoot, source);
    if (!rel) return true;
    const parts = rel.split(sep);
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === 'node_modules' || lower === '.git' || lower === '.local') return false;
      if (lower === '__tests__' || lower === '__fixtures__' || lower === 'fixtures') return false;
      if (lower === 'tests' || lower === '__test__' || lower === 'test') return false;
      if (lower === 'coverage') return false;
      if (lower === 'auth.json') return false;
      if (lower === '.env' || lower.startsWith('.env.') || lower.startsWith('.env-')) return false;
    }
    const base = basename(source);
    if (base === 'auth.json') return false;
    if (base === '.env' || base.startsWith('.env.') || base.startsWith('.env-')) return false;
    if (/\.test\.[a-z]+$/i.test(base) || /\.spec\.[a-z]+$/i.test(base)) return false;
    return true;
  };
}

function copyTreeFiltered(src, dest, filter) {
  cpSync(src, dest, { recursive: true, force: true, filter, dereference: false });
}

function copyIfExists(src, dest) {
  if (!existsSync(src)) return false;
  try {
    if (lstatSync(src).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const stat = statSync(src);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyIfExists(join(src, entry), join(dest, entry));
    }
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  return true;
}

/**
 * Build the staged release package.
 *
 * @param {object} options
 * @param {string} [options.root] source checkout (default: repo root)
 * @param {string} [options.webRoot] built WebUI checkout
 * @param {string} [options.outDir] staging output (default: <root>/.release/package)
 * @param {boolean} [options.buildWeb=true] run `npm run build` in webRoot
 * @param {Function} [options.run] injectable `(cmd, args, opts) => result`
 */
export function buildRelease({ root = DEFAULT_ROOT, webRoot, outDir, buildWeb = true, run = defaultRun } = {}) {
  const r = resolve(root);
  const w = resolve(webRoot ?? resolveDefaultWebRoot(r));
  const o = resolve(outDir ?? join(r, DEFAULT_OUT_DIR_NAME));

  guardOutDir(r, w, o);

  const missing = sourceArtifactErrors(r);
  if (missing.length) {
    fail(`Source checkout missing required artifacts: ${missing.join(', ')}. Refusing to stage.`);
  }
  const rootManifest = readJson(join(r, 'package.json'));
  // The checkout itself is never the publishable artifact; only the staged
  // package under .release/ is. Keep the root private so `npm publish` from
  // the repo root cannot ship the whole checkout.
  if (rootManifest.private !== true) fail('Refusing to stage: root package.json must keep private: true.');
  const rootSdkPin = rootManifest.dependencies?.[PI_RUNTIME_DEP];
  if (rootSdkPin !== PINNED_PI_VERSION) {
    fail(`Refusing to stage: root ${PI_RUNTIME_DEP} pin must be ${PINNED_PI_VERSION} (found ${rootSdkPin}).`);
  }

  if (buildWeb) {
    const result = run('npm', ['run', 'build'], { cwd: w, stdio: 'inherit' });
    const status = result?.status;
    const signal = result?.signal;
    const error = result?.error;
    if (error || signal != null || status == null || status !== 0) {
      const detail = error?.message || (signal != null ? `signal ${signal}` : `status ${status}`);
      fail(`Web build failed in ${w} (${detail}).`);
    }
  }
  const webMissing = webArtifactErrors(w);
  if (webMissing.length) {
    fail(
      `Web checkout misbuilt in ${w} (missing ${webMissing.map((p) => basename(p)).join(', ')}). ` +
        `Build the WebUI first: cd ${w} && npm ci && npm run build.`,
    );
  }
  const webManifest = readJson(join(w, 'package.json'));
  const webSdkRange = webManifest.dependencies?.[PI_RUNTIME_DEP];
  if (!webSdkRange) fail(`Refusing to stage: web manifest has no ${PI_RUNTIME_DEP} range.`);
  const require = createRequire(import.meta.url);
  const semver = require('semver');
  if (!semver.satisfies(PINNED_PI_VERSION, webSdkRange)) {
    fail(
      `Refusing to stage: web ${PI_RUNTIME_DEP} range ${webSdkRange} ` +
        `does not accept required ${PINNED_PI_VERSION}. Align the WebUI dependency first.`,
    );
  }

  // Merge production dependencies: runtime allowlist + WebUI deps, minus trials.
  const webDeps = { ...(webManifest.dependencies || {}) };
  for (const name of EXCLUDED_DEPS) delete webDeps[name];
  delete webDeps['@michaelt025/dispatch-web'];
  const dependencies = { ...webDeps, ...RUNTIME_DEPS };
  // Pi is shared between the CLI runtime and the Web SDK: pin the verified version.
  dependencies[PI_RUNTIME_DEP] = PINNED_PI_VERSION;

  // Merge applicable root security overrides (e.g. express.qs), excluding
  // trial overrides tied to EXCLUDED_DEPS.
  const stagedOverrides = {};
  for (const [name, value] of Object.entries(rootManifest.overrides || {})) {
    if (EXCLUDED_DEPS.includes(name)) continue;
    stagedOverrides[name] = value;
  }

  const stagedManifest = {
    name: '@michaelt025/dispatch',
    version: rootManifest.version,
    description: rootManifest.description || 'Dispatch — Pi orchestration with Astra planning and milestone review',
    license: 'MIT',
    type: 'module',
    keywords: ['pi', 'coding-agent', 'ai', 'orchestration', 'cli', 'web-ui', 'llm'],
    repository: { type: 'git', url: 'git+https://github.com/MichaelT025/Dispatch.git' },
    homepage: 'https://github.com/MichaelT025/Dispatch#readme',
    bugs: { url: 'https://github.com/MichaelT025/Dispatch/issues' },
    engines: { node: '>=22.19.0' },
    bin: { dispatch: 'bin/dispatch.mjs' },
    scripts: { postinstall: 'node lib/install-notice.mjs' },
    // Scoped packages default to restricted access on npm; the release is public.
    publishConfig: { access: 'public' },
    dependencies,
  };
  if (Object.keys(stagedOverrides).length) stagedManifest.overrides = stagedOverrides;

  // Never rm -rf an arbitrary outDir: only owned release output or a truly
  // empty directory may be replaced.
  if (existsSync(o)) {
    let entries = [];
    try {
      entries = readdirSync(o);
    } catch {
      entries = ['<unreadable>'];
    }
    if (entries.length !== 0 && !isOwnedReleaseOutput(o)) {
      fail(`Refusing to replace unmanaged output at ${o}: missing ${RELEASE_MARKER_FILE} ownership marker.`);
    }
  }

  // Stage to a fresh mkdtemp dir (same parent, same filesystem for rename),
  // then rotate: old -> backup, new -> out. The old stage is only deleted
  // after the new rename succeeds; on failure the backup is rolled back.
  mkdirSync(dirname(o), { recursive: true });
  const tmp = mkdtempSync(join(dirname(o), '.dispatch-release-tmp-'));
  let backupContainer = null;
  let backup = null;
  let movedOld = false;
  try {
    // Explicit runtime source allowlist.
    copyIfExists(join(r, 'bin', 'dispatch.mjs'), join(tmp, 'bin', 'dispatch.mjs'));
    const libSrc = join(r, 'lib');
    if (existsSync(libSrc)) copyTreeFiltered(libSrc, join(tmp, 'lib'), runtimeFilter(libSrc));
    for (const tree of MANAGED_TREES) {
      const src = join(r, tree);
      if (!existsSync(src)) fail(`Missing required extension tree: ${tree}`);
      copyTreeFiltered(src, join(tmp, tree), runtimeFilter(src));
    }
    // Re-validate entries survived filtering (a filter bug must not ship).
    for (const entry of MANAGED_ENTRIES) {
      if (!existsSync(join(tmp, entry))) fail(`Staged artifact missing entry ${entry}; refusing to replace output.`);
    }
    for (const file of ['config/agents.json', 'config/checks.json']) {
      copyIfExists(join(r, file), join(tmp, file));
    }
    for (const role of ['orchestrator.md', 'general.md', 'fast.md', 'review.md']) {
      copyIfExists(join(r, 'roles', role), join(tmp, 'roles', role));
    }
    // Assets: preserve original artwork as-is.
    if (existsSync(join(r, 'assets'))) {
      copyTreeFiltered(join(r, 'assets'), join(tmp, 'assets'), runtimeFilter(join(r, 'assets')));
    }
    const releaseReadme = join(r, 'docs', 'RELEASE_README.md');
    copyIfExists(existsSync(releaseReadme) ? releaseReadme : join(r, 'README.md'), join(tmp, 'README.md'));
    copyIfExists(join(r, 'THIRD_PARTY_NOTICES.md'), join(tmp, 'THIRD_PARTY_NOTICES.md'));
    copyIfExists(join(r, 'LICENSE'), join(tmp, 'LICENSE'));
    copyIfExists(join(r, 'LICENSE.md'), join(tmp, 'LICENSE.md'));

    // Vendor the WebUI with its relative layout.
    const vendor = join(tmp, 'vendor', 'web-ui');
    copyIfExists(join(w, 'package.json'), join(vendor, 'package.json'));
    for (const dir of ['dist/server', 'web/dist', 'web/public']) {
      if (existsSync(join(w, dir))) copyTreeFiltered(join(w, dir), join(vendor, dir), runtimeFilter(join(w, dir)));
    }
    for (const file of ['LICENSE', 'LICENSE.md', 'README.md']) {
      copyIfExists(join(w, file), join(vendor, file));
    }
    // Re-validate the vendored web entry points after copy.
    for (const p of ['package.json', join('dist', 'server', 'index.js'), join('web', 'dist', 'index.html')]) {
      if (!existsSync(join(vendor, p))) fail(`Staged web artifact missing ${p}; refusing to replace output.`);
    }

    writeFileSync(join(tmp, 'package.json'), JSON.stringify(stagedManifest, null, 2) + '\n');
    writeFileSync(
      join(tmp, RELEASE_MARKER_FILE),
      JSON.stringify({ marker: 'dispatch-release', version: RELEASE_MARKER_VERSION, name: stagedManifest.name, packageVersion: stagedManifest.version }) + '\n',
    );

    if (existsSync(o)) {
      // Exclusively-allocated backup container: never touch a pre-existing
      // predictable `${outDir}.backup-*` path, which may be unowned.
      backupContainer = mkdtempSync(join(dirname(o), '.dispatch-release-backup-'));
      backup = join(backupContainer, basename(o));
      renameSync(o, backup);
      movedOld = true;
    }
    try {
      renameSync(tmp, o);
    } catch (renameError) {
      if (movedOld) {
        try {
          renameSync(backup, o);
        } catch (rollbackError) {
          const original = renameError?.message ?? String(renameError);
          const detail = rollbackError?.message ?? String(rollbackError);
          try {
            rmSync(tmp, { recursive: true, force: true });
          } catch {}
          // Retain our own backup container for manual recovery; do not clean it.
          fail(
            `Failed to stage new package at ${o} (${original}); old stage preserved at ${backup} and rollback failed (${detail}). Recover manually.`,
          );
        }
        try {
          rmSync(backupContainer, { recursive: true, force: true });
        } catch {}
      }
      throw renameError;
    }
    if (movedOld) rmSync(backupContainer, { recursive: true, force: true });
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    if (backupContainer && !movedOld) {
      try {
        rmSync(backupContainer, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  }

  return { root: r, webRoot: w, outDir: o, manifest: stagedManifest };
}

function parseArgs(argv) {
  const options = { buildWeb: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--web-dir') {
      options.webDir = argv[++i];
      if (!options.webDir) fail('Missing value for --web-dir.');
    } else if (arg === '--out-dir') {
      options.outDir = argv[++i];
      if (!options.outDir) fail('Missing value for --out-dir.');
    } else if (arg === '--skip-web-build') {
      options.buildWeb = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

const invoked = resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        'Usage: node scripts/build-release.mjs [--web-dir <path>] [--out-dir <path>] [--skip-web-build]\n',
      );
      process.exit(0);
    }
    const result = buildRelease({
      root: DEFAULT_ROOT,
      webRoot: options.webDir ? resolve(options.webDir) : undefined,
      outDir: options.outDir ? resolve(options.outDir) : undefined,
      buildWeb: options.buildWeb,
    });
    process.stdout.write(`Staged release package at ${result.outDir}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
