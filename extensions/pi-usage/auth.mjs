import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UsageRequestError } from './http.mjs';

/** Codex/Go always use Dispatch's resolved credentials and OAuth refresh. */
async function resolveNativeAuth(registry, provider) {
  try {
    const resolved = await registry.getProviderAuth(provider);
    return resolved?.auth;
  } catch (error) {
    // Keep an already-normalized auth failure intact; native failures never fall back.
    if (error instanceof UsageRequestError && error.code === 'AUTH') throw error;
    throw new UsageRequestError('AUTH');
  }
}

export function createAuthResolver(registry, { env = process.env, home = homedir(), read = readFile } = {}) {
  return async (provider) => {
    if (provider !== 'command-code') return resolveNativeAuth(registry, provider);
    // Prefer a future native provider when registered; never fall back after its auth fails.
    if (registry.getProvider?.('command-code')) return resolveNativeAuth(registry, provider);
    const key = env.COMMAND_CODE_API_KEY;
    if (typeof key === 'string' && key.trim()) return { apiKey: key.trim() };
    try {
      const json = JSON.parse(await read(env.COMMAND_CODE_AUTH_PATH || join(home, '.commandcode', 'auth.json'), 'utf8'));
      const token = json?.apiKey ?? json?.api_key;
      if (typeof token === 'string' && token.trim()) return { apiKey: token.trim() };
      throw new UsageRequestError('AUTH');
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw new UsageRequestError('AUTH');
    }
  };
}

/** Matches Pi's Codex transport: derive the account from this exact access token. */
export function codexAccountId(token) {
  try {
    if (typeof token !== 'string' || token.split('.').length !== 3) return undefined;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const id = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof id === 'string' && id.trim() && !/[\r\n]/.test(id) ? id : undefined;
  } catch { return undefined; }
}
