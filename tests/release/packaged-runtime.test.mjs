/**
 * Packaged runtime integration test (explicit, opt-in only).
 *
 * Run:  DISPATCH_TEST_TARBALL=/absolute/path/to/michaelt025-dispatch-0.1.0.tgz \
 *         node --test tests/release/packaged-runtime.test.mjs
 *
 * This file is intentionally NOT part of root `npm test`. It installs the
 * single release artifact into an isolated prefix outside the repo and
 * exercises the ACTUAL installed CLI + WebUI with no source/sibling imports
 * (only the node:test runner is a source import). Flags mirror lib/cli.mjs:
 * CLI `--offline --mode rpc --no-session`, Web `--web --port <n> --no-open
 * --offline`. No real auth, inference, or global Pi modifications.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const require = createRequire(join(ROOT, 'package.json'));

const MANAGED_ENTRIES = [
  'extensions/piastra/index.ts',
  'extensions/pi-ui/index.ts',
  'extensions/pi-worktree/git-worktree.ts',
  'extensions/pi-queue/index.ts',
  'extensions/pi-compact-transcript/index.ts',
  'extensions/pi-atelier/extensions/index.ts',
  'extensions/pi-todo/index.ts',
];
const LEGACY_DEPS = ['@agegr/pi-web', 'pi-web-ui', 'tau-mirror'];

function tarballPath() {
  const raw = process.env.DISPATCH_TEST_TARBALL;
  if (!raw) {
    assert.fail(
      'Packaged runtime test requires DISPATCH_TEST_TARBALL.\n' +
      'Build a fresh artifact first (parent owns the build), then run:\n' +
      '  npm run build:release\n' +
      '  DISPATCH_TEST_TARBALL=/absolute/path/to/.release/michaelt025-dispatch-<version>.tgz \\\n' +
      '    node --test tests/release/packaged-runtime.test.mjs\n' +
      'The path must be absolute and end in .tgz. This is a separate explicit\n' +
      'integration test and never runs under root `npm test`.',
    );
  }
  if (!isAbsolute(raw) || !raw.endsWith('.tgz') || !existsSync(raw)) {
    assert.fail(
      `DISPATCH_TEST_TARBALL must be an absolute path to an existing .tgz file, got: ${raw}\n` +
      'Build a fresh artifact first (npm run build:release), then re-run with the absolute .tgz path.',
    );
  }
  return raw;
}

async function rmRetry(target, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (i === attempts - 1) throw error;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}

function freeLoopbackPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

async function waitFor(fn, { timeoutMs, intervalMs = 150, label }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
    }
  }
  throw new Error(`${label} (last: ${last?.message || last})`);
}

test('packaged artifact installs CLI + WebUI without source and shuts down gracefully', { timeout: 240_000 }, async (t) => {
  const tarball = tarballPath();
  // Temp root OUTSIDE the repo; everything owned below is removed at the end.
  const tempRoot = await mkdtemp(join(tmpdir(), 'dispatch-packaged-'));
  const installDir = join(tempRoot, 'install');
  const dispatchHome = join(tempRoot, 'dispatch-home');
  const xdg = join(tempRoot, 'xdg');
  const work = join(tempRoot, 'work');
  await mkdir(installDir, { recursive: true });
  await mkdir(dispatchHome, { recursive: true });
  await mkdir(xdg, { recursive: true });
  await mkdir(work, { recursive: true });

  const ownedChildren = new Set();
  const track = (child) => {
    ownedChildren.add(child);
    child.on('exit', () => ownedChildren.delete(child));
    return child;
  };
  t.after(async () => {
    for (const child of [...ownedChildren]) {
      try {
        if (child.exitCode === null && !child.killed) {
          if (child.connected) { try { child.send('stop'); } catch { /* ignore */ } }
          else { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
        }
      } catch { /* ignore */ }
    }
    const deadline = Date.now() + 10_000;
    while (ownedChildren.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const child of [...ownedChildren]) {
      try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    await rmRetry(tempRoot);
  });

  // 1. Install the artifact with scripts enabled (verifies install-notice
  //    postinstall is safe). Registry downloads for npm dependencies allowed.
  //    NEVER global (-g): install --prefix into the isolated temp dir.
  const spawnLib = require('cross-spawn');
  const installed = spawnLib.sync('npm', ['install', '--prefix', installDir, tarball, '--no-audit', '--no-fund'], {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(installed.status, 0, `npm install --prefix failed:\n${installed.stdout?.slice(-3000)}\n${installed.stderr?.slice(-3000)}`);

  const pkgRoot = join(installDir, 'node_modules', '@michaelt025', 'dispatch');
  assert.ok(existsSync(pkgRoot), `installed package missing at ${pkgRoot}`);
  const manifest = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'));
  const rootManifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@michaelt025/dispatch');
  assert.equal(manifest.version, rootManifest.version, 'installed CLI version must match source version');
  for (const legacy of LEGACY_DEPS) {
    assert.ok(!(legacy in (manifest.dependencies || {})), `legacy dep must not ship: ${legacy}`);
  }
  for (const entry of MANAGED_ENTRIES) {
    assert.ok(existsSync(join(pkgRoot, entry)), `missing managed entry: ${entry}`);
  }
  for (const file of [
    'extensions/piastra/help.mjs',
    // Full launcher runtime (parent packaging phase must stage these;
    // the current help-only stub artifact fails here by design).
    'lib/cli.mjs',
    'lib/state.mjs',
    'lib/install-notice.mjs',
    'bin/dispatch.mjs',
    join('vendor', 'web-ui', 'dist', 'server', 'index.js'),
    join('vendor', 'web-ui', 'web', 'dist', 'index.html'),
  ]) {
    assert.ok(existsSync(join(pkgRoot, file)), `missing artifact file: ${file}`);
  }
  const faviconCandidates = [
    join('vendor', 'web-ui', 'web', 'dist', 'favicon.svg'),
    join('vendor', 'web-ui', 'web', 'public', 'favicon.svg'),
    join('vendor', 'web-ui', 'web', 'dist', 'icon.ico'),
  ];
  assert.ok(faviconCandidates.some((f) => existsSync(join(pkgRoot, f))), 'vendored Web favicon asset missing');

  const installedBin = join(pkgRoot, 'bin', 'dispatch.mjs');
  const versionRun = spawnSync(process.execPath, [installedBin, '--version'], { encoding: 'utf8', cwd: work });
  assert.equal(versionRun.status, 0, `installed --version failed: ${versionRun.stderr?.slice(-1000)}`);
  assert.equal(versionRun.stdout.trim(), manifest.version);

  // 2. Synthetic setup ONLY via the installed lib/state helper into temp
  //    DISPATCH_HOME (+ temp XDG). Synthetic OAuth stub, never real login.
  const installedState = await import(pathToFileURL(join(pkgRoot, 'lib', 'state.mjs')).href);
  const paths = installedState.resolveDispatchPaths({
    env: { DISPATCH_HOME: dispatchHome },
    packageRoot: pkgRoot,
  });
  assert.equal(paths.packageRoot, pkgRoot);
  await installedState.completeDispatchSetup(paths, { go: 'skipped' });
  await writeFile(
    join(paths.agentDir, 'auth.json'),
    JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'synthetic-test', refresh: 'synthetic-test' } }) + '\n',
  );
  const prefs = JSON.parse(await readFile(join(paths.agentDir, 'piastra', 'agents.json'), 'utf8'));
  for (const role of ['general', 'fast']) {
    assert.ok(prefs.roles?.[role]?.model?.toLowerCase().includes('luna'), `expected Luna ${role}, got: ${prefs.roles?.[role]?.model}`);
    assert.equal(prefs.roles?.[role]?.thinking, 'medium');
  }

  const childEnv = {
    ...process.env,
    DISPATCH_HOME: paths.home,
    XDG_CONFIG_HOME: xdg,
    PI_CODING_AGENT_DIR: join(tempRoot, 'unused-agent-dir'),
    PI_OFFLINE: '1',
    DISPATCH_OFFLINE: '1',
  };

  // 3. Actual installed CLI RPC (offline): catalog + state proof, no model calls.
  {
    const child = track(spawn(process.execPath, [installedBin, '--offline', '--mode', 'rpc', '--no-session'], {
      cwd: work,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    assert.ok(child.stdin && child.stdout && child.stderr);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', () => {});
    let buffer = '';
    const pending = new Map();
    const failPending = (err) => {
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      pending.clear();
    };
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.type === 'response' && msg?.id !== undefined && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.success) entry.resolve(msg.data);
          else entry.reject(new Error(`rpc ${msg.command} failed: ${msg.error}\nstderr: ${stderr.slice(-2000)}`));
        }
      }
    });
    child.on('close', () => failPending(new Error(`cli closed early\nstderr: ${stderr.slice(-2000)}`)));
    let nextId = 1;
    const request = (type, extra = {}, timeoutMs = 30_000) => new Promise((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`rpc ${type} timed out\nstderr: ${stderr.slice(-2000)}`));
      }, timeoutMs);
      pending.set(id, { resolve: res, reject: rej, timer });
      child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`, (err) => {
        if (err) {
          pending.delete(id);
          clearTimeout(timer);
          rej(err);
        }
      });
    });

    const catalog = await request('get_commands');
    const names = (catalog?.commands || []).map((c) => c?.name);
    for (const required of ['dispatch-help', 'dispatch', 'agent']) {
      assert.ok(names.includes(required), `missing /${required}; got: ${names.join(', ')}`);
    }
    const state = await request('get_state');
    assert.equal(typeof state?.messageCount, 'number', 'get_state must report messageCount without model calls');

    const closed = new Promise((resolveClose) => {
      const timer = setTimeout(() => resolveClose(null), 15_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolveClose(code);
      });
    });
    child.stdin.end();
    assert.equal(await closed, 0, `installed CLI stdin.end must exit 0\nstderr: ${stderr.slice(-2000)}`);
  }

  // 4. Actual installed Web (offline, loopback, no browser auto-open).
  //    IPC bootstrap imports the REAL installed bin only AFTER argv is set;
  //    parent "stop" -> child process.emit('SIGINT') exercises the graceful
  //    Node signal handler (no abrupt kill).
  {
    const port = await freeLoopbackPort();
    const bootstrap = join(tempRoot, 'web-bootstrap.mjs');
    await writeFile(bootstrap, `const target = Number(process.env.DISPATCH_WEB_BOOTSTRAP_PORT);\nprocess.on('message', (m) => { if (m === 'stop') process.emit('SIGINT'); });\nprocess.argv = [process.execPath, ${JSON.stringify(installedBin)}, '--web', '--port', String(target), '--no-open', '--offline'];\nawait import(${JSON.stringify(pathToFileURL(installedBin).href)});\n`);
    if (process.platform !== 'win32') {
      try { await chmod(bootstrap, 0o600); } catch { /* best effort */ }
    }
    const webChild = track(fork(bootstrap, [], {
      cwd: work,
      env: { ...childEnv, DISPATCH_WEB_BOOTSTRAP_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      silent: true,
    }));
    let webStderr = '';
    webChild.stderr?.on('data', (d) => { webStderr += String(d); });
    webChild.on('error', () => {});
    const webExit = new Promise((resolveExit) => {
      const timer = setTimeout(() => resolveExit(null), 60_000);
      webChild.on('exit', (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });

    const base = `http://127.0.0.1:${port}`;
    const health = await waitFor(async () => {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.pid, webChild.pid, 'health must report the owned server PID');
      return body;
    }, { timeoutMs: 45_000, label: 'owned web server health' });
    assert.ok(health);

    const indexRes = await fetch(`${base}/`);
    assert.equal(indexRes.status, 200, 'UI index must be 200');
    await indexRes.arrayBuffer();
    const manifestRes = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifestRes.status, 200, 'web manifest must be 200');
    await manifestRes.arrayBuffer();
    let faviconRes = await fetch(`${base}/favicon.svg`);
    if (faviconRes.status !== 200) faviconRes = await fetch(`${base}/icon.ico`);
    assert.equal(faviconRes.status, 200, 'favicon must be 200');
    await faviconRes.arrayBuffer();

    // Foreground stays up with no browser open; plain HTTP clients closing
    // must not stop the owned server.
    assert.equal(webChild.exitCode, null, 'web server must remain running without a browser');
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(webChild.exitCode, null, 'closing the HTTP client must not stop the server');

    webChild.send('stop');
    assert.equal(await webExit, 0, `IPC stop must exit 0\nstderr: ${webStderr.slice(-3000)}`);
    await waitFor(async () => {
      try {
        await fetch(`${base}/api/health`);
      } catch {
        return true;
      }
      throw new Error('port still open');
    }, { timeoutMs: 15_000, label: 'owned port closed after IPC stop' });
  }
});
