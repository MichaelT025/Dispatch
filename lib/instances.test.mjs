import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackDispatchInstance, assertNoActiveDispatch } from './instances.mjs';

test('foreground lease blocks updates until process exit; cleanup touches only its own lease', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dispatch-instance-'));
  const paths = { home, packageRoot: home };
  const host = new EventEmitter();
  try {
    const release = await trackDispatchInstance(paths, 'web', { host, pid: 1234 });
    assert.equal(host.listenerCount('exit'), 1);
    await assert.rejects(assertNoActiveDispatch(paths, { isAlive: async () => true }), /Close running Dispatch/);
    host.emit('exit');
    await assertNoActiveDispatch(paths, { isAlive: () => true });
    assert.deepEqual(await readdir(join(home, 'instances')), []);
    release(); // idempotent
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('dead owned leases are removed; another installation is left untouched', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dispatch-instance-'));
  const host = new EventEmitter();
  const paths = { home, packageRoot: home };
  let releaseOther;
  try {
    const release = await trackDispatchInstance(paths, 'cli', { host, pid: 1234 });
    releaseOther = await trackDispatchInstance({ home, packageRoot: join(home, 'other') }, 'web', { host, pid: 5678 });
    const probed = [];
    await assertNoActiveDispatch(paths, { isAlive: pid => { probed.push(pid); return false; } });
    assert.deepEqual(probed, [1234]);
    assert.equal((await readdir(join(home, 'instances'))).length, 1);
    release();
  } finally {
    releaseOther?.();
    await rm(home, { recursive: true, force: true });
  }
});
