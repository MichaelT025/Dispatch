// Asynchronous worker delivery for the orchestrator.
//
// `delegate` returns as soon as its workers are started; each result is pushed
// back into the parent conversation later as a `dispatch-worker-result` custom
// message (Pi converts custom messages to user turns and persists them, so a
// resumed session still contains every result). Results that land within the
// coalescing window travel in one message so a burst of finishing workers wakes
// the orchestrator once, not once per worker. `await_workers` and
// `cancel_worker` return results directly and take them out of the queue so a
// result never reaches the model twice.
export const WORKER_RESULT_TYPE = 'dispatch-worker-result';
export const WORKER_TOOL_NAMES = ['delegate', 'await_workers', 'cancel_worker', 'continue_worker'];
export const RESULT_TEXT_LIMIT = 12000;

export function formatElapsed(worker, now = Date.now()) {
  const seconds = Math.max(0, Math.floor(((worker?.ended ?? now) - (worker?.started ?? now)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** One model-facing block per finished worker: header, capped text, transcript. */
export function formatWorkerResult(result) {
  const text = String(result.text ?? '');
  const capped = text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}\n[Truncated; see transcript.]` : text;
  const status = result.status || (result.ok ? 'completed' : 'failed');
  return `#${result.id} ${result.role} · ${result.model} · ${status === 'completed' ? 'completed' : status.toUpperCase()}${result.elapsed ? ` · ${result.elapsed}` : ''}\n${capped}\nTranscript: ${result.transcript || '(none)'}`;
}

export function formatWorkerResults(results) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return 'No worker results.';
  return `Worker results (${list.length}):\n\n${list.map(formatWorkerResult).join('\n\n')}`;
}

/** Model-facing acknowledgement for started workers. */
export function formatStarted(workers, { notesDir, continued = false } = {}) {
  const list = Array.isArray(workers) ? workers : [];
  const lines = list.map(w => `#${w.id} ${w.role} (${w.access || 'read'}) · ${w.model} · ${w.status}`);
  const head = continued
    ? `Continued worker #${list[0]?.id}; its result arrives as a [${WORKER_RESULT_TYPE}] message when it finishes.`
    : `Started ${list.length} worker${list.length === 1 ? '' : 's'}; results arrive as [${WORKER_RESULT_TYPE}] messages as each finishes, in this turn or a later one.`;
  const tail = [
    notesDir ? `Shared session notes: ${notesDir} (read_note/list_notes).` : '',
    'Keep working on anything that does not need these results, or end your turn. Use await_workers only when your next step needs a result and nothing else is left to do.',
  ].filter(Boolean).join('\n');
  return `${head}\n${lines.join('\n')}\n${tail}`;
}

/**
 * Coalescing completion queue. `push` buffers a finished worker's result and
 * arms a short timer; `flush` hands everything buffered to `send` in one call.
 * While `isBusy()` (compaction or a branch summary in progress) delivery is
 * retried later instead of appending into a phase Pi may discard. `take`
 * removes results a tool is about to return directly.
 */
export function createCompletionQueue({ send, isBusy = () => false, delay = 300, retry = 250 }) {
  let buffered = [];
  let timer;
  let disposed = false;
  const arm = ms => { if (!timer && !disposed && buffered.length) timer = setTimeout(flush, ms); };
  function flush() {
    timer = undefined;
    if (disposed || !buffered.length) return;
    if (isBusy()) { arm(retry); return; }
    const batch = buffered;
    buffered = [];
    try { send(batch); } catch { /* delivery failures must not stall later results */ }
  }
  return {
    push(result) { if (disposed) return; buffered.push(result); arm(delay); },
    take(ids) {
      const wanted = new Set(ids);
      const taken = buffered.filter(r => wanted.has(r.id));
      buffered = buffered.filter(r => !wanted.has(r.id));
      if (!buffered.length && timer) { clearTimeout(timer); timer = undefined; }
      return taken;
    },
    pending: () => buffered.map(r => r.id),
    flush,
    dispose() { disposed = true; if (timer) clearTimeout(timer); timer = undefined; buffered = []; },
  };
}

/**
 * Rebuild the worker list of a resumed branch. Delegate-family tool results
 * carry the workers they started or touched; result messages carry final
 * states. Later entries win per worker id, so a worker started in one tool
 * result and finished in a later custom message restores as finished.
 */
export function mergeRestoredWorkers(branch) {
  const workers = new Map();
  for (const entry of branch || []) {
    let saved;
    if (entry?.type === 'message' && entry.message?.role === 'toolResult' && WORKER_TOOL_NAMES.includes(entry.message.toolName)) saved = entry.message.details?.workers;
    else if (entry?.type === 'custom_message' && entry.customType === WORKER_RESULT_TYPE) saved = entry.details?.workers;
    for (const worker of saved || []) {
      if (typeof worker?.id !== 'number') continue;
      workers.set(worker.id, { ...(workers.get(worker.id) || {}), ...worker });
    }
  }
  for (const worker of workers.values()) {
    if (['running', 'starting'].includes(worker.status)) { worker.status = 'interrupted'; worker.activity = 'This worker is no longer attached.'; }
  }
  return workers;
}
