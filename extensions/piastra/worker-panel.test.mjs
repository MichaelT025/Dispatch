import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { WIDGET_KEY, createWorkerPanel, formatElapsed, renderSubagentPanel, spinnerFrame } from './worker-panel.ts';

// Test harness: a ctx whose ui mock records setWidget calls and exposes the
// mounted factory's component for direct render inspection.
function makeHarness({ mode = 'tui', themeName = 'dark' } = {}) {
  const widgetCalls = [];
  const state = { renders: 0 };
  const tui = { requestRender: () => { state.renders += 1; } };
  const component = { current: undefined };
  const theme = { fg: (_style, text) => text };
  const ctx = {
    mode,
    ui: {
      theme,
      setWidget(key, content, options) {
        widgetCalls.push({ key, content, options });
        component.current = content ? content(tui, theme) : undefined;
      },
    },
  };
  component.render = (width = 80) => component.current ? component.current.render(width) : [];
  return { ctx, tui, widgetCalls, component, state, themeName };
}

const worker = (id, toolCallId, role, status, started = Date.now() - 5000, ended) =>
  ({ id, toolCallId, role, status, task: `SECRET-TASK-${id} with \x1b[31mANSI`, model: 'test/model', activity: 'SECRET-ACTIVITY', started, ...(ended ? { ended } : {}) });

test('pure renderer: icons, role names, timers and width-safe tree layout', () => {
  const rows = [
    { role: 'general', status: 'running', started: 1000, ended: undefined },
    { role: 'fast', status: 'completed', started: 1000, ended: 4000 },
    { role: 'review', status: 'failed', started: 1000, ended: 5000 },
    { role: 'review', status: 'cancelled', started: 1000, ended: 5000 },
    { role: 'general', status: 'interrupted', started: 1000, ended: 5000 },
  ];
  const plain = renderSubagentPanel(rows, { fg: (_style, text) => text }, 80, { spinnerFrame: 3, now: 6000, runOpen: true });
  // Finished counts every terminal status; only a trailing blank, no blank after heading.
  assert.deepEqual(plain, [
    '● Subagents (4/5)',
    '├─ ⠸ general 5s',
    '├─ ✓ fast 3s',
    '├─ ✗ review 4s',
    '├─ ⊘ review 4s',
    '└─ ⏹ general 4s',
    '',
  ]);
  // Styling: accent spinner, success/error glyphs, per-role colors.
  const styled = renderSubagentPanel(rows, { fg: (style, text) => `[${style}]${text}` }, 80, { spinnerFrame: 3, now: 6000, runOpen: true });
  assert.match(styled[0], /^\[accent\]●/);
  assert.match(styled[1], /\[accent\]⠸ \[warning\]general/);
  assert.match(styled[2], /\[success\]✓ \[thinkingMedium\]fast/);
  assert.match(styled[3], /\[error\]✗ \[success\]review/);
  assert.match(styled[4], /\[error\]⊘/);
  assert.match(styled[5], /\[error\]⏹/);
  // Settled run renders the hollow heading dot.
  const idle = renderSubagentPanel([{ role: 'general', status: 'completed', started: 1000, ended: 2000 }], { fg: (_style, text) => text }, 80, { runOpen: false });
  assert.match(idle[0], /○ Subagents \(1\/1\)/);
  // spinnerFrame wraps and stays in range.
  assert.equal(spinnerFrame(0), spinnerFrame(10));
  assert.equal(spinnerFrame(-1), '⠏');
  assert.equal(formatElapsed(59000), '59s');
  assert.equal(formatElapsed(65000), '1m05s');
});

