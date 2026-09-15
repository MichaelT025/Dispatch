import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createWorkerProgress } from './worker-render.ts';
import { WIDGET_KEY } from './worker-panel.ts';

// Integration regression tests for the parent `index.ts` wiring of the
// subagent panel. Every test loads the ACTUAL extension (same direct-import
// pattern as guard.test.mjs) and drives the real `pi.on` handlers plus the
// real `delegate` tool execute, so a forgotten lifecycle hook (bind on
// session_start/session_tree, beginRun on agent_start, addCall on delegate
// execute, publish via the 250ms ticker/finalization, endRun on
// agent_settled, reset, dispose on session_shutdown) fails these assertions.
//
// No provider calls: `ModelRuntime.create` is patched with offline fixtures.
//  - unavailable-model fixture: runtime resolves, `getModel` returns undefined,
//    so each REAL per-worker try/catch/finally path in index.ts finalizes its
//    worker as `failed` and the REAL final model-facing result map
//    (`completed.map(...)`) produces the delegate tool result.
//  - hung-runtime fixture: `ModelRuntime.create` rejects after a delay, so the
//    batch stays `starting` (spinner ticking) until the rejection hits the
//    outer catch / finalizeOutstandingWorkers path.
//
// Coverage statement: a fully successful worker (`ok: true`, r.text) requires
// a real provider session, which these tests must not make. The success
// formatting expression is the same `completed.map(...)` path exercised here
// with `ok: false` payloads, the completed-row panel rendering is covered by
// the direct renderer payload comparison in the final test plus the unit
// tests in worker-panel.test.mjs. Everything else (widget mount/lifecycle,
// addCall whitelisting, restored-history exclusion, run retain/clear, reset,
// shutdown) is exercised through the real extension code.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Temporary agent dir/profile: nothing touches the real ~/.pi agent state and
// no extension/skill/theme resources are loaded (getAgentDir is read lazily
// inside the extension, after this assignment).
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), 'piastra-panel-integration-'));

const sleep = ms => new Promise(resolveTimer => setTimeout(resolveTimer, ms));

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
  const commands = new Map();
  const shortcuts = new Map();
  return {
    events,
    handlers,
    tools,
    commands,
    shortcuts,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerCommand: (name, definition) => { commands.set(name, definition); },
    registerShortcut: (key, definition) => { shortcuts.set(key, definition); },
    registerTool: (tool) => { tools.push(tool); },
    getThinkingLevel: () => 'low',
    appendEntry: () => {},
    getAllTools: () => [],
    setModel: async () => true,
    setThinkingLevel: () => {},
    setActiveTools: () => {},
  };
}

// TUI-style ExtensionContext mock: records every setWidget call and keeps the
// latest mounted widget component so tests can inspect real rendered lines.
function makeCtx({ branch = [] } = {}) {
  const widgetCalls = [];
  const renders = { count: 0 };
  const tui = { requestRender: () => { renders.count += 1; } };
  const theme = { fg: (_style, text) => text };
  let component;
  const ctx = {
    mode: 'tui',
    cwd: root,
    hasUI: true,
    isIdle: () => true,
    ui: {
      theme,
      setWidget(key, content, options) {
        widgetCalls.push({ key, content, options });
        component = typeof content === 'function' ? content(tui, theme) : undefined;
      },
      notify: () => {},
      setStatus: () => {},
    },
    sessionManager: { getBranch: () => branch },
    modelRegistry: { find: () => ({ provider: 'fixture', id: 'model' }) },
  };
  const renderWidget = (width = 80) => {
    const lines = component && typeof component.render === 'function' ? component.render(width) : [];
    return lines.map(stripTerminalSequences);
  };
  const widgetText = () => renderWidget().join('\n');
  return {
    ctx,
    widgetCalls,
    renders,
    renderWidget,
    widgetText,
  };
}

let extensionPromise;
const loadExtension = () => extensionPromise ??= import(pathToFileURL(join(root, 'extensions', 'piastra', 'index.ts')).href);

// Fires every handler the extension registered for an event, in registration
// order (Pi emits them in this order too).
async function fire(pi, name, event, ctx) {
  for (const handler of pi.handlers.get(name) ?? []) await handler(event, ctx);
}

async function bootstrap({ branch } = {}) {
  const extension = await loadExtension();
  const events = fakeEvents();
  const pi = fakePi(events);
  extension.default(pi);
  const harness = makeCtx({ branch });
  const delegate = pi.tools.find((tool) => tool.name === 'delegate');
  assert.ok(delegate, 'the real extension registers the delegate tool');
  return { extension, events, pi, delegate, ...harness };
}

