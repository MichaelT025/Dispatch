import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  const messages = [];
  return {
    events,
    handlers,
    tools,
    messages,
    sendMessage: (message, options) => { messages.push({ message, options }); },
    registerMessageRenderer: () => {},
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
  assert.match(workerGuardMessage(1), /^1 Dispatch worker is still running/);
  assert.match(workerGuardMessage(2), /^2 Dispatch workers are still running/);
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

// Async delegation: `delegate` returns as soon as its workers start; the result
// arrives through pi.sendMessage as a dispatch-worker-result custom message.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const untilSent = async (pi, count = 1, timeout = 3000) => {
  const started = Date.now();
  while (pi.messages.length < count) {
    if (Date.now() - started > timeout) throw new Error(`Expected ${count} worker result messages, got ${pi.messages.length}.`);
    await sleep(20);
  }
  return pi.messages;
};

test('async delegation: delegate returns started workers, results arrive as one steer message and the guard releases', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'piastra-delegate-success-'));
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
    await rm(dir, { recursive: true, force: true });
  });
  const models = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'),
    modelsStorePath: join(dir, 'models-store.json'), allowModelNetwork: false });
  const dummyModel = { id: 'offline', name: 'Offline', provider: 'test', api: 'openai-completions', baseUrl: 'http://unused.invalid',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
  models.getModel = () => dummyModel;
  t.mock.method(ModelRuntime, 'create', async () => models);
  const prompts = [];
  // Use real SDK construction and permissions, replacing only the paid model
  // interaction. Each worker answers with the prompt it received.
  t.mock.method(AgentSession.prototype, 'prompt', async function (prompt) {
    prompts.push(prompt);
    await sleep(30);
    this.agent.state.messages.push({ role: 'assistant', content: [{ type: 'text', text: `Verified worker result for ${prompt.split('\n')[0]}` }], stopReason: 'stop' });
  });
  const extension = await import(pathToFileURL(join(root, 'extensions', 'piastra', 'index.ts')).href);
  const events = fakeEvents();
  const pi = fakePi(events);
  extension.default(pi);
  const delegate = pi.tools.find(tool => tool.name === 'delegate');
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'parent-success' }, isProjectTrusted: () => true, isIdle: () => true, ui: { notify() {} } };

  const output = await delegate.execute('first-batch', { tasks: [
    { role: 'fast', access: 'read', task: 'Inspect the assigned files' },
    { role: 'general', access: 'write', task: 'Edit the assigned files' },
  ] }, undefined, undefined, ctx);
  // The tool result is an acknowledgement, not the worker result.
  assert.match(output.content[0].text, /Started 2 workers; results arrive as \[dispatch-worker-result\] messages/);
  assert.match(output.content[0].text, /#1 fast \(read\)/);
  assert.match(output.content[0].text, /#2 general \(write\)/);
  assert.match(output.content[0].text, /Shared session notes:/);
  assert.ok(!/Verified worker result/.test(output.content[0].text), 'delegate must not block on worker output');
  assert.deepEqual(output.details.workers.map(w => w.status), ['starting', 'starting']);
  assert.equal(output.details.notesDir, join(dir, 'piastra', 'runs', 'parent-success', 'notes'));
  // Workers are still live after the call returned: the switch guard holds.
  const busy = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, busy);
  assert.equal(busy.active, 2);

  // Both results land within the coalescing window and travel as ONE message
  // that triggers an orchestrator turn.
  const [message] = await untilSent(pi, 1);
  await sleep(50);
  assert.equal(pi.messages.length, 1, 'two workers finishing together must produce one message');
  assert.equal(message.message.customType, 'dispatch-worker-result');
  assert.equal(message.message.display, true);
  assert.deepEqual(message.options, { triggerTurn: true, deliverAs: 'steer' });
  assert.match(message.message.content, /Worker results \(2\):/);
  assert.match(message.message.content, /#1 fast · opencode-go\/deepseek-v4\.1-flash · completed · \d+s\nVerified worker result for Inspect the assigned files/);
  assert.match(message.message.content, /#2 general · opencode-go\/glm-5\.3-flash · completed/);
  assert.match(message.message.content, /Transcript: .+\.jsonl/);
  assert.deepEqual(message.message.details.workers.map(w => w.status), ['completed', 'completed']);
  assert.equal(message.message.details.results.length, 2);
  const free = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, free);
  assert.equal(free.active, 0);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) assert.match(prompt, /parent-success/);

  // await_workers on finished workers returns the cached results directly.
  const awaitTool = pi.tools.find(tool => tool.name === 'await_workers');
  const awaited = await awaitTool.execute('await-1', { ids: [1] }, undefined, undefined, ctx);
  assert.match(awaited.content[0].text, /Worker results \(1\):\n\n#1 fast/);
  assert.deepEqual(awaited.details.workers.map(w => w.id), [1]);
  const idle = await awaitTool.execute('await-2', {}, undefined, undefined, ctx);
  assert.equal(idle.content[0].text, 'No running workers.');

  // continue_worker re-prompts the SAME session (third prompt, no new worker id)
  // and delivers through a fresh result message.
  const continueTool = pi.tools.find(tool => tool.name === 'continue_worker');
  const continued = await continueTool.execute('continue-1', { id: 2, task: 'Also fix the test' }, undefined, undefined, ctx);
  assert.match(continued.content[0].text, /Continued worker #2/);
  assert.equal(continued.details.workers[0].status, 'starting');
  await untilSent(pi, 2);
  assert.equal(prompts.length, 3);
  assert.match(prompts[2], /^Also fix the test/);
  assert.match(pi.messages[1].message.content, /#2 general · .* · completed · \d+s\nVerified worker result for Also fix the test/);
  await assert.rejects(continueTool.execute('continue-2', { id: 9, task: 'x' }, undefined, undefined, ctx), /Unknown worker #9/);

  // Results are not re-delivered by a later flush: the queue is empty.
  await sleep(400);
  assert.equal(pi.messages.length, 2);
  for (const handler of pi.handlers.get('session_shutdown') || []) await handler({}, ctx);
});

test('timeout delivers pre-abort stopping point and file evidence; continuation resets it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-timeout-'));
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
    await rm(dir, { recursive: true, force: true });
  });
  const models = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'),
    modelsStorePath: join(dir, 'models-store.json'), allowModelNetwork: false });
  models.getModel = () => ({ id: 'offline', name: 'Offline', provider: 'test', api: 'openai-completions', baseUrl: 'http://unused.invalid',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 });
  t.mock.method(ModelRuntime, 'create', async () => models);
  const deadline = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  let deadlines = 0;
  t.mock.method(AbortSignal, 'timeout', ms => {
    if (ms !== 20 * 60 * 1000) return originalTimeout(ms);
    deadlines++;
    return deadlines === 1 ? deadline.signal : new AbortController().signal;
  });
  let release;
  let prompts = 0;
  t.mock.method(AgentSession.prototype, 'prompt', async function () {
    if (++prompts > 1) {
      this.agent.state.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Continued successfully' }], stopReason: 'stop' });
      return;
    }
    this._emit({ type: 'tool_execution_start', toolCallId: 'edit1', toolName: 'edit', args: { path: 'extensions/piastra/progress.mjs' } });
    this._emit({ type: 'tool_execution_end', toolCallId: 'edit1', toolName: 'edit', isError: false });
    this._emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Now checking the tests' } });
    this._emit({ type: 'tool_execution_start', toolCallId: 'check1', toolName: 'run_checks', args: { name: 'test' } });
    const pending = new Promise(resolve => { release = resolve; });
    deadline.abort(new Error('Synthetic deadline'));
    await pending;
  });
  t.mock.method(AgentSession.prototype, 'abort', async function () {
    // Abort teardown can overwrite live activity: the result must retain the
    // snapshot from immediately before this event.
    this._emit({ type: 'tool_execution_end', toolCallId: 'check1', toolName: 'run_checks', isError: true });
    release();
  });
  const extension = await import(pathToFileURL(join(root, 'extensions', 'piastra', 'index.ts')).href);
  const pi = fakePi(fakeEvents());
  extension.default(pi);
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'timeout-test' }, isProjectTrusted: () => true, isIdle: () => true, ui: { notify() {} } };
  t.after(async () => { for (const handler of pi.handlers.get('session_shutdown') || []) await handler({}, ctx); });
  await pi.tools.find(tool => tool.name === 'delegate').execute('timeout-batch', { tasks: [{ role: 'general', access: 'write', task: 'Test timeout' }] }, undefined, undefined, ctx);
  await untilSent(pi, 1);
  const result = pi.messages[0].message.details.results[0];
  assert.equal(result.status, 'cancelled');
  assert.match(result.text, /timed out after 20 minutes/);
  assert.match(result.stoppingPoint.pending[0], /run_checks/);
  assert.match(result.stoppingPoint.partialResponse, /Now checking/);
  assert.deepEqual(result.fileEvidence.files, ['extensions/piastra/progress.mjs']);
  assert.match(pi.messages[0].message.content, /Files changed.*progress.mjs/);
  assert.match(pi.messages[0].message.content, /git diff --stat/);
  await pi.tools.find(tool => tool.name === 'continue_worker').execute('continue-timeout', { id: 1, task: 'Continue' }, undefined, undefined, ctx);
  await untilSent(pi, 2);
  const continued = pi.messages[1].message.details.results[0];
  assert.equal(continued.status, 'completed');
  assert.equal(continued.stoppingPoint, undefined);
  assert.deepEqual(continued.fileEvidence.files, []);
  assert.equal(deadlines, 2);
});

