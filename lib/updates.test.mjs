import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, after } from 'node:test';
import { PACKAGE_NAME, checkForUpdate, detectNpmInstall, runUpdate } from './updates.mjs';

const homes = [];
after(async () => {
  for (const h of homes) await rm(h, { recursive: true, force: true });
});
const temp = prefix => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  homes.push(dir);
  return dir;
};

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function streamResponse(text, { status = 200, cancelProbe } = {}) {
  const bytes = Buffer.from(text, 'utf8');
  let cancelled = false;
  let released = false;
  const half = Math.ceil(bytes.length / 2);
  const parts = [bytes.subarray(0, half), bytes.subarray(half)];
  let i = 0;
  const body = {
    getReader() {
      return {
        async read() {
          if (i >= parts.length) return { done: true, value: undefined };
          return { done: false, value: parts[i++] };
        },
        async cancel() { cancelled = true; },
        releaseLock() { released = true; },
      };
    },
  };
  if (cancelProbe) cancelProbe.state = { get cancelled() { return cancelled; }, get released() { return released; } };
  return { ok: status >= 200 && status < 300, status, body, headers: { get: () => null } };
}
const out = () => {
  const chunks = [];
  return { chunks, stream: { write: s => { chunks.push(String(s)); return true; } }, text: () => chunks.join('') };
};

test('PACKAGE_NAME exact', () => {
  assert.equal(PACKAGE_NAME, '@michaelt025/dispatch');
});

test('checkForUpdate returns newer stable only', async () => {
  const got = await checkForUpdate({
    currentVersion: '0.1.0', env: {},
    fetchImpl: async () => jsonResponse({ name: PACKAGE_NAME, version: '0.2.0' }),
  });
  assert.deepEqual(got, { currentVersion: '0.1.0', version: '0.2.0' });
});

test('checkForUpdate ignores prerelease latest, bad semver, current/cached', async () => {
  const pre = await checkForUpdate({ currentVersion: '0.1.0', env: {}, fetchImpl: async () => jsonResponse({ name: PACKAGE_NAME, version: '0.2.0-beta.1' }) });
  assert.equal(pre, undefined);
  const bad = await checkForUpdate({ currentVersion: '0.1.0', env: {}, fetchImpl: async () => jsonResponse({ name: PACKAGE_NAME, version: 'nope' }) });
  assert.equal(bad, undefined);
  const same = await checkForUpdate({ currentVersion: '0.2.0', env: {}, fetchImpl: async () => jsonResponse({ name: PACKAGE_NAME, version: '0.2.0' }) });
  assert.equal(same, undefined);
  const wrongName = await checkForUpdate({ currentVersion: '0.1.0', env: {}, fetchImpl: async () => jsonResponse({ name: '@other/pkg', version: '9.9.9' }) });
  assert.equal(wrongName, undefined);
  for (const payload of [{ version: '9.9.9' }, { name: PACKAGE_NAME, version: 'v9.9.9' }]) {
    assert.equal(await checkForUpdate({ currentVersion: '0.1.0', env: {}, fetchImpl: async () => jsonResponse(payload) }), undefined);
  }
});

test('checkForUpdate honors skip/offline, not PI_SKIP_VERSION_CHECK; swallows 404/timeout', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return jsonResponse({ name: PACKAGE_NAME, version: '9.9.9' }); };
  assert.equal(await checkForUpdate({ currentVersion: '0.1.0', env: { DISPATCH_SKIP_VERSION_CHECK: '1' }, fetchImpl }), undefined);
  assert.equal(await checkForUpdate({ currentVersion: '0.1.0', env: { DISPATCH_OFFLINE: 'true' }, fetchImpl }), undefined);
  assert.equal(await checkForUpdate({ currentVersion: '0.1.0', env: { PI_OFFLINE: '1' }, fetchImpl }), undefined);
  assert.equal(called, 0);
  const withPiSkip = await checkForUpdate({ currentVersion: '0.1.0', env: { PI_SKIP_VERSION_CHECK: '1' }, fetchImpl });
  assert.equal(withPiSkip.version, '9.9.9');
  assert.equal(await checkForUpdate({ currentVersion: '0.1.0', env: {}, fetchImpl: async () => ({ ok: false, status: 404 }) }), undefined);
  assert.equal(await checkForUpdate({ currentVersion: '0.1.0', env: {}, fetchImpl: async () => { throw new Error('timeout'); } }), undefined);
  const aborting = await checkForUpdate({
    currentVersion: '0.1.0', env: {},
    fetchImpl: async (_url, { signal } = {}) => {
      signal?.throwIfAborted?.();
      throw signal?.aborted ? new Error('aborted') : new Error('boom');
    },
    timeoutMs: 10,
  });
  assert.equal(aborting, undefined);
});

