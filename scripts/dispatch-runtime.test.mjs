import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { completeDispatchSetup, resolveDispatchPaths } from '../lib/state.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'dispatch.mjs');

// Single end-to-end RPC smoke through the real launcher binary.
// Offline, synthetic credentials only in temp dirs, no model requests, no
// ordinary user prompt. stdin.end() must exit 0.
test('dispatch offline rpc smoke: catalog proof then help without model history', { timeout: 90_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dispatch-runtime-'));
  const dispatchHome = join(base, 'home');
  const xdg = join(base, 'xdg');
  const sentinel = join(base, 'sentinel-agent');
  const work = join(base, 'work');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dispatchHome, { recursive: true });
  await mkdir(xdg, { recursive: true });
  await mkdir(sentinel, { recursive: true });
  await mkdir(work, { recursive: true });
  // Sentinel marker proves the bogus inherited agent dir is never mutated.
  await writeFile(join(sentinel, 'SENTINEL.txt'), 'do-not-touch\n');
  const sentinelBefore = (await readdir(sentinel)).sort();

  const paths = resolveDispatchPaths({ env: { DISPATCH_HOME: dispatchHome }, packageRoot: ROOT });
  await completeDispatchSetup(paths, { go: 'skipped' });
  // Synthetic OAuth credential ONLY in the temp agent dir (offline stub).
  await writeFile(
    join(paths.agentDir, 'auth.json'),
    JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'synthetic-test', refresh: 'synthetic-test' } }) + '\n',
  );
  const stateBefore = await readFile(paths.stateFile, 'utf8');

  let child = null;
  try {
    child = spawn(process.execPath, [BIN, '--name', '--web', '--offline', '--mode', 'rpc', '--no-session'], {
      cwd: work,
      env: {
        ...process.env,
        DISPATCH_HOME: paths.home,
        XDG_CONFIG_HOME: xdg,
        PI_CODING_AGENT_DIR: sentinel,
        PI_CODING_AGENT_SESSION_DIR: join(sentinel, 'sessions'),
        PI_OFFLINE: '1',
        DISPATCH_OFFLINE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.ok(child.stdin && child.stdout && child.stderr, 'child stdio missing');
    t.after(() => {
      try {
        if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
      } catch { /* ignore */ }
    });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', () => {});

    // Line-buffered JSON RPC over stdout.
    let buffer = '';
    const pending = new Map();
    const notices = [];
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
          const { resolve: res, reject: rej, timer } = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.success) res(msg.data);
          else rej(new Error(`rpc ${msg.command} failed: ${msg.error || 'unknown'}\nstderr: ${stderr.slice(-2000)}`));
        } else if (msg?.type === 'extension_ui_request') {
          notices.push(msg);
        }
      }
    });
    child.on('close', () => failPending(new Error(`child closed early\nstderr: ${stderr.slice(-2000)}`)));

    let nextId = 1;
    function request(type, extra = {}, timeoutMs = 30_000) {
      const id = nextId++;
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectPromise(new Error(`rpc ${type} timed out after ${timeoutMs}ms\nstderr: ${stderr.slice(-2000)}`));
        }, timeoutMs);
        pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
        child.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n', (err) => {
          if (err) {
            pending.delete(id);
            clearTimeout(timer);
            rejectPromise(err);
          }
        });
      });
    }

    // Catalog proof first: all launcher-owned commands must be registered.
    // Never send an ordinary user prompt; only catalog + help + state.
    const catalog = await request('get_commands');
    const names = (catalog?.commands || []).map((c) => c?.name);
    for (const required of ['dispatch-help', 'dispatch', 'agent', 'workers', 'wt', 'todos', 'atelier']) {
      assert.ok(names.includes(required), `missing /${required}; got: ${names.join(', ')}\nstderr: ${stderr.slice(-2000)}`);
    }
    assert.ok(names.includes('q') || names.includes('queue-drain'), `missing queue command; got: ${names.join(', ')}`);

    const before = await request('get_state');
    assert.equal(typeof before?.messageCount, 'number');
    assert.equal(before.sessionName, '--web', 'a flag-looking Pi option value is forwarded intact');

    // Help slash only after catalog proof; must not add model history.
    await request('prompt', { message: '/dispatch-help shortcuts' });
    // Allow the help notify to arrive without racing the next state read.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await request('get_state');
    assert.equal(after?.messageCount, before?.messageCount, 'help must not enter model history');

    // Graceful exit via stdin EOF.
    const closed = new Promise((resolveClose) => {
      const timer = setTimeout(() => resolveClose(null), 15_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolveClose(code);
      });
    });
    child.stdin.end();
    const code = await closed;
    assert.equal(code, 0, `stdin.end must exit 0\nstderr: ${stderr.slice(-2000)}`);

    // Own state preserved; sentinel never mutated.
    const stateAfter = await readFile(paths.stateFile, 'utf8');
    assert.equal(stateAfter, stateBefore, 'own dispatch state must be preserved');
    assert.deepEqual((await readdir(sentinel)).sort(), sentinelBefore, 'bogus PI agent dir must not be mutated');
    assert.equal(await readFile(join(sentinel, 'SENTINEL.txt'), 'utf8'), 'do-not-touch\n');
    void notices;
  } finally {
    try {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 1000));
        if (child.exitCode === null) try { child.kill('SIGKILL'); } catch {}
      }
    } catch {}
    await rm(base, { recursive: true, force: true });
  }
});
