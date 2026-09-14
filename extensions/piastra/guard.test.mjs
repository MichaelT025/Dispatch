import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  ACTIVE_WORKER_STATUSES,
  PIASTRA_WORKER_GUARD_CHANNEL,
  activeWorkerCount,
  createSessionPhaseGuard,
  finalizeOutstandingWorkers,
  registerWorkerGuard,
  sessionPhaseGuardMessage,
  settleWorkerBatch,
  workerGuardMessage,
} from './guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fakeEvents() {
  const listeners = new Map();
  return {
    emit(channel, data) {
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(handler);
      return () => {
        const current = listeners.get(channel) ?? [];
        listeners.set(channel, current.filter((entry) => entry !== handler));
      };
    },
  };
}

function fakePi(events) {
  const handlers = new Map();
  const tools = [];
  return {
    events,
    handlers,
    tools,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerCommand: () => {},
    registerShortcut: () => {},
    registerTool: (tool) => { tools.push(tool); },
    getThinkingLevel: () => 'low',
    appendEntry: () => {},
    getAllTools: () => [],
    setModel: async () => true,
    setThinkingLevel: () => {},
    setActiveTools: () => {},
  };
}

test('activeWorkerCount only counts starting and running workers', () => {
  const views = new Map([
    [1, { worker: { status: 'running' } }],
    [2, { worker: { status: 'starting' } }],
    [3, { worker: { status: 'completed' } }],
    [4, { worker: { status: 'failed' } }],
    [5, { worker: { status: 'interrupted' } }],
    [6, {}],
  ]);
  assert.deepEqual(ACTIVE_WORKER_STATUSES, ['starting', 'running']);
  assert.equal(activeWorkerCount(views), 2);
});

test('registerWorkerGuard answers the synchronous query and stops after dispose', () => {
  const events = fakeEvents();
  const views = new Map([[7, { worker: { status: 'running' } }]]);
  const guard = registerWorkerGuard(events, views);

  const request = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, request);
  assert.deepEqual(request, { type: 'query', busy: true, active: 1, compacting: false, summarizing: false });
  assert.equal(guard.count(), 1);

  views.get(7).worker.status = 'completed';
  const idle = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, idle);
  assert.deepEqual(idle, { type: 'query', busy: false, active: 0, compacting: false, summarizing: false });

  guard.dispose();
  const afterDispose = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, afterDispose);
  assert.deepEqual(afterDispose, { type: 'query', busy: false, active: 0 });
});

test('workerGuardMessage describes the block clearly', () => {
  assert.match(workerGuardMessage(1), /^1 PiAstra worker is still running/);
  assert.match(workerGuardMessage(2), /^2 PiAstra workers are still running/);
});

test('createSessionPhaseGuard tracks compaction and branch-summary lifecycles', () => {
  const phases = createSessionPhaseGuard();
  assert.equal(phases.busy(), false);
  assert.equal(sessionPhaseGuardMessage({}), undefined);

  phases.beforeCompact();
  assert.equal(phases.compacting(), true);
  assert.equal(phases.busy(), true);
  assert.match(sessionPhaseGuardMessage({ compacting: true, summarizing: false }), /compaction/i);
  // Every terminal compaction event releases the phase; extra events are safe.
  phases.afterCompact();
  phases.afterCompact();
  assert.equal(phases.compacting(), false);

  const controller = new AbortController();
  phases.beforeTree({ preparation: { userWantsSummary: true }, signal: controller.signal });
  assert.equal(phases.summarizing(), true);
  assert.match(sessionPhaseGuardMessage({ compacting: false, summarizing: true }), /branch summary/i);
  // An aborted summary returns without `session_tree`; the signal releases it.
  controller.abort();
  assert.equal(phases.summarizing(), false);

  phases.beforeTree({ preparation: { userWantsSummary: true }, signal: new AbortController().signal });
  phases.afterTree();
  assert.equal(phases.summarizing(), false);

  // Plain tree navigation (no summary) is never treated as busy.
  phases.beforeTree({ preparation: { userWantsSummary: false }, signal: new AbortController().signal });
  assert.equal(phases.busy(), false);

  phases.beforeCompact();
  phases.beforeTree({ preparation: { userWantsSummary: true }, signal: new AbortController().signal });
  phases.reset();
  assert.equal(phases.busy(), false);
});

