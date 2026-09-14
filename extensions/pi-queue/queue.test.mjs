// Unit tests for the vendored pi-queue fork entrypoint (extensions/pi-queue).
// Loads the real extension factory under node --experimental-strip-types with
// a fake ExtensionAPI harness and drives the session events the extension
// subscribes to, without touching a terminal or a model provider.
//
// Run: node --experimental-strip-types --test extensions/pi-queue/queue.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession, SettingsManager } from '@earendil-works/pi-coding-agent';

const extensionUrl = new URL('./index.ts', import.meta.url);
const { default: installQueue } = await import(extensionUrl.href);

const SIDEBAR_CHANNEL = 'pi-atelier:sidebar-panels';
const QUEUE_ENTRY_TYPE = 'pi-queue-steer:queue';

const settle = () => new Promise(resolve => setImmediate(resolve));
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Stand-in for AgentSession.prompt preflight. delivery.ts wraps this function
// on AgentSession.prototype, so every queued send actually flows through the
// bridge and only resolves/rejects on the preflight signal Pi would emit.
const promptControl = {
  behavior: 'accept',
  delay: 0,
  barrier: null,
  decide: null,
  calls: [],
};
const sendControl = { throwOnce: false };
const promptErrors = [];
function resetPromptControl() {
  promptControl.behavior = 'accept';
  promptControl.delay = 0;
  promptControl.barrier = null;
  promptControl.decide = null;
  promptControl.calls.length = 0;
  promptErrors.length = 0;
  sendControl.throwOnce = false;
}
AgentSession.prototype.prompt = async function (text, options) {
  const call = { text, options, index: promptControl.calls.length };
  promptControl.calls.push(call);
  if (promptControl.barrier) await promptControl.barrier;
  if (promptControl.delay > 0) await wait(promptControl.delay);
  const accepted = promptControl.decide ? promptControl.decide(call) : promptControl.behavior === 'accept';
  options?.preflightResult?.(accepted);
  if (!accepted) throw new Error('prompt preflight rejected');
};

// Expose the steering mode to the batch tests without touching real settings.
let steeringModeOverride;
const baseGetSteeringMode = SettingsManager.prototype.getSteeringMode;
SettingsManager.prototype.getSteeringMode = function () {
  return steeringModeOverride ?? baseGetSteeringMode.call(this);
};

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  const sent = [];
  const appended = [];
  const channelEvents = [];
  const listeners = new Map();
  const pi = {
    on(name, fn) { handlers.set(name, fn); },
    registerCommand(name, options) { commands.set(name, options); },
    events: {
      on(name, fn) {
        const set = listeners.get(name) ?? new Set();
        set.add(fn);
        listeners.set(name, set);
        return () => set.delete(fn);
      },
      emit(name, value) { for (const fn of listeners.get(name) ?? []) fn(value); },
    },
    // Exercise the real delivery adapter: Pi's runtime normalizes content and
    // calls AgentSession.sendUserMessage -> AgentSession.prompt. This harness
    // does the same through the AgentSession prototype the bridge wrapped.
    sendUserMessage(content, options) {
      sent.push({ content, options });
      if (sendControl.throwOnce) {
        sendControl.throwOnce = false;
        throw new Error('synchronous send failure');
      }
      const session = Object.create(AgentSession.prototype);
      const text = typeof content === 'string'
        ? content
        : content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      const promptOptions = {
        expandPromptTemplates: options?.expandPromptTemplates ?? false,
        streamingBehavior: options?.deliverAs,
        source: 'extension',
      };
      session.prompt(text, promptOptions).catch((error) => { promptErrors.push(error); });
    },
    getCommands: () => [],
    setModel: async () => true,
    setThinkingLevel() {},
    getThinkingLevel: () => 'medium',
    appendEntry(type, data) { appended.push({ type, data }); },
    // Test drivers
    async fire(name, event, ctx) { const fn = handlers.get(name); if (fn) await fn(event, ctx); },
  };
  // Sidebar and interop bridges subscribe directly through pi.events.on.
  pi.events.on(SIDEBAR_CHANNEL, (value) => {
    if (value?.version === 1) channelEvents.push(value);
  });
  return { pi, handlers, commands, sent, appended, channelEvents };
}

