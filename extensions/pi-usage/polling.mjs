/**
 * Keep a usage refresh running one at a time.
 *
 * The service owns cancellation of its network work. This helper only controls
 * when refreshes start and stops scheduling them after disposal.
 */
export function startUsagePolling(
  refresh,
  {
    intervalMs = 180_000,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
  } = {},
) {
  let disposed = false;
  let inFlight = false;
  let pendingTimer = null;

  const schedule = () => {
    if (disposed) return;

    pendingTimer = setTimer(() => {
      pendingTimer = null;
      runRefresh();
    }, intervalMs);

    if (pendingTimer && typeof pendingTimer.unref === 'function') {
      pendingTimer.unref();
    }
  };

  const runRefresh = () => {
    if (disposed || inFlight) return;
    inFlight = true;

    let result;
    try {
      result = refresh();
    } catch {
      inFlight = false;
      schedule();
      return;
    }

    Promise.resolve(result).then(
      () => {
        inFlight = false;
        schedule();
      },
      () => {
        inFlight = false;
        schedule();
      },
    );
  };

  runRefresh();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pendingTimer !== null) {
        clearTimer(pendingTimer);
        pendingTimer = null;
      }
    },
  };
}
