import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  DEFAULT_DISPATCH_PORT,
  dispatchEnvironment,
  parseDispatchArgs,
  runDispatch,
  waitForOwnedWebServer,
} from './cli.mjs';
import { completeDispatchSetup, resolveDispatchPaths } from './state.mjs';
import { formatTerminalHelp } from '../extensions/piastra/help.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function tempHome(tag) {
  return mkdtempSync(join(tmpdir(), `dispatch-cli-${tag}-`));
}

function makePaths(tag) {
  const home = tempHome(tag);
  return resolveDispatchPaths({ env: {}, home, packageRoot: REPO_ROOT });
}

function memOutput() {
  let text = '';
  return { write(s) { text += String(s); }, get() { return text; } };
}

// ---------------------------------------------------------------------------
// parseDispatchArgs
// ---------------------------------------------------------------------------

test('parse: help/version take precedence before separator', { timeout: 5000 }, () => {
  assert.deepEqual(parseDispatchArgs(['--help'], {}), { mode: 'help' });
  assert.deepEqual(parseDispatchArgs(['-h'], {}), { mode: 'help' });
  assert.deepEqual(parseDispatchArgs(['--help', '--web'], {}), { mode: 'help' });
  assert.deepEqual(parseDispatchArgs(['--version'], {}), { mode: 'version' });
  assert.deepEqual(parseDispatchArgs(['-v'], {}), { mode: 'version' });
});

test('parse: setup/update reserved with no extra args', { timeout: 5000 }, () => {
  assert.deepEqual(parseDispatchArgs(['setup'], {}), { mode: 'setup' });
  assert.deepEqual(parseDispatchArgs(['update'], {}), { mode: 'update' });
  assert.throws(() => parseDispatchArgs(['setup', 'extra'], {}), /Unexpected arguments/);
  assert.throws(() => parseDispatchArgs(['update', '--web'], {}), /Unexpected arguments/);
});

test('parse: cli mode forwards argv including -- separator', { timeout: 5000 }, () => {
  const r = parseDispatchArgs(['--offline', '--mode', 'rpc', '--no-session'], {});
  assert.equal(r.mode, 'cli');
  assert.deepEqual(r.piArgs, ['--offline', '--mode', 'rpc', '--no-session']);
  assert.equal(r.offline, true);
  // --web after -- is forwarded, not treated as web mode.
  const fwd = parseDispatchArgs(['--', '--web', '--port', '9000'], {});
  assert.equal(fwd.mode, 'cli');
  assert.deepEqual(fwd.piArgs, ['--', '--web', '--port', '9000']);
  // Plain args forwarded verbatim.
  const plain = parseDispatchArgs(['-p', 'hello'], {});
  assert.deepEqual(plain.piArgs, ['-p', 'hello']);
});

test('parse: flag-looking Pi option values stay opaque to Dispatch', () => {
  for (const option of ['--name', '-n', '--system-prompt', '--append-system-prompt', '--model', '--extension', '--session']) {
    for (const value of ['--web', '--help', '--version', '--no-open', '--port', '--offline', '--']) {
      const argv = [option, value];
      const parsed = parseDispatchArgs(argv);
      assert.equal(parsed.mode, 'cli', `${option} ${value}`);
      assert.deepEqual(parsed.piArgs, argv);
      assert.equal(parsed.offline, false);
    }
  }
  assert.equal(parseDispatchArgs(['--name', '--', '--help']).mode, 'help');
});

test('parse: cli offline from env truthy variants', { timeout: 5000 }, () => {
  for (const env of [{ DISPATCH_OFFLINE: '1' }, { DISPATCH_OFFLINE: 'true' }, { PI_OFFLINE: 'yes' }, { PI_OFFLINE: 'ON' }]) {
    assert.equal(parseDispatchArgs([], env).offline, true);
  }
  assert.equal(parseDispatchArgs([], {}).offline, false);
  assert.equal(parseDispatchArgs([], { DISPATCH_OFFLINE: '0' }).offline, false);
});

