import { requestJson } from './http.mjs';
import { parseCommandCodeTimestamp } from './command-quota.mjs';

const API_ROOT = 'https://api.commandcode.ai/alpha';

function responseRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commandCodeUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const suffix = query.toString();
  return `${API_ROOT}/${path}${suffix ? `?${suffix}` : ''}`;
}

function organizationId(whoami) {
  const id = whoami?.org?.id;
  // Personal accounts can return org: null. Omit orgId in that case so
  // the API resolves the authenticated account, as in Usage-Dashboard.
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

function currentPeriodStart(subscriptions) {
  const data = responseRecord(subscriptions?.data) ? subscriptions.data : subscriptions;
  if (!responseRecord(data)) return undefined;
  return parseCommandCodeTimestamp(
    data.currentPeriodStart ?? data.current_period_start,
  ) ?? undefined;
}

/**
 * Fetch the raw Command Code account payloads used by the provider adapter.
 * Endpoint failures intentionally propagate as fixed UsageRequestError codes;
 * response bodies and account identity are never included in errors.
 */
export async function fetchCommandCodePayloads({ token, signal, fetch }) {
  const whoami = await requestJson(commandCodeUrl('whoami'), { token, signal, fetch });
  const orgId = organizationId(whoami);

  const [credits, subscriptions] = await Promise.all([
    requestJson(commandCodeUrl('billing/credits', { orgId }), { token, signal, fetch }),
    requestJson(commandCodeUrl('billing/subscriptions', { orgId }), { token, signal, fetch }),
  ]);

  const since = currentPeriodStart(subscriptions);
  const usage = await requestJson(
    commandCodeUrl('usage/summary', { orgId, ...(since ? { since } : {}) }),
    { token, signal, fetch },
  );

  return {
    whoami,
    credits,
    subscriptions,
    usage: since && responseRecord(usage) ? { ...usage, periodBasis: 'billing-period' } : usage,
  };
}
