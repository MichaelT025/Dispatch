import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { createAuthResolver, codexAccountId } from './auth.mjs';
import { fetchProvider } from './adapter.mjs';
import { requestJson, UsageRequestError } from './http.mjs';

const HOME = '/synthetic/pi-usage-home';
const ENV = Object.freeze({});

function noCredentialReads() {
  return async () => {
    throw new Error('unexpected credential read');
  };
}

async function assertAuth(promise, secret) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof UsageRequestError);
    assert.equal(error.code, 'AUTH');
    assert.equal(error.message, 'AUTH');
    assert.equal(String(error).includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
}

function resolver(registry, options = {}) {
  return createAuthResolver(registry, {
    env: ENV,
    home: HOME,
    read: noCredentialReads(),
    ...options,
  });
}

test('resolves Codex and Go credentials through the runtime registry only', async () => {
  const calls = [];
  let reads = 0;
  const registry = {
    async getProviderAuth(provider) {
      calls.push(provider);
      return {
        auth: { apiKey: `${provider}-runtime-token` },
        source: 'runtime',
      };
    },
  };
  const resolve = createAuthResolver(registry, {
    env: ENV,
    home: HOME,
    read: async () => {
      reads += 1;
      throw new Error('filesystem fallback is forbidden');
    },
  });

  assert.deepEqual(await resolve('openai-codex'), { apiKey: 'openai-codex-runtime-token' });
  assert.deepEqual(await resolve('opencode-go'), { apiKey: 'opencode-go-runtime-token' });
  assert.deepEqual(calls, ['openai-codex', 'opencode-go']);
  assert.equal(reads, 0);
});

test('maps runtime auth refresh failures to AUTH without exposing the token', async () => {
  const secret = 'refresh-secret-never-exposed';
  const registry = {
    async getProviderAuth(provider) {
      throw new Error(`${provider} refresh failed for ${secret}`);
    },
  };
  const resolve = resolver(registry);

  await assertAuth(resolve('openai-codex'), secret);
  await assertAuth(resolve('opencode-go'), secret);
});

test('uses a trimmed Command Code environment key before any local credential read', async () => {
  const secret = 'command-env-secret';
  let reads = 0;
  const resolve = createAuthResolver({}, {
    env: { COMMAND_CODE_API_KEY: `  ${secret}  ` },
    home: HOME,
    read: async () => {
      reads += 1;
      throw new Error('environment credentials must win over the file');
    },
  });

  assert.deepEqual(await resolve('command-code'), { apiKey: secret });
  assert.equal(reads, 0);
});

test('reads apiKey from the injected default local path', async () => {
  const secret = 'command-file-secret';
  const calls = [];
  const resolve = createAuthResolver({}, {
    env: ENV,
    home: HOME,
    read: async (path, encoding) => {
      calls.push([path, encoding]);
      return JSON.stringify({ apiKey: ` ${secret} ` });
    },
  });

  assert.deepEqual(await resolve('command-code'), { apiKey: secret });
  assert.deepEqual(calls, [[join(HOME, '.commandcode', 'auth.json'), 'utf8']]);
});

test('reads api_key from an explicitly injected Command Code auth path', async () => {
  const secret = 'command-alias-secret';
  const path = '/synthetic/command-code/auth.json';
  const resolve = createAuthResolver({}, {
    env: { COMMAND_CODE_AUTH_PATH: path },
    home: HOME,
    read: async (actualPath, encoding) => {
      assert.equal(actualPath, path);
      assert.equal(encoding, 'utf8');
      return JSON.stringify({ api_key: `\n${secret}\n` });
    },
  });

  assert.deepEqual(await resolve('command-code'), { apiKey: secret });
});

