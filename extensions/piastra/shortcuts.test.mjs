import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { matchesKey, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import {
  EDITOR_FACTORY_BRAND,
  LEADER_HINT,
  LEADER_TIMEOUT_MS,
  PiastraEditor,
  installShortcuts,
} from './shortcuts.ts';

// Legacy terminal byte encodings for the mapped keys.
const SHIFT_TAB = '\x1b[Z';
const CTRL_X = '\x18';
const CTRL_T = '\x14';
const ESCAPE = '\x1b';

// Mirrors pi's default app.* bindings (docs/keybindings.md) so pass-through
// behaviour is exercised through real key matching.
const DEFAULT_BINDINGS = {
  'app.interrupt': ['escape'],
  'app.clear': ['ctrl+c'],
  'app.exit': ['ctrl+d'],
  'app.thinking.cycle': ['shift+tab'],
  'app.thinking.toggle': ['ctrl+t'],
  'app.message.copy': ['ctrl+x'],
  'app.tools.expand': ['ctrl+o'],
};
const keybindingsStub = (bindings = DEFAULT_BINDINGS) => ({
  matches: (data, action) => (bindings[action] ?? []).some(key => matchesKey(data, key)),
});
const tuiStub = () => {
  let renders = 0;
  return {
    terminal: { rows: 24 },
    requestRender() { renders++; },
    get renders() { return renders; },
  };
};
const themeStub = { borderColor: (text) => text };

/** Simulates what pi's setCustomEditorComponent does: copy native handlers. */
function installNativeHandlers(editor, handlers) {
  for (const [action, handler] of Object.entries(handlers)) editor.actionHandlers.set(action, handler);
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function fakePi() {
  const handlers = new Map();
  return {
    on(name, fn) { handlers.set(name, fn); },
    async emit(name, event, ctx) { const fn = handlers.get(name); if (fn) await fn(event, ctx); },
  };
}

function fakeUi(factories = []) {
  const notified = [];
  return {
    notified,
    factories,
    getEditorComponent() { return factories.length ? factories[factories.length - 1] : undefined; },
    setEditorComponent(factory) { factories.push(factory); },
    notify(message, kind) { notified.push([message, kind]); },
    theme: { fg: (_style, text) => text },
  };
}

function countingActions(overrides = {}) {
  const calls = { cycleAgents: 0, openAgentPicker: 0, openWorkers: 0, toggleTools: 0 };
  const actions = {
    cycleAgents: () => { calls.cycleAgents++; },
    openAgentPicker: () => { calls.openAgentPicker++; },
    openWorkers: () => { calls.openWorkers++; },
    ...overrides,
  };
  return { calls, actions };
}

test('editor keeps the CustomEditor duck-type contract pi relies on', () => {
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub());
  assert.ok(editor instanceof CustomEditor);
  assert.ok('actionHandlers' in editor);
  assert.ok(editor.actionHandlers instanceof Map);
});

test('shift+tab cycles agents instead of the native thinking cycle', async () => {
  const tui = tuiStub();
  const { calls, actions } = countingActions();
  const editor = new PiastraEditor(tui, themeStub, keybindingsStub(), { actions });
  const thinkingCycle = [];
  installNativeHandlers(editor, { 'app.thinking.cycle': () => thinkingCycle.push(true) });
  editor.handleInput(SHIFT_TAB);
  await settle();
  assert.equal(calls.cycleAgents, 1);
  assert.equal(thinkingCycle.length, 0);
  assert.ok(!editor.isLeaderArmed);
});

test('ctrl+t cycles thinking and leader t toggles it: distinct action ids', () => {
  const { calls, actions } = countingActions();
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub(), { actions });
  const cycle = [];
  const toggle = [];
  installNativeHandlers(editor, {
    'app.thinking.cycle': () => cycle.push(true),
    'app.thinking.toggle': () => toggle.push(true),
  });
  editor.handleInput(CTRL_T);
  assert.deepEqual(cycle, [true]);
  assert.equal(toggle.length, 0);
  editor.handleInput(CTRL_X);
  assert.ok(editor.isLeaderArmed);
  editor.handleInput('t');
  assert.equal(toggle.length, 1);
  assert.equal(cycle.length, 1);
  assert.ok(!editor.isLeaderArmed);
  assert.equal(calls.openAgentPicker, 0);
});

