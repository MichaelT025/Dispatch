import assert from 'node:assert/strict';
import test from 'node:test';

import { UsageRequestError } from './http.mjs';
import { commandProvider } from './command.mjs';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() {
      return body;
    },
  };
}

function context(payloads, status = {}) {
  return {
    token: 'command-test-token',
    signal: new AbortController().signal,
    fetch: async url => {
      const path = new URL(url).pathname;
      const key = path.endsWith('/whoami')
        ? 'whoami'
        : path.endsWith('/billing/credits')
          ? 'credits'
          : path.endsWith('/billing/subscriptions')
            ? 'subscriptions'
            : 'usage';
      return response(payloads[key], status[key] ?? 200);
    },
  };
}

const whoami = {
  org: { id: 'org_sanitized' },
  user: { name: 'Goat User', email: 'goat@example.test' },
};

const period = {
  currentPeriodStart: '2026-09-01T00:00:00.000Z',
  currentPeriodEnd: '2026-10-01T00:00:00.000Z',
};

test('parses sanitized live-shaped GOAT data, inactive windows, and monthly billing', async () => {
  const parsed = await commandProvider.load(context({
    whoami,
    credits: {
      credits: {
        monthlyCredits: 56,
        windowLimits: {
          fiveHour: { used: 0, cap: 14, resetAt: 0 },
          weekly: { used: 0, cap: 35, resetAt: 0 },
        },
      },
    },
    subscriptions: {
      data: { planId: 'individual-goat', ...period },
    },
    usage: { totalMonthlyCredits: 14 },
  }));

  assert.equal(parsed.plan, 'GOAT');
  assert.deepEqual(parsed.windows, [
    { label: '5h', windowSeconds: 18_000, usedPercent: 0, resetsAt: null },
    { label: 'Weekly', windowSeconds: 604_800, usedPercent: 0, resetsAt: null },
    {
      label: 'Monthly',
      windowSeconds: 2_592_000,
      usedPercent: 20,
      resetsAt: '2026-10-01T00:00:00.000Z',
    },
  ]);
  assert.deepEqual(parsed.credits, [
    { label: 'Included', remaining: 56, unit: 'credits' },
  ]);
  assert.equal('whoami' in parsed, false);
  assert.equal(JSON.stringify(parsed).includes('goat@example.test'), false);
});

test('merges windows per label and retains a weekly window from a later payload', async () => {
  const parsed = await commandProvider.load(context({
    whoami,
    credits: {
      credits: {
        monthlyCredits: 10,
        windowLimits: { fiveHour: { used: 1, cap: 10, resetAt: '2026-09-02T00:00:00Z' } },
      },
    },
    subscriptions: {},
    usage: {
      windowLimits: {
        fiveHour: { used: 9, cap: 10, resetAt: '2026-09-02T01:00:00Z' },
        weekly: { used: 2, cap: 10, resetAt: '2026-09-07T00:00:00Z' },
      },
    },
  }));

  assert.deepEqual(parsed.windows, [
    { label: '5h', windowSeconds: 18_000, usedPercent: 10, resetsAt: '2026-09-02T00:00:00.000Z' },
    { label: 'Weekly', windowSeconds: 604_800, usedPercent: 20, resetsAt: '2026-09-07T00:00:00.000Z' },
  ]);
});

test('credits-only responses are valid and preserve the Provider plan', async () => {
  const parsed = await commandProvider.load(context({
    whoami,
    credits: { credits: { monthlyCredits: 12 } },
    subscriptions: { data: { planId: 'individual-provider' } },
    usage: {},
  }));

  assert.deepEqual(parsed, {
    windows: [],
    plan: 'Provider',
    credits: [{ label: 'Included', remaining: 12, unit: 'credits' }],
  });
});

test('Provider plans do not synthesize a monthly window', async () => {
  const parsed = await commandProvider.load(context({
    whoami,
    credits: { credits: { monthlyCredits: 12 } },
    subscriptions: { data: { planId: 'individual-provider', ...period } },
    usage: { totalMonthlyCredits: 12, periodBasis: 'billing-period' },
  }));

  assert.deepEqual(parsed, {
    windows: [],
    plan: 'Provider',
    credits: [{ label: 'Included', remaining: 12, unit: 'credits' }],
  });
});

test('malformed and plan-only responses fail with PARSE', async () => {
  await assert.rejects(
    commandProvider.load(context({ whoami, credits: {}, subscriptions: {}, usage: {} })),
    error => error instanceof UsageRequestError && error.code === 'PARSE',
  );
  await assert.rejects(
    commandProvider.load(context({
      whoami,
      credits: {},
      subscriptions: { data: { planId: 'individual-goat' } },
      usage: {},
    })),
    error => error instanceof UsageRequestError && error.code === 'PARSE',
  );
});

test('request failures propagate without becoming parse failures', async () => {
  await assert.rejects(
    commandProvider.load(context({ whoami, credits: {}, subscriptions: {}, usage: {} }, { whoami: 401 })),
    error => error instanceof UsageRequestError && error.code === 'AUTH',
  );
});