async function makeCtx(overrides = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'piastra-queue-cwd-'));
  let idle = true;
  const notifications = [];
  const ctx = {
    mode: 'rpc',
    hasUI: true,
    cwd,
    isProjectTrusted: () => false,
    scopedModels: [],
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
    model: { provider: 'x', id: 'y', contextWindow: 100000 },
    sessionManager: { getBranch: () => [], getSessionFile: () => null },
    signal: undefined,
    ui: {
      notify(text) { notifications.push(text); },
      setWidget() {},
      setEditorText() {},
      getEditorText: () => '',
      getEditorComponent: () => undefined,
      setEditorComponent() {},
    },
    abort() {},
    isIdle: () => idle,
    setIdle(value) { idle = value; },
    notifications,
    ...overrides,
  };
  return ctx;
}

async function boot(overrides = {}) {
  resetPromptControl();
  const harness = makePi();
  installQueue(harness.pi);
  const ctx = await makeCtx(overrides);
  await harness.pi.fire('session_start', { reason: 'startup' }, ctx);
  return { ...harness, ctx };
}

const commandArgs = (handler) => (args, ctx) => handler(args, ctx); // passthrough clarity no-op

test('registers the /q, /st and pause commands', async () => {
  const h = await boot();
  assert.ok(h.commands.has('q'));
  assert.ok(h.commands.has('st'));
  assert.ok(h.commands.has('pause'));
  assert.ok(h.commands.has('queue-drain'), 'upstream /queue-drain stays registered');
  assert.ok(h.commands.has('piastra-queue-drain'), 'the piastra alias stays registered');
});

test('queue state contract: queue-steer:state event, mirrors, and the piastra aliases', async () => {
  const h = await boot();
  const upstream = [];
  const alias = [];
  h.pi.events.on('queue-steer:state', value => upstream.push(value));
  h.pi.events.on('piastra:queue:state', value => alias.push(value));
  h.ctx.setIdle(false);
  h.commands.get('st').handler('live', h.ctx);
  assert.equal(upstream.length, 1, 'the upstream queue-steer:state event fires on change');
  assert.deepEqual(upstream[0], { pending: 1, paused: false, blocked: false });
  assert.equal(alias.length, 1, 'the piastra alias event fires alongside it');
  assert.deepEqual(alias[0], upstream[0]);
  assert.deepEqual(globalThis.__tmustierPiQueueSteerState, upstream[0], 'upstream mirror is set');
  assert.deepEqual(
    globalThis.__piastraPiQueueState,
    globalThis.__tmustierPiQueueSteerState,
    'the piastra mirror mirrors the upstream mirror',
  );
});

test('whitespace-only /q or /st notifies usage without enqueueing', async () => {
  for (const command of ['q', 'st']) {
    const h = await boot();
    h.ctx.setIdle(true);
    h.commands.get(command).handler('   ', h.ctx);
    assert.equal(h.sent.length, 0);
    assert.equal(h.appended.filter(e => e.type === QUEUE_ENTRY_TYPE).length, 0);
    assert.ok(
      h.ctx.notifications.some(text => text.toLowerCase().includes('usage')),
      `notify pointing at usage expected for /${command}`,
    );
    assert.ok(
      h.channelEvents.some(e => e.type === 'register' && e.panel.id === 'piastra:queue' && e.panel.title === 'Queue'),
    );
  }
});

test('idle /q parks paused exactly like Alt+Enter; rows persist for resume', async () => {
  const h = await boot();
  h.ctx.setIdle(true);
  h.commands.get('q').handler('alpha', h.ctx);
  const state = globalThis.__tmustierPiQueueSteerState;
  assert.deepEqual(globalThis.__piastraPiQueueState, state, 'piastra mirror mirrors upstream');
  assert.equal(state.pending, 1);
  assert.equal(state.paused, true, 'idle /q parks paused');
  // Committed queue state persists on session teardown for a paused resume.
  await h.pi.fire('session_shutdown', { reason: 'quit' }, h.ctx);
  const snapshot = h.appended.filter(e => e.type === QUEUE_ENTRY_TYPE).at(-1);
  assert.equal(snapshot.data.rows.length, 1);
  assert.equal(snapshot.data.rows[0].lane, 'followUp');
  assert.equal(snapshot.data.rows[0].text, 'alpha');
});

