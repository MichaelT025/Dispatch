import assert from 'node:assert/strict';
import test from 'node:test';

import { startUsagePolling } from './polling.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  const scheduled = [];
  let clearCount = 0;

  const setTimeout = (callback, delay) => {
    const timer = {
      id: nextId++,
      callback,
      delay,
      unrefCount: 0,
      unref() {
        this.unrefCount += 1;
      },
    };
    timers.set(timer.id, timer);
    scheduled.push(timer);
    return timer;
  };

  const clearTimeout = timer => {
    clearCount += 1;
    timers.delete(timer.id);
  };

  const tick = () => {
    const [id, timer] = timers.entries().next().value ?? [];
    if (timer === undefined) return false;
    timers.delete(id);
    timer.callback();
    return true;
  };

  return {
    setTimeout,
    clearTimeout,
    tick,
    scheduled,
    get clearCount() {
      return clearCount;
    },
    get pendingCount() {
      return timers.size;
    },
  };
}

const settleMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('invokes refresh immediately and schedules each next run after settlement', async () => {
  const clock = fakeClock();
  let calls = 0;
  const polling = startUsagePolling(
    () => {
      calls += 1;
    },
    { intervalMs: 42, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  );

  assert.equal(calls, 1);
  assert.equal(clock.pendingCount, 0);

  await settleMicrotasks();
  assert.equal(clock.pendingCount, 1);
  assert.equal(clock.scheduled[0].delay, 42);
  assert.equal(clock.scheduled[0].unrefCount, 1);

  clock.tick();
  assert.equal(calls, 2);
  assert.equal(clock.pendingCount, 0);
  await settleMicrotasks();
  assert.equal(clock.pendingCount, 1);

  polling.dispose();
});

test('waits for a delayed refresh before starting the next run', async () => {
  const clock = fakeClock();
  const first = deferred();
  let calls = 0;
  const polling = startUsagePolling(
    () => {
      calls += 1;
      return calls === 1 ? first.promise : undefined;
    },
    { intervalMs: 10, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  );

  assert.equal(calls, 1);
  await settleMicrotasks();
  assert.equal(clock.pendingCount, 0);

  first.resolve();
  await settleMicrotasks();
  assert.equal(clock.pendingCount, 1);

  clock.tick();
  assert.equal(calls, 2);
  polling.dispose();
});

test('swallows refresh rejection and continues polling', async () => {
  const clock = fakeClock();
  let calls = 0;
  const polling = startUsagePolling(
    () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('refresh failed')) : undefined;
    },
    { intervalMs: 10, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  );

  await settleMicrotasks();
  assert.equal(calls, 1);
  assert.equal(clock.pendingCount, 1);

  clock.tick();
  assert.equal(calls, 2);
  polling.dispose();
});

test('dispose before an inflight refresh settles prevents rearming', async () => {
  const clock = fakeClock();
  const pending = deferred();
  let calls = 0;
  const polling = startUsagePolling(
    () => {
      calls += 1;
      return pending.promise;
    },
    { intervalMs: 10, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  );

  polling.dispose();
  pending.resolve();
  await settleMicrotasks();

  assert.equal(calls, 1);
  assert.equal(clock.pendingCount, 0);
  assert.equal(clock.clearCount, 0);
});

test('dispose clears a pending timer and is idempotent', async () => {
  const clock = fakeClock();
  const polling = startUsagePolling(
    () => undefined,
    { intervalMs: 10, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  );
  await settleMicrotasks();
  assert.equal(clock.pendingCount, 1);

  polling.dispose();
  polling.dispose();
  assert.equal(clock.clearCount, 1);
  assert.equal(clock.pendingCount, 0);
  assert.equal(clock.tick(), false);
});
