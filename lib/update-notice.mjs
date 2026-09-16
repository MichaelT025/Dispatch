const KEY = Symbol.for('dispatch.update-notice');

export const UPDATE_NOTICE_TITLE = 'A Dispatch update is available. Run dispatch update.';

function slot() {
  const existing = globalThis[KEY];
  if (existing && typeof existing === 'object') return existing;
  const created = {};
  try {
    globalThis[KEY] = created;
  } catch {
    return created;
  }
  return created;
}

export function setUpdateNoticePromise(promise) {
  const state = slot();
  // Attach a rejection handler immediately so an update-check failure never
  // surfaces as an unhandled rejection; the stored promise resolves to null.
  state.promise = Promise.resolve(promise).then(
    value => value,
    () => null,
  );
  state.shown = false;
}

function isValidResult(info) {
  return (
    info &&
    typeof info === 'object' &&
    typeof info.version === 'string' &&
    info.version.length > 0 &&
    typeof info.currentVersion === 'string' &&
    info.currentVersion.length > 0 &&
    info.version !== info.currentVersion
  );
}

export async function showUpdateNotice(ctx, { isCurrent = () => true } = {}) {
  const state = globalThis[KEY];
  if (!state || typeof state !== 'object' || !state.promise) return;
  // Ineligible surfaces (print/batch/headless) never claim the one-per-process
  // slot, so a racing live context still shows the notice.
  if (!ctx || !ctx.ui) return;
  if (ctx.hasUI === false) return;
  if (ctx.mode !== undefined && ctx.mode !== 'tui' && ctx.mode !== 'rpc' && ctx.mode !== 'web') return;
  if (state.shown) return;
  // Await the shared check first so a stale session pending on the promise
  // never steals the slot from a newer current session that arrives while
  // the check is in flight.
  const promise = state.promise;
  let info;
  try {
    info = await promise;
  } catch {
    return;
  }
  // A newer setUpdateNoticePromise generation replaces state.promise on the
  // shared slot (or replaces the slot); waiters from the old generation
  // stay silent.
  if (globalThis[KEY] !== state) return;
  if (state.promise !== promise) return;
  if (!isValidResult(info)) return;
  // Retired sessions (a newer session_start/shutdown bumped the epoch while
  // the check was in flight) must stay silent without claiming the slot.
  try {
    if (!isCurrent()) return;
  } catch {
    return;
  }
  // Atomic claim before any UI await: continuations after the shared await
  // run sequentially in call order, so concurrent live races show exactly
  // one notice with no concurrent dialogs.
  if (state.shown) return;
  state.shown = true;
  try {
    if (ctx.mode === 'tui' || (ctx.mode === undefined && typeof ctx.ui.select === 'function')) {
      await ctx.ui.select(UPDATE_NOTICE_TITLE, ['Dismiss']);
    } else {
      ctx.ui.notify(UPDATE_NOTICE_TITLE, 'warning');
    }
  } catch {
    // A disposed/retired UI surface may throw; allow a later live context
    // to retry instead of losing the notice forever.
    state.shown = false;
  }
}
