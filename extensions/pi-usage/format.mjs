/**
 * Pure formatting for the pi-usage sidebar/details view.
 *
 * This module deliberately has no UI, event, network, or command integration.
 */

const MAX_ROWS = 24;
const MAX_CHARS = 160;

// Keep control characters out of panel text.  In particular, do not let an
// untrusted provider name move the cursor or make a row look like another row.
const ANSI = /(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -\/]*[@-~]|\u009B[0-?]*[ -\/]*[@-~]|\u009D[^\u0007]*(?:\u0007|\u001B\\)|\u001B[()][0-2A-Z]|\u001B[=<>])/g;
const BIDI = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

function clean(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  let text;
  try {
    text = String(value);
  } catch {
    return fallback;
  }
  return text
    .replace(ANSI, '')
    .replace(BIDI, '')
    .replace(CONTROL, character => character === '\t' ? ' ' : '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function row(text, role = 'primary') {
  return { text: Array.from(clean(text)).slice(0, MAX_CHARS).join(''), role };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionNow(value) {
  let candidate = value;
  if (typeof candidate === 'function') {
    try { candidate = candidate(); } catch { candidate = Date.now(); }
  }
  if (candidate instanceof Date) candidate = candidate.getTime();
  if (typeof candidate === 'string') candidate = Date.parse(candidate);
  return Number.isFinite(candidate) ? candidate : Date.now();
}

function dateMs(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) && Number.isFinite(new Date(parsed).getTime()) ? parsed : null;
}

function ageText(value, now) {
  const timestamp = dateMs(value);
  if (timestamp === null) return null;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function durationText(milliseconds) {
  let seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) return remainderMinutes ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours ? `${days}d ${remainderHours}h` : `${days}d`;
}

function percent(value) {
  const number = finiteNumber(value);
  if (number === null || number < 0) return null;
  const bounded = Math.min(100, number);
  return `${Number.isInteger(bounded) ? bounded : bounded.toFixed(1).replace(/\.0$/, '')}%`;
}

function amount(value) {
  const number = finiteNumber(value);
  if (number === null || number < 0) return null;
  if (number >= 1_000_000_000) return number.toExponential(2);
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function creditText(credit) {
  if (!credit || (credit.unit !== 'credits' && credit.unit !== 'USD')) return null;
  const value = amount(credit.remaining);
  if (value === null) return null;
  return credit.unit === 'USD' ? `$${value} USD` : `${value} credits`;
}

function providerName(provider) {
  return clean(provider?.displayName) || clean(provider?.providerId) || 'Provider';
}

function planText(provider) {
  const plan = clean(provider?.plan);
  return plan ? ` (${plan})` : '';
}

function resetText(value, now) {
  if (value === null) return 'starts on first use';
  const reset = dateMs(value);
  if (reset === null) return 'reset time unavailable';
  if (reset <= now) return 'reset pending refresh';
  return `reset in ${durationText(reset - now)}`;
}

function fixedError(error, retryAfterMs, retryAt, checkedAt, now) {
  switch (error) {
    case 'AUTH': return 'Authentication required - sign in again';
    case 'RATE_LIMITED': {
      const deadline = dateMs(retryAt);
      let remaining = deadline === null ? null : deadline - now;
      if (remaining === null) {
        const retry = finiteNumber(retryAfterMs);
        if (retry !== null && retry > 0) {
          const checked = dateMs(checkedAt);
          const elapsed = checked === null ? 0 : Math.max(0, now - checked);
          remaining = retry - elapsed;
        }
      }
      if (remaining !== null && remaining > 0) return `Rate limited - try again in ${durationText(remaining)}`;
      if (remaining !== null) return 'Rate limited - refresh available';
      return 'Rate limited - try again later';
    }
    case 'NETWORK': return 'Network unavailable - check connection and retry';
    case 'NOT_ENTITLED': return 'No usage subscription - check your plan';
    case 'NOT_CONFIGURED': return 'Not configured - sign in to view usage';
    case 'PARSE':
    case 'HTTP':
    default: return 'Usage unavailable - retry refresh';
  }
}

function configured(provider) {
  return provider && provider.state !== 'unconfigured' && provider.error !== 'NOT_CONFIGURED';
}

function statusRows(provider, now, details) {
  const rows = [];
  const age = ageText(provider?.checkedAt, now);
  const usageAge = ageText(provider?.fetchedAt, now);
  if (provider?.stale) rows.push(row('  Status: stale - showing last known usage', 'warning'));
  if (provider?.error) rows.push(row(`  ${fixedError(provider.error, provider.retryAfterMs, provider.retryAt, provider.checkedAt, now)}`, 'error'));
  else if (provider?.state === 'unavailable') rows.push(row('  Usage unavailable - retry refresh', 'error'));
  if (provider?.stale && usageAge) rows.push(row(`  Usage data ${usageAge}`, 'dim'));
  if (age) rows.push(row(`  Checked ${age}${details ? checkedTimestamp(provider) : ''}`, 'dim'));
  return rows;
}

function checkedTimestamp(provider) {
  const checked = dateMs(provider?.checkedAt);
  return checked === null ? '' : ` (${new Date(checked).toISOString()})`;
}

function fetchedTimestamp(provider) {
  const fetched = dateMs(provider?.fetchedAt);
  return fetched === null ? '' : ` fetched ${new Date(fetched).toISOString()}`;
}

function providerRows(provider, now, details) {
  const name = providerName(provider);
  const rows = [row(`${name}${planText(provider)}`, 'accent')];
  // Status precedes potentially long quota lists so truncation cannot make
  // stale/error results appear healthy.
  rows.push(...statusRows(provider, now, details));
  const windows = Array.isArray(provider?.windows) ? provider.windows : [];
  const credits = Array.isArray(provider?.credits) ? provider.credits : [];

  for (const window of windows) {
    if (!window || typeof window !== 'object') continue;
    const used = percent(window.usedPercent);
    if (used === null) continue;
    const label = clean(window.label) || 'Usage';
    rows.push(row(`  ${label}: ${used} used, ${resetText(window.resetsAt, now)}`, 'primary'));
  }
  for (const credit of credits) {
    const text = creditText(credit);
    if (text) rows.push(row(`  ${clean(credit.label) || 'Credits'}: ${text}`, 'primary'));
  }

  if (details && provider?.fetchedAt !== null && provider?.fetchedAt !== undefined) {
    const timestamp = fetchedTimestamp(provider);
    if (timestamp) rows.push(row(`  Usage${timestamp}`, 'dim'));
  }
  return rows;
}

function entriesFrom(snapshot) {
  if (Array.isArray(snapshot)) return snapshot.filter(value => value && typeof value === 'object');
  if (Array.isArray(snapshot?.providers)) return snapshot.providers.filter(value => value && typeof value === 'object');
  return [];
}

/**
 * Format a UsageData[] snapshot into safe sidebar/detail rows.
 * Empty snapshots intentionally mean "still loading", not "no subscriptions".
 */
export function formatUsageRows(snapshot, options = {}) {
  const { now: nowOption, details = false } = options ?? {};
  const now = optionNow(nowOption === undefined ? Date.now() : nowOption);
  const entries = entriesFrom(snapshot);
  if (entries.length === 0) return [row('Loading subscriptions...', 'muted')];

  const active = entries.filter(configured);
  if (!details && active.length === 0) return [row('No subscriptions configured', 'muted')];

  const output = [];
  if (details && active.length === 0) output.push(row('No subscriptions configured', 'muted'));
  for (const provider of details ? entries : active) {
    if (!configured(provider)) {
      output.push(row(`${providerName(provider)}: Not configured - sign in to view usage`, 'muted'));
      continue;
    }
    output.push(...providerRows(provider, now, Boolean(details)));
  }

  if (details) return output;
  if (output.length <= MAX_ROWS) return output;
  const remaining = output.length - (MAX_ROWS - 1);
  return [...output.slice(0, MAX_ROWS - 1), row(`... and ${remaining} more usage rows`, 'dim')];
}