test('leader y copies via the native app.message.copy handler, a and w open PiAstra UI', async () => {
  const { calls, actions } = countingActions();
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub(), { actions });
  const copy = [];
  installNativeHandlers(editor, { 'app.message.copy': () => copy.push(true) });
  editor.handleInput(CTRL_X);
  editor.handleInput('y');
  await settle();
  assert.equal(copy.length, 1);
  // Kitty-protocol encodings for the leader keys resolve through matchesKey.
  editor.handleInput(CTRL_X);
  editor.handleInput('\x1b[97;1:1u'); // kitty: press a
  await settle();
  editor.handleInput(CTRL_X);
  editor.handleInput('\x1b[119;1:1u'); // kitty: press w
  await settle();
  assert.equal(calls.openAgentPicker, 1);
  assert.equal(calls.openWorkers, 1);
});

test('leader m opens the native model picker with legacy and Kitty keys; plain m still types', () => {
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub());
  let selections = 0;
  installNativeHandlers(editor, { 'app.model.select': () => selections++ });
  editor.handleInput('m');
  assert.equal(editor.getText(), 'm');
  assert.equal(selections, 0);
  for (const key of ['m', '\x1b[109;1:1u']) {
    editor.handleInput(CTRL_X);
    editor.handleInput(key);
    assert.equal(editor.isLeaderArmed, false);
    assert.equal(editor.getText(), 'm');
  }
  assert.equal(selections, 2);
  assert.ok(LEADER_HINT.includes('m'));
});

test('leader m falls back to typing when the native model-picker handler is absent', () => {
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub());
  editor.handleInput(CTRL_X);
  editor.handleInput('m');
  assert.equal(editor.getText(), 'm');
  assert.equal(editor.isLeaderArmed, false);
});

test('escape cancels the leader without aborting the agent', () => {
  const { calls, actions } = countingActions();
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub(), { actions });
  const interrupt = [];
  installNativeHandlers(editor, { 'app.interrupt': () => interrupt.push(true) });
  editor.handleInput(CTRL_X);
  editor.handleInput(ESCAPE);
  assert.ok(!editor.isLeaderArmed);
  assert.equal(interrupt.length, 0);
  // Unarmed escape still reaches the native interrupt handler.
  editor.handleInput(ESCAPE);
  assert.equal(interrupt.length, 1);
});

test('unmatched leader keys disarm and fall through normally', async () => {
  const { calls, actions } = countingActions();
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub(), { actions });
  const expand = [];
  installNativeHandlers(editor, { 'app.tools.expand': () => expand.push(true) });
  editor.handleInput(CTRL_X);
  editor.handleInput('q');
  assert.ok(!editor.isLeaderArmed);
  assert.equal(editor.getText(), 'q');
  // Control keys fall through to their native handlers after disarming.
  editor.handleInput(CTRL_X);
  editor.handleInput('\x0f');
  assert.ok(!editor.isLeaderArmed);
  assert.equal(expand.length, 1);
  // Extension shortcut aliases still pass through while armed (kitty
  // encoding for ctrl+shift+a) via the default onExtensionShortcut wiring.
  editor.onExtensionShortcut = (data) => { if (matchesKey(data, 'ctrl+shift+a')) { calls.cycleAgents++; return true; } return false; };
  editor.handleInput(CTRL_X);
  editor.handleInput('\x1b[97;6u');
  assert.ok(!editor.isLeaderArmed);
  await settle();
  assert.equal(calls.cycleAgents, 1);
});

test('plain typing passes through untouched while unarmed', () => {
  const { calls, actions } = countingActions();
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub(), { actions });
  editor.handleInput('h');
  editor.handleInput('i');
  assert.equal(editor.getText(), 'hi');
  assert.equal(calls.cycleAgents, 0);
});

test('leader hint is visible only while armed and stays within width', () => {
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub(), {
    hintStyle: hint => `<${hint}>`,
  });
  const plain = editor.render(80).join('\n');
  assert.ok(!plain.includes(LEADER_HINT.trim()));
  editor.handleInput(CTRL_X);
  const armed = editor.render(80);
  assert.ok(stripTerminalSequences(armed.join('\n')).includes(`<${LEADER_HINT}>`));
  for (const line of armed) assert.ok(visibleWidth(line) <= 80);
  editor.handleInput('t');
  assert.ok(!editor.render(80).join('\n').includes(LEADER_HINT.trim()));
});