test('parse: --port and --no-open require --web', { timeout: 5000 }, () => {
  assert.throws(() => parseDispatchArgs(['--port', '9000'], {}), /require --web/);
  assert.throws(() => parseDispatchArgs(['--port=9000'], {}), /require --web/);
  assert.throws(() => parseDispatchArgs(['--no-open'], {}), /require --web/);
});

test('parse: web --port validation and explicit over invalid env', { timeout: 5000 }, () => {
  assert.deepEqual(parseDispatchArgs(['--web'], {}).port, DEFAULT_DISPATCH_PORT);
  assert.equal(parseDispatchArgs(['--web', '--port', '9123'], {}).port, 9123);
  assert.equal(parseDispatchArgs(['--web', '--port=9124'], {}).port, 9124);
  assert.equal(parseDispatchArgs(['--web', '--no-open'], {}).noOpen, true);
  assert.equal(parseDispatchArgs(['--web'], { DISPATCH_PORT: '9321' }).port, 9321);
  // Explicit valid port wins over invalid env.
  assert.equal(parseDispatchArgs(['--web', '--port', '9123'], { DISPATCH_PORT: 'bogus' }).port, 9123);
  // Invalid env with no explicit throws.
  assert.throws(() => parseDispatchArgs(['--web'], { DISPATCH_PORT: 'bogus' }), /Port must be/);
  for (const argv of [
    ['--web', '--port', '0'],
    ['--web', '--port', '65536'],
    ['--web', '--port', 'notaport'],
    ['--web', '--port'],
    ['--web', '--port', '-5'],
    ['--web', '--port='],
  ]) {
    assert.throws(() => parseDispatchArgs(argv, {}), /Port must be|--port requires a value/, JSON.stringify(argv));
  }
});

test('parse: unknown web flags rejected', { timeout: 5000 }, () => {
  assert.throws(() => parseDispatchArgs(['--web', '--unknown'], {}), /Unsupported web argument/);
  assert.throws(() => parseDispatchArgs(['--web', '--port', '9000', '--bogus'], {}), /Unsupported web argument/);
  // CLI unknown flags are forwarded (Pi owns them).
  assert.equal(parseDispatchArgs(['--unknown-flag'], {}).mode, 'cli');
});

// ---------------------------------------------------------------------------
// dispatchEnvironment
// ---------------------------------------------------------------------------

test('environment isolates PI dirs, forces loopback, owns web path, managed=1', { timeout: 5000 }, () => {
  const paths = makePaths('env');
  const env = {
    FOO: 'keep-me',
    PI_CODING_AGENT_DIR: '/bogus/agent',
    PI_CODING_AGENT_SESSION_DIR: '/bogus/sessions',
    PI_PACKAGE_DIR: '/bogus/pkg',
    PI_WEB_RESTART_CHILD: '1',
    PI_WEB_SERVICE_NAME: 'x',
    PI_WEB_HOST: '0.0.0.0',
    PI_WEB_PORT: '9999',
    PI_WEB_MANAGED: '0',
  };
  const out = dispatchEnvironment(paths, env, { cwd: '/work', port: 9123, offline: true, version: '0.1.0-test' });
  assert.equal(out.PI_CODING_AGENT_DIR, paths.agentDir);
  assert.equal(out.PI_CODING_AGENT_SESSION_DIR, undefined);
  assert.equal(out.PI_PACKAGE_DIR, undefined);
  assert.equal(out.PI_WEB_RESTART_CHILD, undefined);
  assert.equal(out.PI_WEB_SERVICE_NAME, undefined);
  assert.equal(out.PI_WEB_HOST, '127.0.0.1');
  assert.equal(out.PI_WEB_PORT, '9123');
  assert.equal(out.PI_WEB_MANAGED, '1');
  assert.equal(out.PI_WEB_LAUNCHED_BY, 'dispatch');
  assert.equal(out.PI_WEB_CWD, '/work');
  assert.equal(out.PI_WEB_DATA_DIR, paths.webDir);
  assert.equal(out.DISPATCH_HOME, paths.home);
  assert.equal(out.PI_OFFLINE, '1');
  assert.equal(out.FOO, 'keep-me');
  // Caller env is not mutated.
  assert.equal(env.PI_CODING_AGENT_DIR, '/bogus/agent');
});

