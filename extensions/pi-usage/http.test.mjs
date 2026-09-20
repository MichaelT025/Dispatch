import assert from 'node:assert/strict';
import test from 'node:test';

import { requestJson, retryDelay, UsageRequestError } from './http.mjs';

function response(status, body, { retryAfter, responseBody } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => name === 'retry-after' ? retryAfter : null },
    ...(responseBody === undefined ? {} : { body: responseBody }),
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert(error instanceof UsageRequestError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test('sends bearer/JSON request options and returns decoded JSON', async () => {
  let request;
  const signal = new AbortController().signal;
  const body = { windows: [{ label: '5h' }] };
  const result = await requestJson('https://provider.invalid/usage', {
    token: 'request-secret',
    signal,
    headers: { 'X-Provider': 'test' },
    fetch: async (url, options) => {
      request = { url, options };
      return response(200, body);
    },
  });

  assert.deepEqual(result, body);
  assert.deepEqual(request, {
    url: 'https://provider.invalid/usage',
    options: {
      headers: {
        'X-Provider': 'test',
        Authorization: 'Bearer request-secret',
        Accept: 'application/json',
      },
      redirect: 'error',
      signal,
    },
  });
});

test('maps authentication, entitlement, HTTP, and malformed JSON failures', async (t) => {
  const cases = [
    [401, null, 'AUTH'],
    [402, { error: { message: 'upgrade and do not leak this text' } }, 'NOT_ENTITLED'],
    [403, { error: { type: 'subscription_required' } }, 'NOT_ENTITLED'],
    [403, { error: { type: 'invalid_api_key' } }, 'AUTH'],
    [500, { message: 'provider outage secret' }, 'HTTP'],
    [200, new SyntaxError('malformed secret response'), 'PARSE'],
  ];

  for (const [status, body, code] of cases) {
    await t.test(`${status} -> ${code}`, async () => {
      await rejectsWithCode(requestJson('https://provider.invalid/usage', {
        token: 'status-secret',
        fetch: async () => response(status, body),
      }), code);
    });
  }
});

test('cancels unused error bodies without changing fixed status errors', async () => {
  const cases = [
    [401, 'AUTH'],
    [429, 'RATE_LIMITED'],
    [500, 'HTTP'],
  ];

  for (const [status, code] of cases) {
    let cancelCalls = 0;
    const body = {
      cancel() {
        cancelCalls += 1;
        return Promise.reject(new Error('body cancellation failed'));
      },
    };
    await rejectsWithCode(requestJson('https://provider.invalid/usage', {
      token: 'body-secret',
      fetch: async () => response(status, { message: 'unused body' }, {
        retryAfter: '3',
        responseBody: body,
      }),
    }), code);
    assert.equal(cancelCalls, 1, `${status} response body is cancelled`);
  }
});

test('maps rate limits and Retry-After seconds without exposing response data', async () => {
  const result = requestJson('https://provider.invalid/usage', {
    token: 'rate-limit-secret',
    fetch: async () => response(429, { message: 'secret provider body' }, { retryAfter: '7' }),
  });

  await assert.rejects(result, (error) => {
    assert(error instanceof UsageRequestError);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.retryAfterMs, 7_000);
    assert.equal(error.message, 'RATE_LIMITED');
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test('parses Retry-After dates and preserves a zero-second retry', () => {
  const now = Date.parse('2026-01-02T03:04:05.000Z');
  assert.equal(retryDelay('7', now), 7_000);
  assert.equal(retryDelay('0', now), 0);
  assert.equal(retryDelay('Fri, 02 Jan 2026 03:04:12 GMT', now), 7_000);
  assert.equal(retryDelay('not-a-retry-value', now), undefined);
});

test('normalizes transport failures and never includes raw secret text', async () => {
  const secret = 'transport-secret-value';
  await assert.rejects(requestJson('https://provider.invalid/usage', {
    token: secret,
    fetch: async () => { throw new Error(`socket failed while handling ${secret}`); },
  }), (error) => {
    assert(error instanceof UsageRequestError);
    assert.equal(error.code, 'NETWORK');
    assert.equal(error.message, 'NETWORK');
    assert.doesNotMatch(error.message, /transport-secret-value/);
    return true;
  });
});

test('does not leak malformed provider body errors', async () => {
  const secret = 'body-secret-value';
  await assert.rejects(requestJson('https://provider.invalid/usage', {
    token: secret,
    fetch: async () => response(200, new SyntaxError(`invalid JSON containing ${secret}`)),
  }), (error) => {
    assert.equal(error.code, 'PARSE');
    assert.equal(error.message, 'PARSE');
    assert.doesNotMatch(JSON.stringify(error), /body-secret-value/);
    return true;
  });
});