test('leader times out, rearms on repeat ctrl+x, and disarms on blur', () => {
  const mock = test.mock;
  const { calls, actions } = countingActions();
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub(), { actions });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    editor.handleInput(CTRL_X);
    assert.ok(editor.isLeaderArmed);
    mock.timers.tick(1500);
    editor.handleInput(CTRL_X); // rearm restarts the timer
    mock.timers.tick(1500);
    assert.ok(editor.isLeaderArmed);
    mock.timers.tick(500);
    assert.ok(!editor.isLeaderArmed);
    // After a timeout the next key is ordinary input again.
    editor.handleInput('t');
    assert.equal(editor.getText(), 't');
    // Blur clears an armed leader.
    editor.handleInput(CTRL_X);
    assert.ok(editor.isLeaderArmed);
    editor.focused = false;
    assert.ok(!editor.isLeaderArmed);
    assert.equal(calls.cycleAgents, 0);
  } finally {
    mock.timers.reset();
  }
});

test('leader timeout matches the documented 2000ms window', () => {
  const mock = test.mock;
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub());
  assert.equal(LEADER_TIMEOUT_MS, 2000);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    editor.handleInput(CTRL_X);
    mock.timers.tick(1999);
    assert.ok(editor.isLeaderArmed);
    mock.timers.tick(1);
    assert.ok(!editor.isLeaderArmed);
  } finally {
    mock.timers.reset();
  }
});


test('installShortcuts replaces its own factory and skips foreign ones with a warning', async () => {
  const pi = fakePi();
  // A foreign extension owns the editor: skip gracefully instead of
  // constructing and leaking its editor or clobbering its behavior.
  const foreignCalls = [];
  const foreign = (tui, theme, keybindings) => {
    foreignCalls.push([tui, theme, keybindings]);
    const base = new CustomEditor(tui, theme, keybindings);
    base.actionHandlers.set('app.models.save', () => foreignCalls.push('save'));
    return base;
  };
  const ui = fakeUi([foreign]);
  const ctx = { mode: 'tui', ui };
  installShortcuts(pi, { cycleAgents() {}, openAgentPicker() {}, openWorkers() {} });
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  // No second factory installed, and the foreign factory was never invoked
  // (a discarded instance would leak any state it holds).
  assert.equal(ui.factories.length, 1);
  assert.equal(foreignCalls.length, 0);
  assert.ok(ui.notified.some(([message, kind]) => kind === 'warning' && message.includes('shortcuts not installed')));

  // A branded factory (our own earlier install after /reload) is replaced.
  let brandedCalls = 0;
  const branded = (tui, theme, keybindings) => {
    brandedCalls++;
    return new CustomEditor(tui, theme, keybindings);
  };
  Object.defineProperty(branded, EDITOR_FACTORY_BRAND, { value: true });
  ui.factories.length = 0;
  ui.factories.push(branded);
  await pi.emit('session_start', { reason: 'reload' }, ctx);
  assert.equal(ui.factories.length, 2); // foreign factory + our replacement
  assert.equal(brandedCalls, 0);
  const replacement = ui.factories[1](tuiStub(), themeStub, keybindingsStub());
  assert.ok(replacement instanceof PiastraEditor);
});

test('ctrl+o invokes toggleTools when it synchronously claims the toggle', async () => {
  const { calls, actions } = countingActions({
    toggleTools: (ctx) => { calls.toggleTools++; return ctx.claim === true; },
  });
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub(), { actions, ctx: { claim: true } });
  const expand = [];
  installNativeHandlers(editor, { 'app.tools.expand': () => expand.push(true) });
  editor.handleInput('\x0f'); // ctrl+o
  assert.equal(calls.toggleTools, 1);
  assert.equal(expand.length, 0);
  assert.equal(editor.getText(), '');
});

