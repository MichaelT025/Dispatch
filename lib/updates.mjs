import spawn from 'cross-spawn';
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import semver from 'semver';
import { assertNoActiveDispatch } from './instances.mjs';

export const PACKAGE_NAME = '@michaelt025/dispatch';
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace('/', '%2F')}/latest`;
const MAX_BODY_BYTES = 64 * 1024;

const truthy = value => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());

function safeDisplay(value, max = 100) {
  const s = String(value ?? '');
  // Strip control chars / ANSI escapes so external registry values cannot
  // inject terminal sequences into error output.
  return JSON.stringify(s.slice(0, max));
}

function isStable(version) {
  return typeof version === 'string' && semver.valid(version) === version && semver.prerelease(version) === null;
}

async function readBoundedJson(response) {
  // Optional content-length early reject (never trust it alone; still cap).
  try {
    const len = response?.headers?.get?.('content-length');
    if (len !== undefined && len !== null && String(len).trim() !== '') {
      const n = Number(String(len).trim());
      if (Number.isFinite(n) && n > MAX_BODY_BYTES) throw new Error('Registry response too large.');
    }
  } catch (error) {
    if (error?.message === 'Registry response too large.') throw error;
  }
  // Real fetch Responses expose a ReadableStream body: stream it with a byte
  // cap first so an oversized body never buffers unbounded. Cancel the
  // stream on overflow and release the reader lock.
  const body = response?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    let received = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value?.byteLength ?? value?.length ?? 0;
        if (received > MAX_BODY_BYTES) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new Error('Registry response too large.');
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock?.(); } catch { /* ignore */ }
    }
    const text = Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString('utf8');
    return JSON.parse(text);
  }
  // Test-double fallback: plain { json, text } objects without a stream.
  // Still enforce the byte cap on the actual byte length.
  if (typeof response?.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('Registry response too large.');
    return JSON.parse(text);
  }
  if (typeof response?.json === 'function') {
    const data = await response.json();
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_BODY_BYTES) {
      throw new Error('Registry response too large.');
    }
    return data;
  }
  throw new Error('Registry check failed (invalid response).');
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  if (signal.aborted) return signal;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* ignore */ }
  const timer = setTimeout(() => {
    try { signal.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
    controller.abort(timeout.reason);
  }, Math.max(1, timeoutMs));
  try { timeout.addEventListener('abort', () => { clearTimeout(timer); controller.abort(timeout.reason); }, { once: true }); } catch { /* ignore */ }
  return controller.signal;
}

async function fetchLatestStrict({ fetchImpl = fetch, timeoutMs = 5000, signal } = {}) {
  const combined = combinedSignal(signal, timeoutMs);
  const response = await fetchImpl(REGISTRY_LATEST_URL, {
    headers: { Accept: 'application/json' },
    signal: combined,
  });
  if (response?.status === 404) {
    const error = new Error(`Package ${PACKAGE_NAME} is not published yet (registry returned 404).`);
    error.code = 'ENOTPUBLISHED';
    throw error;
  }
  if (!response?.ok) throw new Error(`Registry check failed (HTTP ${response?.status ?? 'unknown'}).`);
  const body = await readBoundedJson(response);
  if (body == null || typeof body !== 'object') throw new Error('Registry check failed (invalid JSON).');
  if (body.name !== PACKAGE_NAME) {
    throw new Error('Registry check failed (unexpected package name).');
  }
  if (typeof body.version !== 'string' || semver.valid(body.version) !== body.version) {
    throw new Error('Registry check failed (invalid version).');
  }
  return body;
}

/**
 * Nonblocking background check. Never throws: any error (network, timeout,
 * 404/unpublished, invalid JSON/semver) resolves to undefined. Only a newer
 * stable semver version resolves to { currentVersion, version, engines? }.
 * Honors DISPATCH_SKIP_VERSION_CHECK and DISPATCH_OFFLINE/PI_OFFLINE only.
 * PI_SKIP_VERSION_CHECK is deliberately ignored (the launcher forces it).
 */
export async function checkForUpdate({ currentVersion, env = process.env, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  try {
    if (!currentVersion || semver.valid(currentVersion) === null) return undefined;
    if (truthy(env?.DISPATCH_SKIP_VERSION_CHECK)) return undefined;
    if (truthy(env?.DISPATCH_OFFLINE) || truthy(env?.PI_OFFLINE)) return undefined;
    const body = await fetchLatestStrict({ fetchImpl, timeoutMs });
    const latest = body.version;
    if (!isStable(latest)) return undefined;
    if (!isStable(currentVersion)) {
      // A prerelease install still only updates to a newer stable release.
      if (!semver.gt(latest, currentVersion, { includePrerelease: true })) return undefined;
    } else if (!semver.gt(latest, currentVersion)) return undefined;
    const out = { currentVersion, version: latest };
    if (body.engines !== undefined) out.engines = body.engines;
    return out;
  } catch {
    return undefined;
  }
}

function pathSegments(p) {
  return resolve(p).split(sep).filter(Boolean);
}

function hasManagedPathComponent(packageRoot) {
  const segs = pathSegments(packageRoot).map(s => s.toLowerCase());
  return segs.some(s => s === '.npx' || s === '_npx' || s.includes('_npx') || s === '.pnpm' || s.includes('.pnpm') || s === 'npx-cache');
}

function defaultRun(args, { cwd, timeoutMs = 15_000 } = {}) {
  const result = spawn.sync('npm', args, { encoding: 'utf8', cwd, timeout: timeoutMs });
  return {
    status: result.status,
    signal: result.signal ?? null,
    stdout: typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? ''),
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  };
}

async function isSymlink(p, { lstatImpl = lstat } = {}) {
  try {
    return (await lstatImpl(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function fileExists(p, { readFileImpl = readFile } = {}) {
  try {
    await readFileImpl(p, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function canonicalOf(p, { realpathImpl = realpath } = {}) {
  try {
    return resolve(await realpathImpl(p));
  } catch {
    return resolve(p);
  }
}

function globalRootMatchesPrefix(globalRoot, prefix) {
  const normRoot = resolve(globalRoot);
  return (
    normRoot === resolve(join(prefix, 'lib', 'node_modules')) ||
    normRoot === resolve(join(prefix, 'node_modules'))
  );
}

function unsupported(reason, manual) {
  return { kind: 'unsupported', reason, manual };
}

// Global-scope manual: only used when the install was positively identified
// as a global npm layout with a prefix mismatch.
function manualGlobal(reason, specHint) {
  const target = specHint ? ` ${specHint}` : '';
  return `${reason} Update manually instead (no files were changed): npm install -g ${PACKAGE_NAME}${target}, or reinstall from a fresh checkout. Close all running dispatch sessions first (including any using other DISPATCH_HOMEs, which cannot be auto-discovered).`;
}

// Non-global manual: MUST NOT recommend `npm install -g` (wrong scope for
// pnpm/yarn/local/file/link installs). Instruct updating with the original
// manager/location or a fresh artifact.
function manualOther(reason) {
  return `${reason} No files were changed. Update using the original installer/location that put this copy here (the same manager and project), or reinstall from a fresh artifact. Close all running dispatch sessions first (including any using other DISPATCH_HOMEs, which cannot be auto-discovered). Do not run an npm global install for this copy.`;
}

/**
 * Pure, positively-identified npm install detection. Only exact global or
 * local npm layouts are supported; everything else is { kind: 'unsupported' }
 * with manual guidance and never a mutation.
 */
export async function detectNpmInstall({
  packageRoot,
  run = defaultRun,
  lstatImpl = lstat,
  readFileImpl = readFile,
  realpathImpl = realpath,
} = {}) {
  const root = resolve(packageRoot);
  if (hasManagedPathComponent(root)) {
    return unsupported('npx/pnpm cache path', manualOther('This install lives under an npx/pnpm cache path.'));
  }
  const canonical = await canonicalOf(root, { realpathImpl });
  const norm = p => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const displayPath = resolve(root);
  if (await isSymlink(root, { lstatImpl })) {
    return unsupported('symlinked package (npm link)', manualOther('This package is symlinked (npm link).'));
  }

  // --- Global identity: npm root -g must exactly contain this package. ---
  let globalRoot = '';
  let globalPrefix = '';
  try {
    const r = await run(['root', '-g'], { cwd: root });
    if (!r?.error && r?.status === 0) globalRoot = String(r.stdout ?? '').trim().split('\n').pop().trim();
  } catch { /* treat as unknown */ }
  try {
    // -g ignores project .npmrc so a project prefix cannot hijack globals.
    const r = await run(['config', 'get', 'prefix', '-g'], { cwd: root });
    if (!r?.error && r?.status === 0) globalPrefix = String(r.stdout ?? '').trim().split('\n').pop().trim();
  } catch { /* treat as unknown */ }
  // Fall back for old test doubles that only answer 'config get prefix'.
  if (!globalPrefix) {
    try {
      const r = await run(['config', 'get', 'prefix'], { cwd: root });
      const out = r && !r.error && r.status === 0 ? String(r.stdout ?? '').trim().split('\n').pop().trim() : '';
      if (out) globalPrefix = out;
    } catch { /* ignore */ }
  }
  if (globalRoot) {
    const canonGlobalRoot = await canonicalOf(resolve(globalRoot), { realpathImpl });
    // A verified nonempty prefix is ALWAYS required for globals: without it
    // an update would fall back to the ambient global scope.
    if (!globalPrefix) {
      return unsupported(
        'global prefix unavailable',
        manualGlobal('Could not verify the global npm prefix (empty prefix lookup); refusing to update the ambient global scope.'),
      );
    }
    const canonPrefix = await canonicalOf(resolve(globalPrefix), { realpathImpl });
    const expectedGlobal = norm(join(canonGlobalRoot, PACKAGE_NAME));
    if (norm(canonical) === expectedGlobal) {
      if (!globalRootMatchesPrefix(canonGlobalRoot, canonPrefix)) {
        return unsupported('global prefix mismatch', manualGlobal('The global npm prefix does not match the global root.'));
      }
      // The final global package itself must not be a symlink: an npm-link
      // target can resolve to a regular dir via realpath, so check lstat too.
      const rawExpected = join(resolve(globalRoot), PACKAGE_NAME);
      if (await isSymlink(rawExpected, { lstatImpl }) || await isSymlink(displayPath, { lstatImpl })) {
        return unsupported('symlinked package (npm link)', manualOther('This package is symlinked (npm link).'));
      }
      return { kind: 'global', packagePath: displayPath, globalRoot: canonGlobalRoot, prefix: canonPrefix };
    }
  }

  // --- Local identity: derive the owning prefix from the exact known shape
  // <prefix>/node_modules/@scope/dispatch. `npm prefix` run inside the
  // package returns the package's OWN root, not the owning project, so it
  // must not be trusted here.
  const suffix = join('node_modules', PACKAGE_NAME).toLowerCase();
  const lowerCanon = canonical.toLowerCase();
  if (!lowerCanon.endsWith(suffix) && !lowerCanon.endsWith((suffix))) {
    return unsupported(
      'unidentified install',
      manualOther('This does not look like an npm global or local install (checkout, linked package, or another manager).'),
    );
  }
  // Slice the candidate prefix off the canonical path (3 levels up).
  let candidatePrefix = canonical;
  for (let i = 0; i < 3; i++) candidatePrefix = dirname(candidatePrefix);
  const expectedLocal = norm(join(resolve(candidatePrefix), 'node_modules', PACKAGE_NAME));
  if (norm(canonical) !== expectedLocal) {
    return unsupported(
      'unidentified install',
      manualOther('This does not look like an npm global or local install (checkout, linked package, or another manager).'),
    );
  }
  const prefix = resolve(candidatePrefix);
  if (await isSymlink(displayPath, { lstatImpl }) || await isSymlink(root, { lstatImpl })) {
    return unsupported('symlinked package (npm link)', manualOther('This package is symlinked (npm link).'));
  }
  // npm-only layout: other managers rejected.
  for (const lock of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    if (await fileExists(join(prefix, lock), { readFileImpl })) {
      return unsupported('not an npm install', manualOther(`Found ${lock}: pnpm/yarn/bun layouts are not supported.`));
    }
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFileImpl(join(prefix, 'package.json'), 'utf8'));
  } catch {
    return unsupported('unidentified install', manualOther('Could not read the owning package.json.'));
  }
  // Optional entries can shadow regular ones in npm resolution: scan
  // optionalDependencies FIRST, then dependencies, then devDependencies.
  // If the spec appears in more than one section with differing values,
  // refuse as ambiguous instead of guessing.
  const sections = [
    ['optionalDependencies', '--save-optional'],
    ['dependencies', '--save-prod'],
    ['devDependencies', '--save-dev'],
  ];
  const hits = [];
  for (const [field, flag] of sections) {
    const entry = manifest?.[field]?.[PACKAGE_NAME];
    if (typeof entry === 'string') hits.push({ field, flag, spec: entry });
  }
  if (hits.length === 0) {
    return unsupported(
      'not a direct dependency',
      manualOther('This package is not a direct dependency of the owning package.json.'),
    );
  }
  if (hits.length > 1 && new Set(hits.map(h => h.spec)).size > 1) {
    return unsupported('ambiguous dependency', manualOther('This package is listed with conflicting specs; refusing to guess.'));
  }
  // Prefer optional over regular when duplicated with the same spec.
  const order = { '--save-optional': 0, '--save-prod': 1, '--save-dev': 2 };
  hits.sort((a, b) => order[a.flag] - order[b.flag]);
  const { flag: saveKind, spec } = hits[0];
  const trimmed = spec.trim();
  // Reject link/workspace-style aliases outright.
  if (/^\s*(link:|workspace:|portal:|github:|git\+|git:|https?:)/i.test(spec)) {
    return unsupported('linked dependency', manualOther('This install is a link/workspace alias on a local checkout.'));
  }
  const isFileSpec = /^\s*file:/i.test(spec);
  const isBareRelative = /^\s*(\.|\/)/.test(spec);
  let allowFileArchive = false;
  if (isFileSpec) {
    const rest = trimmed.replace(/^\s*file:/i, '');
    if (/\.t(ar\.)?gz(\?.*)?$/i.test(rest)) {
      allowFileArchive = true; // real npm local file:.tgz archive (copied dir)
    } else {
      return unsupported('file dependency', manualOther('This install is a file: dependency on a local directory checkout.'));
    }
  } else if (isBareRelative || /\.\./.test(trimmed) && /file:/i.test(spec)) {
    return unsupported('file dependency', manualOther('This install is a file: dependency on a local directory checkout.'));
  }
  if (!allowFileArchive && /^\s*(file:|link:|\.|\/)/.test(spec)) {
    return unsupported('file dependency', manualOther('This install is a file: dependency on a local checkout.'));
  }
  // Verify the actual installed package.json name and the lock entry:
  // the lock must parse, must not be a link entry, and must match the
  // installed version. Mere lockfile existence is not enough.
  let installed;
  try {
    installed = JSON.parse(await readFileImpl(join(canonical, 'package.json'), 'utf8'));
  } catch {
    return unsupported('unidentified install', manualOther('Could not read the installed package.json.'));
  }
  if (installed?.name !== PACKAGE_NAME) {
    return unsupported('unidentified install', manualOther('The installed package.json name does not match.'));
  }
  const installedVersion = installed?.version;
  let lockText;
  try {
    lockText = await readFileImpl(join(prefix, 'package-lock.json'), 'utf8');
  } catch {
    return unsupported('not an npm install', manualOther('No npm package-lock.json found (pnpm/yarn/bun layouts are not supported).'));
  }
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return unsupported('not an npm install', manualOther('The npm package-lock.json could not be parsed.'));
  }
  if (lock?.lockfileVersion === undefined || lock?.lockfileVersion === null) {
    return unsupported('not an npm install', manualOther('The npm package-lock.json is missing lockfileVersion (not npm-owned).'));
  }
  const pkgKey = `node_modules/${PACKAGE_NAME}`;
  const entry = lock?.packages?.[pkgKey] ?? lock?.dependencies?.[PACKAGE_NAME];
  if (!entry || typeof entry !== 'object') {
    return unsupported('not a direct dependency', manualOther('The npm lockfile has no entry for this package.'));
  }
  if (entry.link === true || typeof entry.resolved === 'string' && /^\s*(link:|file:[^]*[^z])$/i.test(entry.resolved) && !/\.t(ar\.)?gz/i.test(entry.resolved)) {
    if (entry.link === true || !/\.t(ar\.)?gz/i.test(String(entry.resolved ?? ''))) {
      return unsupported('linked dependency', manualOther('The npm lockfile marks this package as a link.'));
    }
  }
  if (typeof entry.version === 'string' && typeof installedVersion === 'string') {
    if (entry.version !== installedVersion) {
      return unsupported('lock mismatch', manualOther('The npm lockfile entry does not match the installed version.'));
    }
  } else if (!allowFileArchive) {
    return unsupported('lock mismatch', manualOther('The npm lockfile entry does not match the installed version.'));
  }
  void allowFileArchive;
  return { kind: 'local', packagePath: displayPath, prefix, saveKind, spec };
}

function defaultLookup({ fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  // Explicit update lookup: DISPATCH_SKIP_VERSION_CHECK must NOT disable a
  // user-requested check (only the background check honors it). Offline still
  // resolves undefined here; runUpdate throws a clear offline error first.
  return async ({ currentVersion, env, signal } = {}) => {
    void env;
    let body;
    try {
      body = await fetchLatestStrict({ fetchImpl, timeoutMs, signal });
    } catch (error) {
      throw error;
    }
    if (!isStable(body.version)) {
      const error = new Error(`Registry latest tag ${safeDisplay(body.version)} is not a stable release; refusing to update.`);
      error.code = 'EUNSTABLE';
      throw error;
    }
    if (semver.valid(currentVersion) === null) throw new Error(`Current version ${safeDisplay(currentVersion)} is not valid semver.`);
    if (!semver.gt(body.version, currentVersion)) return undefined;
    return { currentVersion, version: body.version, engines: body.engines };
  };
}

async function defaultVerify({ packagePath, version, runImpl }) {
  const manifest = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
  if (manifest?.name !== PACKAGE_NAME) {
    throw new Error(`Update verification failed: installed package name ${safeDisplay(manifest?.name)} does not match ${PACKAGE_NAME}.`);
  }
  if (manifest?.version !== version) {
    throw new Error(`Update verification failed: installed version ${safeDisplay(manifest?.version)} does not match ${safeDisplay(version)}.`);
  }
  const bin = join(packagePath, 'bin', 'dispatch.mjs');
  const result = await runImpl(['--version'], { cwd: packagePath, bin });
  const reported = String(result?.stdout ?? '').trim().split('\n').pop().trim();
  if (result?.error || result?.signal || result?.status !== 0) {
    throw new Error(`Update verification failed: installed binary exited ${result?.signal ?? result?.status ?? 'with an error'} instead of reporting ${safeDisplay(version)}.`);
  }
  if (reported !== version) {
    throw new Error(`Update verification failed: installed binary reports ${safeDisplay(reported) || 'unknown'} instead of ${safeDisplay(version)}.`);
  }
}

function defaultRunChild(args, { cwd, timeoutMs, signal }) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn('npm', args, { stdio: 'inherit', cwd, timeout: timeoutMs, signal });
    } catch (error) {
      reject(error);
      return;
    }
    if (!child || typeof child.on !== 'function') {
      reject(new Error('Could not start npm.'));
      return;
    }
    const onAbort = () => { try { child.kill?.('SIGTERM'); } catch { /* ignore */ } };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('error', error => {
      signal?.removeEventListener?.('abort', onAbort);
      reject(error);
    });
    child.on('close', (code, sig) => {
      signal?.removeEventListener?.('abort', onAbort);
      resolvePromise({ status: code, signal: sig ?? null });
    });
  });
}

/**
 * Explicit self-update. Returns 0 when already current or after a verified
 * success; throws a clear actionable error otherwise. Never touches user
 * state; failed installs report a manual npm command (no false rollback).
 * No Pi or native imports before mutation.
 */
export async function runUpdate({
  paths,
  env = process.env,
  output = process.stdout,
  errorOutput = process.stderr, // reserved for future diagnostics; never dumps env
  lookup,
  run = defaultRun,
  runChild = defaultRunChild,
  verify,
  assertIdle = assertNoActiveDispatch,
  fetchImpl = fetch,
  timeoutMs = 5000,
  installTimeoutMs = 120_000,
  signal,
  currentNode = process.version,
  accessImpl = (p, mode) => access(p, mode),
  lstatImpl = lstat,
  readFileImpl = readFile,
  realpathImpl = realpath,
} = {}) {
  if (!paths?.packageRoot) throw new Error('Cannot update: package root is unknown.');
  void errorOutput;
  signal?.throwIfAborted?.();
  // Offline must throw a clear offline error BEFORE any registry lookup,
  // never a false "already current".
  if (truthy(env?.DISPATCH_OFFLINE) || truthy(env?.PI_OFFLINE)) {
    throw new Error('Cannot check for updates while offline (DISPATCH_OFFLINE/PI_OFFLINE is set). Reconnect and try again.');
  }
  // NOTE: DISPATCH_SKIP_VERSION_CHECK is intentionally ignored here: an
  // explicit user-requested `dispatch update` must still check.
  const installedManifest = JSON.parse(await readFileImpl(join(resolve(paths.packageRoot), 'package.json'), 'utf8'));
  const currentVersion = installedManifest?.version;
  if (typeof currentVersion !== 'string' || semver.valid(currentVersion) === null) {
    throw new Error('Cannot update: installed version is not valid semver.');
  }
  const lookupFn = lookup ?? defaultLookup({ fetchImpl, timeoutMs });
  let latest;
  try {
    latest = await lookupFn({ currentVersion, env, signal });
  } catch (error) {
    if (error?.code === 'ENOTPUBLISHED' || /404/.test(String(error?.message))) {
      throw new Error(`No published release of ${PACKAGE_NAME} is available yet. Try again later.`);
    }
    throw new Error(`Could not check for updates: ${error?.message ?? error}. Try again later.`);
  }
  signal?.throwIfAborted?.();
  if (!latest) {
    output?.write?.(`Dispatch ${currentVersion} is already current.\n`);
    return 0;
  }
  const target = latest.version;
  if (!isStable(target)) {
    throw new Error(`Refusing to install invalid release version ${safeDisplay(target)}.`);
  }
  if (!semver.gt(target, currentVersion)) {
    output?.write?.(`Dispatch ${currentVersion} is already current.\n`);
    return 0;
  }
  const requiredNode = latest.engines?.node;
  if (typeof requiredNode === 'string' && requiredNode.trim() !== '') {
    let ok = false;
    try {
      ok = semver.satisfies(currentNode, requiredNode, { includePrerelease: false });
    } catch {
      throw new Error(`Release ${safeDisplay(target)} declares an invalid engines.node range; refusing to update.`);
    }
    if (!ok) {
      throw new Error(
        `Release ${safeDisplay(target)} requires node ${safeDisplay(requiredNode)} but the current runtime is ${currentNode}. Update Node first, then run dispatch update again.`,
      );
    }
  }
  const detection = await detectNpmInstall({ packageRoot: paths.packageRoot, run, lstatImpl, readFileImpl, realpathImpl });
  if (!detection || detection.kind === 'unsupported') {
    throw new Error(detection?.manual ?? manualOther('Unsupported install layout.'));
  }
  // Writability: the install parent/prefix must be writable, not just the
  // package dir (npm writes siblings/locks under the prefix).
  const writableTargets = detection.kind === 'global'
    ? [detection.packagePath, detection.globalRoot, detection.prefix].filter(Boolean)
    : [detection.packagePath, detection.prefix];
  for (const targetPath of new Set(writableTargets.map(p => resolve(p)))) {
    try {
      await accessImpl(targetPath, constants.W_OK);
    } catch {
      throw new Error('Cannot update: the install directory is not writable. Re-run with sufficient permissions or update manually.');
    }
  }
  signal?.throwIfAborted?.();
  try {
    await assertIdle(paths);
  } catch (error) {
    throw error;
  }
  const spec = `${PACKAGE_NAME}@${target}`;
  let args;
  let cwd;
  if (detection.kind === 'global') {
    args = ['install', '-g'];
    if (detection.prefix) args.push('--prefix', detection.prefix);
    args.push(spec);
    // Do not run npm from the directory it is about to replace (Windows locks cwd).
    cwd = detection.prefix;
  } else {
    // Explicitly disable global mode: an ambient npm_config_global=true (or
    // user config global=true) would otherwise make `npm install --prefix ...`
    // write a global installation instead of the identified local one.
    args = ['install', '--global=false', '--prefix', detection.prefix, detection.saveKind, spec];
    cwd = detection.prefix;
  }
  // Never shell:true; scripts stay enabled (native Web deps require them).
  // No silent global Pi updates happen here: only the exact Dispatch spec.
  let result;
  try {
    result = await runChild(args, { cwd, timeoutMs: installTimeoutMs, signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error(
      `Update to ${safeDisplay(target)} failed (${error?.message ?? 'npm error'}). No files were rolled back. ` +
      `Recover manually with: npm ${args.join(' ')} (after closing all dispatch sessions). User settings and credentials were not touched.`,
    );
  }
  signal?.throwIfAborted?.();
  if (result?.signal || result?.status !== 0) {
    throw new Error(
      `Update to ${safeDisplay(target)} failed (npm exited ${result?.signal ?? result?.status ?? 'with an error'}). No files were rolled back. ` +
      `Recover manually with: npm ${args.join(' ')} (after closing all dispatch sessions). User settings and credentials were not touched.`,
    );
  }
  const verifyFn = verify ?? (async () => defaultVerify({
    packagePath: detection.packagePath,
    version: target,
    runImpl: async (binArgs, { cwd: binCwd, bin }) => {
      const syncResult = spawn.sync(process.execPath, [bin, ...binArgs], { encoding: 'utf8', cwd: binCwd, timeout: 15_000 });
      return { stdout: typeof syncResult.stdout === 'string' ? syncResult.stdout : '', status: syncResult.status, signal: syncResult.signal ?? null, error: syncResult.error };
    },
  }));
  try {
    await verifyFn({ packagePath: detection.packagePath, version: target });
  } catch (error) {
    throw new Error(`Update verification failed: ${error?.message ?? error} Recover manually with: npm ${args.join(' ')}.`);
  }
  output?.write?.(`Dispatch updated to ${target}.\n`);
  return 0;
}
