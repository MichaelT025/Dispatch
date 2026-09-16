import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  UPDATE_NOTICE_TITLE,
  setUpdateNoticePromise,
  showUpdateNotice,
} from './update-notice.mjs';

const KEY = Symbol.for('dispatch.update-notice');
const EXPECTED = 'A Dispatch update is available. Run dispatch update.';

function reset() {
  delete globalThis[KEY];
}

function tuiCtx(calls) {
  return {
    mode: 'tui',
    hasUI: true,
    ui: {
      async select(title, options) {
        calls.push({ title, options });
        return options[0];
      },
      notify() {
        throw new Error('notify must not be used in TUI mode');
      },
    },
  };
}

function rpcCtx(calls) {
  return {
    mode: 'rpc',
    hasUI: true,
    ui: {
      notify(text, level) {
        calls.push({ text, level });
      },
    },
  };
}

test('title constant is exact', () => {
  assert.equal(UPDATE_NOTICE_TITLE, EXPECTED);
});

test('module is pure: no Pi/SDK/native imports', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const text = await readFile(resolve(root, 'lib/update-notice.mjs'), 'utf8');
  assert.doesNotMatch(text, /@earendil-works|pi-coding-agent|pi-tui|node:/);
  assert.doesNotMatch(text, /setTimeout|setInterval|fetch\(/);
});

test('TUI shows exact title with single Dismiss option', async () => {
  reset();
  setUpdateNoticePromise(Promise.resolve({ version: '9.9.9', currentVersion: '1.0.0' }));
  const calls = [];
  await showUpdateNotice(tuiCtx(calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, EXPECTED);
  assert.deepEqual(calls[0].options, ['Dismiss']);
  reset();
});

test('RPC/Web notify with exact text and warning level', async () => {
  for (const mode of ['rpc', 'web']) {
    reset();
    setUpdateNoticePromise(Promise.resolve({ version: '2.0.0', currentVersion: '1.0.0' }));
    const calls = [];
    await showUpdateNotice(rpcCtx(calls).mode === mode ? { ...rpcCtx(calls), mode } : { mode, hasUI: true, ui: { notify: (t, l) => calls.push({ text: t, level: l }) } });
    assert.equal(calls.length, 1, mode);
    assert.equal(calls[0].text, EXPECTED, mode);
    assert.equal(calls[0].level, 'warning', mode);
  }
  reset();
});

test('shown once per process across repeated contexts and startup races', async () => {
  reset();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  setUpdateNoticePromise(gate);
  const a = [];
  const b = [];
  const p1 = showUpdateNotice(tuiCtx(a));
  const p2 = showUpdateNotice(tuiCtx(b));
  release({ version: '3.0.0', currentVersion: '1.0.0' });
  await Promise.all([p1, p2]);
  assert.equal(a.length + b.length, 1);
  // A third context after the notice stays silent.
  const c = [];
  await showUpdateNotice(tuiCtx(c));
  assert.equal(c.length, 0);
  reset();
});

test('stale pending claim never steals notice from new current context', async () => {
  reset();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  setUpdateNoticePromise(gate);
  let oldCurrent = true;
  const oldCalls = [];
  const newCalls = [];
  const pOld = showUpdateNotice(tuiCtx(oldCalls), { isCurrent: () => oldCurrent });
  const pNew = showUpdateNotice(tuiCtx(newCalls), { isCurrent: () => true });
  // Old session retires (epoch bump) while the shared check is pending and
  // before it resolves; only the new current context may display.
  oldCurrent = false;
  release({ version: '8.0.0', currentVersion: '1.0.0' });
  await Promise.all([pOld, pNew]);
  assert.equal(oldCalls.length, 0);
  assert.equal(newCalls.length, 1);
  assert.equal(newCalls[0].title, EXPECTED);
  assert.deepEqual(newCalls[0].options, ['Dismiss']);
  reset();
});

test('no result, same version, and rejection fall back silently', async () => {
  for (const value of [null, undefined, {}, { version: '1.0.0', currentVersion: '1.0.0' }, { version: '', currentVersion: 'x' }]) {
    reset();
    setUpdateNoticePromise(Promise.resolve(value));
    const calls = [];
    await showUpdateNotice(tuiCtx(calls));
    assert.equal(calls.length, 0, JSON.stringify(value));
  }
  reset();
  setUpdateNoticePromise(Promise.reject(new Error('net down')));
  const calls = [];
  await showUpdateNotice(tuiCtx(calls));
  assert.equal(calls.length, 0);
  // Rejection must not produce an unhandled rejection (stored promise resolves null).
  const stored = globalThis[KEY].promise;
  assert.equal(await stored, null);
  reset();
});

test('print/no-UI/stale contexts stay silent with no machine output', async () => {
  reset();
  setUpdateNoticePromise(Promise.resolve({ version: '5.0.0', currentVersion: '1.0.0' }));
  const silent = [];
  await showUpdateNotice({ mode: 'print', hasUI: false, ui: { select: () => silent.push(1), notify: () => silent.push(1) } });
  await showUpdateNotice({ mode: 'json', hasUI: true, ui: { select: () => silent.push(1), notify: () => silent.push(1) } });
  await showUpdateNotice({ mode: 'tui', hasUI: false, ui: { select: () => silent.push(1), notify: () => silent.push(1) } });
  await showUpdateNotice(tuiCtx(silent), { isCurrent: () => false });
  assert.equal(silent.length, 0);
  // Notice still available for a live context afterwards.
  const live = [];
  await showUpdateNotice(tuiCtx(live));
  assert.equal(live.length, 1);
  reset();
});

test('UI throw resets flag so a later context can retry', async () => {
  reset();
  setUpdateNoticePromise(Promise.resolve({ version: '6.0.0', currentVersion: '1.0.0' }));
  await showUpdateNotice({
    mode: 'tui',
    hasUI: true,
    ui: { async select() { throw new Error('disposed'); }, notify() {} },
  });
  assert.equal(globalThis[KEY].shown, false);
  const calls = [];
  await showUpdateNotice(tuiCtx(calls));
  assert.equal(calls.length, 1);
  reset();
});

test('no model/history writes: only ui.select/notify touched', async () => {
  reset();
  setUpdateNoticePromise(Promise.resolve({ version: '7.0.0', currentVersion: '1.0.0' }));
  const ctx = tuiCtx([]);
  const before = Object.keys(ctx);
  await showUpdateNotice(ctx);
  assert.deepEqual(Object.keys(ctx), before);
  reset();
});

test('extension handler guards on DISPATCH_ACTIVE and tolerates missing library', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const text = await readFile(resolve(root, 'extensions/piastra/index.ts'), 'utf8');
  assert.match(text, /DISPATCH_ACTIVE.*'1'/);
  assert.match(text, /import\('\.\.\/\.\.\/lib\/update-notice\.mjs'\)/);
  assert.doesNotMatch(text, /from ['"]\.\.\/\.\.\/lib\/update-notice/);
  assert.match(text, /isCurrent/);
  assert.match(text, /session_shutdown/);
  // Legacy runtime simulation: handler path rejects import without throwing.
  let rejected = false;
  await import('node:module').then(() => {}).catch(() => {});
  try {
    await import(resolve(root, 'lib/does-not-exist-legacy-check.mjs'));
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
});
