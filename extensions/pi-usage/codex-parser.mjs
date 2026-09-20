// Adapted from Usage-Dashboard, upstream commit e128b1aac3b63590241722c95bbb30951c13f6a3.
// Apache-2.0. Modifications: standalone parser, unknown-JSON validation, safe dates,
// finite percentage normalization, and the ParsedUsage credit shape.

const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const WEEKLY_WINDOW_LABEL_MAX_SECONDS = 8 * 24 * 60 * 60;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function labelWindow(windowSeconds) {
  // These are the labels used by the Codex endpoint for its standard windows.
  if (windowSeconds <= FIVE_HOURS_SECONDS) return '5h';
  if (windowSeconds <= WEEKLY_WINDOW_LABEL_MAX_SECONDS) return 'Weekly';
  return `${Math.round(windowSeconds / (24 * 60 * 60))}d`;
}

function unixToIso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;

  const milliseconds = value * 1000;
  if (!Number.isFinite(milliseconds)) return null;

  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;

  try {
    return date.toISOString();
  } catch {
    // Date#toISOString can throw for values outside the representable range.
    return null;
  }
}

function parseWindow(value, label) {
  if (!isRecord(value)) return null;

  const windowSeconds = value.limit_window_seconds;
  const usedPercent = value.used_percent;
  if (
    typeof windowSeconds !== 'number' ||
    !Number.isFinite(windowSeconds) ||
    windowSeconds <= 0 ||
    typeof usedPercent !== 'number' ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0
  ) {
    return null;
  }

  // An explicit null reset is the API's inactive-window marker. A missing or
  // malformed reset is not treated as inactive, since that would hide bad data.
  if (!Object.prototype.hasOwnProperty.call(value, 'reset_at')) return null;
  const resetsAt = value.reset_at === null ? null : unixToIso(value.reset_at);
  if (value.reset_at !== null && resetsAt === null) return null;

  return {
    label: label || labelWindow(windowSeconds),
    windowSeconds,
    // A provider can report over-quota values, but never expose an invalid
    // percentage to consumers of ParsedUsage.
    usedPercent: Math.min(usedPercent, 100),
    resetsAt,
  };
}

function parseCredits(value) {
  if (!isRecord(value) || value.has_credits === false || value.unlimited === true) {
    return undefined;
  }

  let balance;
  let unit = 'credits';
  if (typeof value.balance === 'number') {
    balance = value.balance;
    if (value.unit === 'USD' || value.currency === 'USD') unit = 'USD';
  } else if (typeof value.balance_usd === 'number') {
    // A USD-named field is explicit; the ordinary `balance` field is not USD.
    balance = value.balance_usd;
    unit = 'USD';
  } else if (typeof value.balanceUsd === 'number') {
    balance = value.balanceUsd;
    unit = 'USD';
  }

  if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) {
    return undefined;
  }

  return [{ label: 'Credits', remaining: balance, unit }];
}

/**
 * Parse the JSON returned by chatgpt.com/backend-api/wham/usage.
 *
 * This function deliberately accepts unknown input: malformed fields are
 * ignored and malformed/no-usage payloads return null rather than throwing.
 */
export function parseCodexUsage(value) {
  try {
    if (!isRecord(value)) return null;

    const windows = [];
    const rateLimit = isRecord(value.rate_limit) ? value.rate_limit : null;
    const standardWindows = [];
    if (rateLimit) {
      if (Object.prototype.hasOwnProperty.call(rateLimit, 'primary_window')) {
        standardWindows.push(rateLimit.primary_window);
      }
      if (Object.prototype.hasOwnProperty.call(rateLimit, 'secondary_window')) {
        standardWindows.push(rateLimit.secondary_window);
      }
    }

    const parsedStandard = standardWindows
      .map(window => parseWindow(window, null))
      .filter(window => window !== null)
      .sort((a, b) => a.windowSeconds - b.windowSeconds);
    windows.push(...parsedStandard);

    if (Array.isArray(value.additional_rate_limits)) {
      for (const additional of value.additional_rate_limits) {
        if (!isRecord(additional) || !isRecord(additional.rate_limit)) continue;
        const primary = parseWindow(
          additional.rate_limit.primary_window,
          typeof additional.limit_name === 'string' && additional.limit_name.trim()
            ? additional.limit_name.trim()
            : typeof additional.metered_feature === 'string' && additional.metered_feature.trim()
              ? additional.metered_feature.trim()
              : null,
        );
        if (primary) windows.push(primary);
      }
    }

    const parsed = { windows };
    if (typeof value.plan_type === 'string' && value.plan_type.trim()) {
      parsed.plan = value.plan_type.trim();
    }

    const credits = parseCredits(value.credits);
    if (credits) parsed.credits = credits;

    // A plan name alone is metadata, not usage. A valid window or credit
    // balance is required for a successful parse.
    if (windows.length === 0 && !credits) return null;
    return parsed;
  } catch {
    // Unknown JSON should never make a provider poll fail.
    return null;
  }
}