test('ctrl+o falls back to native app.tools.expand when unhandled or absent', async () => {
  const { calls, actions } = countingActions({
    toggleTools: (ctx) => { calls.toggleTools++; return ctx.claim === true; },
  });
  const expand = [];
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub(), { actions, ctx: { claim: false } });
  installNativeHandlers(editor, { 'app.tools.expand': () => expand.push(true) });
  editor.handleInput('\x0f');
  assert.equal(calls.toggleTools, 1);
  assert.equal(expand.length, 1);

  // Without the native handler, the key falls back to ordinary input handling.
  const bare = new PiastraEditor(tuiStub(), themeStub, keybindingsStub(), { actions, ctx: { claim: false } });
  bare.handleInput('\x0f');
  assert.equal(calls.toggleTools, 2);
  assert.equal(bare.getText(), '');

  // No toggleTools action at all → straight to the native handler.
  const nativeOnly = new PiastraEditor(tuiStub(), themeStub, keybindingsStub());
  const expandOnly = [];
  installNativeHandlers(nativeOnly, { 'app.tools.expand': () => expandOnly.push(true) });
  nativeOnly.handleInput('\x0f');
  assert.equal(expandOnly.length, 1);
});

test('toggleTools throwing reports via onActionError and falls back natively', async () => {
  const errors = [];
  const expand = [];
  const editor = new PiastraEditor(tuiStub(), themeStub, keybindingsStub(), {
    actions: { toggleTools: () => { throw new Error('boom'); } },
    onActionError: (error) => { errors.push(error); },
  });
  installNativeHandlers(editor, { 'app.tools.expand': () => expand.push(true) });
  editor.handleInput('\x0f');
  assert.equal(errors.length, 1);
  assert.equal(expand.length, 1);
});

test('installShortcuts wires ctrl+o through the piastra:compact-transcript:toggle event bus', async () => {
  const pi = fakePi();
  const ui = fakeUi();
  const ctx = { mode: 'tui', ui };
  const emitted = [];
  const { actions } = countingActions();
  // Simulate the compact-transcript plugin claiming only when asked to.
  let claim = false;
  pi.events = {
    on() {},
    emit(channel, envelope) {
      emitted.push([channel, envelope]);
      if (claim) envelope.handled = true;
    },
  };
  installShortcuts(pi, actions);
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  const editor = ui.factories[0](tuiStub(), themeStub, keybindingsStub());
  const expand = [];
  installNativeHandlers(editor, { 'app.tools.expand': () => expand.push(true) });

  // Unhandled: envelope stays handled:false, native handler runs.
  editor.handleInput('\x0f');
  assert.equal(emitted.length, 1);
  const [channel, envelope] = emitted[0];
  assert.equal(channel, 'piastra:compact-transcript:toggle');
  assert.equal(envelope.handled, false);
  assert.equal(envelope.ctx, ctx);
  assert.equal(expand.length, 1);

  // Handled: the plugin flips the envelope synchronously inside emit, so the
  // native handler is not invoked and nothing leaks into the editor text.
  claim = true;
  editor.handleInput('\x0f');
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1][1].handled, true);
  assert.equal(expand.length, 1);
  assert.equal(editor.getText(), '');
});

test('installShortcuts tolerates a missing event bus and falls back natively', async () => {
  const ui = fakeUi();
  const ctx = { mode: 'tui', ui };
  const pi = fakePi();
  delete pi.events;
  installShortcuts(pi, { cycleAgents() {}, openAgentPicker() {}, openWorkers() {} });
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  const editor = ui.factories[0](tuiStub(), themeStub, keybindingsStub());
  const expand = [];
  installNativeHandlers(editor, { 'app.tools.expand': () => expand.push(true) });
  editor.handleInput('\x0f');
  assert.equal(expand.length, 1);
});

test('installShortcuts skips installation outside interactive mode and disarms on shutdown', async () => {
  const pi = fakePi();
  const rpcUi = fakeUi();
  await pi.emit('session_start', { reason: 'startup' }, { mode: 'rpc', ui: rpcUi });
  assert.equal(rpcUi.factories.length, 0);

  const ui = fakeUi();
  const ctx = { mode: 'tui', ui };
  installShortcuts(pi, { cycleAgents() {}, openAgentPicker() {}, openWorkers() {} });
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  const editor = ui.factories[0](tuiStub(), themeStub, keybindingsStub());
  editor.handleInput(CTRL_X);
  assert.ok(editor.isLeaderArmed);
  await pi.emit('session_shutdown', { reason: 'quit' }, ctx);
  assert.ok(!editor.isLeaderArmed);
});
