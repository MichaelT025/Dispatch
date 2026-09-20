import assert from 'node:assert/strict';
import test from 'node:test';

import { formatUsageRows } from './format.mjs';

const NOW = Date.parse('2026-01-02T12:00:00.000Z');
const base = (extra = {}) => ({
  providerId: 'openai-codex',
  displayName: 'Codex',
  state: 'ok',
  windows: [{ label: '5h', usedPercent: 42, resetsAt: '2026-01-02T14:00:00.000Z' }],
  fetchedAt: '2026-01-02T11:55:00.000Z',
  checkedAt: '2026-01-02T11:55:00.000Z',
  ...extra,
});

const text = rows => rows.map(row => row.text).join('\n');

test('empty and unconfigured snapshots have explicit states', () => {
  assert.match(text(formatUsageRows([], { now: NOW })), /Loading/);
  const providers = [
    { providerId: 'codex', displayName: 'Codex', state: 'unconfigured', windows: [], fetchedAt: null, checkedAt: new Date(NOW).toISOString(), error: 'NOT_CONFIGURED' },
    { providerId: 'go', displayName: 'Go', state: 'unconfigured', windows: [], fetchedAt: null, checkedAt: new Date(NOW).toISOString(), error: 'NOT_CONFIGURED' },
  ];
  assert.equal(text(formatUsageRows(providers, { now: NOW })), 'No subscriptions configured');
  const details = text(formatUsageRows(providers, { now: NOW, details: true }));
  assert.match(details, /Codex: Not configured - sign in to view usage/);
  assert.match(details, /Go: Not configured - sign in to view usage/);
});

test('formats plans, percentages, countdowns, and freshness age', () => {
  const output = text(formatUsageRows([base({ plan: 'Pro' })], { now: NOW }));
  assert.match(output, /Codex \(Pro\)/);
  assert.match(output, /42% used/);
  assert.match(output, /reset in 2h/);
  assert.match(output, /Checked 5m ago/);
});

test('does not pretend a passed reset already returned to zero', () => {
  const passed = base({ windows: [
    { label: 'weekly', usedPercent: 88, resetsAt: '2026-01-02T11:00:00.000Z' },
    { label: 'inactive', usedPercent: 0, resetsAt: null },
  ] });
  const output = text(formatUsageRows([passed], { now: NOW }));
  assert.match(output, /88% used, reset pending refresh/);
  assert.match(output, /0% used, starts on first use/);
  assert.doesNotMatch(output, /88% used, reset in/);
});

test('distinguishes stale, auth, rate-limit, and network states with fixed actions', () => {
  const rows = formatUsageRows([
    base({ stale: true }),
    base({ providerId: 'auth', displayName: 'Auth', state: 'unavailable', error: 'AUTH', windows: [], fetchedAt: null }),
    base({ providerId: 'rate', displayName: 'Rate', state: 'unavailable', error: 'RATE_LIMITED', retryAt: new Date(NOW + 90_000).toISOString(), retryAfterMs: 90_000, windows: [], fetchedAt: null }),
    base({ providerId: 'net', displayName: 'Net', state: 'unavailable', error: 'NETWORK', windows: [], fetchedAt: null }),
  ], { now: NOW });
  const output = text(rows);
  assert.match(output, /stale - showing last known usage/);
  assert.match(output, /Authentication required - sign in again/);
  assert.match(output, /Rate limited - try again in 1m 30s/);
  assert.match(output, /Network unavailable - check connection and retry/);
  assert.doesNotMatch(output, /account|raw|secret/i);
});

