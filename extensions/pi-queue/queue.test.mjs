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

const extensionUrl = new URL('./index.ts', import.meta.url);
const { default: installQueue } = await import(extensionUrl.href);

const SIDEBAR_CHANNEL = 'pi-atelier:sidebar-panels';
const QUEUE_ENTRY_TYPE = 'pi-queue-steer:queue';

const settle = () => new Promise(resolve => setImmediate(resolve));

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
    sendUserMessage(content, options) { sent.push({ content, options }); },
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
