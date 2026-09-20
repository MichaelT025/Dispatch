/*
 * Adapted from Usage-Dashboard (e128b1aac3b63590241722c95bbb30951c13f6a3),
 * Apache-2.0. Modifications: standalone .mjs parser; rolling and weekly
 * windows only; defensive unknown-input handling; no billing/HTTP concerns.
 */

const WINDOW_SECONDS = Object.freeze({
  '5h': 18_000,
  Weekly: 604_800,
});

const WINDOW_ALIASES = new Map([
  ['five_hour', '5h'],
  ['fivehour', '5h'],
  ['five-hour', '5h'],
  ['rolling', '5h'],
  ['5h', '5h'],
  ['session', '5h'],
  ['seven_day', 'Weekly'],
  ['sevenday', 'Weekly'],
  ['seven-day', 'Weekly'],
  ['weekly', 'Weekly'],
  ['week', 'Weekly'],
  ['trailing7d', 'Weekly'],
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Normalize ISO strings and epoch seconds/milliseconds without inventing a
 * reset date. Numeric values use the same conservative ranges as the source
 * provider: tiny/ambiguous numbers and zero are not accepted as timestamps.
 */
export function parseCommandCodeTimestamp(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || /^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return null;
    const milliseconds = Date.parse(trimmed);
    if (!Number.isFinite(milliseconds)) return null;
    try {
      return new Date(milliseconds).toISOString();
    } catch {
      return null;
    }
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  const milliseconds = value >= 1e12 ? value : value >= 1e9 ? value * 1000 : null;
  if (milliseconds === null || !Number.isFinite(milliseconds)) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

function firstNumber(record, keys) {
  for (const key of keys) {
    const value = toFiniteNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function clampPercent(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return round2(Math.min(100, value));
}

function usagePercent(record) {
  const direct = firstNumber(record, [
    'percent',
    'usedPercent',
    'used_percent',
    'usagePercent',
    'usage_percent',
    'percentage',
  ]);
  if (direct !== null) return clampPercent(direct);

  const utilization = firstNumber(record, [
    'utilization',
    'usedRatio',
    'used_ratio',
  ]);
  if (utilization !== null) return clampPercent(utilization * 100);

  const used = firstNumber(record, ['used', 'usedCredits', 'used_credits']);
  const limit = firstNumber(record, [
    'limit',
    'cap',
    'total',
    'quota',
    'max',
  ]);
  if (used !== null && limit !== null && used >= 0 && limit > 0) {
    return clampPercent((used / limit) * 100);
  }

  const remaining = firstNumber(record, [
    'remaining',
    'remainingCredits',
    'remaining_credits',
  ]);
  if (
    remaining !== null &&
    limit !== null &&
    remaining >= 0 &&
    limit > 0 &&
    remaining <= limit
  ) {
    return clampPercent(((limit - remaining) / limit) * 100);
  }

  return null;
}

function resetValue(record) {
  for (const key of [
    'resetsAt',
    'resets_at',
    'reset_at',
    'resetAt',
    'expires_at',
    'expiresAt',
    'reset',
    'resets',
  ]) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function isInactiveReset(record, reset, percent) {
  if (reset !== 0 || percent !== 0) return false;

  // A zero reset is meaningful only when the payload also proves that no
  // quota has been consumed. A zero percent alone is not enough evidence.
  const used = firstNumber(record, ['used', 'usedCredits', 'used_credits']);
  if (used === 0) return true;

  const remaining = firstNumber(record, [
    'remaining',
    'remainingCredits',
    'remaining_credits',
  ]);
  const limit = firstNumber(record, [
    'limit',
    'cap',
    'total',
    'quota',
    'max',
  ]);
  return remaining !== null && limit !== null && limit > 0 && remaining === limit;
}

function parseWindow(value, label) {
  if (!isRecord(value)) return null;

  const percent = usagePercent(value);
  if (percent === null) return null;

  const reset = resetValue(value);
  if (isInactiveReset(value, reset, percent)) {
    return {
      label,
      windowSeconds: WINDOW_SECONDS[label],
      usedPercent: 0,
      resetsAt: null,
    };
  }

  const resetsAt = parseCommandCodeTimestamp(reset);
  if (!resetsAt) return null;
  return {
    label,
    windowSeconds: WINDOW_SECONDS[label],
    usedPercent: percent,
    resetsAt,
  };
}

function canonicalWindowLabel(value) {
  if (typeof value !== 'string') return null;
  return WINDOW_ALIASES.get(value) ?? WINDOW_ALIASES.get(value.toLowerCase()) ?? null;
}

function addCandidates(value, candidates, seen) {
  if (!isRecord(value) || seen.has(value)) return;
  seen.add(value);
  candidates.push(value);

  // These are known response wrappers, rather than an unrestricted object
  // walk. This avoids treating unrelated nested billing data as quota data.
  for (const key of [
    'usage',
    'quotas',
    'windows',
    'data',
    'summary',
    'windowLimits',
    'window_limits',
    'windowlimits',
    'limits',
    'credits',
  ]) {
    const nested = value[key];
    if (Array.isArray(nested)) continue;
    addCandidates(nested, candidates, seen);
  }
}

function parseArray(value) {
  const windows = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const rawLabel = entry.label ?? entry.name ?? entry.window;
    const label = canonicalWindowLabel(rawLabel);
    if (!label) continue;

    // The object form has fixed durations. An explicit duration is accepted
    // only when it agrees with the known rolling/weekly duration.
    const explicitSeconds = toFiniteNumber(
      entry.windowSeconds ?? entry.window_seconds,
    );
    if (explicitSeconds !== null && explicitSeconds !== WINDOW_SECONDS[label]) {
      continue;
    }
    const parsed = parseWindow(entry, label);
    if (parsed) windows.push(parsed);
  }
  return windows.length > 0 ? windows : null;
}

/**
 * Parse only Command Code rolling (5h) and weekly quota windows. Unknown or
 * incomplete input returns null; it never creates a zero-valued window.
 */
export function parseCommandCodeWindows(value) {
  if (Array.isArray(value)) return parseArray(value);
  if (!isRecord(value)) return null;

  const candidates = [];
  addCandidates(value, candidates, new WeakSet());
  const windows = [];

  for (const label of ['5h', 'Weekly']) {
    for (const candidate of candidates) {
      for (const [key, rawValue] of Object.entries(candidate)) {
        if (canonicalWindowLabel(key) !== label) continue;
        const parsed = parseWindow(rawValue, label);
        if (parsed) {
          windows.push(parsed);
          break;
        }
      }
      if (windows.at(-1)?.label === label) break;
    }
  }

  return windows.length > 0 ? windows : null;
}