test('uses effective cooldown deadlines and elapsed legacy retry durations', () => {
  const deadline = new Date(NOW + 60 * 60 * 1_000).toISOString();
  const effective = text(formatUsageRows([base({
    state: 'unavailable', error: 'RATE_LIMITED', retryAt: deadline, retryAfterMs: 1_000,
    windows: [], fetchedAt: null,
  })], { now: NOW + 59 * 60 * 1_000 }));
  assert.match(effective, /Rate limited - try again in 1m/);
  assert.doesNotMatch(effective, /1s/);

  const elapsed = text(formatUsageRows([base({
    state: 'unavailable', error: 'RATE_LIMITED', retryAfterMs: 90_000,
    windows: [], fetchedAt: null,
  })], { now: NOW }));
  assert.match(elapsed, /Rate limited - refresh available/);

  const pending = text(formatUsageRows([base({
    state: 'unavailable', error: 'RATE_LIMITED', retryAfterMs: 90_000,
    checkedAt: new Date(NOW - 30_000).toISOString(), windows: [], fetchedAt: null,
  })], { now: NOW }));
  assert.match(pending, /Rate limited - try again in 1m/);
});

test('keeps credits distinct from USD and shows credits-only providers', () => {
  const output = text(formatUsageRows([base({
    windows: [],
    credits: [
      { label: 'Included', remaining: 12, unit: 'credits' },
      { label: 'Balance', remaining: 3.5, unit: 'USD' },
    ],
  })], { now: NOW }));
  assert.match(output, /Included: 12 credits/);
  assert.match(output, /Balance: \$3.5 USD/);
  assert.doesNotMatch(output, /Included: \$/);
});

test('details include all windows, credit pools, and timestamps while sidebar caps rows', () => {
  const provider = base({
    fetchedAt: '2026-01-02T11:59:00.000Z',
    windows: Array.from({ length: 30 }, (_, index) => ({ label: `window-${index}`, usedPercent: index, resetsAt: null })),
    credits: Array.from({ length: 4 }, (_, index) => ({ label: `pool-${index}`, remaining: index, unit: 'credits' })),
  });
  const sidebar = formatUsageRows([provider], { now: NOW });
  const details = formatUsageRows([provider], { now: NOW, details: true });
  assert.ok(sidebar.length <= 24);
  assert.ok(sidebar.every(item => item.text.length <= 160));
  assert.ok(details.length > 24);
  assert.match(text(details), /2026-01-02T11:59:00.000Z/);
  assert.match(text(details), /window-29/);
  assert.match(text(details), /pool-3/);
});

test('stale warnings survive truncation and checked age differs from data age', () => {
  const provider = base({
    state: 'unavailable', stale: true, error: 'NETWORK',
    fetchedAt: '2026-01-01T12:00:00.000Z', checkedAt: new Date(NOW).toISOString(),
    windows: Array.from({ length: 30 }, (_, i) => ({ label: `window-${i}`, usedPercent: i, resetsAt: null })),
  });
  const sidebar = text(formatUsageRows([provider], { now: NOW }));
  assert.match(sidebar, /Status: stale/);
  assert.match(sidebar, /Network unavailable/);
  assert.match(sidebar, /Usage data 24h ago/);
  assert.match(sidebar, /Checked 0s ago/);
  const details = text(formatUsageRows([provider], { now: NOW, details: true }));
  assert.match(details, /Checked 0s ago \(2026-01-02T12:00:00.000Z\)/);
});

test('sanitizes adversarial text and does not publish account keys or raw errors', () => {
  const dirty = base({
    displayName: '\u001b[31mBad\u001b[0m\nName\u202E',
    plan: 'pro\u0007\u001b]8;;https://evil.invalid\u0007click',
    accountKey: 'super-secret-account-key',
    error: 'SOMETHING_PRIVATE: super-secret-error',
    state: 'unavailable',
  });
  const rows = formatUsageRows([dirty], { now: NOW });
  assert.ok(rows.every(item => item.text.length <= 160));
  const output = text(rows);
  assert.doesNotMatch(output, /\u001b|\u0007|\u202e|super-secret|SOMETHING_PRIVATE/);
  assert.doesNotMatch(output, /\nName/);
  assert.match(output, /Usage unavailable - retry refresh/);
});