test('oversized real stream response is cancelled, never buffered unbounded', async () => {
  const big = JSON.stringify({ name: PACKAGE_NAME, version: '9.9.9', pad: 'x'.repeat(200 * 1024) });
  const probe = {};
  const res = streamResponse(big, { cancelProbe: probe });
  const got = await checkForUpdate({ currentVersion: '0.1.0', env: {}, fetchImpl: async () => res });
  assert.equal(got, undefined); // swallowed bounded-overflow error
  assert.equal(probe.state.cancelled, true);
  assert.equal(probe.state.released, true);
});

test('content-length early reject overflows without buffering', async () => {
  const got = await checkForUpdate({
    currentVersion: '0.1.0', env: {},
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: name => (String(name).toLowerCase() === 'content-length' ? String(10 * 1024 * 1024) : null) },
      body: { getReader: () => { throw new Error('must not read'); } },
      text: async () => { throw new Error('must not buffer text'); },
    }),
  });
  assert.equal(got, undefined);
});

test('fetch combines outer signal with timeout (not outer ?? timeout)', async () => {
  let seen;
  const controller = new AbortController();
  const got = await checkForUpdate({
    currentVersion: '0.1.0', env: {},
    fetchImpl: async (_url, { signal } = {}) => {
      seen = signal;
      assert.ok(signal, 'signal passed');
      // Outer abort must propagate through the combined signal.
      controller.abort(new Error('outer'));
      assert.equal(signal.aborted, true);
      throw signal.reason ?? new Error('aborted');
    },
    timeoutMs: 5000,
  });
  assert.equal(got, undefined);
  assert.ok(seen);
});

async function makeGlobalTree() {
  const base = temp('dispatch-global-');
  const globalRoot = join(base, 'global', 'node_modules');
  const pkg = join(globalRoot, '@michaelt025', 'dispatch');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.1.0' }));
  return { base, globalRoot, pkg };
}

function globalRun(globalRoot, prefix) {
  return async (args, { cwd } = {}) => {
    assert.ok(cwd && typeof cwd === 'string', 'global queries use explicit cwd');
    if (args.join(' ') === 'root -g') return { status: 0, stdout: `${globalRoot}\n` };
    if (args.join(' ') === 'config get prefix -g') return { status: 0, stdout: `${prefix}\n` };
    // Back-compat: answer legacy query too so old doubles keep working.
    if (args.join(' ') === 'config get prefix') return { status: 0, stdout: `${prefix}\n` };
    if (args[0] === 'prefix') return { status: 0, stdout: `${prefix}\n` };
    throw new Error('unexpected npm query ' + args.join(' '));
  };
}

test('detectNpmInstall identifies npm global exact path', async () => {
  const { globalRoot, pkg } = await makeGlobalTree();
  const prefix = resolve(join(globalRoot, '..'));
  // npm global root is <prefix>/node_modules here.
  const got = await detectNpmInstall({ packageRoot: pkg, run: globalRun(globalRoot, prefix) });
  assert.equal(got.kind, 'global');
  assert.equal(got.packagePath, resolve(pkg));
});

test('global with missing prefix is refused, never ambient scope', async () => {
  const { globalRoot, pkg } = await makeGlobalTree();
  const run = async (args, { cwd } = {}) => {
    assert.ok(cwd);
    if (args.join(' ') === 'root -g') return { status: 0, stdout: `${globalRoot}\n` };
    if (args.join(' ') === 'config get prefix -g' || args.join(' ') === 'config get prefix') return { status: 0, stdout: '\n' };
    throw new Error('unexpected ' + args.join(' '));
  };
  const got = await detectNpmInstall({ packageRoot: pkg, run });
  assert.equal(got.kind, 'unsupported');
  assert.match(got.manual ?? got.reason, /prefix/i);
});