// Offline fixtures for ModelRuntime.create (patched globally, always restored).
const unavailableModelRuntime = () => ({ getModel: () => undefined });
const hungRuntimeError = 'fixture: runtime initialization hung and failed';
const hungRuntime = () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error(hungRuntimeError)), 1200));

async function withRuntimePatch(fixture, run) {
  const original = ModelRuntime.create;
  ModelRuntime.create = fixture;
  try {
    return await run();
  } finally {
    ModelRuntime.create = original;
  }
}

test('delegate wiring: widget mounts aboveEditor during onUpdate, holds failed rows, result content preserved; agent_settled retains then next agent_start clears', async () => {
  const { pi, delegate, ctx, widgetCalls, widgetText, renderWidget } = await bootstrap();
  await fire(pi, 'session_start', {}, ctx);
  await fire(pi, 'agent_start', {}, ctx);

  const updates = [];
  const batch = await withRuntimePatch(unavailableModelRuntime, async () =>
    delegate.execute('call-1', {
      tasks: [
        { role: 'general', access: 'write', task: 'PANEL-TASK-A fix the widget' },
        { role: 'fast', access: 'read', task: 'PANEL-TASK-B scan the docs' },
      ],
    }, undefined, (update) => updates.push(update), ctx));

  // The first publish (initial + addCall) happens synchronously inside
  // execute; the widget must already be mounted by the first onUpdate.
  assert.ok(updates.length >= 2, `expected initial and final onUpdate, got ${updates.length}`);
  assert.equal(widgetCalls.length, 1, 'widget must mount exactly once for the run');
  assert.equal(widgetCalls[0].key, WIDGET_KEY);
  assert.equal(widgetCalls[0].options?.placement, 'aboveEditor');
  assert.equal(typeof widgetCalls[0].content, 'function');

  // Real model-facing delegate result: the completed.map(...) formatting over
  // per-worker results (FAILED variant of the success path; see header).
  const resultText = batch.content.map((part) => part.text).join('\n');
  assert.match(resultText, /general · opencode-go\/glm-5\.3-flash · FAILED/);
  assert.match(resultText, /Unavailable model opencode-go\/glm-5\.3-flash; no fallback used\./);
  assert.match(resultText, /fast · opencode-go\/deepseek-v4\.1-flash · FAILED/);
  assert.match(resultText, /Transcript: \(none\)/);
  assert.deepEqual(batch.details.workers.map((worker) => worker.status), ['failed', 'failed']);
  const finalUpdate = updates.at(-1);
  assert.deepEqual(finalUpdate.details.workers.map((worker) => worker.status), ['failed', 'failed']);

  // Widget layout: heading counts, role names, status glyphs, timers — and
  // nothing else: no task text, no model, no activity, no transcript.
  const text = widgetText();
  assert.match(text, /Subagents \(2\/2\)/);
  assert.match(text, /✗ general \d+s/);
  assert.match(text, /✗ fast \d+s/);
  for (const secret of ['PANEL-TASK', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'Unavailable model', 'Transcript', '\x1b']) {
    assert.ok(!text.includes(secret), `widget leaked ${JSON.stringify(secret)}:\n${text}`);
  }

  // agent_settled with ctx.isIdle() → endRun: settled rows are retained.
  await fire(pi, 'agent_settled', {}, ctx);
  const settledText = widgetText();
  assert.match(settledText, /○ Subagents \(2\/2\)/);
  assert.match(settledText, /✗ general/);
  assert.match(settledText, /✗ fast/);
  await sleep(300);
  assert.equal(widgetCalls.length, 1, 'settled panel must not remount');

  // Next agent_start begins a new run: rows cleared.
  await fire(pi, 'agent_start', {}, ctx);
  assert.deepEqual(renderWidget(), []);
});

