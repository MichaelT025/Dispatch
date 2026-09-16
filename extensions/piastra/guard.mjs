/**
 * Cross-extension worker guard.
 *
 * `/worktree` asks PiAstra through the shared event bus whether delegated
 * workers are still running before it forks a session. `EventBus.emit` is
 * synchronous, so a synchronous handler can answer on the caller's request
 * object without polling or a second round trip.
 *
 * The same worker count plus the compaction/branch-summary phases are enforced
 * again by `session_before_switch` in `index.ts`, so no session replacement
 * path can orphan running workers or interrupt active summarization even if a
 * caller skips the handshake.
 */
export const PIASTRA_WORKER_GUARD_CHANNEL = 'piastra:worker-guard';
export const ACTIVE_WORKER_STATUSES = ['starting', 'running'];

export function activeWorkerCount(workerViews) {
  let count = 0;
  for (const record of workerViews.values()) {
    if (ACTIVE_WORKER_STATUSES.includes(record?.worker?.status)) count += 1;
  }
  return count;
}

/**
 * Retire workers still in `starting`/`running` when a batch fails before the
 * per-worker error handling runs (for example a rejected ModelRuntime or
 * session initialization, or cancellation). Without this, the guard records
 * would stay active for the rest of the session and block session switching.
 */
export function finalizeOutstandingWorkers(workers, { reason, cancelled = false } = {}) {
  const now = Date.now();
  let finalized = 0;
  for (const worker of workers) {
    if (!ACTIVE_WORKER_STATUSES.includes(worker?.status)) continue;
    worker.status = cancelled ? 'cancelled' : 'failed';
    worker.activity = reason || (cancelled ? 'Delegation was cancelled before this worker finished.' : 'Worker batch did not complete.');
    worker.ended = now;
    finalized += 1;
  }
  return finalized;
}

/**
 * Track the compaction and branch-summary phases that `ctx.isIdle()` does not
 * expose. `AgentSession.isIdle` is only `!isStreaming`, and a manual `/compact`
 * or a `/tree` branch summary runs outside the agent run. A session switch
 * during either aborts it, and the TUI also drops messages it queued during
 * compaction. Pi exposes these phases only through the session lifecycle
 * events below (`ExtensionContext` has no `isCompacting` field), so count:
 *
 * - `session_before_compact` ... `session_compact` | `session_compact_failed`
 * - `session_before_tree` (only when a summary is requested) ... `session_tree`
 *
 * The TUI's own pending-message queue during compaction has no extension API;
 * blocking the whole compaction phase is the closest supported guard. If
 * another extension cancels tree navigation after this handler runs, or
 * summarization throws before a terminal event, Pi 0.84.4 emits no
 * `session_tree` and does not abort `event.signal`; the summary flag then
 * clears only on the next successful tree navigation, session start, or
 * shutdown. `ExtensionContext` exposes neither the session nor `isCompacting`,
 * so there is no supported liveness probe that could clear it sooner.
 */
export function createSessionPhaseGuard() {
  let compactionDepth = 0;
  let summarizing = 0;
  const clearSummarizing = () => { summarizing = 0; };
  return {
    beforeCompact() { compactionDepth += 1; },
    // `session_compact` and `session_compact_failed` are both terminal; the
    // clamp keeps an unexpected ordering from underflowing the count.
    afterCompact() { compactionDepth = Math.max(0, compactionDepth - 1); },
    beforeTree(event) {
      if (event?.preparation?.userWantsSummary !== true) return;
      summarizing += 1;
      // An aborted branch summary returns without emitting `session_tree`.
      event.signal?.addEventListener('abort', clearSummarizing, { once: true });
    },
    afterTree() { clearSummarizing(); },
    reset() { compactionDepth = 0; summarizing = 0; },
    compacting: () => compactionDepth > 0,
    summarizing: () => summarizing > 0,
    busy: () => compactionDepth > 0 || summarizing > 0,
  };
}

export function registerWorkerGuard(events, workerViews, phases) {
  const unsubscribe = events.on(PIASTRA_WORKER_GUARD_CHANNEL, request => {
    if (!request || request.type !== 'query') return;
    const active = activeWorkerCount(workerViews);
    const compacting = phases?.compacting?.() === true;
    const summarizing = phases?.summarizing?.() === true;
    request.active = active;
    request.compacting = compacting;
    request.summarizing = summarizing;
    request.busy = active > 0 || compacting || summarizing;
  });
  return {
    count: () => activeWorkerCount(workerViews),
    compacting: () => phases?.compacting?.() === true,
    summarizing: () => phases?.summarizing?.() === true,
    busy: () => activeWorkerCount(workerViews) > 0 || phases?.busy?.() === true,
    dispose: unsubscribe,
  };
}

/**
 * Run every worker promise to settlement before surfacing the first rejection.
 * `Promise.all` rejects as soon as one worker fails; batch cleanup that then
 * calls `finalizeOutstandingWorkers` would mark still-running siblings terminal
 * and release the switch guard while their sessions are alive. `allSettled`
 * first keeps the guard honest until every sibling has actually stopped.
 */
export async function settleWorkerBatch(promises) {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find(entry => entry.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map(entry => entry.value);
}

export function workerGuardMessage(active) {
  return `${active} Dispatch worker${active === 1 ? ' is' : 's are'} still running. Wait for completion or cancel the delegate call before switching sessions.`;
}

export function sessionPhaseGuardMessage({ compacting, summarizing } = {}) {
  if (compacting) return 'Context compaction is still running. Wait for it to finish before switching sessions.';
  if (summarizing) return 'A branch summary is still running. Wait for it to finish before switching sessions.';
  return undefined;
}