test('a rejected worker runtime initialization is reported as a failed result message and releases the guard', async () => {
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
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'guard-init' }, isProjectTrusted: () => true, isIdle: () => true, ui: { notify: () => {} } };
  const originalCreate = ModelRuntime.create;
  ModelRuntime.create = async () => { throw new Error('synthetic runtime initialization failure'); };
  try {
    const output = await delegate.execute('call-init', {
      tasks: [
        { role: 'general', access: 'write', task: 'Edit a file' },
        { role: 'fast', access: 'read', task: 'Inspect a file' },
      ],
    }, undefined, undefined, ctx);
    assert.match(output.content[0].text, /Started 2 workers/);
    const [message] = await untilSent(pi, 1);
    assert.match(message.message.content, /#1 general · .* · FAILED · \d+s\nsynthetic runtime initialization failure/);
    assert.match(message.message.content, /#2 fast · .* · FAILED/);
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
  for (const handler of pi.handlers.get('session_shutdown') || []) await handler({}, ctx);
});

test('an aborted delegate call starts nothing; cancel_worker stops a starting worker and returns it without a duplicate message', async () => {
  const extension = await import(pathToFileURL(join(root, 'extensions', 'piastra', 'index.ts')).href);
  const events = fakeEvents();
  const pi = fakePi(events);
  extension.default(pi);
  const delegate = pi.tools.find((tool) => tool.name === 'delegate');
  const cancelTool = pi.tools.find((tool) => tool.name === 'cancel_worker');
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'guard-cancel' }, isProjectTrusted: () => true, isIdle: () => true, ui: { notify: () => {} } };

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    delegate.execute('call-cancel', { tasks: [{ role: 'fast', access: 'read', task: 'Inspect a file' }] }, controller.signal, undefined, ctx),
    (error) => error?.name === 'AbortError',
  );
  const none = { type: 'query', busy: false, active: 0 };
  events.emit(PIASTRA_WORKER_GUARD_CHANNEL, none);
  assert.equal(none.active, 0, 'an aborted call must not register workers');

  // A hung runtime keeps the worker `starting`; cancel_worker aborts it.
  const originalCreate = ModelRuntime.create;
  ModelRuntime.create = () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('fixture: never used')), 5000));
  try {
    await delegate.execute('call-hang', { tasks: [{ role: 'fast', access: 'read', task: 'Inspect a file' }] }, undefined, undefined, ctx);
    const active = { type: 'query', busy: false, active: 0 };
    events.emit(PIASTRA_WORKER_GUARD_CHANNEL, active);
    assert.equal(active.active, 1);
    const cancelled = await cancelTool.execute('cancel-1', { id: 1 }, undefined, undefined, ctx);
    assert.match(cancelled.content[0].text, /#1 fast · .* · CANCELLED/);
    assert.equal(cancelled.details.workers[0].status, 'cancelled');
    const released = { type: 'query', busy: false, active: 0 };
    events.emit(PIASTRA_WORKER_GUARD_CHANNEL, released);
    assert.equal(released.active, 0);
    // The direct return consumed the queued result: no message follows.
    await sleep(450);
    assert.equal(pi.messages.length, 0, 'cancel_worker must not also deliver a result message');
    const again = await cancelTool.execute('cancel-2', { id: 1 }, undefined, undefined, ctx);
    assert.match(again.content[0].text, /not running \(cancelled\)/);
  } finally {
    ModelRuntime.create = originalCreate;
    for (const handler of pi.handlers.get('session_shutdown') || []) await handler({}, ctx);
  }
});

