import { formatUsageRows } from './format.mjs';

const channel = 'pi-atelier:sidebar-panels';
const source = 'pi-usage';
const id = 'dispatch:subscriptions';
const revisionsKey = Symbol.for('dispatch.pi-usage.sidebar-revisions');
const revisions = globalThis[revisionsKey] ??= new WeakMap();

/** Public presentation-only protocol; works without an Atelier dependency. */
export function createUsageSidebar(events, { now = Date.now } = {}) {
  let disposed = false;
  let previous = '';
  let panel = { id, title: 'Subscriptions', rows: formatUsageRows([], { now: now() }) };
  const emit = (type, extra) => {
    const revision = (revisions.get(events) ?? 0) + 1;
    revisions.set(events, revision);
    events.emit(channel, { version: 1, type, source, revision, ...extra });
  };
  const publish = (requestId) => {
    if (disposed) return;
    const signature = JSON.stringify(panel);
    if (!requestId && signature === previous) return;
    previous = signature;
    emit('register', { panel, ...(requestId ? { requestId } : {}) });
  };
  const unsubscribe = events.on(channel, event => {
    if (event?.version === 1 && event.type === 'discover' && typeof event.requestId === 'string' &&
      event.requestId.length > 0 && event.requestId.length <= 256 && !/[\x00-\x20\x7f]/.test(event.requestId)) {
      publish(event.requestId);
    }
  });
  publish();
  return {
    update(snapshot) {
      if (disposed) return;
      // Do not send raw provider results, account fingerprints, or authentication.
      panel = { id, title: 'Subscriptions', rows: formatUsageRows(snapshot, { now: now() }) };
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      emit('unregister', { id });
    },
  };
}