test('registerWorkerGuard reports compaction and branch summaries in the shared query', () => {
  const events = fakeEvents();
  const views = new Map();
  const phases = createSessionPhaseGuard();
  const guard = registerWorkerGuard(events, views, phases);

  const idle = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, idle);
  assert.deepEqual(idle, { type: 'query', busy: false, active: 0, compacting: false, summarizing: false });

  phases.beforeCompact();
  const compacting = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, compacting);
  assert.deepEqual(compacting, { type: 'query', busy: true, active: 0, compacting: true, summarizing: false });
  assert.equal(guard.busy(), true);

  phases.afterCompact();
  phases.beforeTree({ preparation: { userWantsSummary: true }, signal: new AbortController().signal });
  const summarizing = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, summarizing);
  assert.deepEqual(summarizing, { type: 'query', busy: true, active: 0, compacting: false, summarizing: true });

  phases.afterTree();
  const released = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, released);
  assert.equal(released.busy, false);
  assert.equal(guard.busy(), false);
  guard.dispose();
});

test('settleWorkerBatch keeps the guard active until every sibling settles', async () => {
  const workers = [{ status: 'running' }, { status: 'running' }];
  const views = () => new Map(workers.map((worker, index) => [index, { worker }]));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const batch = settleWorkerBatch([
    Promise.reject(new Error('synthetic publication failure')),
    (async () => { await gate; workers[1].status = 'completed'; return 'sibling completed'; })(),
  ]);
  const finalized = batch.catch((error) => {
    // This models the batch catch in index.ts: finalize only runs here.
    finalizeOutstandingWorkers(workers, { reason: error.message });
    throw error;
  });

  // The first promise rejected already, but the sibling is still running, so
  // the batch guard must still report it as active.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(activeWorkerCount(views()), 2, 'guard stays active while the sibling runs');

  release();
  await assert.rejects(finalized, /synthetic publication failure/);
  // The sibling completed on its own and was not relabeled by the batch catch.
  assert.deepEqual(workers.map((worker) => worker.status), ['failed', 'completed']);
  const released = { type: 'query', busy: false, active: 0 };
  const events = fakeEvents();
  const phases = createSessionPhaseGuard();
  registerWorkerGuard(events, new Map(workers.map((worker, index) => [index, { worker }])), phases);
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, released);
  assert.deepEqual(released, { type: 'query', busy: false, active: 0, compacting: false, summarizing: false });
});

test('finalizeOutstandingWorkers retires only starting and running records', () => {
  const workers = [
    { status: 'starting' },
    { status: 'running' },
    { status: 'completed' },
    { status: 'failed', activity: 'kept' },
  ];
  assert.equal(finalizeOutstandingWorkers(workers, { reason: 'init failed' }), 2);
  assert.deepEqual(workers.map((worker) => worker.status), ['failed', 'failed', 'completed', 'failed']);
  assert.equal(workers[0].activity, 'init failed');
  assert.ok(workers[1].ended);
  assert.equal(workers[3].activity, 'kept');

  const cancelled = [{ status: 'starting' }, { status: 'running' }];
  assert.equal(finalizeOutstandingWorkers(cancelled, { cancelled: true }), 2);
  assert.deepEqual(cancelled.map((worker) => worker.status), ['cancelled', 'cancelled']);
});

test('a rejected worker runtime initialization finalizes records and releases the guard', async () => {
  const extension = await import(pathToFileURL(join(root, 'extensions', 'piastra', 'index.ts')).href);
  const events = fakeEvents();
  const pi = fakePi(events);
  extension.default(pi);
  const delegate = pi.tools.find((tool) => tool.name === 'delegate');
  assert.ok(delegate, 'delegate tool is registered');

  let panel;
  events.on('pi-atelier:sidebar-panels', (event) => {
    if (event?.type === 'register') panel = event.panel;
  });

  const originalCreate = ModelRuntime.create;
  ModelRuntime.create = async () => { throw new Error('synthetic runtime initialization failure'); };
  try {
    await assert.rejects(
      delegate.execute('call-init', {
        tasks: [
          { role: 'general', access: 'write', task: 'Edit a file' },
          { role: 'fast', access: 'read', task: 'Inspect a file' },
        ],
      }, undefined, undefined, { cwd: root, sessionManager: { getSessionId: () => 'guard-init' }, isProjectTrusted: () => true, ui: { notify: () => {} } }),
      /synthetic runtime initialization failure/,
    );
  } finally {
    ModelRuntime.create = originalCreate;
  }

  const query = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, query);
  assert.deepEqual(query, { type: 'query', busy: false, active: 0, compacting: false, summarizing: false });
  assert.ok(panel, 'sidebar published the finalized batch');
  const rows = panel.rows.filter((row) => row.text.startsWith('#'));
  assert.equal(rows.length, 2);
  for (const worker of rows) assert.match(worker.text, /· failed ·/, worker.text);
});