test('mid-run /q enqueues unparked for the run tail', async () => {
  const h = await boot();
  h.ctx.setIdle(false);
  h.commands.get('q').handler('later', h.ctx);
  assert.equal(globalThis.__piastraPiQueueState.pending, 1);
  assert.equal(globalThis.__piastraPiQueueState.paused, false);
  assert.equal(h.sent.length, 0, 'nothing dispatched on enqueue');
});

test('idle /st with no backlog starts immediately (single dispatched message)', async () => {
  const h = await boot();
  h.commands.get('st').handler('kick', h.ctx);
  await settle();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].content, 'kick');
  assert.deepEqual(h.sent[0].options, undefined, 'idle dispatch is a plain user message');
  assert.equal(globalThis.__piastraPiQueueState.pending, 0);
});

test('idle /st with backlog appends FIFO and dispatches in timeline order on resume', async () => {
  const h = await boot();
  h.ctx.setIdle(true);
  h.commands.get('q').handler('first', h.ctx); // parks the queue paused
  h.commands.get('st').handler('seg', h.ctx); // backlog exists -> appended, not started
  assert.equal(h.sent.length, 0, 'steer never overtakes a parked timeline');
  // FIFO append: an idle backlog steer is an ordinary enqueue('steer') row —
  // it lands behind the parked head instead of jumping before future run roots.
  const rows = h.channelEvents
    .filter(e => e.type === 'register' && e.panel.id === 'piastra:queue')
    .at(-1).panel.rows;
  const headIndex = rows.findIndex(row => row.text.includes('[Queued]') && row.text.includes('first'));
  const steerIndex = rows.findIndex(row => row.text.includes('[Steer]') && row.text.includes('seg'));
  assert.ok(headIndex !== -1 && steerIndex !== -1, 'both rows are published');
  assert.ok(headIndex < steerIndex, 'the steer appends behind the head in FIFO order');
  // Actual resume dispatch: lifting the park (mid-run /q resumes) dispatches
  // the timeline head first, then the appended steer — never the reverse.
  h.ctx.setIdle(false);
  h.commands.get('q').handler('tail', h.ctx); // resumes the queue
  await h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } }, h.ctx);
  await settle();
  assert.equal(h.sent.length, 0, 'the follow-up head holds the steer at the turn boundary');
  await h.pi.fire('agent_end', { messages: [{ role: 'assistant', stopReason: 'end_turn', content: [] }] }, h.ctx);
  await settle();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].content, 'first', 'the FIFO head dispatches first');
  h.ctx.setIdle(true);
  await h.pi.fire('agent_settled', {}, h.ctx);
  await settle();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1].content, 'seg', 'the appended steer follows in timeline order');
});

test('/queue-drain and its piastra alias drain dispatchable rows as one steering message', async () => {
  for (const command of ['queue-drain', 'piastra-queue-drain']) {
    const h = await boot();
    h.ctx.setIdle(false);
    h.commands.get('st').handler('three', h.ctx); // mid-run steer inserts at the current-run head
    h.commands.get('q').handler('one', h.ctx);
    h.commands.get('q').handler('two', h.ctx);
    await h.commands.get(command).handler(undefined, h.ctx);
    await settle();
    assert.equal(h.sent.length, 1, `/${command} merges the timeline into one message`);
    const content = h.sent[0].content;
    assert.ok(
      content.includes('three') && content.indexOf('three') < content.indexOf('one') && content.indexOf('one') < content.indexOf('two'),
      `drain preserves timeline order, got: ${content}`,
    );
    assert.deepEqual(h.sent[0].options, { deliverAs: 'steer' }, 'mid-run drain delivers as steering');
    assert.equal(globalThis.__tmustierPiQueueSteerState.pending, 0, 'the drained rows leave the queue');
  }
});

