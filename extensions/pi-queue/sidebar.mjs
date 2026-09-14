// Pi Atelier's optional public panel protocol publisher for the pi-queue fork.
// Mirrors extensions/piastra/sidebar.mjs: no plugin dependency, no polling.
// Rows are built from the extension's actual queue snapshot, never an
// appearance copy, and are capped to the protocol's 24 rows / 160 chars.
const channel = 'pi-atelier:sidebar-panels';
const PROTOCOL_MAX_ROWS = 24;
const PROTOCOL_MAX_CHARS = 160;

/**
 * getSnapshot(): { pending, paused, blocked, blockedNote, rows }
 *   rows: [{ lane: 'steer' | 'followUp', text, paused, head }]
 */
export function createQueueSidebar(events, getSnapshot) {
  let revision = 0;
  let previous = '';
  let disposed = false;
  const clip = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, PROTOCOL_MAX_CHARS);

  const publish = (requestId) => {
    if (disposed) return;
    const state = getSnapshot();
    const rows = [];
    const flags = [];
    if (state.paused) flags.push('paused');
    if (state.blocked) flags.push(`blocked: ${clip(state.blockedNote || 'control command')}`);
    rows.push({
      text: clip(`${state.pending} pending${flags.length ? ` · ${flags.join(' · ')}` : ''}`),
      role: 'accent',
    });
    state.rows.slice(0, Math.max(0, PROTOCOL_MAX_ROWS - 2)).forEach((row, index) => {
      const label = row.lane === 'steer' ? 'Steer' : 'Queued';
      const headNote = row.head && index === 0 ? '▸ ' : '';
      const pausedNote = row.paused ? ' · paused' : '';
      rows.push({
        text: clip(`[${label}] ${headNote}${row.text}${pausedNote}`),
        role: row.lane === 'steer' ? 'working' : 'primary',
      });
    });
    if (!state.rows.length) rows.push({ text: 'No queued rows yet', role: 'muted' });
    if (state.rows.length > PROTOCOL_MAX_ROWS - 2) {
      rows.push({ text: clip(`${state.rows.length - (PROTOCOL_MAX_ROWS - 2)} more queued rows`), role: 'dim' });
    }
    rows.push({ text: '/q <text> queue · /st <text> steer current run', role: 'accent' });
    const panel = {
      id: 'piastra:queue',
      title: clip(`Queue${state.paused ? ' · paused' : state.blocked ? ' · blocked' : ''}`),
      rows: rows
        .map(row => ({ text: String(row.text).slice(0, PROTOCOL_MAX_CHARS), role: row.role }))
        .slice(0, PROTOCOL_MAX_ROWS),
    };
    const signature = JSON.stringify(panel);
    if (!requestId && signature === previous) return;
    previous = signature;
    events.emit(channel, {
      version: 1,
      type: 'register',
      source: 'pi-queue',
      revision: ++revision,
      panel,
      ...(requestId ? { requestId } : {}),
    });
  };

  const unsubscribe = events.on(channel, event => {
    if (event?.version === 1 && event.type === 'discover' && typeof event.requestId === 'string') publish(event.requestId);
  });

  return {
    publish: () => publish(),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      events.emit(channel, { version: 1, type: 'unregister', source: 'pi-queue', revision: ++revision, id: 'piastra:queue' });
    },
  };
}