test('a cancelled worker batch finalizes starting records so the guard releases', async () => {
  const extension = await import(pathToFileURL(join(root, 'extensions', 'piastra', 'index.ts')).href);
  const events = fakeEvents();
  const pi = fakePi(events);
  extension.default(pi);
  const delegate = pi.tools.find((tool) => tool.name === 'delegate');
  assert.ok(delegate, 'delegate tool is registered');

  let panel;
  events.on('pi-atelier:sidebar-panels', (event) => {
    if (event?.type === 'register') panel = event.panel;
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    delegate.execute('call-cancel', {
      tasks: [{ role: 'fast', access: 'read', task: 'Inspect a file' }],
    }, controller.signal, undefined, { cwd: root, sessionManager: { getSessionId: () => 'guard-cancel' }, isProjectTrusted: () => true, ui: { notify: () => {} } }),
    (error) => error?.name === 'AbortError',
  );

  const query = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, query);
  assert.deepEqual(query, { type: 'query', busy: false, active: 0, compacting: false, summarizing: false });
  assert.ok(panel, 'sidebar published the finalized batch');
  assert.ok(panel.rows.some((row) => row.text.startsWith('#') && /· cancelled ·/.test(row.text)), JSON.stringify(panel.rows));
  assert.ok(!panel.rows.some((row) => row.text.startsWith('#') && /· (starting|running) ·/.test(row.text)), JSON.stringify(panel.rows));
});

test('the PiAstra extension registers the guard handshake and session_before_switch guard', async () => {
  const extension = await import(pathToFileURL(join(root, 'extensions', 'piastra', 'index.ts')).href);
  assert.equal(typeof extension.default, 'function');

  const events = fakeEvents();
  const pi = fakePi(events);
  extension.default(pi);

  assert.ok(pi.handlers.has('session_before_switch'), 'session_before_switch guard is registered');
  assert.ok(pi.handlers.has('session_shutdown'), 'guard/sidebar cleanup is registered');
  for (const name of ['session_before_compact', 'session_compact', 'session_compact_failed', 'session_before_tree', 'session_tree']) {
    assert.ok(pi.handlers.has(name), `${name} phase handler is registered`);
  }

  const request = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, request);
  assert.deepEqual(request, { type: 'query', busy: false, active: 0, compacting: false, summarizing: false });

  const notices = [];
  const ctx = { ui: { notify: (message, type) => notices.push({ message, type }) } };
  const beforeSwitch = pi.handlers.get('session_before_switch')[0];
  assert.equal(await beforeSwitch({}, ctx), undefined);
  assert.deepEqual(notices, []);

  // A manual compaction is invisible to ctx.isIdle(); the lifecycle guard cancels
  // the switch, then releases when the terminal event arrives.
  await pi.handlers.get('session_before_compact')[0]({}, ctx);
  assert.deepEqual(await beforeSwitch({}, ctx), { cancel: true });
  assert.match(notices.at(-1).message, /compaction is still running/i);
  assert.equal(notices.at(-1).type, 'warning');

  await pi.handlers.get('session_compact_failed')[0]({}, ctx);
  assert.equal(await beforeSwitch({}, ctx), undefined);

  // Branch summarization is guarded over the session_before_tree/session_tree pair.
  const controller = new AbortController();
  await pi.handlers.get('session_before_tree')[0]({ preparation: { userWantsSummary: true }, signal: controller.signal }, ctx);
  assert.deepEqual(await beforeSwitch({}, ctx), { cancel: true });
  await pi.handlers.get('session_tree')[0]({}, ctx);
  assert.equal(await beforeSwitch({}, ctx), undefined);
});