test('steer rows dispatch at the turn boundary during a run, before follow-ups', async () => {
  const h = await boot();
  h.ctx.setIdle(false);
  h.commands.get('st').handler('in-flight note', h.ctx);
  h.commands.get('q').handler('tail', h.ctx);
  // Turn boundary: a clean assistant turn_end.
  await h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } }, h.ctx);
  await settle();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], { content: 'in-flight note', options: { deliverAs: 'steer' } });
  // Next boundary (run settles) releases the follow-up.
  h.ctx.setIdle(true);
  await h.pi.fire('agent_settled', {}, h.ctx);
  await settle();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1].content, 'tail');
});

test('edit-session changes and dispatch update the sidebar snapshot', async () => {
  const h = await boot();
  h.commands.get('q').handler('editable', h.ctx);
  const panels = h.channelEvents.filter(e => e.type === 'register' && e.panel.id === 'piastra:queue');
  const latest = panels.at(-1).panel;
  assert.ok(latest.title.includes('paused'));
  const labels = latest.rows.map(row => row.text).join('\n');
  assert.ok(labels.includes('[Queued]'), 'follow-up rows carry explicit Queued labels');
  h.commands.get('st').handler('segment', h.ctx);
  // Idle /st with backlog keeps palette; snapshot rows include the steer.
  const latestRows = h.channelEvents.filter(e => e.type === 'register' && e.panel.id === 'piastra:queue').at(-1).panel.rows;
  const joined = latestRows.map(row => row.text).join('\n');
  assert.ok(joined.includes('[Steer]'), 'steer rows carry explicit Steer labels');
});

test('sidebar panel never exceeds the protocol caps and publishes only on change', async () => {
  const h = await boot();
  h.commands.get('q').handler('one', h.ctx);
  h.commands.get('q').handler('two', h.ctx);
  h.commands.get('st').handler('three', h.ctx);
  const start = h.channelEvents.filter(e => e.type === 'register').length;
  h.ctx.setIdle(true);
    h.commands.get('q').handler('   ', h.ctx); // no-op: whitespace usage
  assert.equal(h.channelEvents.filter(e => e.type === 'register').length, start, 'usage notification must not republish');
  for (const event of h.channelEvents.filter(e => e.type === 'register')) {
    assert.ok(event.panel.rows.length <= 24, 'rows capped at 24');
    for (const row of event.panel.rows) assert.ok(row.text.length <= 160, 'rows capped at 160 chars');
  }
});

test('long queue backlog is capped inside the sidebar panel', async () => {
  const h = await boot();
  for (let n = 0; n < 40; n++) h.commands.get('q').handler(`row ${n}`, h.ctx);
  const panel = h.channelEvents.filter(e => e.type === 'register').at(-1).panel;
  assert.equal(panel.rows.length, 24);
  assert.ok(panel.rows.at(-1).text.includes('more queued rows'));
});

test('dispatch, persistence restore edit/resume, and teardown unregister the panel', async () => {
  const h = await boot();
  h.commands.get('q').handler('kept', h.ctx);
  await h.pi.fire('session_shutdown', { reason: 'quit' }, h.ctx);
  const unregister = h.channelEvents.at(-1);
  assert.equal(unregister.type, 'unregister');
  assert.equal(unregister.id, 'piastra:queue');
  assert.deepEqual(unregister.panel === undefined, true);
});

test('/pause residue: paused steer dispatch is blocked until resume', async () => {
  const h = await boot();
  h.ctx.setIdle(false);
  h.commands.get('st').handler('pending steer', h.ctx);
  h.commands.get('pause').handler(undefined, h.ctx);
  await h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'aborted', content: [] } }, h.ctx);
  await settle();
  assert.equal(h.sent.length, 0, 'the paused timeline holds the steer row at the boundary');
  const state = globalThis.__piastraPiQueueState;
  assert.equal(state.paused, true);
  assert.equal(state.pending, 1);
});

// --- Review finding #1 regressions: acknowledged queued delivery ---------