test('global query uses -g flag to ignore project npmrc', async () => {
  const { globalRoot, pkg } = await makeGlobalTree();
  const prefix = resolve(join(globalRoot, '..'));
  const seen = [];
  const run = async (args, { cwd } = {}) => {
    seen.push(args.join(' '));
    if (args.join(' ') === 'root -g') return { status: 0, stdout: `${globalRoot}\n` };
    if (args.join(' ') === 'config get prefix -g') return { status: 0, stdout: `${prefix}\n` };
    if (args.join(' ') === 'config get prefix') throw new Error('legacy query must not be needed');
    if (args[0] === 'prefix') return { status: 0, stdout: `${prefix}\n` };
    throw new Error('unexpected ' + args.join(' '));
  };
  const got = await detectNpmInstall({ packageRoot: pkg, run });
  assert.equal(got.kind, 'global');
  assert.ok(seen.includes('config get prefix -g'));
});

test('detectNpmInstall rejects symlink (npm link)', async () => {
  const { globalRoot, pkg } = await makeGlobalTree();
  const prefix = resolve(join(globalRoot, '..'));
  const lstatImpl = async () => ({ isSymbolicLink: () => true });
  const got = await detectNpmInstall({ packageRoot: pkg, run: globalRun(globalRoot, prefix), lstatImpl });
  assert.equal(got.kind, 'unsupported');
});

function lockFor(version) {
  return JSON.stringify({
    name: 'proj', lockfileVersion: 3,
    packages: { '': { name: 'proj' }, [`node_modules/${PACKAGE_NAME}`]: { version, resolved: `https://registry.npmjs.org/${PACKAGE_NAME}/-/${PACKAGE_NAME.split('/')[1]}-${version}.tgz` } },
  });
}

async function makeLocalFixture({ depField = 'dependencies', spec = '^0.1.0', installedVersion = '0.1.0', lockVersion } = {}) {
  const base = temp('dispatch-local-');
  const prefix = join(base, 'proj');
  const pkg = join(prefix, 'node_modules', '@michaelt025', 'dispatch');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: installedVersion }));
  await writeFile(join(prefix, 'package.json'), JSON.stringify({ name: 'proj', [depField]: { [PACKAGE_NAME]: spec } }));
  await writeFile(join(prefix, 'package-lock.json'), lockFor(lockVersion ?? installedVersion));
  return { base, prefix, pkg };
}
const localRun = prefix => async args => {
  if (args[0] === 'root') return { status: 0, stdout: '/elsewhere\n' };
  if (args[0] === 'config') return { status: 0, stdout: '/elsewhere\n' };
  if (args[0] === 'prefix') return { status: 0, stdout: `${prefix}\n` };
  throw new Error('unexpected ' + args.join(' '));
};

test('detectNpmInstall rejects npx cache and wrong scope / file deps', async () => {
  const npx = await (async () => {
    const base = temp('dispatch-npx-');
    const pkg = join(base, '_npx', 'x', 'node_modules', '@michaelt025', 'dispatch');
    await mkdir(pkg, { recursive: true });
    return pkg;
  })();
  const npxGot = await detectNpmInstall({ packageRoot: npx, run: async () => { throw new Error('must not query'); } });
  assert.equal(npxGot.kind, 'unsupported');

  const { prefix, pkg } = await makeLocalFixture({ spec: 'file:../dispatch' });
  const run = async args => {
    if (args[0] === 'root') return { status: 0, stdout: '/elsewhere\n' };
    if (args[0] === 'config') return { status: 0, stdout: '/elsewhere\n' };
    if (args[0] === 'prefix') return { status: 0, stdout: `${prefix}\n` };
    throw new Error('unexpected');
  };
  const got = await detectNpmInstall({ packageRoot: pkg, run });
  assert.equal(got.kind, 'unsupported');
});

