import assert from 'node:assert/strict';
import test from 'node:test';

import { goProvider } from './go.mjs';

const usage = {
  usage: {
    rolling: {
      status: 'ok',
      percent: 12.5,
      resetsAt: '2025-01-01T05:00:00.000Z',
    },
    weekly: {
      status: 'ok',
      percent: 34,
      resetsAt: '2025-01-06T00:00:00.000Z',
    },
    monthly: {
      status: 'rate-limited',
      percent: 100,
      resetsAt: '2025-02-01T00:00:00.000Z',
    },
  },
};

function response(body, status = 200, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function context(fetch) {
  return { token: 'go-secret', signal: new AbortController().signal, fetch };
}

test('requests the fixed URL with bearer authentication and parses usage', async () => {
  const calls = [];
  const fetch = async (...args) => {
    calls.push(args);
    return response(usage);
  };

  const parsed = await goProvider.load(context(fetch));

  assert.deepEqual(parsed.windows.map(({ label, usedPercent }) => ({ label, usedPercent })), [
    { label: '5h', usedPercent: 12.5 },
    { label: 'Weekly', usedPercent: 34 },
    { label: 'Monthly', usedPercent: 100 },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://opencode.ai/zen/go/v1/usage');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer go-secret');
  assert.equal(calls[0][1].headers.Accept, 'application/json');
  assert.equal(calls[0][1].redirect, 'error');
});

test('rejects a valid JSON response with no parseable usage as PARSE', async () => {
  await assert.rejects(
    goProvider.load(context(async () => response({ usage: {} }))),
    error => error?.code === 'PARSE',
  );
});

test('maps entitlement responses to NOT_ENTITLED', async () => {
  await assert.rejects(
    goProvider.load(context(async () => response({ error: { type: 'entitlement_required' } }, 403))),
    error => error?.code === 'NOT_ENTITLED',
  );
});

test('maps 429 responses and retry-after to RATE_LIMITED', async () => {
  await assert.rejects(
    goProvider.load(context(async () => response({}, 429, { 'retry-after': '7' }))),
    error => error?.code === 'RATE_LIMITED' && error.retryAfterMs === 7000,
  );
});