test('/cancel stops workers by id, all, or a picker without spending a turn; bad ids and idle states notify', async () => {
  const extension = await import(pathToFileURL(join(root, 'extensions', 'piastra', 'index.ts')).href);
  const events = fakeEvents();
  const pi = fakePi(events);
  const commands = new Map();
  pi.registerCommand = (name, definition) => { commands.set(name, definition); };
  extension.default(pi);
  const delegate = pi.tools.find((tool) => tool.name === 'delegate');
  const cancel = commands.get('cancel');
  assert.ok(cancel, '/cancel is registered');
  assert.match(cancel.description, /\/cancel <id>/);
  const notices = [];
  let pick;
  const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'guard-slash-cancel' }, isProjectTrusted: () => true, isIdle: () => true,
    ui: { notify: (message, level) => notices.push({ message, level }), select: async () => pick } };

  await cancel.handler('', ctx);
  assert.deepEqual(notices.at(-1), { message: 'No running workers.', level: 'info' });

  const originalCreate = ModelRuntime.create;
  ModelRuntime.create = () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('fixture: never used')), 5000));
  try {
    await delegate.execute('call-hang', { tasks: [
      { role: 'fast', access: 'read', task: 'Inspect a file' },
      { role: 'general', access: 'write', task: 'Edit a file' },
      { role: 'fast', access: 'read', task: 'Read the docs' },
    ] }, undefined, undefined, ctx);
    await cancel.handler('#9', ctx);
    assert.match(notices.at(-1).message, /Unknown worker #9\. Running: #1, #2, #3\./);
    assert.equal(notices.at(-1).level, 'warning');

    await cancel.handler('1', ctx);
    assert.match(notices.at(-1).message, /Cancelling #1\./);
    await untilSent(pi, 1);
    assert.match(pi.messages[0].message.content, /#1 fast · .* · CANCELLED/);
    await cancel.handler('1', ctx);
    assert.match(notices.at(-1).message, /not running \(cancelled\)/);

    // Bare /cancel picks from running workers only.
    pick = undefined;
    await cancel.handler('', ctx);
    assert.ok(!/Cancelling/.test(notices.at(-1).message), 'dismissing the picker cancels nothing');
    pick = '#2 general · Edit a file';
    await cancel.handler('', ctx);
    assert.match(notices.at(-1).message, /Cancelling #2\./);
    await untilSent(pi, 2);

    await cancel.handler('all', ctx);
    assert.match(notices.at(-1).message, /Cancelling #3\./);
    await untilSent(pi, 3);
    const query = { type: 'query', busy: false, active: 0 };
    events.emit(PIASTRA_WORKER_GUARD_CHANNEL, query);
    assert.equal(query.active, 0);
  } finally {
    ModelRuntime.create = originalCreate;
    for (const handler of pi.handlers.get('session_shutdown') || []) await handler({}, ctx);
  }
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