test('async preflight rejection retains every row, parks the queue, and persists it', async () => {
  const h = await boot();
  h.ctx.setIdle(true);
  h.commands.get('q').handler('alpha', h.ctx); // idle /q parks paused
  h.ctx.setIdle(false);
  h.commands.get('q').handler('tail', h.ctx); // mid-run /q resumes the timeline

  let release;
  promptControl.barrier = new Promise((resolve) => { release = resolve; });
  promptControl.behavior = 'reject';
  const boundary = h.pi.fire('agent_end', { messages: [{ role: 'assistant', stopReason: 'end_turn', content: [] }] }, h.ctx);
  await settle();

  // The pre-send snapshot exists and the rows are still queued while the
  // preflight promise is pending.
  const preAck = h.appended.filter((e) => e.type === QUEUE_ENTRY_TYPE).at(-1);
  assert.deepEqual(preAck.data.rows.map((r) => r.text), ['alpha', 'tail'], 'snapshot persisted before the send');
  assert.equal(globalThis.__piastraPiQueueState.pending, 2, 'rows stay queued until the ack settles');

  release();
  await boundary;
  await settle();

  const state = globalThis.__piastraPiQueueState;
  assert.equal(state.pending, 2, 'rejection retains the same rows');
  assert.equal(state.paused, true, 'rejection parks the timeline');
  const latest = h.appended.filter((e) => e.type === QUEUE_ENTRY_TYPE).at(-1);
  assert.deepEqual(latest.data.rows.map((r) => r.text), ['alpha', 'tail']);
  assert.equal(latest.data.paused, true);
  assert.ok(promptErrors.length >= 1, 'the original prompt rejection still travels the runtime error path');
  assert.ok(h.ctx.notifications.some((t) => t.includes('Could not deliver queued follow-up')));
});

test('a delayed acceptance removes the row once and blocks duplicate dispatch', async () => {
  const h = await boot();
  h.ctx.setIdle(false);
  h.commands.get('st').handler('one', h.ctx); // mid-run steer at the head
  h.commands.get('q').handler('two', h.ctx);

  let release;
  promptControl.barrier = new Promise((resolve) => { release = resolve; });
  const boundary = h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } }, h.ctx);
  await settle();
  assert.equal(h.sent.length, 1, 'the first boundary dispatched the steer');

  // Repeat boundaries and an explicit drain while the ack is pending must not
  // send the in-flight row a second time.
  await h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } }, h.ctx);
  await h.commands.get('queue-drain').handler(undefined, h.ctx);
  h.commands.get('q').handler('three', h.ctx); // new row may enqueue meanwhile
  await settle();
  assert.equal(h.sent.length, 1, 'the in-flight row is never double-sent');

  release();
  await boundary;
  await settle();
  // Accepted row leaves once; rows enqueued during flight survive untouched.
  const latest = h.appended.filter((e) => e.type === QUEUE_ENTRY_TYPE).at(-1);
  assert.deepEqual(latest.data.rows.map((r) => r.text), ['two', 'three']);
  assert.deepEqual(h.sent.map((s) => s.content), ['one']);

  h.ctx.setIdle(true);
  await h.pi.fire('agent_settled', {}, h.ctx);
  await settle();
  assert.deepEqual(h.sent.map((s) => s.content), ['one', 'two'], 'the surviving head dispatches next');
});

test('partial batch acceptance removes acked rows and keeps the failed row and its tail', async () => {
  const h = await boot();
  steeringModeOverride = 'all';
  try {
    h.ctx.setIdle(false);
    h.commands.get('st').handler('one', h.ctx);
    h.commands.get('st').handler('two', h.ctx);
    h.commands.get('st').handler('three', h.ctx);
    // Accept the first prompt, reject the second; the third must never send.
    promptControl.decide = (call) => call.index === 0;

    await h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } }, h.ctx);
    await settle();

    assert.deepEqual(h.sent.map((s) => s.content), ['one', 'two'], 'the batch stops at the rejection');
    assert.equal(globalThis.__piastraPiQueueState.pending, 2, 'the failed row and its tail stay queued');
    assert.equal(globalThis.__piastraPiQueueState.paused, true);
    const latest = h.appended.filter((e) => e.type === QUEUE_ENTRY_TYPE).at(-1);
    assert.deepEqual(latest.data.rows.map((r) => r.text), ['two', 'three'], 'same ids, text and order retained');
  } finally {
    steeringModeOverride = undefined;
  }
});

