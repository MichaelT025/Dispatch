/**
 * Run one independent usage request per provider for each refresh.
 * Successful provider data is kept only long enough to make a matching
 * failed refresh visibly stale.
 */
export function createUsageService({
  providers,
  fetchProvider: fetchOne,
  onUpdate = () => {},
  now = Date.now,
}) {
  const definitions = [...(providers ?? [])];
  const controller = new AbortController();
  const pending = Symbol('pending');
  let snapshot = [];
  const lastSuccess = new Map();
  const rateLimitUntil = new Map();
  const defaultCooldownMs = 2 * 180_000;
  const minimumCooldownMs = 30_000;
  const maximumCooldownMs = 24 * 60 * 60 * 1_000;
  let inFlight;
  let disposed = false;

  const networkFailure = provider => ({
    providerId: provider.id,
    displayName: provider.displayName,
    state: 'unavailable',
    windows: [],
    fetchedAt: null,
    checkedAt: new Date(now()).toISOString(),
    error: 'NETWORK',
  });

  const notify = () => {
    if (disposed) return;
    const value = snapshot.slice();
    try {
      const result = onUpdate(value);
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch {
      // A subscriber must not make another provider's result fail.
    }
  };

  const resultFor = (provider, result) => {
    if (result?.state === 'ok') {
      lastSuccess.set(provider.id, {
        accountKey: result.accountKey,
        windows: result.windows,
        credits: result.credits,
        fetchedAt: result.fetchedAt,
      });
      return result;
    }

    const previous = lastSuccess.get(provider.id);
    const sameAccount = typeof result?.accountKey === 'string'
      && result.accountKey === previous?.accountKey;
    const reusable = sameAccount
      && result.state !== 'unconfigured'
      && result.error !== 'AUTH'
      && result.error !== 'NOT_CONFIGURED';

    if (!reusable) {
      lastSuccess.delete(provider.id);
      return result;
    }

    return {
      ...result,
      state: 'unavailable',
      windows: previous.windows,
      ...(previous.credits === undefined ? {} : { credits: previous.credits }),
      fetchedAt: previous.fetchedAt,
      stale: true,
    };
  };

  const cooldownFor = result => {
    const requested = result?.retryAfterMs;
    const duration = Number.isFinite(requested)
      ? Math.min(maximumCooldownMs, Math.max(minimumCooldownMs, requested))
      : defaultCooldownMs;
    return duration;
  };

  const refresh = () => {
    if (disposed) return Promise.resolve(snapshot.slice());
    if (inFlight) return inFlight;

    const previousSnapshot = snapshot;
    const results = definitions.map(provider => previousSnapshot.find(result => result?.providerId === provider.id) ?? pending);
    const startedAt = now();

    let skipped = 0;
    const requests = definitions.map((provider, index) => {
      const previous = results[index];
      const until = rateLimitUntil.get(provider.id);
      if (previous !== pending && until !== undefined && until > startedAt) {
        skipped += 1;
        return Promise.resolve(previous);
      }

      let request;
      try {
        request = fetchOne(provider, { signal: controller.signal });
      } catch (error) {
        request = Promise.reject(error);
      }

      return Promise.resolve(request)
        .catch(() => networkFailure(provider))
        .then(result => {
          if (result?.state === 'ok') {
            rateLimitUntil.delete(provider.id);
          } else if (result?.error === 'RATE_LIMITED') {
            const retryAt = now() + cooldownFor(result);
            rateLimitUntil.set(provider.id, retryAt);
            result = { ...result, retryAt: new Date(retryAt).toISOString() };
          }

          const visible = resultFor(provider, result);
          results[index] = visible;
          if (!disposed) {
            snapshot = results.filter(value => value !== pending);
            notify();
          }
          return visible;
        });
    });

    const run = Promise.all(requests);
    inFlight = run;
    if (definitions.length > 0 && skipped === definitions.length) notify();
    run.then(
      () => { if (inFlight === run) inFlight = undefined; },
      () => { if (inFlight === run) inFlight = undefined; },
    );
    return run;
  };

  return {
    refresh,
    getSnapshot: () => snapshot.slice(),
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
    },
  };
}