test('agent_settled with ctx.isIdle() freezes still-active rows to interrupted; a busy ctx does not end the run', async () => {
  const { pi, delegate, ctx, widgetCalls, renders, widgetText } = await bootstrap();
  await fire(pi, 'session_start', {}, ctx);
  await fire(pi, 'agent_start', {}, ctx);

  const updates = [];
  const controller = new AbortController();
  const hung = withRuntimePatch(hungRuntime, () =>
    delegate.execute('call-hang', { tasks: [{ role: 'general', access: 'read', task: 'PANEL-TASK-HANG' }] },
      controller.signal, (update) => updates.push(update), ctx));
  hung.catch(() => { /* handled by assert.rejects in finally */ });

  try {
    await sleep(120);
    const rendersEarly = renders.count;
    await sleep(650);
    // The 250ms worker ticker must be publishing/spinning while the worker is
    // starting (this is the only spinner driver; the panel owns no timer).
    assert.ok(renders.count > rendersEarly, '250ms ticker did not drive repaints while a worker was starting');
    assert.match(widgetText(), /[├└]─ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] general \d+s/);
    assert.match(widgetText(), /● Subagents \(0\/1\)/);

    // ctx.isIdle() true → endRun via the real agent_settled handler.
    await fire(pi, 'agent_settled', {}, ctx);
    const frozenText = widgetText();
    assert.match(frozenText, /○ Subagents \(1\/1\)/);
    assert.match(frozenText, /⏹ general \d+s/, 'still-active row must be marked interrupted by endRun');
    const frozenRenders = renders.count;
    await sleep(600);
    assert.equal(renders.count, frozenRenders, 'frozen panel must stop repainting after endRun');
    assert.equal(widgetText(), frozenText);
  } finally {
    controller.abort(new Error('test cleanup'));
    await assert.rejects(hung, new RegExp(hungRuntimeError), 'hung runtime fixture must surface its rejection');
  }

  // Next agent_start clears the retained rows.
  await fire(pi, 'agent_start', {}, ctx);
  assert.deepEqual(widgetText(), '');
  // The panel must still be alive for the new run: a follow-up delegate call
  // remounts and shows only the new worker.
  await withRuntimePatch(unavailableModelRuntime, () =>
    delegate.execute('call-next', { tasks: [{ role: 'fast', access: 'read', task: 'PANEL-TASK-NEXT' }] }, undefined, () => {}, ctx));
  const nextText = widgetText();
  assert.match(nextText, /Subagents \(1\/1\)/);
  assert.match(nextText, /✗ fast \d+s/);
  assert.ok(!nextText.includes('general'), 'previous run row leaked into the new run');
});

test('agent_settled while ctx is busy keeps the run open (spinner keeps spinning)', async () => {
  const { pi, delegate, ctx, renders, widgetText } = await bootstrap();
  await fire(pi, 'session_start', {}, ctx);
  await fire(pi, 'agent_start', {}, ctx);

  const busyCtx = { ...ctx, isIdle: () => false };
  const controller = new AbortController();
  const hung = withRuntimePatch(hungRuntime, () =>
    delegate.execute('call-hang-busy', { tasks: [{ role: 'fast', access: 'read', task: 'PANEL-TASK-BUSY' }] },
      controller.signal, () => {}, busyCtx));
  hung.catch(() => { /* handled by assert.rejects in finally */ });
  try {
    await sleep(600);
    await fire(pi, 'agent_settled', {}, busyCtx);
    const text = widgetText();
    assert.match(text, /● Subagents \(0\/1\)/, 'a busy ctx must not end the run');
    assert.match(text, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] fast \d+s/);
    assert.ok(!text.includes('⏹'), 'no interruption marker while the run is open');
    const before = renders.count;
    await sleep(600);
    assert.ok(renders.count > before, 'spinner must keep ticking while the run is open');
  } finally {
    controller.abort(new Error('test cleanup'));
    await assert.rejects(hung, new RegExp(hungRuntimeError));
  }
  // After the batch failure the worker is finalized to failed through the
  // outer catch path (finalizeOutstandingWorkers), still visible in the panel.
  assert.match(widgetText(), /✗ fast \d+s/);
});

