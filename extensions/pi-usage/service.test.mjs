import assert from 'node:assert/strict';
import test from 'node:test';

import { createUsageService } from './service.mjs';

const provider = (id, displayName = id) => ({ id, displayName });
const usage = (providerId, extra = {}) => ({
  providerId,
  displayName: providerId,
  state: 'ok',
  windows: [],
  fetchedAt: '2026-01-01T00:00:00.000Z',
  checkedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

test('fetches providers concurrently and publishes independent results as they arrive', async () => {
  const slow = deferred();
  const providers = [provider('slow'), provider('fast')];
  const calls = [];
  const updates = [];
  const service = createUsageService({
    providers,
    fetchProvider: (definition, options) => {
      calls.push({ definition, signal: options.signal });
      return definition.id === 'slow' ? slow.promise : Promise.resolve(usage('fast'));
    },
    onUpdate: snapshot => updates.push(snapshot),
  });

  const refresh = service.refresh();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls.map(call => call.definition.id), ['slow', 'fast']);
  assert.equal(calls[0].signal, calls[1].signal);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].map(result => result.providerId), ['fast']);
  assert.equal(service.getSnapshot()[0].providerId, 'fast');

  slow.resolve(usage('slow'));
  const results = await refresh;
  assert.deepEqual(results.map(result => result.providerId), ['slow', 'fast']);
  assert.deepEqual(service.getSnapshot().map(result => result.providerId), ['slow', 'fast']);
  assert.equal(updates.length, 2);

  service.dispose();
});

test('deduplicates simultaneous refreshes and shares the in-flight promise', async () => {
  const pending = deferred();
  const calls = [];
  const service = createUsageService({
    providers: [provider('same'), provider('other')],
    fetchProvider: definition => {
      calls.push(definition.id);
      return definition.id === 'same' ? pending.promise : Promise.resolve(usage('other'));
    },
  });

  const first = service.refresh();
  const second = service.refresh();
  assert.equal(first, second);
  assert.deepEqual(calls, ['same', 'other']);

  pending.resolve(usage('same'));
  await first;
  service.dispose();
});

test('cooldown skips only the rate-limited provider and resumes after it elapses', async () => {
  let currentTime = 1_000_000;
  const calls = [];
  const limited = {
    providerId: 'limited', displayName: 'limited', state: 'unavailable', windows: [],
    fetchedAt: null, checkedAt: '2026-02-03T04:05:06.000Z', error: 'RATE_LIMITED',
    retryAfterMs: 60_000,
  };
  const service = createUsageService({
    providers: [provider('limited'), provider('healthy')],
    now: () => currentTime,
    fetchProvider: definition => {
      calls.push(definition.id);
      return definition.id === 'limited' ? limited : Promise.resolve(usage('healthy'));
    },
  });

  await service.refresh();
  currentTime += 59_999;
  await service.refresh();
  assert.deepEqual(calls, ['limited', 'healthy', 'healthy']);

  currentTime += 1;
  await service.refresh();
  assert.deepEqual(calls, ['limited', 'healthy', 'healthy', 'limited', 'healthy']);
  service.dispose();
});

test('clamps rate-limit retry durations and clears cooldown after success', async () => {
  let currentTime = 2_000_000;
  let calls = 0;
  const responses = [
    { providerId: 'rate', displayName: 'rate', state: 'unavailable', windows: [], fetchedAt: null,
      checkedAt: '2026-02-03T04:05:06.000Z', error: 'RATE_LIMITED', retryAfterMs: 1 },
    { providerId: 'rate', displayName: 'rate', state: 'unavailable', windows: [], fetchedAt: null,
      checkedAt: '2026-02-03T04:05:06.000Z', error: 'RATE_LIMITED', retryAfterMs: 25 * 60 * 60 * 1_000 },
    usage('rate'),
    usage('rate'),
  ];
  const service = createUsageService({
    providers: [provider('rate')],
    now: () => currentTime,
    fetchProvider: () => {
      calls += 1;
      return Promise.resolve(responses.shift());
    },
  });

  const [first] = await service.refresh();
  assert.equal(first.retryAt, new Date(currentTime + 30_000).toISOString());
  currentTime += 29_999;
  await service.refresh();
  assert.equal(calls, 1);
  currentTime += 1;
  await service.refresh();
  assert.equal(calls, 2);
  currentTime += 24 * 60 * 60 * 1_000 - 1;
  await service.refresh();
  assert.equal(calls, 2);
  currentTime += 1;
  await service.refresh();
  assert.equal(calls, 3);
  await service.refresh();
  assert.equal(calls, 4);
  service.dispose();
});

test('refresh republishes an all-cooling snapshot without making requests', async () => {
  let currentTime = 3_000_000;
  const calls = [];
  const updates = [];
  const limited = id => ({
    providerId: id, displayName: id, state: 'unavailable', windows: [],
    fetchedAt: null, checkedAt: new Date(currentTime).toISOString(),
    error: 'RATE_LIMITED', retryAfterMs: 60_000,
  });
  const service = createUsageService({
    providers: [provider('first'), provider('second')],
    now: () => currentTime,
    fetchProvider: definition => {
      calls.push(definition.id);
      return Promise.resolve(limited(definition.id));
    },
    onUpdate: snapshot => updates.push(snapshot),
  });

  await service.refresh();
  const before = service.getSnapshot();
  const updateCount = updates.length;
  currentTime += 30_000;
  await service.refresh();

  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(updates.length, updateCount + 1);
  assert.deepEqual(updates.at(-1), before);
  assert.deepEqual(service.getSnapshot(), before);
  service.dispose();
});

