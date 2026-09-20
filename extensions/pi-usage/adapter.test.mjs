import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { fetchProvider } from './adapter.mjs';
import { fetchCommandCodePayloads } from './command-requests.mjs';
import { requestJson } from './http.mjs';

const checkedAt = '2026-01-02T03:04:05.000Z';
const now = () => Date.parse(checkedAt);

function definition(load) {
  return { id: 'test-provider', displayName: 'Test Provider', load };
}

function jsonResponse(value, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    async json() { return value; },
  };
}

test('returns usage and an opaque account key derived from the credential', async () => {
  const seen = [];
  const provider = definition(async ({ token, signal }) => {
    seen.push({ token, signal });
    return { windows: [{ label: '5h', windowSeconds: 18_000, usedPercent: 2, resetsAt: null }] };
  });

  const first = await fetchProvider(provider, {
    resolveAuth: async () => ({ apiKey: 'secret-account-one' }),
    now,
  });
  const second = await fetchProvider(provider, {
    resolveAuth: async () => ({ apiKey: 'secret-account-two' }),
    now,
  });

  assert.equal(first.state, 'ok');
  assert.equal(first.checkedAt, checkedAt);
  assert.equal(first.fetchedAt, checkedAt);
  assert.equal(first.accountKey, createHash('sha256').update('test-provider\0secret-account-one').digest('hex'));
  assert.notEqual(first.accountKey, second.accountKey);
  assert.match(first.accountKey, /^[0-9a-f]{64}$/);
  assert.equal(seen[0].token, 'secret-account-one');
  assert.equal(seen[0].signal.aborted, true, 'adapter cleans up the controller after success');
  assert.doesNotMatch(JSON.stringify(first), /secret-account-one/);
  assert.doesNotMatch(JSON.stringify(second), /secret-account-two/);
});

test('reports missing credentials as an unconfigured provider without loading it', async () => {
  let loaded = false;
  const result = await fetchProvider(definition(async () => {
    loaded = true;
    return { windows: [] };
  }), { resolveAuth: async () => undefined, now });

  assert.equal(loaded, false);
  assert.deepEqual(result, {
    providerId: 'test-provider',
    displayName: 'Test Provider',
    state: 'unconfigured',
    windows: [],
    fetchedAt: null,
    checkedAt,
    error: 'NOT_CONFIGURED',
  });
});

test('bounds a stalled auth refresh by the whole-operation deadline', async () => {
  let release;
  const auth = new Promise((resolve) => { release = resolve; });
  const operation = fetchProvider(definition(async () => ({ windows: [] })), {
    resolveAuth: () => auth,
    timeoutMs: 15,
    now,
  });

  const result = await operation;
  release({ apiKey: 'late-secret' });
  assert.equal(result.state, 'unavailable');
  assert.equal(result.error, 'NETWORK');
  assert.equal(result.fetchedAt, null);
  assert.equal(result.checkedAt, checkedAt);
  assert.doesNotMatch(JSON.stringify(result), /late-secret/);
});

test('bounds a stalled fetch and aborts the provider signal', async () => {
  let releaseFetch;
  let fetchSignal;
  const pendingFetch = new Promise((resolve) => { releaseFetch = resolve; });
  const provider = definition(({ token, signal, fetch }) => {
    fetchSignal = signal;
    return requestJson('https://provider.invalid/usage', { token, signal, fetch });
  });
  const operation = fetchProvider(provider, {
    resolveAuth: async () => ({ apiKey: 'fetch-secret' }),
    fetch: () => pendingFetch,
    timeoutMs: 15,
    now,
  });

  const result = await operation;
  assert.equal(result.error, 'NETWORK');
  assert.equal(fetchSignal.aborted, true);
  releaseFetch(jsonResponse({ windows: [] }));
});

