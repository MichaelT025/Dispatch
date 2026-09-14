// Worker bridge: PiAstra's public worker protocol on the extension event bus.
// External viewers loaded into the same session (the PiAstra web UI server's
// inline extension) subscribe here instead of scraping tool-result text.
// Versioned like the Atelier sidebar protocol; no polling, no plugin dependency.
//
// Outbound (`piastra:workers`, version 1):
//   { type: 'workers', workers }                       every publish (deduplicated)
//   { type: 'transcript', workerId, messages, streaming }  live worker session state
// Inbound on the same channel:
//   { type: 'discover' }                               re-emit the worker list
//   { type: 'transcript_request', workerId }           re-emit one transcript
//   { type: 'cancel', workerId }                       abort one running worker
export const WORKER_CHANNEL = 'piastra:workers';

/** Public worker summary: everything a viewer needs, nothing session-bound. */
export function workerSummary(worker) {
  return {
    id: worker.id, toolCallId: worker.toolCallId, role: worker.role, model: worker.model, task: worker.task,
    status: worker.status, activity: worker.activity, started: worker.started, ended: worker.ended,
    transcript: worker.transcript, recent: [...(worker.recent || [])], text: worker.text || '',
  };
}

export function createWorkerBridge(events, records) {
  let previous = '';
  const emit = data => events.emit(WORKER_CHANNEL, { version: 1, ...data });
  const publish = force => {
    const workers = [...records.values()].map(record => workerSummary(record.worker));
    const signature = JSON.stringify(workers);
    if (!force && signature === previous) return;
    previous = signature;
    emit({ type: 'workers', workers });
  };
  const transcript = (workerId, messages, streaming) => {
    emit({ type: 'transcript', workerId, messages: messages || [], streaming: streaming || null });
  };
  const unsubscribe = events.on(WORKER_CHANNEL, event => {
    if (event?.version !== 1) return;
    if (event.type === 'discover') publish(true);
    else if (event.type === 'transcript_request') {
      const record = records.get(event.workerId);
      // Saved workers carry only a transcript path; the viewer reads that file itself.
      // getMessages() already appends the in-flight message (the /workers view
      // renders it as one list); the next live event separates it again.
      if (record?.getMessages) transcript(event.workerId, record.getMessages(), null);
    } else if (event.type === 'cancel') records.get(event.workerId)?.cancel?.();
  });
  return {
    publish: () => publish(false),
    transcript,
    dispose() { unsubscribe(); },
  };
}
