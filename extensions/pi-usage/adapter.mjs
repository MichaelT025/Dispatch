import { createHash } from 'node:crypto';
import { UsageRequestError } from './http.mjs';

/** Bound the entire operation, including credential refresh and response body reads. */
export async function fetchProvider(definition, {
  resolveAuth, fetch = globalThis.fetch, signal, now = Date.now, timeoutMs = 12000,
}) {
  const controller = new AbortController();
  let accountKey;
  const failed = (error) => ({
    providerId: definition.id, displayName: definition.displayName,
    state: error.code === 'NOT_CONFIGURED' ? 'unconfigured' : 'unavailable',
    windows: [], fetchedAt: null, checkedAt: new Date(now()).toISOString(),
    error: error.code, ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(accountKey ? { accountKey } : {}),
  });
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new UsageRequestError('NETWORK'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await Promise.race([aborted, (async () => {
      if (controller.signal.aborted) throw new UsageRequestError('NETWORK');
      const auth = await resolveAuth(definition.id);
      if (controller.signal.aborted) throw new UsageRequestError('NETWORK');
      if (!auth?.apiKey) throw new UsageRequestError('NOT_CONFIGURED');
      // Token fingerprint prevents retaining a previous account's usage on auth changes.
      accountKey = createHash('sha256').update(`${definition.id}\0${auth.apiKey}`).digest('hex');
      const parsed = await definition.load({ token: auth.apiKey, signal: controller.signal, fetch });
      if (controller.signal.aborted) throw new UsageRequestError('NETWORK');
      if (!parsed || (!parsed.windows?.length && !parsed.credits?.length)) throw new UsageRequestError('PARSE');
      const checkedAt = new Date(now()).toISOString();
      return { ...parsed, providerId: definition.id, displayName: definition.displayName, state: 'ok', fetchedAt: checkedAt, checkedAt, accountKey };
    })()]);
  } catch (error) {
    return failed(error instanceof UsageRequestError ? error : new UsageRequestError('NETWORK'));
  } finally {
    // A failed parallel request must not leave its siblings/body reads running.
    controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