test('a rejected merged drain keeps every row and rows enqueued while it is in flight', async () => {
  const h = await boot();
  h.ctx.setIdle(false);
  h.commands.get('st').handler('one', h.ctx);
  h.commands.get('q').handler('two', h.ctx);

  let release;
  promptControl.barrier = new Promise((resolve) => { release = resolve; });
  promptControl.behavior = 'reject';
  const drain = h.commands.get('queue-drain').handler(undefined, h.ctx);
  await settle();
  h.commands.get('q').handler('three', h.ctx); // enqueued while the drain preflight is pending

  release();
  await drain;
  await settle();

  const latest = h.appended.filter((e) => e.type === QUEUE_ENTRY_TYPE).at(-1);
  assert.deepEqual(latest.data.rows.map((r) => r.text), ['one', 'two', 'three']);
  assert.equal(latest.data.paused, true);
  assert.equal(globalThis.__piastraPiQueueState.pending, 3);
  assert.ok(h.ctx.notifications.some((t) => t.includes('Could not drain the queue')));
});

test('idle /st preflight rejection retains the steer row and parks the queue', async () => {
  const h = await boot();
  promptControl.behavior = 'reject';
  h.commands.get('st').handler('kick', h.ctx);
  await settle();

  assert.equal(h.sent.length, 1, 'the immediate steer was invoked once');
  const state = globalThis.__piastraPiQueueState;
  assert.equal(state.pending, 1, 'the rejected immediate steer stays queued');
  assert.equal(state.paused, true, 'the timeline parks for an explicit resume');
  const latest = h.appended.filter((e) => e.type === QUEUE_ENTRY_TYPE).at(-1);
  assert.equal(latest.data.rows[0].text, 'kick');
  assert.equal(latest.data.rows[0].lane, 'steer');
  assert.ok(h.ctx.notifications.some((t) => t.includes('Could not deliver queued steer')));
});

test('a synchronous send failure keeps the row and parks the queue', async () => {
  const h = await boot();
  h.ctx.setIdle(false);
  h.commands.get('st').handler('boom', h.ctx);
  sendControl.throwOnce = true;

  await h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } }, h.ctx);
  await settle();

  const state = globalThis.__piastraPiQueueState;
  assert.equal(state.pending, 1);
  assert.equal(state.paused, true);
  const latest = h.appended.filter((e) => e.type === QUEUE_ENTRY_TYPE).at(-1);
  assert.equal(latest.data.rows[0].text, 'boom');
  assert.ok(h.ctx.notifications.some((t) => t.includes('Could not deliver queued steer')));
});

test('an acknowledgement arriving after teardown never mutates the retired runtime', async () => {
  const h = await boot();
  h.ctx.setIdle(false);
  h.commands.get('st').handler('late', h.ctx);

  let release;
  promptControl.barrier = new Promise((resolve) => { release = resolve; });
  promptControl.behavior = 'reject';
  const boundary = h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } }, h.ctx);
  await settle();
  assert.equal(h.sent.length, 1);

  await h.pi.fire('session_shutdown', { reason: 'quit' }, h.ctx);
  const notificationsAfterShutdown = h.ctx.notifications.length;
  const appendsAfterShutdown = h.appended.length;

  release();
  await boundary;
  await settle();

  assert.equal(h.sent.length, 1, 'no retry after teardown');
  assert.equal(h.ctx.notifications.length, notificationsAfterShutdown, 'late ack does not notify');
  assert.equal(h.appended.length, appendsAfterShutdown, 'late ack does not persist');
});

