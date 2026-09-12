// Pi Atelier's optional public panel protocol. No plugin dependency or polling.
const channel = 'pi-atelier:sidebar-panels';
export function createWorkerSidebar(events, workerViews) {
  let revision = 0;
  let previous = '';
  const publish = (requestId) => {
    const workers = [...workerViews.values()].map(record => record.worker);
    const active = workers.filter(worker => ['starting', 'running'].includes(worker.status));
    const recent = workers.filter(worker => !active.includes(worker)).slice(-3).reverse();
    const visible = [...active, ...recent].slice(0, 7);
    const rows = visible.flatMap(worker => [
      { text: `#${worker.id} ${worker.role} · ${worker.status}`, role: worker.status === 'failed' ? 'error' : active.includes(worker) ? 'working' : 'muted' },
      { text: worker.task, role: 'primary' },
      { text: `${worker.model} · ${worker.activity || ''}`, role: 'dim' },
    ]);
    if (!workers.length) rows.push({ text: 'No workers yet', role: 'muted' });
    if (active.length > visible.length) rows.push({ text: `${active.length - visible.length} more active workers`, role: 'working' });
    rows.push({ text: 'Ctrl+Shift+W: open workers', role: 'accent' });
    const panel = { id: 'piastra:workers', title: `Workers · ${active.length} active`, rows };
    const signature = JSON.stringify(panel);
    if (!requestId && signature === previous) return;
    previous = signature;
    events.emit(channel, { version: 1, type: 'register', source: 'piastra', revision: ++revision, panel, ...(requestId ? { requestId } : {}) });
  };
  const unsubscribe = events.on(channel, event => {
    if (event?.version === 1 && event.type === 'discover' && typeof event.requestId === 'string') publish(event.requestId);
  });
  return {
    publish: () => publish(),
    dispose() {
      unsubscribe();
      events.emit(channel, { version: 1, type: 'unregister', source: 'piastra', revision: ++revision, id: 'piastra:workers' });
    },
  };
}
