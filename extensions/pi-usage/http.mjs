// Request failures deliberately carry only fixed codes, never provider bodies or tokens.
export class UsageRequestError extends Error {
  constructor(code, retryAfterMs) {
    super(code);
    this.code = code;
    if (Number.isFinite(retryAfterMs)) this.retryAfterMs = Math.max(0, retryAfterMs);
  }
}

export function retryDelay(value, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 24 * 60 * 60 * 1000) : undefined;
}

function discardBody(response) {
  try { Promise.resolve(response.body?.cancel()).catch(() => {}); }
  catch { /* Locked/already closed bodies are stopped by the adapter's abort. */ }
}

export async function requestJson(url, { token, signal, fetch: fetchImpl = globalThis.fetch, headers = {} }) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { ...headers, Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', signal,
    });
  } catch { throw new UsageRequestError('NETWORK'); }
  if (response.status === 401) {
    discardBody(response);
    throw new UsageRequestError('AUTH');
  }
  if (response.status === 429) {
    discardBody(response);
    throw new UsageRequestError('RATE_LIMITED', retryDelay(response.headers?.get('retry-after')));
  }
  if (response.status === 402 || response.status === 403) {
    let body;
    try { body = await response.json(); } catch { /* no usable entitlement evidence */ }
    const kind = body?.error?.type ?? body?.error?.code ?? body?.code;
    if (response.status === 402 || (typeof kind === 'string' && /entitlement|subscription_required|upgrade_required|plan_required|payment_required/i.test(kind))) {
      throw new UsageRequestError('NOT_ENTITLED');
    }
    throw new UsageRequestError('AUTH');
  }
  if (!response.ok) {
    discardBody(response);
    throw new UsageRequestError('HTTP');
  }
  try { return await response.json(); }
  catch (error) { throw new UsageRequestError(!signal?.aborted && error instanceof SyntaxError ? 'PARSE' : 'NETWORK'); }
}