test('rejected delivery retains the exact image payload for the next attempt', async () => {
  const h = await boot();
  h.ctx.setIdle(false);
  h.ctx.mode = 'tui';
  const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } };
  await h.pi.fire('input', { text: '', images: [image], source: 'interactive', streamingBehavior: 'steer' }, h.ctx);

  promptControl.behavior = 'reject';
  await h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } }, h.ctx);
  await settle();

  const latest = h.appended.filter((e) => e.type === QUEUE_ENTRY_TYPE).at(-1);
  assert.deepEqual(latest.data.rows[0].images, [image], 'the image survives the rejection snapshot');
  assert.equal(globalThis.__piastraPiQueueState.pending, 1);

  // Resume the parked row and accept it: the same image reaches the agent.
  promptControl.behavior = 'accept';
  h.ctx.setIdle(false);
  const resume = h.commands.get('q').handler('resume', h.ctx); // mid-run enqueue resumes
  void resume;
  await h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } }, h.ctx);
  await settle();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1].content, [{ type: 'text', text: '' }, image]);
  assert.equal(globalThis.__piastraPiQueueState.pending, 1, 'only the resumed head left');
});

test('pausing during a delayed all-mode batch consumes only the accepted row', async () => {
  const h = await boot();
  steeringModeOverride = 'all';
  let release;
  let boundary;
  try {
    h.ctx.setIdle(false);
    for (const text of ['one', 'two', 'three']) h.commands.get('st').handler(text, h.ctx);
    promptControl.barrier = new Promise(resolve => { release = resolve; });
    boundary = h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } }, h.ctx);
    await settle();
    assert.deepEqual(h.sent.map(s => s.content), ['one']);
    h.commands.get('pause').handler('', h.ctx);
    release();
    await boundary;
    assert.deepEqual(h.sent.map(s => s.content), ['one'], 'pause stops the unsent batch tail');
    const snapshot = h.appended.filter(e => e.type === QUEUE_ENTRY_TYPE).at(-1).data;
    assert.deepEqual(snapshot.rows.map(r => r.text), ['two', 'three']);
    assert.equal(snapshot.paused, true);
    assert.equal(globalThis.__piastraPiQueueState.paused, true);
  } finally {
    release?.();
    await boundary;
    steeringModeOverride = undefined;
  }
});

test('queued /new persists its command and tail before a rejected deferred send', async () => {
  const h = await boot();
  h.ctx.setIdle(false);
  h.commands.get('st').handler('/new', h.ctx);
  h.commands.get('q').handler('after new', h.ctx);
  promptControl.behavior = 'reject';
  await h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } }, h.ctx);
  const before = h.appended.filter(e => e.type === QUEUE_ENTRY_TYPE).at(-1).data;
  assert.deepEqual(before.rows.map(r => r.text), ['/new', 'after new']);
  // The internal command is deliberately submitted on a timer, not during
  // the boundary event that scheduled it.
  await wait(5);
  await settle();
  assert.equal(h.sent[0].content, '/queue-steer-factory-new');
  const after = h.appended.filter(e => e.type === QUEUE_ENTRY_TYPE).at(-1).data;
  assert.deepEqual(after.rows, before.rows, 'failure preserves command and tail identities');
  assert.equal(after.paused, true);
  assert.equal(globalThis.__piastraPiQueueState.blocked, false);
});

test('cancelled queued /new preserves a paused snapshot of the entire handoff', async () => {
  const h = await boot({ newSession: async () => ({ cancelled: true }) });
  h.ctx.setIdle(false);
  h.commands.get('st').handler('/new', h.ctx);
  h.commands.get('q').handler('after cancellation', h.ctx);
  await h.pi.fire('turn_end', { message: { role: 'assistant', stopReason: 'end_turn' } }, h.ctx);
  const before = h.appended.filter(e => e.type === QUEUE_ENTRY_TYPE).at(-1).data;
  await wait(5);
  // The fake prompt host acknowledges command dispatch but does not execute
  // handlers, so drive the real internal handler's cancelled result here.
  await h.commands.get('queue-steer-factory-new').handler('', h.ctx);
  const after = h.appended.filter(e => e.type === QUEUE_ENTRY_TYPE).at(-1).data;
  assert.deepEqual(after.rows, before.rows);
  assert.equal(after.paused, true);
  assert.equal(globalThis.__piastraPiQueueState.blocked, false);
});