test('multiple sequential and parallel delegate calls accumulate in one run; restored session history is excluded', async () => {
  const branch = [{
    type: 'message',
    message: {
      role: 'toolResult',
      toolName: 'delegate',
      details: {
        workers: [
          { id: 90, toolCallId: 'old-call', role: 'legacy-one', model: 'old/model', task: 'OLD-TASK-90', status: 'completed', activity: 'Finished', started: 1, ended: 2, recent: [] },
          { id: 91, toolCallId: 'old-call', role: 'legacy-two', model: 'old/model', task: 'OLD-TASK-91', status: 'running', activity: 'Thinking…', started: 1, recent: [] },
        ],
      },
    },
  }];
  const { pi, delegate, ctx, widgetText } = await bootstrap({ branch });
  await fire(pi, 'session_start', {}, ctx);
  assert.ok(widgetText() === '', 'restored workers must not mount the panel before a run');

  await fire(pi, 'agent_start', {}, ctx);
  await withRuntimePatch(unavailableModelRuntime, async () => {
    // Two delegate calls in the SAME agent run, started in parallel, plus one
    // sequential follow-up: all three calls accumulate in one run.
    const parallel = await Promise.all([
      delegate.execute('call-a', { tasks: [{ role: 'review', access: 'read', task: 'PANEL-TASK-A' }] }, undefined, () => {}, ctx),
      delegate.execute('call-b', { tasks: [{ role: 'general', access: 'write', task: 'PANEL-TASK-B' }] }, undefined, () => {}, ctx),
    ]);
    assert.equal(parallel.length, 2);
    assert.match(widgetText(), /Subagents \(2\/2\)/);
    await delegate.execute('call-c', { tasks: [{ role: 'fast', access: 'read', task: 'PANEL-TASK-C' }] }, undefined, () => {}, ctx);
  });

  const text = widgetText();
  assert.match(text, /Subagents \(3\/3\)/);
  for (const role of ['review', 'general', 'fast']) assert.match(text, new RegExp(`✗ ${role} \\d+s`));
  // Restored history (including the interrupted old worker) never leaks in.
  assert.ok(!text.includes('legacy'), `restored history leaked into the panel:\n${text}`);
  assert.ok(!text.includes('⏹'), 'restored interrupted worker leaked into the panel');
  assert.ok(!text.includes('OLD-TASK'));
});

test('ModelRuntime.create rejection fixture: outer catch finalizes workers and the widget holds failed rows', async () => {
  const { pi, delegate, ctx, widgetText } = await bootstrap();
  await fire(pi, 'session_start', {}, ctx);
  await fire(pi, 'agent_start', {}, ctx);

  const updates = [];
  await assert.rejects(
    withRuntimePatch(async () => { throw new Error('fixture: runtime initialization rejected'); }, () =>
      delegate.execute('call-reject', { tasks: [{ role: 'general', access: 'write', task: 'PANEL-TASK-REJECT' }] },
        undefined, (update) => updates.push(update), ctx)),
    /fixture: runtime initialization rejected/,
  );
  assert.deepEqual(updates.at(-1).details.workers.map((worker) => worker.status), ['failed']);
  const text = widgetText();
  assert.match(text, /Subagents \(1\/1\)/);
  assert.match(text, /✗ general \d+s/);
  assert.ok(!text.includes('PANEL-TASK-REJECT'));
});

test('session_start and session_tree resets: no old row leakage into a new session/run', async () => {
  const { pi, delegate, widgetText, renderWidget, widgetCalls, ctx } = await bootstrap();
  await fire(pi, 'session_start', {}, ctx);
  await fire(pi, 'agent_start', {}, ctx);
  await withRuntimePatch(unavailableModelRuntime, () =>
    delegate.execute('call-1', { tasks: [{ role: 'general', access: 'write', task: 'PANEL-TASK-1' }] }, undefined, () => {}, ctx));
  assert.match(widgetText(), /✗ general \d+s/);

  // New session (session_start) rebinds on a fresh ctx: old widget unmounted,
  // old rows dropped.
  const next = makeCtx();
  await fire(pi, 'session_start', {}, next.ctx);
  assert.ok(widgetCalls.some((call) => call.key === WIDGET_KEY && call.content === undefined), 'session_start must unregister the old widget');
  assert.deepEqual(renderWidget(), []);
  await fire(pi, 'agent_start', {}, next.ctx);
  await withRuntimePatch(unavailableModelRuntime, () =>
    delegate.execute('call-2', { tasks: [{ role: 'fast', access: 'read', task: 'PANEL-TASK-2' }] }, undefined, () => {}, next.ctx));
  const afterStart = next.widgetText();
  assert.match(afterStart, /Subagents \(1\/1\)/);
  assert.match(afterStart, /✗ fast \d+s/);
  assert.ok(!afterStart.includes('general'), 'old run row leaked across session_start');

  // Branch navigation (session_tree) behaves the same on a further ctx.
  const third = makeCtx();
  await fire(pi, 'session_tree', {}, third.ctx);
  assert.ok(next.widgetCalls.some((call) => call.key === WIDGET_KEY && call.content === undefined), 'session_tree must unregister the previous widget');
  await fire(pi, 'agent_start', {}, third.ctx);
  await withRuntimePatch(unavailableModelRuntime, () =>
    delegate.execute('call-3', { tasks: [{ role: 'review', access: 'read', task: 'PANEL-TASK-3' }] }, undefined, () => {}, third.ctx));
  const afterTree = third.widgetText();
  assert.match(afterTree, /✗ review \d+s/);
  assert.ok(!/fast|general/.test(afterTree), 'old rows leaked across session_tree');
});

