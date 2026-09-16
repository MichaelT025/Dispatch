import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensurePlainPi, PI_PINNED_VERSION } from './pi-install.mjs';

test('absent pi (ENOENT) with consent installs pinned spec', async () => {
  const calls = [];
  const seen = [];
  const result = await ensurePlainPi({
    probe: async () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
    install: async () => { calls.push('install'); return { status: 0 }; },
    confirm: async () => true,
    info: (t) => seen.push(t),
  });
  assert.equal(result.status, 'installed');
  assert.deepEqual(calls, ['install']);
});

test('declined install rejects; failed install rejects without leaking detail', async () => {
  await assert.rejects(() => ensurePlainPi({
    probe: async () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }),
    install: async () => { throw new Error('unreachable'); },
    confirm: async () => false,
    info: () => {},
  }), /declined/);
  await assert.rejects(() => ensurePlainPi({
    probe: async () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }),
    install: async () => ({ status: 1 }),
    confirm: async () => true,
    info: () => {},
  }), /Could not install/);
});

test('existing pi of any version is left untouched, never upgraded', async () => {
  const seen = [];
  const result = await ensurePlainPi({
    probe: async () => ({ status: 0 }),
    install: async () => { throw new Error('must not install'); },
    info: (t) => seen.push(t),
  });
  assert.equal(result.status, 'existing');
  assert.ok(seen.join(' ').includes(PI_PINNED_VERSION));
});

test('non-ENOENT probe failure treated as existing, not absent', async () => {
  const seen = [];
  const result = await ensurePlainPi({
    probe: async () => ({ error: Object.assign(new Error('denied'), { code: 'EACCES' }) }),
    install: async () => { throw new Error('must not install'); },
    info: (t) => seen.push(t),
  });
  assert.equal(result.status, 'existing');
});

test('abort rejects promptly', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => ensurePlainPi({
    probe: async () => ({ status: 0 }),
    info: () => {},
    signal: controller.signal,
  }));
});

test('signal-terminated install is a failure, not success', async () => {
  await assert.rejects(() => ensurePlainPi({
    probe: async () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }),
    install: async () => ({ status: null, signal: 'SIGINT' }),
    confirm: async () => true,
    info: () => {},
  }), /Could not install/);
});

test('null status without signal is a failure, not success', async () => {
  await assert.rejects(() => ensurePlainPi({
    probe: async () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }),
    install: async () => ({ status: null, signal: null }),
    confirm: async () => true,
    info: () => {},
  }), /Could not install/);
});

test('nonzero existing-pi probe is not reported as a successful probe', async () => {
  const seen = [];
  const result = await ensurePlainPi({
    probe: async () => ({ status: 1, signal: null }),
    install: async () => { throw new Error('must not install'); },
    info: (t) => seen.push(t),
  });
  assert.equal(result.status, 'existing');
  assert.ok(seen.join(' ').includes('Could not probe'));
});

test('aborted install rejects with AbortError', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => ensurePlainPi({
    probe: async () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }),
    install: async ({ signal }) => { signal?.throwIfAborted?.(); return { status: 0 }; },
    confirm: async () => true,
    info: () => {},
    signal: controller.signal,
  }), (e) => e?.name === 'AbortError' || /cancelled/i.test(String(e?.message)));
});