test('distinguishes a missing local file from a corrupt local file', async () => {
  const missing = createAuthResolver({}, {
    env: ENV,
    home: HOME,
    read: async () => {
      const error = new Error('synthetic missing credential file');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.equal(await missing('command-code'), undefined);

  const corruptSecret = 'corrupt-file-secret';
  const corrupt = createAuthResolver({}, {
    env: ENV,
    home: HOME,
    read: async () => `{ not-json ${corruptSecret}`,
  });
  await assertAuth(corrupt('command-code'), corruptSecret);
});

test('prefers a registered native Command Code provider over env and file credentials', async () => {
  const calls = [];
  const secret = 'native-command-secret';
  const resolve = createAuthResolver({
    getProvider(provider) {
      calls.push(['getProvider', provider]);
      return { id: provider };
    },
    async getProviderAuth(provider) {
      calls.push(['getProviderAuth', provider]);
      return {
        auth: { apiKey: secret },
        source: 'runtime',
      };
    },
  }, {
    env: { COMMAND_CODE_API_KEY: 'stale-env-secret' },
    home: HOME,
    read: noCredentialReads(),
  });

  assert.deepEqual(await resolve('command-code'), { apiKey: secret });
  assert.deepEqual(calls, [
    ['getProvider', 'command-code'],
    ['getProviderAuth', 'command-code'],
  ]);
});

test('does not fall back to local credentials when native Command Code auth refresh fails', async () => {
  const secret = 'native-refresh-secret';
  let reads = 0;
  const resolve = createAuthResolver({
    getProvider: () => ({ id: 'command-code' }),
    async getProviderAuth() {
      throw new Error(`native refresh rejected ${secret}`);
    },
  }, {
    env: { COMMAND_CODE_API_KEY: 'fallback-secret' },
    home: HOME,
    read: async () => {
      reads += 1;
      return JSON.stringify({ apiKey: 'file-fallback-secret' });
    },
  });

  await assertAuth(resolve('command-code'), secret);
  assert.equal(reads, 0);
});

test('preserves normalized native AUTH failures without trying fallback credentials', async () => {
  for (const provider of ['openai-codex', 'opencode-go', 'command-code']) {
    const expected = new UsageRequestError('AUTH');
    const resolve = createAuthResolver({
      getProvider: () => ({ id: 'command-code' }),
      async getProviderAuth() {
        throw expected;
      },
    }, {
      env: { COMMAND_CODE_API_KEY: 'fallback-secret' },
      home: HOME,
      read: noCredentialReads(),
    });

    await assert.rejects(resolve(provider), error => error === expected);
  }
});

function nativeDefinition(id) {
  return {
    id,
    displayName: id,
    load: ({ token, signal, fetch }) => requestJson(`https://usage.invalid/${id}`, {
      token, signal, fetch,
    }),
  };
}

test('integrates the installed ModelRegistry facade with fetchProvider for all native providers', async () => {
  const runtime = {
    getProvider: provider => provider === 'command-code' ? { id: provider } : undefined,
    async getAuth(provider) {
      return {
        auth: { apiKey: `native-${provider}-token` },
        source: 'runtime',
      };
    },
  };
  const registry = new ModelRegistry(runtime);
  const resolve = resolver(registry);
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, authorization: options.headers.Authorization });
    return {
      ok: true,
      status: 200,
      async json() { return { windows: [{ label: 'synthetic' }] }; },
    };
  };
  const definitions = ['openai-codex', 'opencode-go', 'command-code'].map(nativeDefinition);

  const results = await Promise.all(definitions.map(definition => fetchProvider(definition, {
    resolveAuth: resolve,
    fetch,
    now: () => Date.parse('2026-02-19T00:00:00.000Z'),
  })));

  assert.deepEqual(results.map(result => result.state), ['ok', 'ok', 'ok']);
  assert.deepEqual(requests.map(request => request.url), definitions.map(({ id }) => `https://usage.invalid/${id}`));
  assert.deepEqual(requests.map(request => request.authorization), definitions.map(({ id }) => `Bearer native-${id}-token`));
});

test('keeps native providers unconfigured when the installed registry has no auth result', async () => {
  const registry = new ModelRegistry({
    getProvider: provider => provider === 'command-code' ? { id: provider } : undefined,
    async getAuth() { return undefined; },
  });
  const resolve = resolver(registry);
  let requests = 0;
  const fetch = async () => {
    requests += 1;
    return { ok: true, status: 200, async json() { return { windows: [{ label: 'unexpected' }] }; } };
  };
  const definitions = ['openai-codex', 'opencode-go', 'command-code'].map(nativeDefinition);

  const results = await Promise.all(definitions.map(definition => fetchProvider(definition, {
    resolveAuth: resolve,
    fetch,
    now: () => Date.parse('2026-02-19T00:00:00.000Z'),
  })));

  assert.deepEqual(results.map(result => result.state), ['unconfigured', 'unconfigured', 'unconfigured']);
  assert.deepEqual(results.map(result => result.error), ['NOT_CONFIGURED', 'NOT_CONFIGURED', 'NOT_CONFIGURED']);
  assert.equal(requests, 0);
});

function tokenFor(claims) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

test('extracts the Codex account from the exact access-token claim', () => {
  assert.equal(codexAccountId(tokenFor({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-synthetic-123' },
  })), 'acct-synthetic-123');
});

test('returns undefined for malformed tokens and malformed Codex account claims', () => {
  const malformedClaims = [
    {},
    { 'https://api.openai.com/auth': null },
    { 'https://api.openai.com/auth': {} },
    { 'https://api.openai.com/auth': { chatgpt_account_id: 42 } },
    { 'https://api.openai.com/auth': { chatgpt_account_id: '' } },
    { 'https://api.openai.com/auth': { chatgpt_account_id: '   ' } },
    { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-with\nnewline' } },
    { auth: { chatgpt_account_id: 'wrong-claim-location' } },
  ];

  for (const claims of malformedClaims) {
    assert.equal(codexAccountId(tokenFor(claims)), undefined);
  }
  const validPayload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-structure-check' },
  })).toString('base64url');
  for (const token of [
    undefined,
    null,
    42,
    {},
    'not-a-jwt',
    'header..signature',
    'header.not-json.signature',
    `header.${validPayload}`,
    `header.${validPayload}.signature.extra`,
  ]) {
    assert.equal(codexAccountId(token), undefined);
  }
});