test('normalizes an unexpected provider rejection without stopping other providers', async () => {
  const slow = deferred();
  const now = () => Date.parse('2026-02-03T04:05:06.000Z');
  const service = createUsageService({
    providers: [provider('broken'), provider('healthy')],
    fetchProvider: definition => definition.id === 'broken'
      ? Promise.reject(new Error('private provider detail'))
      : slow.promise,
    now,
  });

  const refresh = service.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(service.getSnapshot(), [{
    providerId: 'broken',
    displayName: 'broken',
    state: 'unavailable',
    windows: [],
    fetchedAt: null,
    checkedAt: '2026-02-03T04:05:06.000Z',
    error: 'NETWORK',
  }]);

  slow.resolve(usage('healthy'));
  const results = await refresh;
  assert.equal(results[0].error, 'NETWORK');
  assert.equal(results[1].providerId, 'healthy');
});

test('keeps the last successful data visible while refreshing and marks matching failures stale', async () => {
  const retry = deferred();
  let calls = 0;
  const successful = usage('cached', {
    accountKey: 'account-one',
    windows: [{ label: '5h', windowSeconds: 18_000, usedPercent: 25, resetsAt: null }],
    credits: [{ label: 'included', remaining: 12, unit: 'credits' }],
    fetchedAt: '2026-02-01T00:00:00.000Z',
  });
  const service = createUsageService({
    providers: [provider('cached')],
    fetchProvider: () => calls++ === 0 ? successful : retry.promise,
  });

  await service.refresh();
  const refresh = service.refresh();
  assert.deepEqual(service.getSnapshot(), [successful]);

  retry.resolve({
    providerId: 'cached',
    displayName: 'cached',
    state: 'unavailable',
    windows: [],
    fetchedAt: null,
    checkedAt: '2026-02-02T00:00:00.000Z',
    error: 'NETWORK',
    accountKey: 'account-one',
  });
  const [result] = await refresh;

  assert.deepEqual(result, {
    providerId: 'cached',
    displayName: 'cached',
    state: 'unavailable',
    windows: successful.windows,
    credits: successful.credits,
    fetchedAt: successful.fetchedAt,
    checkedAt: '2026-02-02T00:00:00.000Z',
    error: 'NETWORK',
    accountKey: 'account-one',
    stale: true,
  });
  assert.deepEqual(service.getSnapshot(), [result]);
});

test('clears cached data on account switching and accepts the new account on recovery', async () => {
  const accountOne = usage('switching', {
    accountKey: 'account-one',
    windows: [{ label: 'old', windowSeconds: 60, usedPercent: 10, resetsAt: null }],
    credits: [{ label: 'old', remaining: 8, unit: 'credits' }],
  });
  const accountTwoFailure = {
    providerId: 'switching', displayName: 'switching', state: 'unavailable', windows: [],
    fetchedAt: null, checkedAt: '2026-02-02T00:00:00.000Z', error: 'NETWORK', accountKey: 'account-two',
  };
  const accountTwoSuccess = usage('switching', {
    accountKey: 'account-two',
    windows: [{ label: 'new', windowSeconds: 60, usedPercent: 2, resetsAt: null }],
    credits: [{ label: 'new', remaining: 20, unit: 'credits' }],
  });
  const responses = [accountOne, accountTwoFailure, accountTwoSuccess];
  const service = createUsageService({
    providers: [provider('switching')],
    fetchProvider: () => Promise.resolve(responses.shift()),
  });

  await service.refresh();
  const [cleared] = await service.refresh();
  assert.deepEqual(cleared, accountTwoFailure);
  assert.equal(cleared.stale, undefined);
  assert.deepEqual(await service.refresh(), [accountTwoSuccess]);
  assert.deepEqual(service.getSnapshot(), [accountTwoSuccess]);
});

test('clears matching cached data for auth failures', async () => {
  const successful = usage('auth', { accountKey: 'account-one', windows: [{ label: 'day', windowSeconds: 86_400, usedPercent: 1, resetsAt: null }] });
  const failure = {
    providerId: 'auth', displayName: 'auth', state: 'unavailable', windows: [], fetchedAt: null,
    checkedAt: '2026-02-02T00:00:00.000Z', error: 'AUTH', accountKey: 'account-one',
  };
  const responses = [successful, failure];
  const service = createUsageService({
    providers: [provider('auth')],
    fetchProvider: () => Promise.resolve(responses.shift()),
  });

  await service.refresh();
  assert.deepEqual(await service.refresh(), [failure]);
});

test('dispose aborts the shared signal and ignores late results', async () => {
  const late = deferred();
  const updates = [];
  let signal;
  const service = createUsageService({
    providers: [provider('late')],
    fetchProvider: (_definition, options) => {
      signal = options.signal;
      return late.promise;
    },
    onUpdate: snapshot => updates.push(snapshot),
  });

  const refresh = service.refresh();
  await Promise.resolve();
  service.dispose();
  assert.equal(signal.aborted, true);

  late.resolve(usage('late'));
  await refresh;
  assert.deepEqual(updates, []);
  assert.deepEqual(service.getSnapshot(), []);

  service.dispose();
});