test('environment without port/offline omits optional keys', { timeout: 5000 }, () => {
  const paths = makePaths('envopt');
  const out = dispatchEnvironment(paths, {}, { cwd: '/w', version: 'v' });
  assert.equal(out.PI_WEB_PORT, undefined);
  assert.equal(out.PI_OFFLINE, undefined);
});

// ---------------------------------------------------------------------------
// waitForOwnedWebServer (stubbed fetch, no browser/network)
// ---------------------------------------------------------------------------

test('waitForOwnedWebServer accepts own pid', { timeout: 5000 }, async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    assert.match(url, /\/api\/health$/);
    assert.ok(opts?.signal);
    return { ok: true, json: async () => ({ ok: true, pid: 4242 }) };
  };
  await waitForOwnedWebServer('http://127.0.0.1:9123', { pid: 4242, fetchImpl, timeoutMs: 1000 });
  assert.ok(calls.length >= 1);
});

test('waitForOwnedWebServer rejects foreign pid without opening it', { timeout: 5000 }, async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ ok: true, pid: 9999 }) };
  };
  await assert.rejects(
    () => waitForOwnedWebServer('http://127.0.0.1:9123', { pid: 4242, fetchImpl, timeoutMs: 2000 }),
    /belongs to another process/,
  );
  assert.equal(calls, 1);
});

test('waitForOwnedWebServer timeout is bounded with stub fetch', { timeout: 5000 }, async () => {
  const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
  const start = Date.now();
  await assert.rejects(
    () => waitForOwnedWebServer('http://127.0.0.1:1', { pid: 1, fetchImpl, timeoutMs: 120 }),
    /did not become ready/,
  );
  assert.ok(Date.now() - start < 2000, 'bounded timeout');
});

// ---------------------------------------------------------------------------
// runDispatch with injected doubles (never reads real settings)
// ---------------------------------------------------------------------------

test('help/version never seed state or launch', { timeout: 5000 }, async () => {
  for (const argv of [['--help'], ['--version']]) {
    const paths = makePaths('helpver');
    const output = memOutput();
    const fail = () => { throw new Error('must not launch'); };
    const code = await runDispatch(argv, {
      env: {},
      cwd: tmpdir(),
      paths,
      output,
      errorOutput: memOutput(),
      setup: fail,
      interaction: fail,
      launchPi: fail,
      launchWeb: fail,
    });
    assert.equal(code, 0);
    if (argv[0] === '--help') assert.equal(output.get(), formatTerminalHelp() + '\n');
    else assert.match(output.get(), /^\d+\.\d+\.\d+/);
    // No state file seeded.
    let missing = false;
    try { await readFile(paths.stateFile, 'utf8'); } catch (e) { missing = e?.code === 'ENOENT'; }
    assert.ok(missing, 'help/version must not seed state');
    await rm(paths.home, { recursive: true, force: true });
  }
});

test('missing state with no args and --web returns 1 asking for setup', { timeout: 5000 }, async () => {
  for (const argv of [[], ['--web']]) {
    const paths = makePaths('missing');
    const errorOutput = memOutput();
    let launched = false;
    const code = await runDispatch(argv, {
      env: {},
      cwd: tmpdir(),
      paths,
      output: memOutput(),
      errorOutput,
      setup: async () => { throw new Error('must not setup'); },
      interaction: () => { throw new Error('must not interact'); },
      launchPi: async () => { launched = true; },
      launchWeb: async () => { launched = true; },
    });
    assert.equal(code, 1);
    assert.match(errorOutput.get(), /Run dispatch setup/);
    assert.equal(launched, false);
    await rm(paths.home, { recursive: true, force: true });
  }
});

