import { codexAccountId } from './auth.mjs';
import { UsageRequestError, requestJson } from './http.mjs';
import { parseCodexUsage } from './codex-parser.mjs';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export const codexProvider = {
  id: 'openai-codex',
  displayName: 'Codex',
  async load({ token, signal, fetch }) {
    const accountId = codexAccountId(token);
    const value = await requestJson(CODEX_USAGE_URL, {
      token,
      signal,
      fetch,
      headers: accountId ? { 'ChatGPT-Account-Id': accountId } : {},
    });
    const parsed = parseCodexUsage(value);
    if (!parsed) throw new UsageRequestError('PARSE');
    return parsed;
  },
};