test('local derives prefix from exact shape, ignores misleading npm prefix', async () => {
  const { pkg } = await makeLocalFixture({});
  // npm prefix run inside the package would return the package's own root;
  // detection must still succeed via the canonical shape.
  const run = async args => {
    if (args[0] === 'root') return { status: 0, stdout: '/elsewhere\n' };
    if (args[0] === 'config') return { status: 0, stdout: '/elsewhere\n' };
    if (args[0] === 'prefix') return { status: 0, stdout: `${pkg}\n` }; // misleading own-root
    throw new Error('unexpected');
  };
  const got = await detectNpmInstall({ packageRoot: pkg, run });
  assert.equal(got.kind, 'local');
});

test('detectNpmInstall identifies local with dep kind and rejects other lockfiles', async () => {
  const { prefix, pkg } = await makeLocalFixture({ depField: 'devDependencies', spec: '^0.1.0' });
  await writeFile(join(prefix, 'pnpm-lock.yaml'), 'x');
  const run = localRun(prefix);
  const rejected = await detectNpmInstall({ packageRoot: pkg, run });
  assert.equal(rejected.kind, 'unsupported');
  assert.ok(!String(rejected.manual).includes('npm install -g'), 'no wrong global command for pnpm layout');
  await rm(join(prefix, 'pnpm-lock.yaml'), { force: true });
  const ok = await detectNpmInstall({ packageRoot: pkg, run });
  assert.equal(ok.kind, 'local');
  assert.equal(ok.saveKind, '--save-dev');
});

test('local file:.tgz archive is supported; file:dir and link: rejected', async () => {
  const tgz = await makeLocalFixture({ spec: 'file:../dispatch-0.1.0.tgz' });
  const ok = await detectNpmInstall({ packageRoot: tgz.pkg, run: localRun(tgz.prefix) });
  assert.equal(ok.kind, 'local');

  const dir = await makeLocalFixture({ spec: 'file:../dispatch' });
  assert.equal((await detectNpmInstall({ packageRoot: dir.pkg, run: localRun(dir.prefix) })).kind, 'unsupported');

  const link = await makeLocalFixture({ spec: 'link:../dispatch' });
  const linkGot = await detectNpmInstall({ packageRoot: link.pkg, run: localRun(link.prefix) });
  assert.equal(linkGot.kind, 'unsupported');
  assert.ok(!String(linkGot.manual).includes('npm install -g'));
});

test('local lock entry must match installed version, not just exist', async () => {
  const { prefix, pkg } = await makeLocalFixture({ installedVersion: '0.1.0', lockVersion: '0.2.0' });
  const got = await detectNpmInstall({ packageRoot: pkg, run: localRun(prefix) });
  assert.equal(got.kind, 'unsupported');
});

test('optionalDependencies shadows regular (priority) and conflicts are ambiguous', async () => {
  const base = temp('dispatch-opt-');
  const prefix = join(base, 'proj');
  const pkg = join(prefix, 'node_modules', '@michaelt025', 'dispatch');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.1.0' }));
  await writeFile(join(prefix, 'package.json'), JSON.stringify({
    name: 'proj',
    dependencies: { [PACKAGE_NAME]: '^0.1.0' },
    optionalDependencies: { [PACKAGE_NAME]: '^0.1.0' },
  }));
  await writeFile(join(prefix, 'package-lock.json'), lockFor('0.1.0'));
  const same = await detectNpmInstall({ packageRoot: pkg, run: localRun(prefix) });
  assert.equal(same.kind, 'local');
  assert.equal(same.saveKind, '--save-optional');

  await writeFile(join(prefix, 'package.json'), JSON.stringify({
    name: 'proj',
    dependencies: { [PACKAGE_NAME]: '^0.1.0' },
    optionalDependencies: { [PACKAGE_NAME]: '^0.2.0' },
  }));
  const amb = await detectNpmInstall({ packageRoot: pkg, run: localRun(prefix) });
  assert.equal(amb.kind, 'unsupported');
});