test('aborts a stalled parallel Command Code billing request when its sibling fails', async () => {
  const calls = [];
  let siblingSignal;
  const operationStarted = Date.now();
  const provider = definition(({ token, signal, fetch }) => fetchCommandCodePayloads({
    token, signal, fetch,
  }));
  const result = await fetchProvider(provider, {
    resolveAuth: async () => ({ apiKey: 'command-code-secret' }),
    timeoutMs: 5_000,
    fetch: async (url, options) => {
      calls.push(url);
      if (url.endsWith('/whoami')) return jsonResponse({ org: { id: 'org-1' } });
      if (url.includes('/billing/credits')) return jsonResponse({ failure: 'billing unavailable' }, 500);
      if (url.includes('/billing/subscriptions')) {
        siblingSignal = options.signal;
        return new Promise(() => {});
      }
      throw new Error(`unexpected future request: ${url}`);
    },
    now,
  });

  assert.equal(result.error, 'HTTP');
  assert.deepEqual(calls.slice(0, 3), [
    'https://api.commandcode.ai/alpha/whoami',
    'https://api.commandcode.ai/alpha/billing/credits?orgId=org-1',
    'https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-1',
  ]);
  assert.equal(siblingSignal.aborted, true);
  assert.ok(Date.now() - operationStarted < 1_000, 'failure aborts before the deadline');
  assert.equal(calls.length, 3, 'no request starts after the failed parallel billing call');
});

test('does not start a provider request after auth is aborted', async () => {
  let releaseAuth;
  let loadCalls = 0;
  const auth = new Promise((resolve) => { releaseAuth = resolve; });
  const operation = fetchProvider(definition(async () => {
    loadCalls += 1;
    return { windows: [{ label: 'late' }] };
  }), {
    resolveAuth: () => auth,
    timeoutMs: 15,
    now,
  });

  const result = await operation;
  releaseAuth({ apiKey: 'late-auth-secret' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.error, 'NETWORK');
  assert.equal(loadCalls, 0);
});

test('bounds a stalled response body and aborts the provider signal', async () => {
  let releaseBody;
  let bodySignal;
  const pendingBody = new Promise((resolve) => { releaseBody = resolve; });
  const provider = definition(({ token, signal, fetch }) => {
    bodySignal = signal;
    return requestJson('https://provider.invalid/usage', { token, signal, fetch });
  });
  const result = await fetchProvider(provider, {
    resolveAuth: async () => ({ apiKey: 'body-secret' }),
    fetch: async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: () => pendingBody,
    }),
    timeoutMs: 15,
    now,
  });

  assert.equal(result.error, 'NETWORK');
  assert.equal(bodySignal.aborted, true);
  releaseBody({ windows: [] });
});

test('external cancellation aborts in-flight work before the deadline', async () => {
  const external = new AbortController();
  let providerSignal;
  const provider = definition(({ signal }) => {
    providerSignal = signal;
    return new Promise(() => {});
  });
  const operation = fetchProvider(provider, {
    resolveAuth: async () => ({ apiKey: 'cancel-secret' }),
    signal: external.signal,
    timeoutMs: 5_000,
    now,
  });

  await new Promise((resolve) => setImmediate(resolve));
  external.abort();
  const result = await operation;

  assert.equal(providerSignal.aborted, true);
  assert.equal(result.state, 'unavailable');
  assert.equal(result.error, 'NETWORK');
  assert.doesNotMatch(JSON.stringify(result), /cancel-secret/);
});

test('normalizes auth failures and never publishes raw auth error text', async () => {
  const secret = 'raw-secret-from-auth';
  const result = await fetchProvider(definition(async () => ({ windows: [] })), {
    resolveAuth: async () => { throw new Error(`refresh failed for ${secret}`); },
    now,
  });

  assert.equal(result.state, 'unavailable');
  assert.equal(result.error, 'NETWORK');
  assert.doesNotMatch(JSON.stringify(result), /raw-secret-from-auth/);
  assert.doesNotMatch(result.error, /raw-secret/);
});