test('renderer sanitizes injected roles and fits every line to width', () => {
  const rows = [{ role: '\x1b[31mgene\x07ral\u0007', status: 'running', started: 0 }];
  const lines = renderSubagentPanel(rows, { fg: (_style, text) => text }, 40, { spinnerFrame: 0, now: 3000, runOpen: true });
  const plain = lines.map(stripTerminalSequences).join('\n');
  assert.doesNotMatch(plain, /\x1b\[31m|\x07|\u0007/);
  assert.match(plain, /general/);
  // Newlines/tabs are stripped by clean as well.
  const dirty = renderSubagentPanel([{ role: 'a\nb\tc\rd', status: 'running', started: 0 }], { fg: (_style, text) => text }, 40, { spinnerFrame: 0, now: 3000, runOpen: true });
  for (const line of dirty) {
    assert.ok(!line.includes('\n') || stripTerminalSequences(line).includes('\n') === false);
    assert.ok(!line.includes('\t'), `tab leaked: ${JSON.stringify(line)}`);
  }
  assert.match(dirty.map(stripTerminalSequences).join('\n'), /abcd/);
  // Zero width or zero rows renders nothing (no blank spacer).
  assert.deepEqual(renderSubagentPanel(rows, { fg: (_style, text) => text }, 0, { spinnerFrame: 0, now: 3000, runOpen: true }), []);
  assert.deepEqual(renderSubagentPanel([], { fg: (_style, text) => text }, 80, { runOpen: true }), []);
  // Even at tiny widths nothing exceeds the width and nothing throws.
  const narrow = renderSubagentPanel(rows, { fg: (_style, text) => text }, 5, { spinnerFrame: 0, now: 3000, runOpen: true });
  for (const line of narrow) assert.ok(visibleWidth(line) <= 5, `line too wide: ${line}`);
});

test('run filtering: only current-run toolCallIds, no restored history, retries keep the run', () => {
  const h = makeHarness();
  const views = new Map();
  const panel = createWorkerPanel(views);
  try {
    panel.bind(h.ctx);
    // Restored history exists before any run: never rendered.
    views.set(9, { worker: worker(9, 'history-1', 'general', 'completed', 1000, 2000) });
    panel.publish();
    assert.equal(h.widgetCalls.length, 0);
    assert.deepEqual(h.component.render(), []);

    panel.beginRun(true);
    panel.addCall('call-a');
    panel.addCall('call-b');
    // Retried agent runs emit extra agent_start: beginRun must not reset.
    panel.beginRun(true);
    views.set(1, { worker: worker(1, 'call-a', 'general', 'running') });
    views.set(2, { worker: worker(2, 'call-b', 'fast', 'completed', 1000, 3000) });
    views.set(3, { worker: worker(3, 'history-1', 'review', 'failed', 1000, 4000) });
    panel.publish();
    const text = h.component.render().map(stripTerminalSequences).join('\n');
    assert.match(text, /Subagents \(1\/2\)/);
    assert.match(text, /general/);
    assert.doesNotMatch(text, /history-1|SECRET/);
    assert.ok(!text.includes('review'), 'history worker leaked into the panel');

    // Workers appear only once addCall whitelisted their call.
    views.set(4, { worker: worker(4, 'call-c', 'review', 'starting') });
    panel.publish();
    assert.doesNotMatch(h.component.render().map(stripTerminalSequences).join('\n'), /review/);
    panel.addCall('call-c');
    panel.publish();
    assert.match(h.component.render().map(stripTerminalSequences).join('\n'), /Subagents \(1\/3\)/);
  } finally { panel.dispose(); }
});

test('multiple batches and lifecycle: lazy mount, updates, reset and rebind', () => {
  const h = makeHarness();
  const views = new Map();
  const panel = createWorkerPanel(views);
  try {
    panel.bind(h.ctx);
    panel.beginRun(true);
    panel.addCall('r1');
    views.set(1, { worker: worker(1, 'r1', 'general', 'running') });
    panel.publish();
    // Mount happens once, lazily, on the first visible publish.
    assert.equal(h.widgetCalls.length, 1);
    assert.equal(h.widgetCalls[0].key, WIDGET_KEY);
    assert.equal(h.widgetCalls[0].options?.placement, 'aboveEditor');
    assert.equal(typeof h.widgetCalls[0].content, 'function');

    const firstFrame = h.component.render().map(stripTerminalSequences).join('\n');
    assert.match(firstFrame, new RegExp(`[├└]─ ${spinnerFrame(1)} general \\d+s`));
    // No blank line after the heading: heading, row, trailing blank.
    const firstLines = h.component.render().map(stripTerminalSequences);
    assert.equal(firstLines.length, 3);
    assert.match(firstLines[0], /Subagents \(0\/1\)/);
    assert.match(firstLines[1], /general/);
    assert.equal(firstLines[2], '');
    // Changed content → exactly one extra repaint request.
    views.get(1).worker.status = 'completed';
    views.get(1).worker.ended = Date.now();
    panel.publish();
    const settled = h.component.render().map(stripTerminalSequences).join('\n');
    assert.match(settled, /○ Subagents \(1\/1\)/);
    assert.match(settled, /✓ general/);
    const rendersAfterChange = h.state.renders;
    // Unchanged panel: further publish ticks must not request repaints.
    panel.publish(); panel.publish();
    assert.equal(h.state.renders, rendersAfterChange);

    // Completed rows survive agent_settled until the next run.
    panel.endRun();
    assert.match(h.component.render().map(stripTerminalSequences).join('\n'), /✓ general/);
    assert.equal(h.widgetCalls.length, 1);

    // New run with no delegates unmounts instead of leaving a blank spacer.
    panel.beginRun(true);
    assert.deepEqual(h.component.render(), []);
    assert.equal(h.widgetCalls.at(-1).key, WIDGET_KEY);
    assert.equal(h.widgetCalls.at(-1).content, undefined);
    views.clear();
    views.set(2, { worker: worker(2, 'r2', 'fast', 'running') });
    panel.publish();
    assert.doesNotMatch(h.component.render().map(stripTerminalSequences).join('\n'), /general/);

    // Session-boundary reset unregisters the widget.
    panel.reset();
    assert.equal(h.widgetCalls.at(-1).key, WIDGET_KEY);
    assert.equal(h.widgetCalls.at(-1).content, undefined);
    // Rebind mounts again on the new session.
    const h2 = makeHarness();
    const panel2 = createWorkerPanel(views);
    panel2.bind(h2.ctx);
    panel2.beginRun(true);
    panel2.addCall('r3');
    views.set(3, { worker: worker(3, 'r3', 'review', 'running') });
    panel2.publish();
    assert.match(h2.component.render().map(stripTerminalSequences).join('\n'), /review/);
    panel2.dispose();
  } finally { panel.dispose(); }
});

test('ended timers freeze and rows stay after settle until reset', () => {
  const h = makeHarness();
  const views = new Map();
  const panel = createWorkerPanel(views);
  try {
    panel.bind(h.ctx);
    panel.beginRun(true);
    panel.addCall('r1');
    views.set(1, { worker: worker(1, 'r1', 'general', 'running', 1000) });
    panel.publish();
    // endRun marks still-active rows interrupted with ended=frozenAt.
    panel.endRun();
    const frozen = h.component.render().map(stripTerminalSequences).join('\n');
    assert.match(frozen, /○ Subagents \(1\/1\)/);
    assert.match(frozen, /[├└]─ ⏹ general \d+(?:m\d+)?s/);
    assert.doesNotMatch(frozen, /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/);
    const elapsed = frozen.match(/general (\d+(?:m\d+)?s)/)[1];
    const rendersBefore = h.state.renders;
    panel.publish(); panel.publish();
    assert.equal(h.state.renders, rendersBefore);
    assert.equal(h.component.render().map(stripTerminalSequences).join('\n').match(/general (\d+(?:m\d+)?s)/)[1], elapsed);
    // A spinner frame must not advance once the run ended.
    assert.equal(h.component.render().map(stripTerminalSequences).join('\n'), frozen);
  } finally { panel.dispose(); }
});

test('bounded output: capped rows keep overflow marker and full state', () => {
  const h = makeHarness();
  const views = new Map();
  const panel = createWorkerPanel(views);
  try {
    panel.bind(h.ctx);
    panel.beginRun(true);
    panel.addCall('batch');
    for (let id = 1; id <= 15; id++) views.set(id, { worker: worker(id, 'batch', 'general', 'running', 1000) });
    panel.publish();
    const lines = h.component.render();
    // 12 content lines budget: heading + 10 rows + overflow, plus trailing blank.
    assert.equal(lines.length, 13);
    const plain = lines.map(stripTerminalSequences);
    assert.match(plain[0], /● Subagents \(0\/15\)/);
    assert.match(plain[1], /^├─/);
    assert.match(plain.at(-2), /\+5 more · \/workers/);
    assert.match(plain.at(-1), /^$/);
    // Active workers are never silently dropped.
    assert.equal(plain.slice(1, -1).filter(Boolean).length, 11);
    assert.equal(plain.slice(1, -2).length, 10);
    // All state retained even while display is capped.
    const views2 = new Map();
    for (let id = 1; id <= 15; id++) views2.set(id, { worker: worker(id, 'batch', 'general', 'completed', 1000, 2000) });
    const capped = createWorkerPanel(views2);
    const h2 = makeHarness();
    capped.bind(h2.ctx);
    capped.beginRun(true);
    capped.addCall('batch');
    capped.publish();
    const settledLines = h2.component.render();
    assert.equal(settledLines.length, 13);
    assert.match(settledLines.map(stripTerminalSequences).join('\n'), /Subagents \(15\/15\)/);
    assert.match(settledLines.map(stripTerminalSequences).at(-2), /\+5 more/);
    capped.dispose();
  } finally { panel.dispose(); }
});

test('empty state and non-TUI modes never mount or throw', () => {
  const h = makeHarness();
  const panel = createWorkerPanel(new Map());
  try {
    panel.bind(h.ctx);
    panel.beginRun(true);
    panel.addCall('c');
    panel.publish();
    assert.equal(h.widgetCalls.length, 0);
    panel.endRun();
    // Non-TUI ctx (RPC/print mode): panel stays hidden and never mounts.
    const rpc = makeHarness({ mode: 'rpc' });
    const views = new Map([[1, { worker: worker(1, 'c', 'general', 'running') }]]);
    const panel2 = createWorkerPanel(views);
    panel2.bind(rpc.ctx);
    panel2.beginRun(true);
    panel2.addCall('c');
    panel2.publish();
    assert.equal(rpc.widgetCalls.length, 0);
    panel2.endRun();
    panel2.reset();
    // Missing ui object is also safe.
    const panel3 = createWorkerPanel(views);
    panel3.bind({ mode: 'tui' });
    panel3.beginRun(true);
    panel3.publish();
    panel3.endRun();
    panel3.dispose();
  } finally { panel.dispose(); }
});

test('no callbacks after dispose', () => {
  const h = makeHarness();
  const views = new Map();
  const panel = createWorkerPanel(views);
  panel.bind(h.ctx);
  panel.beginRun(true);
  panel.addCall('c');
  views.set(1, { worker: worker(1, 'c', 'general', 'running') });
  panel.publish();
  assert.equal(h.widgetCalls.length, 1);
  panel.dispose();
  const mountedCalls = h.widgetCalls.length;
  const renders = h.state.renders;
  panel.beginRun(true);
  panel.addCall('c2');
  views.set(2, { worker: worker(2, 'c2', 'fast', 'running') });
  panel.publish();
  panel.endRun();
  panel.reset();
  assert.equal(h.widgetCalls.length, mountedCalls);
  assert.equal(h.state.renders, renders);
  // Dispose twice is safe, and the widget was unregistered exactly once.
  panel.dispose();
  const unregister = h.widgetCalls.filter(call => call.content === undefined);
  assert.equal(unregister.length, 1);
});

test('new run with no delegates unregisters the widget', () => {
  const h = makeHarness();
  const views = new Map();
  const panel = createWorkerPanel(views);
  try {
    panel.bind(h.ctx);
    panel.beginRun(true);
    panel.addCall('a');
    views.set(1, { worker: worker(1, 'a', 'general', 'running') });
    panel.publish();
    assert.equal(h.widgetCalls.length, 1);
    assert.ok(h.component.render().length > 0);
    // Settle, then start the next run with no delegates: old widget must go away.
    panel.endRun();
    assert.equal(h.widgetCalls.length, 1);
    panel.beginRun(true);
    assert.deepEqual(h.component.render(), []);
    assert.equal(h.widgetCalls.at(-1).key, WIDGET_KEY);
    assert.equal(h.widgetCalls.at(-1).content, undefined);
    // A publish with still no whitelisted workers must not remount a spacer.
    const callsAfterBegin = h.widgetCalls.length;
    panel.publish();
    assert.deepEqual(h.component.render(), []);
    assert.equal(h.widgetCalls.length, callsAfterBegin);
  } finally { panel.dispose(); }
});

test('retried beginRun mid-run never resets the whitelist', () => {
  const h = makeHarness();
  const views = new Map();
  const panel = createWorkerPanel(views);
  try {
    panel.bind(h.ctx);
    panel.beginRun(true);
    panel.addCall('a');
    views.set(1, { worker: worker(1, 'a', 'general', 'running', 1000) });
    panel.publish();
    assert.match(h.component.render().map(stripTerminalSequences).join('\n'), /general/);
    // Retry emits a second beginRun while still open: must be a no-op.
    panel.beginRun(true);
    views.set(2, { worker: worker(2, 'b', 'fast', 'running', 1000) });
    panel.publish();
    // 'b' was never whitelisted and 'a' survived the retry.
    let text = h.component.render().map(stripTerminalSequences).join('\n');
    assert.match(text, /general/);
    assert.doesNotMatch(text, /fast/);
    assert.match(text, /Subagents \(0\/1\)/);
    panel.addCall('b');
    panel.publish();
    text = h.component.render().map(stripTerminalSequences).join('\n');
    assert.match(text, /general/);
    assert.match(text, /fast/);
    assert.match(text, /Subagents \(0\/2\)/);
  } finally { panel.dispose(); }
});

test('settled panel repaints when the role changes', () => {
  const h = makeHarness();
  const views = new Map([[1, { worker: worker(1, 'c', 'general', 'completed', 1000, 2000) }]]);
  const panel = createWorkerPanel(views);
  try {
    panel.bind(h.ctx);
    panel.beginRun(true);
    panel.addCall('c');
    panel.publish();
    assert.match(h.component.render().map(stripTerminalSequences).join('\n'), /general/);
    const rendersAfterMount = h.state.renders;
    // Identical publish: no repaint.
    panel.publish();
    assert.equal(h.state.renders, rendersAfterMount);
    // Role-only change on a completed row must repaint.
    views.get(1).worker.role = 'fast';
    panel.publish();
    assert.equal(h.state.renders, rendersAfterMount + 1);
    assert.match(h.component.render().map(stripTerminalSequences).join('\n'), /fast/);
    // Stable again: no further repaints.
    const afterRole = h.state.renders;
    panel.publish();
    assert.equal(h.state.renders, afterRole);
  } finally { panel.dispose(); }
});

test('old component and factory stay inert after reset and rebind', () => {
  const h = makeHarness();
  const views = new Map();
  const panel = createWorkerPanel(views);
  try {
    panel.bind(h.ctx);
    panel.beginRun(true);
    panel.addCall('c');
    views.set(1, { worker: worker(1, 'c', 'general', 'running') });
    panel.publish();
    const oldFactory = h.widgetCalls[0].content;
    const oldComponent = h.component.current;
    assert.ok(oldComponent.render(80).length > 0);
    // After reset the retained component and factory render nothing.
    panel.reset();
    assert.deepEqual(oldComponent.render(80), []);
    assert.deepEqual(oldFactory(h.tui, h.ctx.ui.theme).render(80), []);
    // Old factory must not rebind tui: a spy tui stays quiet.
    const spy = { renders: 0, requestRender() { this.renders += 1; } };
    const dummy = oldFactory(spy, h.ctx.ui.theme);
    assert.deepEqual(dummy.render(80), []);
    panel.beginRun(true);
    panel.addCall('c2');
    views.set(2, { worker: worker(2, 'c2', 'fast', 'completed', 1000, 2000) });
    panel.publish();
    assert.equal(spy.renders, 0);
    assert.match(h.component.render().map(stripTerminalSequences).join('\n'), /fast/);
    assert.deepEqual(oldComponent.render(80), []);
    // Rebind to a new ui: previous generation stays inert too.
    const h2 = makeHarness();
    const factoryBeforeRebind = h.widgetCalls.at(-1).content;
    const componentBeforeRebind = h.component.current;
    panel.bind(h2.ctx);
    assert.deepEqual(componentBeforeRebind.render(80), []);
    assert.deepEqual(factoryBeforeRebind(h.tui, h.ctx.ui.theme).render(80), []);
    assert.equal(h2.widgetCalls.length, 0);
  } finally { panel.dispose(); }
});

test('foreign widgets are never unmounted', () => {
  const live = new Map();
  const widgetCalls = [];
  const state = { renders: 0 };
  const tui = { requestRender: () => { state.renders += 1; } };
  const theme = { fg: (_style, text) => text };
  let current;
  const ctx = {
    mode: 'tui',
    ui: {
      theme,
      setWidget(key, content, options) {
        widgetCalls.push({ key, content, options });
        if (content === undefined) live.delete(key);
        else {
          live.set(key, content);
          if (key === WIDGET_KEY) current = content(tui, theme);
        }
      },
    },
  };
  const views = new Map();
  const panel = createWorkerPanel(views);
  try {
    panel.bind(ctx);
    panel.beginRun(true);
    panel.addCall('c');
    views.set(1, { worker: worker(1, 'c', 'general', 'running') });
    panel.publish();
    assert.ok(live.has(WIDGET_KEY));
    ctx.ui.setWidget('foreign:widget', () => ({ render: () => ['x'], invalidate() {} }));
    assert.ok(live.has('foreign:widget'));
    panel.reset();
    assert.ok(!live.has(WIDGET_KEY));
    assert.ok(live.has('foreign:widget'), 'reset cleared a foreign widget');
    assert.ok(widgetCalls.every((call) => call.key !== 'foreign:widget' || call.content !== undefined));
  } finally { panel.dispose(); }
});

test('throwing setWidget is swallowed and retried on next publish', () => {
  const widgetCalls = [];
  const state = { renders: 0 };
  const tui = { requestRender: () => { state.renders += 1; } };
  const theme = { fg: (_style, text) => text };
  const component = { current: undefined };
  let failMount = true;
  const ctx = {
    mode: 'tui',
    ui: {
      theme,
      setWidget(key, content, options) {
        widgetCalls.push({ key, content, options });
        if (key === WIDGET_KEY && content !== undefined && failMount) {
          failMount = false;
          throw new Error('mount boom');
        }
        component.current = content ? content(tui, theme) : undefined;
      },
    },
  };
  component.render = (width = 80) => component.current ? component.current.render(width) : [];
  const views = new Map();
  const panel = createWorkerPanel(views);
  try {
    panel.bind(ctx);
    panel.beginRun(true);
    panel.addCall('c');
    views.set(1, { worker: worker(1, 'c', 'general', 'running') });
    assert.doesNotThrow(() => panel.publish());
    // First mount threw: nothing mounted yet.
    assert.deepEqual(component.render(), []);
    // Next publish retries and mounts.
    assert.doesNotThrow(() => panel.publish());
    assert.ok(component.render().length > 0);
    assert.match(component.render().map(stripTerminalSequences).join('\n'), /general/);
  } finally { panel.dispose(); }
});

test('rebind to a new context cleans up the original ui first', () => {
  const h1 = makeHarness();
  const h2 = makeHarness();
  const views = new Map();
  const panel = createWorkerPanel(views);
  try {
    panel.bind(h1.ctx);
    panel.beginRun(true);
    panel.addCall('a');
    views.set(1, { worker: worker(1, 'a', 'general', 'running') });
    panel.publish();
    assert.equal(h1.widgetCalls.length, 1);
    // Rebind to a different ui object unmounts the old widget and clears the run.
    panel.bind(h2.ctx);
    assert.equal(h1.widgetCalls.at(-1).key, WIDGET_KEY);
    assert.equal(h1.widgetCalls.at(-1).content, undefined);
    assert.equal(h2.widgetCalls.length, 0);
    assert.deepEqual(h2.component.render(), []);
    // Old whitelist is gone: the same views are invisible until re-added.
    panel.publish();
    assert.deepEqual(h2.component.render(), []);
    assert.equal(h2.widgetCalls.length, 0);
    panel.beginRun(true);
    panel.addCall('a');
    panel.publish();
    assert.match(h2.component.render().map(stripTerminalSequences).join('\n'), /general/);
    // Original ui stays untouched after the move.
    assert.equal(h1.widgetCalls.filter((c) => c.content !== undefined).length, 1);
  } finally { panel.dispose(); }
});