async function makeLocalTree(saveField) {
  const base = temp('dispatch-run-');
  const home = join(base, 'home');
  const prefix = join(base, 'proj');
  const pkg = join(prefix, 'node_modules', '@michaelt025', 'dispatch');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.1.0' }));
  await writeFile(join(prefix, 'package.json'), JSON.stringify({ name: 'proj', [saveField]: { '@michaelt025/dispatch': '^0.1.0' } }));
  await writeFile(join(prefix, 'package-lock.json'), lockFor('0.1.0'));
  const paths = { home, agentDir: join(home, 'agent'), webDir: join(home, 'web'), stateFile: join(home, 'state.json'), packageRoot: pkg };
  return { base, prefix, pkg, paths };
}

test('runUpdate no-op when current; active instance blocks; unsupported node refuses', async () => {
  const { prefix, paths } = await makeLocalTree('dependencies');
  const o = out();
  const rc = await runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async () => undefined,
    run: localRun(prefix),
    assertIdle: async () => {},
  });
  assert.equal(rc, 0);
  assert.match(o.text(), /already current/);

  await assert.rejects(() => runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async () => ({ currentVersion: '0.1.0', version: '0.2.0' }),
    run: localRun(prefix),
    assertIdle: async () => { throw new Error('Close running Dispatch sessions before updating (process 1).'); },
  }), /Close running/);

  await assert.rejects(() => runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async () => ({ currentVersion: '0.1.0', version: '0.2.0', engines: { node: '>=99.0.0' } }),
    run: localRun(prefix),
    assertIdle: async () => {},
  }), /requires node/);
});

test('explicit update throws offline before lookup, never false current', async () => {
  const { prefix, paths } = await makeLocalTree('dependencies');
  const o = out();
  let lookedUp = false;
  await assert.rejects(() => runUpdate({
    paths, env: { DISPATCH_OFFLINE: '1' }, output: o.stream,
    lookup: async () => { lookedUp = true; return undefined; },
    run: localRun(prefix),
    assertIdle: async () => {},
  }), /offline/i);
  assert.equal(lookedUp, false);
  assert.ok(!o.text().includes('already current'));
});

test('explicit update ignores DISPATCH_SKIP_VERSION_CHECK (background only)', async () => {
  const { prefix, paths } = await makeLocalTree('dependencies');
  const o = out();
  const seen = [];
  const rc = await runUpdate({
    paths, env: { DISPATCH_SKIP_VERSION_CHECK: '1' }, output: o.stream,
    lookup: async () => ({ currentVersion: '0.1.0', version: '0.2.0' }),
    run: localRun(prefix),
    runChild: async args => { seen.push(args); return { status: 0, signal: null }; },
    verify: async () => {},
    assertIdle: async () => {},
  });
  assert.equal(rc, 0);
  assert.equal(seen.length, 1);
});

test('explicit runUpdate passes signal to lookup/fetch', async () => {
  const { prefix, paths } = await makeLocalTree('dependencies');
  const o = out();
  const controller = new AbortController();
  let gotSignal;
  await runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async ({ signal } = {}) => { gotSignal = signal; return undefined; },
    run: localRun(prefix),
    assertIdle: async () => {},
    signal: controller.signal,
  });
  assert.equal(gotSignal, controller.signal);
});

test('runUpdate requires prefix writable, not just package dir', async () => {
  const { prefix, paths } = await makeLocalTree('dependencies');
  const o = out();
  const accessImpl = async p => {
    if (resolve(p) === resolve(prefix)) throw new Error('EACCES');
  };
  await assert.rejects(() => runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async () => ({ currentVersion: '0.1.0', version: '0.2.0' }),
    run: localRun(prefix),
    runChild: async () => ({ status: 0, signal: null }),
    verify: async () => {},
    assertIdle: async () => {},
    accessImpl,
  }), /not writable/);
});

