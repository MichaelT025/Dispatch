// Adapted from Usage-Dashboard (upstream commit e128b1aac3b63590241722c95bbb30951c13f6a3).
// Licensed under Apache-2.0. Modifications: standalone pure parser and contract-compatible
// clamping of over-quota percentages.

const WINDOW_DEFINITIONS = [
  ['rolling', '5h', 18_000],
  ['weekly', 'Weekly', 604_800],
  ['monthly', 'Monthly', 2_592_000],
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The Go endpoint emits RFC3339 timestamps, which are the unambiguous ISO
// datetime form this parser accepts. Date.parse is intentionally not used for
// validation: it accepts non-ISO values and normalizes invalid calendar dates.
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string') return null;

  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59
  ) {
    return null;
  }

  const milliseconds = Number((fraction + '000').slice(0, 3));
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (zone[0] === '+' ? 1 : -1);
  }

  // setUTCFullYear avoids Date.UTC's special handling of years 0 through 99.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  if (Number.isNaN(date.getTime())) return null;

  date.setTime(date.getTime() - offsetMinutes * 60_000);
  if (Number.isNaN(date.getTime())) return null;

  try {
    return date.toISOString();
  } catch {
    // Date#toISOString throws for values outside the representable range.
    return null;
  }
}

function parseWindow(value) {
  if (!isRecord(value)) return null;

  const { status, percent, resetsAt } = value;
  if (status !== 'ok' && status !== 'rate-limited') return null;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) {
    return null;
  }
  const normalizedResetsAt = normalizeTimestamp(resetsAt);
  if (normalizedResetsAt === null) return null;

  return {
    usedPercent: Math.min(percent, 100),
    resetsAt: normalizedResetsAt,
  };
}

/**
 * Parse the official OpenCode Go usage JSON response.
 *
 * @param {unknown} value
 * @returns {{windows: Array<{label: string, windowSeconds: number, usedPercent: number, resetsAt: string}>}|null}
 */
export function parseGoUsage(value) {
  if (!isRecord(value) || !isRecord(value.usage)) return null;

  const windows = [];
  for (const [key, label, windowSeconds] of WINDOW_DEFINITIONS) {
    const parsed = parseWindow(value.usage[key]);
    if (!parsed) return null;

    windows.push({
      label,
      windowSeconds,
      usedPercent: parsed.usedPercent,
      resetsAt: parsed.resetsAt,
    });
  }

  return { windows };
}
