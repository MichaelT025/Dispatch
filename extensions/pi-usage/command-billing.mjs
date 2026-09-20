/**
 * Command Code billing parsers adapted from Usage-Dashboard
 * e128b1aac3b63590241722c95bbb30951c13f6a3, Apache-2.0.
 *
 * Modifications: split billing helpers from transport/quota parsing, keep
 * credit pools in credit units, and reject identity/dollar aliases.
 */

import { parseCommandCodeTimestamp } from './command-quota.mjs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function titleCase(value) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (word.toUpperCase() === 'GOAT'
      ? 'GOAT'
      : word[0].toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ');
}

const PLAN_LABELS = Object.freeze({
  go: 'Go',
  goat: 'GOAT',
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  provider: 'Provider',
  free: 'Free',
  plus: 'Plus',
  business: 'Business',
  enterprise: 'Enterprise',
});

const PLAN_PREFIXES = Object.freeze([
  ['individual-provider', 'Provider'],
  ['individual-goat', 'GOAT'],
  ['individual-max', 'Max'],
  ['individual-pro', 'Pro'],
  ['individual-go', 'Go'],
  ['teams-pro', 'Pro'],
  ['team-pro', 'Pro'],
]);

function normalizePlan(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase().replace(/[_\s]+/g, '-');
  for (const [prefix, label] of PLAN_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}-`)) return label;
  }
  if (Object.hasOwn(PLAN_LABELS, lower)) return PLAN_LABELS[lower];
  for (const prefix of ['individual-', 'teams-', 'team-', 'organization-', 'org-']) {
    if (lower.startsWith(prefix)) {
      const remainder = trimmed.slice(prefix.length).trim();
      return remainder ? titleCase(remainder) : null;
    }
  }
  return titleCase(trimmed);
}

// Only fields that identify a subscription plan are considered. In
// particular, user.name/email and other identity fields are never candidates.
function planFromRecord(record) {
  const candidates = [
    record.plan,
    record.planName,
    record.plan_name,
    record.planId,
    record.plan_id,
    record.planSlug,
    record.plan_slug,
    record.tier,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return normalizePlan(candidate);
    }
    if (isRecord(candidate)) {
      for (const key of ['name', 'slug', 'tier']) {
        if (typeof candidate[key] === 'string' && candidate[key].trim()) {
          return normalizePlan(candidate[key]);
        }
      }
    }
  }
  return null;
}

function firstArray(value) {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  for (const key of ['subscriptions', 'data', 'items', 'plans']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return null;
}

/** Derive a display plan without treating account identity as a plan. */
export function parseCommandCodePlan(whoami, subscriptions, credits) {
  const sources = [];
  if (isRecord(whoami)) {
    sources.push(whoami, whoami.user, whoami.account, whoami.subscription);
  }

  const subscriptionArray = firstArray(subscriptions);
  if (subscriptionArray) {
    const active = subscriptionArray.find((entry) => {
      if (!isRecord(entry) || typeof entry.status !== 'string') return false;
      return ['active', 'trialing', 'past_due'].includes(entry.status.toLowerCase());
    });
    sources.push(active ?? subscriptionArray[0]);
    if (isRecord(subscriptions)) sources.push(subscriptions);
  } else if (isRecord(subscriptions)) {
    if (isRecord(subscriptions.data)) sources.push(subscriptions.data);
    sources.push(subscriptions, subscriptions.subscription, subscriptions.current);
  }

  if (isRecord(credits)) {
    sources.push(credits);
    if (isRecord(credits.credits)) sources.push(credits.credits);
  }

  for (const source of sources) {
    if (isRecord(source)) {
      const plan = planFromRecord(source);
      if (plan) return plan;
    }
  }
  return undefined;
}

function nestedRecord(value, key) {
  return isRecord(value) && isRecord(value[key]) ? value[key] : null;
}

function firstNumber(record, keys, { nonNegative = false } = {}) {
  if (!isRecord(record)) return null;
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== null && (!nonNegative || value >= 0)) return value;
  }
  return null;
}

const INCLUDED_KEYS = Object.freeze([
  'includedCredits',
  'included_credits',
  'monthlyCredits',
  'monthly_credits',
  'included',
]);

function creditsRecord(value) {
  const nested = nestedRecord(value, 'credits');
  // The API's nested pool object is authoritative. This also prevents a
  // payload that repeats the same pools at root and under `credits` from
  // counting aliases twice.
  if (nested && INCLUDED_KEYS.concat([
    'purchasedCredits', 'purchased_credits', 'purchased',
    'freeCredits', 'free_credits', 'free',
  ]).some((key) => key in nested)) return nested;
  return isRecord(value) ? value : null;
}

function timestamp(value) {
  const parsed = parseCommandCodeTimestamp(value);
  return typeof parsed === 'string' ? parsed : null;
}

function billingUsageRecord(value) {
  if (!isRecord(value)) return null;
  const candidates = [value, value.data, value.summary, value.usage];
  return candidates.find((candidate) => (
    isRecord(candidate) && candidate.periodBasis === 'billing-period'
  )) ?? null;
}

function subscriptionPeriod(value) {
  if (!isRecord(value)) return null;
  const data = isRecord(value.data) ? value.data : value;
  const start = timestamp(data.currentPeriodStart ?? data.current_period_start);
  const end = timestamp(data.currentPeriodEnd ?? data.current_period_end);
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }
  return { startMs, endMs, end };
}

/**
 * Build the monthly billing-period window from included credits only. A
 * billing-period marker, both valid period dates, and numeric credit values
 * are required; cost, purchased credits, and free credits are unrelated.
 */
export function parseCommandCodeMonthly(credits, subscriptions, usage) {
  const pools = creditsRecord(credits);
  const period = subscriptionPeriod(subscriptions);
  const billingUsage = billingUsageRecord(usage);
  if (!pools || !period || !billingUsage) return null;

  const remaining = firstNumber(pools, INCLUDED_KEYS, { nonNegative: true });
  const consumed = firstNumber(billingUsage, [
    'totalMonthlyCredits',
    'total_monthly_credits',
    'monthlyCreditsUsed',
    'monthly_credits_used',
    'includedCreditsUsed',
    'included_credits_used',
  ], { nonNegative: true });
  if (remaining === null || consumed === null) return null;

  // Scale before adding so large finite values cannot overflow to Infinity.
  const scale = Math.max(remaining, consumed);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const normalizedRemaining = remaining / scale;
  const normalizedConsumed = consumed / scale;
  if (!Number.isFinite(normalizedRemaining) || !Number.isFinite(normalizedConsumed)) {
    return null;
  }
  const normalizedTotal = normalizedRemaining + normalizedConsumed;
  if (!Number.isFinite(normalizedTotal) || normalizedTotal <= 0) return null;

  const usedPercent = Math.round(
    (normalizedConsumed / normalizedTotal * 100) * 100,
  ) / 100;
  const periodMilliseconds = period.endMs - period.startMs;
  if (!Number.isFinite(periodMilliseconds) || periodMilliseconds <= 0) return null;
  const windowSeconds = periodMilliseconds / 1000;
  if (!Number.isFinite(usedPercent) || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return null;
  }

  return {
    label: 'Monthly',
    windowSeconds,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    resetsAt: period.end,
  };
}

function poolNumber(value) {
  const direct = finiteNumber(value);
  if (direct !== null) return direct;
  if (!isRecord(value)) return null;
  return firstNumber(value, [
    'remaining',
    'balance',
    'amount',
    'value',
    'credits',
  ]);
}

function poolValue(record, keys) {
  if (!isRecord(record)) return null;
  for (const key of keys) {
    const value = poolNumber(record[key]);
    if (value !== null && value >= 0) return value;
  }
  return null;
}

/**
 * Return independently labelled credit pools. All values are Command Code
 * credits (never dollars), and each alias family contributes at most once.
 */
export function parseCommandCodeCredits(credits, _subscriptions, _usage) {
  const pools = creditsRecord(credits);
  if (!pools) return undefined;

  const definitions = [
    ['Included', INCLUDED_KEYS],
    ['Purchased', ['purchasedCredits', 'purchased_credits', 'purchased']],
    ['Free', ['freeCredits', 'free_credits', 'free']],
  ];
  const result = [];
  for (const [label, keys] of definitions) {
    const remaining = poolValue(pools, keys);
    if (remaining !== null) result.push({ label, remaining, unit: 'credits' });
  }
  return result.length > 0 ? result : undefined;
}
