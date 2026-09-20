import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGoUsage } from './go-parser.mjs';

const resetsAt = {
  rolling: '2025-01-01T05:00:00.000Z',
  weekly: '2025-01-06T00:00:00.000Z',
  monthly: '2025-02-01T00:00:00.000Z',
};

function response(overrides = {}) {
  return {
    usage: {
      rolling: {
        status: 'ok',
        percent: 12.5,
        resetsAt: resetsAt.rolling,
      },
      weekly: {
        status: 'ok',
        percent: 34,
        resetsAt: resetsAt.weekly,
      },
      monthly: {
        status: 'rate-limited',
        percent: 100,
        resetsAt: resetsAt.monthly,
      },
      ...overrides,
    },
  };
}

test('parses rolling, weekly, and monthly OpenCode Go windows', () => {
  assert.deepEqual(parseGoUsage(response()), {
    windows: [
      {
        label: '5h',
        windowSeconds: 18_000,
        usedPercent: 12.5,
        resetsAt: resetsAt.rolling,
      },
      {
        label: 'Weekly',
        windowSeconds: 604_800,
        usedPercent: 34,
        resetsAt: resetsAt.weekly,
      },
      {
        label: 'Monthly',
        windowSeconds: 2_592_000,
        usedPercent: 100,
        resetsAt: resetsAt.monthly,
      },
    ],
  });
});

test('validates leap days and normalizes numeric timezone offsets', () => {
  const parsed = parseGoUsage(
    response({
      rolling: { status: 'ok', percent: 12.5, resetsAt: '2024-02-29T23:00:00Z' },
      weekly: { status: 'ok', percent: 34, resetsAt: '2026-01-01T05:30:00+05:30' },
    }),
  );

  assert.equal(parsed?.windows[0].resetsAt, '2024-02-29T23:00:00.000Z');
  assert.equal(parsed?.windows[1].resetsAt, '2026-01-01T00:00:00.000Z');
});

test('clamps legitimate over-quota values and rejects negative percentages', () => {
  const parsed = parseGoUsage(
    response({
      rolling: { status: 'rate-limited', percent: 143.5, resetsAt: resetsAt.rolling },
    }),
  );
  assert.equal(parsed?.windows[0].usedPercent, 100);

  assert.equal(
    parseGoUsage(
      response({
        rolling: { status: 'ok', percent: -0.01, resetsAt: resetsAt.rolling },
      }),
    ),
    null,
  );
});

test('rejects malformed or incomplete responses without throwing', () => {
  const malformed = [
    null,
    undefined,
    false,
    0,
    '',
    [],
    {},
    { usage: null },
    { usage: {} },
    response({ weekly: undefined }),
    response({ monthly: { status: 'unknown', percent: 1, resetsAt: resetsAt.monthly } }),
    response({ rolling: { status: 'ok', percent: Infinity, resetsAt: resetsAt.rolling } }),
    response({ rolling: { status: 'ok', percent: NaN, resetsAt: resetsAt.rolling } }),
    response({ weekly: { status: 'ok', percent: 1, resetsAt: 'not-a-date' } }),
    response({ rolling: { status: 'ok', percent: 1, resetsAt: '0' } }),
    response({ weekly: { status: 'ok', percent: 1, resetsAt: '2026-02-30T00:00:00Z' } }),
    response({ monthly: { status: 'ok', percent: 1, resetsAt: '2026-01-01T00:00:00' } }),
    response({ monthly: { status: 'ok', percent: 1, resetsAt: null } }),
  ];

  for (const value of malformed) {
    assert.doesNotThrow(() => parseGoUsage(value));
    assert.equal(parseGoUsage(value), null);
  }
});
