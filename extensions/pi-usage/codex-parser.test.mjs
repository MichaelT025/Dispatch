import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexUsage } from './codex-parser.mjs';

test('parses standard Codex windows, plan, and credit balance', () => {
  const parsed = parseCodexUsage({
    plan_type: 'plus',
    rate_limit: {
      primary_window: {
        used_percent: 6,
        reset_at: 1738300000,
        limit_window_seconds: 18000,
      },
      secondary_window: {
        used_percent: 24,
        reset_at: 1738900000,
        limit_window_seconds: 604800,
      },
    },
    credits: { has_credits: true, unlimited: false, balance: 12.5 },
  });

  assert.deepEqual(parsed, {
    plan: 'plus',
    windows: [
      {
        label: '5h',
        windowSeconds: 18000,
        usedPercent: 6,
        resetsAt: '2025-01-31T05:06:40.000Z',
      },
      {
        label: 'Weekly',
        windowSeconds: 604800,
        usedPercent: 24,
        resetsAt: '2025-02-07T03:46:40.000Z',
      },
    ],
    credits: [{ label: 'Credits', remaining: 12.5, unit: 'credits' }],
  });
});

test('sorts primary windows by duration and includes additional primary windows', () => {
  const parsed = parseCodexUsage({
    rate_limit: {
      primary_window: {
        used_percent: 24,
        reset_at: 1738900000,
        limit_window_seconds: 604800,
      },
      secondary_window: {
        used_percent: 6,
        reset_at: 1738300000,
        limit_window_seconds: 18000,
      },
    },
    additional_rate_limits: [
      {
        limit_name: 'Code Reviews',
        rate_limit: {
          primary_window: {
            used_percent: 101,
            reset_at: 1739000000,
            limit_window_seconds: 3600,
          },
          secondary_window: {
            used_percent: 99,
            reset_at: 1739000000,
            limit_window_seconds: 86400,
          },
        },
      },
    ],
  });

  assert.deepEqual(parsed?.windows, [
    {
      label: '5h',
      windowSeconds: 18000,
      usedPercent: 6,
      resetsAt: '2025-01-31T05:06:40.000Z',
    },
    {
      label: 'Weekly',
      windowSeconds: 604800,
      usedPercent: 24,
      resetsAt: '2025-02-07T03:46:40.000Z',
    },
    {
      label: 'Code Reviews',
      windowSeconds: 3600,
      usedPercent: 100,
      resetsAt: '2025-02-08T07:33:20.000Z',
    },
  ]);
});

test('uses duration labels for additional windows without a label', () => {
  const parsed = parseCodexUsage({
    additional_rate_limits: [
      {
        rate_limit: {
          primary_window: {
            used_percent: 1,
            reset_at: 1738300000,
            limit_window_seconds: 86400,
          },
        },
      },
    ],
  });

  assert.equal(parsed?.windows[0].label, 'Weekly');
});

test('keeps ordinary balances as credits and only uses USD when explicit', () => {
  assert.deepEqual(
    parseCodexUsage({ credits: { balance: 4 } }),
    { windows: [], credits: [{ label: 'Credits', remaining: 4, unit: 'credits' }] },
  );
  assert.deepEqual(
    parseCodexUsage({ credits: { balance: 4, unit: 'USD' } }),
    { windows: [], credits: [{ label: 'Credits', remaining: 4, unit: 'USD' }] },
  );
  assert.deepEqual(
    parseCodexUsage({ credits: { balance_usd: 4 } }),
    { windows: [], credits: [{ label: 'Credits', remaining: 4, unit: 'USD' }] },
  );
});

test('preserves an explicit null reset for an inactive window', () => {
  const parsed = parseCodexUsage({
    rate_limit: {
      primary_window: {
        used_percent: 0,
        reset_at: null,
        limit_window_seconds: 18000,
      },
    },
  });
  assert.deepEqual(parsed?.windows[0], {
    label: '5h',
    windowSeconds: 18000,
    usedPercent: 0,
    resetsAt: null,
  });
});

test('clamps over-quota percentages and rejects negative/non-finite values', () => {
  const parsed = parseCodexUsage({
    rate_limit: {
      primary_window: {
        used_percent: 250,
        reset_at: 1738300000,
        limit_window_seconds: 18000,
      },
      secondary_window: {
        used_percent: -1,
        reset_at: 1738300000,
        limit_window_seconds: 604800,
      },
    },
  });
  assert.equal(parsed?.windows.length, 1);
  assert.equal(parsed?.windows[0].usedPercent, 100);

  const nonFinite = parseCodexUsage({
    rate_limit: {
      primary_window: {
        used_percent: Number.NaN,
        reset_at: 1738300000,
        limit_window_seconds: 18000,
      },
    },
  });
  assert.equal(nonFinite, null);
});

test('skips unsafe dates and malformed windows without throwing', () => {
  const parsed = parseCodexUsage({
    rate_limit: {
      primary_window: {
        used_percent: 10,
        reset_at: Number.MAX_VALUE,
        limit_window_seconds: 18000,
      },
      secondary_window: {
        used_percent: 20,
        reset_at: 1738300000,
        limit_window_seconds: 604800,
      },
    },
  });
  assert.equal(parsed?.windows.length, 1);
  assert.match(parsed?.windows[0].resetsAt, /^\d{4}-\d\d-\d\dT.*Z$/);

  for (const input of [
    null,
    undefined,
    42,
    'json',
    [],
    {},
    { rate_limit: null, additional_rate_limits: 'bad' },
    { rate_limit: { primary_window: { used_percent: 1 } } },
    { plan_type: 'pro' },
    { credits: { balance: -1 } },
  ]) {
    assert.doesNotThrow(() => parseCodexUsage(input));
    assert.equal(parseCodexUsage(input), null);
  }
});