test('setup uses synthetic interaction and never launches', { timeout: 5000 }, async () => {
  const paths = makePaths('setup');
  let setupSeen = null;
  let interacted = false;
  const code = await runDispatch(['setup'], {
    env: {},
    cwd: tmpdir(),
    paths,
    output: memOutput(),
    errorOutput: memOutput(),
    interaction: () => {
      interacted = true;
      return { io: { synthetic: true }, dispose() {} };
    },
    setup: async (opts) => {
      setupSeen = opts;
      return { setupComplete: true };
    },
    launchPi: async () => { throw new Error('must not launch Pi'); },
    launchWeb: async () => { throw new Error('must not launch Web'); },
  });
  assert.equal(code, 0);
  assert.equal(interacted, true);
  assert.deepEqual(setupSeen.paths, paths);
  assert.ok(setupSeen.io?.synthetic);
    await rm(paths.home, { recursive: true, force: true });
});

test('complete temp state (skipped) allows Pi launch with injected args/env', { timeout: 10000 }, async () => {
  const home = tempHome('launchpi');
  const paths = resolveDispatchPaths({ env: {}, home, packageRoot: REPO_ROOT });
  await completeDispatchSetup(paths, { go: 'skipped' });
  // Preserve a user global through the launch.
  const env = { MY_USER_GLOBAL: 'keep', PI_CODING_AGENT_DIR: '/bogus/must-be-isolated' };
  let seen = null;
  const output = memOutput();
  const code = await runDispatch(['--offline', '--mode', 'rpc'], {
    env,
    cwd: tmpdir(),
    paths,
    output,
    errorOutput: memOutput(),
    launchPi: async (opts) => { seen = opts; },
    launchWeb: async () => { throw new Error('wrong launcher'); },
  });
  assert.equal(code, 0);
  assert.deepEqual(seen.args, ['--offline', '--mode', 'rpc']);
  assert.deepEqual(seen.paths, paths);
  assert.equal(seen.env.PI_CODING_AGENT_DIR, paths.agentDir);
  assert.equal(seen.env.MY_USER_GLOBAL, 'keep');
  assert.equal(seen.env.PI_WEB_MANAGED, '1');
  assert.equal(seen.env.PI_WEB_HOST, '127.0.0.1');
  assert.equal(env.PI_CODING_AGENT_DIR, '/bogus/must-be-isolated', 'caller env not mutated');
  await rm(home, { recursive: true, force: true });
});

test('complete temp state allows Web launch with injected port/noOpen', { timeout: 10000 }, async () => {
  const home = tempHome('launchweb');
  const paths = resolveDispatchPaths({ env: {}, home, packageRoot: REPO_ROOT });
  await completeDispatchSetup(paths, { go: 'skipped' });
  const work = mkdtempSync(join(tmpdir(), 'dispatch-webcwd-'));
  await mkdir(work, { recursive: true });
  let seen = null;
  const output = memOutput();
  const code = await runDispatch(['--web', '--port', '9234', '--no-open'], {
    env: { KEEP_ME: 'yes', PI_WEB_HOST: '0.0.0.0' },
    cwd: work,
    paths,
    output,
    errorOutput: memOutput(),
    launchPi: async () => { throw new Error('wrong launcher'); },
    launchWeb: async (opts) => { seen = opts; },
  });
  assert.equal(code, 0);
  assert.equal(seen.options.port, 9234);
  assert.equal(seen.options.noOpen, true);
  assert.equal(seen.env.PI_WEB_PORT, '9234');
  assert.equal(seen.env.PI_WEB_HOST, '127.0.0.1');
  assert.equal(seen.env.PI_WEB_DATA_DIR, paths.webDir);
  assert.equal(seen.env.KEEP_ME, 'yes');
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

test('synthetic auth fixture helper writes only temp paths', { timeout: 5000 }, async () => {
  const paths = makePaths('synauth');
  await completeDispatchSetup(paths, { go: 'skipped' });
  const authFile = join(paths.agentDir, 'auth.json');
  await writeFile(authFile, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'synthetic' } }) + '\n');
  const text = await readFile(authFile, 'utf8');
  assert.match(text, /synthetic/);
  await rm(paths.home, { recursive: true, force: true });
});
