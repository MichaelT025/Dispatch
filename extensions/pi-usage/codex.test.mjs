import assert from 'node:assert/strict';
import test from 'node:test';

import { UsageRequestError } from './http.mjs';
import { codexProvider } from './codex.mjs';

const endpoint = 'https://chatgpt.com/backend-api/wham/usage';
const accountToken = `header.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test' },
})).toString('base64url')}.signature`;

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
    headers: new Headers(),
  };
}

function usageResponse() {
  return {
    rate_limit: {
      primary_window: {
        used_percent: 12,
        reset_at: 1_738_300_000,
        limit_window_seconds: 18_000,
      },
    },
  };
}

test('sends the fixed endpoint, bearer, accept, account, and redirect policy', async () => {
  let request;
  const value = await codexProvider.load({
    token: accountToken,
    fetch: async (url, init) => {
      request = { url, init };
      return response(usageResponse());
    },
  });

  assert.deepEqual(value.windows[0].label, '5h');
  assert.equal(request.url, endpoint);
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers.Authorization, `Bearer ${accountToken}`);
  assert.equal(request.init.headers.Accept, 'application/json');
  assert.equal(request.init.headers['ChatGPT-Account-Id'], 'acct_test');
});

test('does not derive or send an account header for a token without a ChatGPT claim', async () => {
  let headers;
  await codexProvider.load({
    token: 'not-a-jwt',
    fetch: async (_url, init) => {
      headers = init.headers;
      return response(usageResponse());
    },
  });

  assert.equal(Object.hasOwn(headers, 'ChatGPT-Account-Id'), false);
});

test('returns parsed usage and rejects an invalid parsed response', async () => {
  const parsed = await codexProvider.load({
    token: 'token',
    fetch: async () => response(usageResponse()),
  });
  assert.equal(parsed.windows.length, 1);

  await assert.rejects(
    codexProvider.load({ token: 'token', fetch: async () => response({ plan_type: 'plus' }) }),
    error => error instanceof UsageRequestError && error.code === 'PARSE',
  );
});

test('maps an authentication failure from the injected fetch', async () => {
  await assert.rejects(
    codexProvider.load({ token: 'token', fetch: async () => response({}, 401) }),
    error => error instanceof UsageRequestError && error.code === 'AUTH',
  );
});
