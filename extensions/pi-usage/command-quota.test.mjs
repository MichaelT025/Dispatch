/*
 * Adapted from Usage-Dashboard (e128b1aac3b63590241722c95bbb30951c13f6a3),
 * Apache-2.0. Tests cover the standalone rolling/weekly parser contract.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCommandCodeTimestamp,
  parseCommandCodeWindows,
} from './command-quota.mjs';

test('parseCommandCodeTimestamp normalizes ISO and epoch timestamps', () => {
  assert.equal(
    parseCommandCodeTimestamp('2026-09-02T12:00:00.000Z'),
    '2026-09-02T12:00:00.000Z',
  );
  assert.equal(
    parseCommandCodeTimestamp(1_757_845_200),
    new Date(1_757_845_200_000).toISOString(),
  );
  assert.equal(
    parseCommandCodeTimestamp(1_757_845_200_000),
    new Date(1_757_845_200_000).toISOString(),
  );
});

test('parseCommandCodeTimestamp rejects unknown and overflowing values', () => {
  for (const value of [null, undefined, {}, [], '', '0', '1757845200', 'not-a-date', -5, 0, Number.NaN, Number.MAX_SAFE_INTEGER, 1e21]) {
    assert.equal(parseCommandCodeTimestamp(value), null);
  }
});

test('parses discovered windowLimits rolling and weekly windows', () => {
  assert.deepEqual(
    parseCommandCodeWindows({
      credits: {
        monthlyCredits: 100,
        windowLimits: {
          fiveHour: {
            used: 17,
            cap: 100,
            resetAt: '2026-09-02T12:00:00.000Z',
          },
          weekly: {
            used: 42,
            cap: 100,
            resetAt: '2026-09-07T00:00:00.000Z',
          },
          monthly: {
            used: 1,
            cap: 2,
            resetAt: '2026-10-01T00:00:00.000Z',
          },
        },
      },
    }),
    [
      {
        label: '5h',
        windowSeconds: 18_000,
        usedPercent: 17,
        resetsAt: '2026-09-02T12:00:00.000Z',
      },
      {
        label: 'Weekly',
        windowSeconds: 604_800,
        usedPercent: 42,
        resetsAt: '2026-09-07T00:00:00.000Z',
      },
    ],
  );
});

test('supports nested wrappers, aliases, and epoch reset values', () => {
  const seconds = 1_757_845_200;
  assert.deepEqual(
    parseCommandCodeWindows({
      data: {
        windowLimits: {
          rolling: { used: 1, limit: 4, resetAt: seconds },
          seven_day: { used: 1, limit: 4, resetAt: seconds * 1000 },
        },
      },
    }),
    [
      {
        label: '5h',
        windowSeconds: 18_000,
        usedPercent: 25,
        resetsAt: new Date(seconds * 1000).toISOString(),
      },
      {
        label: 'Weekly',
        windowSeconds: 604_800,
        usedPercent: 25,
        resetsAt: new Date(seconds * 1000).toISOString(),
      },
    ],
  );
});

test('supports direct percentages and clamps legitimate over-quota values', () => {
  assert.deepEqual(
    parseCommandCodeWindows([
      { label: '5h', percent: 125, resetsAt: '2026-09-02T12:00:00Z' },
      { label: 'Weekly', utilization: 1.5, resetsAt: '2026-09-07T00:00:00Z' },
    ]),
    [
      {
        label: '5h',
        windowSeconds: 18_000,
        usedPercent: 100,
        resetsAt: '2026-09-02T12:00:00.000Z',
      },
      {
        label: 'Weekly',
        windowSeconds: 604_800,
        usedPercent: 100,
        resetsAt: '2026-09-07T00:00:00.000Z',
      },
    ],
  );
});

test('represents only valid inactive zero-reset windows', () => {
  assert.deepEqual(
    parseCommandCodeWindows({
      windowLimits: {
        fiveHour: { used: 0, cap: 14, resetAt: 0 },
        weekly: { used: 0, cap: 35, resetAt: 0 },
      },
    }),
    [
      { label: '5h', windowSeconds: 18_000, usedPercent: 0, resetsAt: null },
      { label: 'Weekly', windowSeconds: 604_800, usedPercent: 0, resetsAt: null },
    ],
  );
  assert.equal(
    parseCommandCodeWindows({
      windowLimits: { fiveHour: { used: 2, cap: 14, resetAt: 0 } },
    }),
    null,
  );
});

test('returns null for malformed input and does not fabricate monthly windows', () => {
  for (const value of [null, undefined, 42, 'usage', {}, { usage: {} }, { monthly: { used: 1, cap: 2, resetAt: '2026-09-02' } }]) {
    assert.equal(parseCommandCodeWindows(value), null);
  }
  assert.doesNotThrow(() => parseCommandCodeWindows({ credits: { windowLimits: null } }));
});
