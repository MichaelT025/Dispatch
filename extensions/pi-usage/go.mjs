import { parseGoUsage } from './go-parser.mjs';
import { requestJson, UsageRequestError } from './http.mjs';

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

/**
 * Request definition for the OpenCode Go usage endpoint.
 *
 * Authentication, response classification, and JSON transport are shared with
 * the other providers; this module only binds the official endpoint to its
 * parser.
 */
export const goProvider = {
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  async load({ token, signal, fetch }) {
    const body = await requestJson(USAGE_URL, { token, signal, fetch });
    const parsed = parseGoUsage(body);
    if (!parsed) throw new UsageRequestError('PARSE');
    return parsed;
  },
};
