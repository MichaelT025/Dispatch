import { fetchCommandCodePayloads } from './command-requests.mjs';
import {
  parseCommandCodeCredits,
  parseCommandCodeMonthly,
  parseCommandCodePlan,
} from './command-billing.mjs';
import { parseCommandCodeWindows } from './command-quota.mjs';
import { UsageRequestError } from './http.mjs';

const WINDOW_ORDER = ['5h', 'Weekly', 'Monthly'];

function mergeWindows(payloads) {
  const byLabel = new Map();

  // Each endpoint can contain a different subset of windows. Prefer the
  // credits response for a duplicate, then usage, then subscriptions, while
  // still filling labels absent from an earlier response.
  for (const payload of payloads) {
    const windows = parseCommandCodeWindows(payload);
    if (!windows) continue;
    for (const window of windows) {
      if (!byLabel.has(window.label)) byLabel.set(window.label, window);
    }
  }

  return WINDOW_ORDER
    .filter(label => byLabel.has(label))
    .map(label => byLabel.get(label));
}

export const commandProvider = {
  id: 'command-code',
  displayName: 'Command Code',
  async load(context) {
    // Do not catch request errors: AUTH, rate limits, network failures, and
    // other transport classifications must reach the adapter unchanged.
    const { whoami, credits, subscriptions, usage } =
      await fetchCommandCodePayloads(context);

    const plan = parseCommandCodePlan(whoami, subscriptions, credits);
    const windows = mergeWindows([credits, usage, subscriptions]);
    const monthly = plan !== 'Provider'
      ? parseCommandCodeMonthly(credits, subscriptions, usage)
      : null;
    if (monthly && !windows.some(window => window.label === monthly.label)) {
      windows.push(monthly);
    }

    const creditPools = parseCommandCodeCredits(credits, subscriptions, usage);

    // A plan is metadata only. Credits without windows are still meaningful
    // usage, but a plan-only response is not a healthy provider result.
    if (windows.length === 0 && !creditPools?.length) {
      throw new UsageRequestError('PARSE');
    }

    const parsed = { windows };
    if (plan !== undefined) parsed.plan = plan;
    if (creditPools?.length) parsed.credits = creditPools;
    return parsed;
  },
};