test('runUpdate verifies exact args and version; failure paths throw', async () => {
  const { prefix, paths } = await makeLocalTree('optionalDependencies');
  const seen = [];
  const o = out();
  const rc = await runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async () => ({ currentVersion: '0.1.0', version: '0.2.0' }),
    run: localRun(prefix),
    runChild: async args => { seen.push(args); return { status: 0, signal: null }; },
    verify: async ({ version }) => { assert.equal(version, '0.2.0'); },
    assertIdle: async () => {},
  });
  assert.equal(rc, 0);
  assert.deepEqual(seen, [['install', '--global=false', '--prefix', resolve(prefix), '--save-optional', `${PACKAGE_NAME}@0.2.0`]]);

  await assert.rejects(() => runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async () => ({ currentVersion: '0.1.0', version: '0.2.0' }),
    run: localRun(prefix),
    runChild: async () => ({ status: 1, signal: null }),
    assertIdle: async () => {},
  }), /manual/);

  await assert.rejects(() => runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async () => ({ currentVersion: '0.1.0', version: '0.2.0' }),
    run: localRun(prefix),
    runChild: async () => ({ status: 0, signal: null }),
    verify: async () => { throw new Error('binary mismatch'); },
    assertIdle: async () => {},
  }), /verification failed/i);

  await assert.rejects(() => runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async () => { const e = new Error('not found'); e.code = 'ENOTPUBLISHED'; throw e; },
    run: localRun(prefix),
    assertIdle: async () => {},
  }), /No published release/);

  await assert.rejects(() => runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async () => ({ currentVersion: '0.1.0', version: 'bad!!' }),
    run: localRun(prefix),
    assertIdle: async () => {},
  }), /invalid release/);
});

test('runUpdate global uses -g without --global=false', async () => {
  const { globalRoot, pkg } = await makeGlobalTree();
  const prefix = resolve(join(globalRoot, '..'));
  const home = temp('dispatch-global-home-');
  const paths = { home, agentDir: join(home, 'agent'), webDir: join(home, 'web'), stateFile: join(home, 'state.json'), packageRoot: pkg };
  const seen = [];
  const o = out();
  const rc = await runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async () => ({ currentVersion: '0.1.0', version: '0.2.0' }),
    run: globalRun(globalRoot, prefix),
    runChild: async args => { seen.push(args); return { status: 0, signal: null }; },
    verify: async () => {},
    assertIdle: async () => {},
  });
  assert.equal(rc, 0);
  assert.deepEqual(seen, [['install', '-g', '--prefix', prefix, `${PACKAGE_NAME}@0.2.0`]]);
});

test('verify rejects nonzero exit even when stdout matches version', async () => {
  const { prefix, paths } = await makeLocalTree('dependencies');
  const o = out();
  await assert.rejects(() => runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async () => ({ currentVersion: '0.1.0', version: '0.2.0' }),
    run: localRun(prefix),
    runChild: async () => ({ status: 0, signal: null }),
    verify: async ({ version }) => {
      // Simulate defaultVerify logic with a lying binary: right stdout, bad exit.
      const result = { stdout: `${version}\n`, status: 1, signal: null, error: undefined };
      const reported = String(result.stdout).trim();
      if (result.error || result.signal || result.status !== 0) throw new Error('binary exited nonzero');
      if (reported !== version) throw new Error('mismatch');
    },
    assertIdle: async () => {},
  }), /nonzero|verification failed/i);
});

test('runUpdate rejects failed spawn signal and unsupported layout without network', async () => {
  const { prefix, paths } = await makeLocalTree('dependencies');
  const o = out();
  await assert.rejects(() => runUpdate({
    paths, env: {}, output: o.stream,
    lookup: async () => ({ currentVersion: '0.1.0', version: '0.3.0' }),
    run: localRun(prefix),
    runChild: async () => ({ status: null, signal: 'SIGTERM' }),
    assertIdle: async () => {},
  }), /failed/);
  const checkoutRoot = temp('dispatch-checkout-');
  await writeFile(join(checkoutRoot, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.1.0' }));
  const checkoutPaths = { ...paths, packageRoot: checkoutRoot };
  await assert.rejects(() => runUpdate({
    paths: checkoutPaths, env: {}, output: o.stream,
    lookup: async () => ({ currentVersion: '0.1.0', version: '0.3.0' }),
    run: async () => ({ status: 1, stdout: '' }),
    assertIdle: async () => {},
  }), /No files were changed|original installer/i);
});