test('session_shutdown disposes: widget unregistered once, guard unsubscribed, no callbacks or timers retained', async () => {
  const { events, pi, delegate, ctx, widgetCalls, renders } = await bootstrap();
  await fire(pi, 'session_start', {}, ctx);
  await fire(pi, 'agent_start', {}, ctx);

  const updates = [];
  await withRuntimePatch(unavailableModelRuntime, () =>
    delegate.execute('call-1', { tasks: [{ role: 'general', access: 'write', task: 'PANEL-TASK-1' }] }, undefined, (update) => updates.push(update), ctx));
  const updatesAfterRun = updates.length;
  await sleep(300);
  assert.equal(updates.length, updatesAfterRun, '250ms ticker kept running after the delegate call settled');

  await fire(pi, 'session_shutdown', {}, ctx);
  const unregisterCalls = widgetCalls.filter((call) => call.key === WIDGET_KEY && call.content === undefined);
  assert.equal(unregisterCalls.length, 1, 'shutdown must unregister the widget exactly once');

  // The worker guard handshake was unsubscribed: queries are no longer answered.
  const query = { type: 'query', busy: false, active: 0 };
  events.emit('piastra:worker-guard', query);
  assert.deepEqual(query, { type: 'query', busy: false, active: 0 });

  // Post-shutdown activity must not resurrect the disposed panel.
  const rendersAtShutdown = renders.count;
  await fire(pi, 'agent_start', {}, ctx);
  await withRuntimePatch(unavailableModelRuntime, () =>
    delegate.execute('call-after-shutdown', { tasks: [{ role: 'general', access: 'write', task: 'PANEL-TASK-2' }] }, undefined, () => {}, ctx));
  assert.equal(widgetCalls.filter((call) => typeof call.content === 'function').length, 1, 'no widget mount after dispose');
  assert.equal(renders.count, rendersAtShutdown, 'no repaints requested after dispose');
  const updatesAfterShutdown = updates.length;
  await sleep(300);
  assert.equal(updates.length, updatesAfterShutdown, 'a delegate ticker survived shutdown');
});

test('/workers command, ctrl+shift+w shortcut and the delegate tool registration remain', async () => {
  const { pi } = await bootstrap();
  assert.ok(pi.commands.has('workers'), '/workers command must stay registered');
  assert.equal(typeof pi.commands.get('workers').handler, 'function');
  assert.ok(pi.shortcuts.has('ctrl+shift+w'), 'ctrl+shift+w shortcut must stay registered');
  assert.ok(pi.tools.some((tool) => tool.name === 'delegate'));
});

test('delegate renderResult publishes the one-line aggregate; direct payload comparison for completed rows', async () => {
  const { pi } = await bootstrap();
  const delegate = pi.tools.find((tool) => tool.name === 'delegate');
  const theme = { fg: (_style, text) => text };
  // Payload shape mirrors what index.ts saves in details.workers; a completed
  // status cannot be produced offline without a provider session, so this is
  // the direct renderer payload comparison promised in the coverage note.
  const workers = [
    { id: 1, role: 'general', model: 'secret/model', status: 'completed', task: 'SECRET-TASK', activity: 'SECRET-ACTIVITY', text: 'SECRET-TEXT', transcript: '/secret/path', started: 1, ended: 2, recent: [] },
    { id: 2, role: 'fast', model: 'secret/model', status: 'failed', task: 'SECRET-TASK', activity: 'SECRET-ACTIVITY', text: 'SECRET-TEXT', transcript: '/secret/path', started: 1, ended: 3, recent: [] },
  ];
  const component = delegate.renderResult({ content: [], details: { workers } }, { expanded: true }, theme);
  const lines = component.render(120).map(stripTerminalSequences);
  assert.equal(lines.length, 1, 'main-chat delegation must stay a single aggregate line even expanded');
  const text = lines.join('\n');
  assert.match(text, /Workers · 1 completed · 1 failed · \/workers for details/);
  for (const secret of ['SECRET-TASK', 'SECRET-ACTIVITY', 'SECRET-TEXT', 'secret/model', '/secret/path']) {
    assert.ok(!text.includes(secret), `aggregate line leaked ${secret}`);
  }
});
