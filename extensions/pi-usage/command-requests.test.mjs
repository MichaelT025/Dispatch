import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCommandCodePayloads } from './command-requests.mjs';

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => value,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('sequences account requests, shares orgId, and sends normalized billing since', async () => {
  const calls = [];
  const credits = deferred();
  const subscriptions = deferred();
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/whoami')) return jsonResponse({ org: { id: 'org/acme' } });
    if (url.includes('/billing/credits')) return credits.promise;
    if (url.includes('/billing/subscriptions')) return subscriptions.promise;
    if (url.includes('/usage/summary')) return jsonResponse({ totalCount: 2 });
    throw new Error('unexpected endpoint');
  };

  const resultPromise = fetchCommandCodePayloads({
    token: 'secret-token', signal: new AbortController().signal, fetch,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://api.commandcode.ai/alpha/whoami',
    'https://api.commandcode.ai/alpha/billing/credits?orgId=org%2Facme',
    'https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org%2Facme',
  ]);
  assert.strictEqual(calls[0].options.signal, calls[1].options.signal);
  assert.strictEqual(calls[1].options.signal, calls[2].options.signal);

  credits.resolve(jsonResponse({ credits: { monthlyCredits: 4 } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3, 'usage waits for subscriptions');

  subscriptions.resolve(jsonResponse({
    data: { currentPeriodStart: '2026-02-03T04:05:06+00:00' },
  }));
  const result = await resultPromise;
  assert.equal(calls.length, 4);
  const usageUrl = new URL(calls[3].url);
  assert.equal(usageUrl.pathname, '/alpha/usage/summary');
  assert.equal(usageUrl.searchParams.get('orgId'), 'org/acme');
  assert.equal(usageUrl.searchParams.get('since'), '2026-02-03T04:05:06.000Z');
  assert.equal(result.usage.periodBasis, 'billing-period');
});

test('omits orgId when whoami has no usable organization, without using another identity', async () => {
  for (const org of [null, undefined, {}, { id: '  ' }, { id: 123 }]) {
    const calls = [];
    const credits = { credits: { monthlyCredits: 4 } };
    const result = await fetchCommandCodePayloads({
      token: 'secret-token',
      signal: new AbortController().signal,
      fetch: async (url) => {
        calls.push(url);
        if (url.endsWith('/whoami')) return jsonResponse({ id: 'wrong-account', user: { id: 'wrong-user' }, org });
        if (url.includes('/credits')) return jsonResponse(credits);
        if (url.includes('/subscriptions')) return jsonResponse({ data: null });
        return jsonResponse({ totalCount: 1 });
      },
    });
    assert.deepEqual(calls, [
      'https://api.commandcode.ai/alpha/whoami',
      'https://api.commandcode.ai/alpha/billing/credits',
      'https://api.commandcode.ai/alpha/billing/subscriptions',
      'https://api.commandcode.ai/alpha/usage/summary',
    ]);
    assert.deepEqual(result.credits, credits);
    assert.deepEqual(result.usage, { totalCount: 1 });
  }
});

test('does not send since or add billing-period without a valid period start', async () => {
  const calls = [];
  const result = await fetchCommandCodePayloads({
    token: 'secret-token',
    signal: new AbortController().signal,
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith('/whoami')) return jsonResponse({ org: { id: 'org-1' } });
      if (url.includes('/subscriptions')) return jsonResponse({ data: { currentPeriodStart: 'not-a-date' } });
      if (url.includes('/credits')) return jsonResponse({});
      return jsonResponse({ totalCount: 1 });
    },
  });
  const usageUrl = new URL(calls.at(-1));
  assert.equal(usageUrl.searchParams.get('orgId'), 'org-1');
  assert.equal(usageUrl.searchParams.has('since'), false);
  assert.equal('periodBasis' in result.usage, false);
});

test('propagates failed requests with a fixed error and no response identity', async () => {
  await assert.rejects(
    fetchCommandCodePayloads({
      token: 'secret-token', signal: new AbortController().signal,
      fetch: async () => jsonResponse({ email: 'person@example.com' }, 503),
    }),
    (error) => error.code === 'HTTP'
      && error.message === 'HTTP'
      && !error.message.includes('person@example.com'),
  );
});
