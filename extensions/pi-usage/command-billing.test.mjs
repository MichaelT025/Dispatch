import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCommandCodeCredits,
  parseCommandCodeMonthly,
  parseCommandCodePlan,
} from './command-billing.mjs';

test('Command Code plan parser reads plan fields, not identity fields', () => {
  assert.equal(
    parseCommandCodePlan(
      { user: { name: 'Michael', email: 'michael@example.test' } },
      { data: { planId: 'individual-goat', status: 'active' } },
      null,
    ),
    'GOAT',
  );
  assert.equal(parseCommandCodePlan({ name: 'Michael', email: 'michael@example.test' }, {}, null), undefined);
  assert.equal(
    parseCommandCodePlan(
      null,
      { subscriptions: [{ plan: 'free', status: 'canceled' }, { plan: 'individual-pro', status: 'active' }] },
      null,
    ),
    'Pro',
  );
});

test('plan labels never expose inherited Object properties', () => {
  assert.equal(parseCommandCodePlan({ plan: 'constructor' }, null, null), 'Constructor');
  assert.equal(parseCommandCodePlan({ plan: '__proto__' }, null, null), 'Proto');
  assert.equal(parseCommandCodePlan({ plan: 'toString' }, null, null), 'Tostring');
  for (const raw of ['constructor', '__proto__', 'toString']) {
    assert.equal(typeof parseCommandCodePlan({ plan: raw }, null, null), 'string');
  }
});

test('monthly usage is included credits consumed plus remaining', () => {
  const credits = {
    credits: { monthlyCredits: 56, purchasedCredits: 100, freeCredits: 12 },
  };
  const subscriptions = {
    data: {
      currentPeriodStart: '2026-09-01T00:00:00.000Z',
      currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    },
  };
  assert.deepEqual(
    parseCommandCodeMonthly(credits, subscriptions, {
      totalMonthlyCredits: 14,
      totalCost: 999,
      periodBasis: 'billing-period',
    }),
    {
      label: 'Monthly',
      windowSeconds: 2_592_000,
      usedPercent: 20,
      resetsAt: '2026-10-01T00:00:00.000Z',
    },
  );
  assert.equal(
    parseCommandCodeMonthly(credits, subscriptions, {
      totalCost: 999,
      periodBasis: 'all-time',
    }),
    null,
  );
});

test('monthly ratio remains finite when credit values would overflow addition', () => {
  const result = parseCommandCodeMonthly(
    { credits: { monthlyCredits: 1e308 } },
    {
      data: {
        currentPeriodStart: '2026-09-01T00:00:00.000Z',
        currentPeriodEnd: '2026-10-01T00:00:00.000Z',
      },
    },
    { totalMonthlyCredits: 1e308, periodBasis: 'billing-period' },
  );

  assert.equal(result?.usedPercent, 50);
  assert.equal(Number.isFinite(result?.windowSeconds), true);
});

test('monthly usage rejects missing or invalid billing periods', () => {
  const credits = { credits: { monthlyCredits: 70 } };
  const subscriptions = {
    data: {
      currentPeriodStart: '2026-10-19T22:58:48.000Z',
      currentPeriodEnd: '2026-10-19T22:58:48.000Z',
    },
  };
  assert.equal(
    parseCommandCodeMonthly(credits, subscriptions, {
      totalMonthlyCredits: 0,
      periodBasis: 'billing-period',
    }),
    null,
  );
  assert.equal(
    parseCommandCodeMonthly(credits, subscriptions, {
      totalMonthlyCredits: 14,
      periodBasis: 'billing-period',
    }),
    null,
  );
});

test('credit pools remain separate and use credit units', () => {
  assert.deepEqual(
    parseCommandCodeCredits({
      // The root alias repeats the nested API object and must not be summed.
      monthlyCredits: 999,
      credits: { monthlyCredits: 100, purchasedCredits: 25, freeCredits: 12.5 },
      balanceUsd: 1234,
    }, null, { totalCost: 9 }),
    [
      { label: 'Included', remaining: 100, unit: 'credits' },
      { label: 'Purchased', remaining: 25, unit: 'credits' },
      { label: 'Free', remaining: 12.5, unit: 'credits' },
    ],
  );
  assert.deepEqual(
    parseCommandCodeCredits({ includedCredits: 4, purchased_credits: 2, free: 0 }, null, null),
    [
      { label: 'Included', remaining: 4, unit: 'credits' },
      { label: 'Purchased', remaining: 2, unit: 'credits' },
      { label: 'Free', remaining: 0, unit: 'credits' },
    ],
  );
});

test('credit parser does not fabricate balances from dollar or malformed fields', () => {
  assert.equal(parseCommandCodeCredits({ balanceUsd: 10, valueUsd: 2 }, null, null), undefined);
  assert.equal(parseCommandCodeCredits({ credits: { monthlyCredits: -1 } }, null, null), undefined);
  assert.doesNotThrow(() => parseCommandCodeCredits(null, null, null));
  assert.doesNotThrow(() => parseCommandCodePlan([], [], []));
  assert.doesNotThrow(() => parseCommandCodeMonthly('bad', {}, []));
});
