// Tests for the PiAstra vendored compact-transcript fork, exercising the real
// ToolExecutionComponent from @earendil-works/pi-coding-agent.
//
// Pre-start render: /resume and /reload rebuild chat BEFORE session_start.
// Run: node --experimental-strip-types --test extensions/pi-compact-transcript/compact-transcript.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import compactTranscript from './extensions/compact-transcript.ts';
import { initTheme } from '@earendil-works/pi-coding-agent';

// The real ToolExecutionComponent shells use pi's global theme singleton.
await initTheme();

const STATE_KEY = Symbol.for('pi-compact-transcript.state');
const state = globalThis[STATE_KEY];

const clean = value => stripTerminalSequences(String(value))
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
  .replace(/\u2506/g, '|').replace(/\u2500/g, '-')
  .trim();

// Neutral theme: colors resolve to the raw id so assertions see plain text.
const fakeTheme = {
  fg: (color, text) => `[${color}]${text}`,
  bg: (_color, text) => text,
  bold: text => text,
};

const COLUMNS = 120;
process.stdout.columns = COLUMNS;

// --- fake extension host -----------------------------------------------------

function createHost() {
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const entryRenderers = new Map();
  const eventListeners = new Map();
  const entries = [];
  // Mirrors pi's shared extension event bus: emit invokes handlers synchronously
  // during the call, so synchronous handled-flag mutations are observable.
  const events = {
    on: (channel, handler) => {
      eventListeners.get(channel)?.push(handler) ?? eventListeners.set(channel, [handler]);
      return () => eventListeners.set(channel, (eventListeners.get(channel) ?? []).filter(h => h !== handler));
    },
    emit: (channel, data) => {
      for (const handler of eventListeners.get(channel) ?? []) handler(data);
    },
  };
  const pi = {
    on: (event, handler) => {
      handlers.get(event)?.push(handler) ?? handlers.set(event, [handler]);
    },
    emit: async (event, payload, ctx) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload ?? {}, ctx);
    },
    events,
    registerCommand: (name, options) => commands.set(name, options),
    registerShortcut: (key, options) => shortcuts.set(key, options),
    registerEntryRenderer: (type, renderer) => entryRenderers.set(type, renderer),
    appendEntry: (type, data) => entries.push({ type, data }),
  };
  return { pi, events, commands, shortcuts, entries };
}

const TOGGLE_EVENT = 'piastra:compact-transcript:toggle';

// Emits the expansion-toggle event the way the PiAstra shortcuts editor does:
// the envelope is mutated synchronously; falls back to pi's native
// app.tools.expand handler unless the plugin claims the toggle by setting
// handled = true.
function emitToggle(host, ctx) {
  const envelope = { handled: false, ctx };
  host.events.emit(TOGGLE_EVENT, envelope);
  if (envelope.handled) return true;
  return 'native';
}

function createCtx({ branch = [], trusted = true } = {}) {
  const notifications = [];
  return {
    notifications,
    mode: 'tui',
    cwd: tmpdir(),
    ui: {
      theme: fakeTheme,
      notify: (message, level) => notifications.push({ message, level }),
      setWorkingMessage() {},
      setStatus() {},
    },
    sessionManager: { getBranch: () => branch },
    isProjectTrusted: () => trusted,
  };
}

// Isolated agent dir per test run so config persistence never touches the
// user's real ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), 'compact-transcript-test-'));

// --- component harness -------------------------------------------------------

const textResult = text => ({
  content: [{ type: 'text', text }],
  isError: false,
});

const ui = { requestRender() {} };

function makeTool(toolName, toolCallId, args, result, toolDefinition) {
  const component = new ToolExecutionComponent(toolName, toolCallId, args, { showImages: false }, toolDefinition, ui, tmpdir());
  if (result) component.updateResult(result, false);
  return component;
}

// A generic built-in-shaped tool definition: bounded result when collapsed,
// full details when expanded — mirrors pi's built-in tools.
const builtinToolDefinition = {
  renderCall: (args, theme) => ({
    render: width => [clean(`call ${args.kind}`)],
    invalidate() {},
  }),
  renderResult: (output, { expanded, isPartial }, theme) => {
    if (isPartial) {
      return { render: () => [clean('running…')], invalidate() {} };
    }
    const lines = String(output.content[0].text).split('\n');
    const shown = expanded ? lines : lines.slice(0, 3);
    return {
      render: width => shown.map(line => clean(line)),
      invalidate() {},
    };
  },
};

// Render helper that goes through the component's real render path.
function rendered(component, width = 120) {
  return component.render(width).map(clean);
}
function renderedText(component, width = 120) {
  return rendered(component, width).join('\n');
}

test('extension loads without a registered ctrl+o shortcut (reserved app.tools.expand) and uses the toggle event instead', () => {
  const host = createHost();
  compactTranscript(host.pi);
  // pi's extension runner reserves app.tools.expand (ctrl+o) and skips
  // extension shortcut overrides, so the plugin must not register one.
  assert.ok(!host.shortcuts.has('ctrl+o'), 'ctrl+o is reserved by the runner and must not be registered');
  assert.ok(host.events.on && host.events.emit, 'shared event bus must be pluggable');
  assert.ok(host.commands.has('compact-transcript'));
  assert.ok(state, 'global runtime state symbol must exist');
  state.currentTheme = fakeTheme;
});

test('delegate renders native rich output fully expanded, never compacted or grouped', async () => {
  const host = createHost();
  compactTranscript(host.pi);
  const ctx = createCtx();
  await host.pi.emit('session_start', { reason: 'startup' }, ctx);

  const delegateDefinition = {
    renderCall: (args, theme) => ({
      render: () => [clean(`PiAstra · ${args.tasks.length} workers in parallel`)],
      invalidate() {},
    }),
    renderResult: (output, { expanded }) => {
      const detail = expanded ? 'worker general · completed\nworker fast · completed\nworker review · completed' : 'workers done';
      return {
        render: width => [clean('=== ' + detail + ' ==='), ...output.content[0].text.split('\n').map(clean)],
        invalidate() {},
      };
    },
  };

  // Partial (streaming) and final states of the delegation call.
  const args = { tasks: [{ role: 'general', access: 'write', task: 'fix it' }] };
  const component = new ToolExecutionComponent('delegate', 'd1', args, { showImages: false }, delegateDefinition, ui, tmpdir());
  component.updateResult(textResult('partial progress'), true);
  component.updateResult(textResult('final worker summary'), false);

  const content = renderedText(component);
  // Multi-line native renderer content proves the expanded native path; a
  // compact line would be a single `◆ …` row.
  assert.match(content, /worker general S{0}·/);
  assert.match(content, /worker review/s);
  assert.match(content, /final worker summary/s);
  assert.doesNotMatch(content, /running/s, 'final state must not show the partial preview');
  assert.equal(state.toolsById.get('d1')?.burstCount, 1);
  assert.equal(state.hiddenToolIds.has('d1'), false);

  // Second delegate call must not be grouped into a burst with the first.
  const second = makeTool('delegate', 'd2', args, textResult('second'), delegateDefinition);
  assert.equal(second.expanded, true);
  assert.equal(state.toolsById.get('d2')?.burstCount, 1);
  assert.equal(state.hiddenToolIds.has('d1'), false);
  assert.ok(rendered(second).length > 0, 'delegate rows stay visible');

  // Explicit collapse requests (native or inherited pi state) cannot hide
  // the delegate's expanded render.
  second.setExpanded(false);
  const replay = renderedText(second);
  assert.match(replay, /second/s);
  assert.equal(second.expanded, true);
});

test('ordinary tools (inspect_git, grep, bash) compact while global setting is enabled', async () => {
  const host = createHost();
  compactTranscript(host.pi);
  const ctx = createCtx();
  state.currentTheme = fakeTheme;
  await host.pi.emit('session_start', { reason: 'startup' }, ctx);

  const bash = makeTool('bash', 'b1', { command: 'echo hi' }, textResult('hi'), builtinToolDefinition);
  const git = makeTool('inspect_git', 'g1', { operation: 'status' }, textResult('nothing to commit'), undefined);
  const grep = makeTool('grep', 'r1', { pattern: 'foo' }, textResult('3 matches'), undefined);
  for (const [component, id] of [[bash, 'b1'], [git, 'g1'], [grep, 'r1']]) {
    const line = renderedText(component);
    assert.equal(state.toolsById.get(id)?.burstCount, 1);
    assert.match(line, /\u25c6/s, 'compact status diamond expected while compact is enabled');
    assert.doesNotMatch(line, /running…|nothing to commit pane/s, 'compact line replaces the native result render');
  }
  assert.match(renderedText(bash), /\$ echo hi/s);
  assert.match(renderedText(git), /nothing to commit/s);
  assert.match(renderedText(grep), /foo/s);
});

test('neighboring bursts coalesce and failed tools keep their own visible row', async () => {
  const host = createHost();
  compactTranscript(host.pi);
  await host.pi.emit('session_start', { reason: 'startup' }, createCtx());

  const first = makeTool('grep', 'r10', { pattern: 'a' }, textResult('match one'), undefined);
  const second = makeTool('grep', 'r11', { pattern: 'b' }, textResult('match two'), undefined);
  assert.equal(state.toolsById.get('r11')?.burstCount, 2, 'same-tool repeats group into a burst');
  assert.equal(state.hiddenToolIds.has('r10'), true, 'burst members except the last are hidden');
  assert.deepEqual(rendered(first), [], 'hidden burst members render nothing');
  assert.match(renderedText(second), /match two/s);

  const failed = makeTool('bash', 'b9', { command: 'false' }, { ...textResult('boom'), isError: true }, undefined);
  assert.equal(state.hiddenToolIds.has('b9'), false, 'failures are always visible');
  assert.match(renderedText(failed), /boom/s);
  assert.equal(state.toolsById.get('b9')?.burstCount, 1);
});

test('toggle event round-trip: collapsed session start, deliberate expand and collapse with handled envelope', async () => {
  const host = createHost();
  compactTranscript(host.pi);
  const ctx = createCtx();
  await host.pi.emit('session_start', { reason: 'startup' }, ctx);
  state.currentTheme = fakeTheme;

  const run = async () => {
    const a = makeTool('bash', 'x1', { command: 'ls' }, textResult('file list\nsecond line\nthird'), builtinToolDefinition);
    const b = makeTool('grep', 'x2', { pattern: 'q' }, textResult('match'), undefined);
    return [a, b];
  };
  let [a, b] = await run();
  assert.equal(state.userExpansion, false);
  assert.match(renderedText(a), /\u25c6/s);

  assert.equal(emitToggle(host, ctx), true, 'enabled plugin claims the toggle with handled = true');
  assert.equal(state.userExpansion, true);
  assert.match(renderedText(a), /third/s, 'expanded native renderer shows full result');
  assert.equal(a.expanded, true);
  assert.equal(b.expanded, true);

  assert.equal(emitToggle(host, ctx), true);
  assert.equal(state.userExpansion, false);
  assert.match(renderedText(a), /\u25c6/s);
  assert.equal(a.expanded, false);

  // Fresh rows created after user expansion start expanded: mimicking pi,
  // which replays its own toolOutputExpanded field via setExpanded right
  // after constructing the row; the policy forces the plugin state.
  assert.equal(emitToggle(host, ctx), true);
  [a, b] = await run();
  a.setExpanded(false); // pi's unsynced native field value
  b.setExpanded(false);
  assert.equal(a.expanded, true);
  assert.match(renderedText(a), /second line/s);
});

test('session switch from expanded state: inherited pi expansion does not override collapsed mode, ctrl+o still works', async () => {
  const host = createHost();
  compactTranscript(host.pi);
  const ctx = createCtx();
  await host.pi.emit('session_start', { reason: 'startup' }, ctx);
  state.currentTheme = fakeTheme;

  let component = makeTool('bash', 's1', { command: 'ls' }, textResult('a\nb\nc\nd'), builtinToolDefinition);
  assert.equal(emitToggle(host, ctx), true);
  assert.equal(state.userExpansion, true);
  assert.match(renderedText(component), /d/s);

  // User resumes a different session in the same runtime: the plugin resets
  // its per-session expansion policy, and pi's inherited toolOutputExpanded=true
  // is replayed onto rebuilt components.
  await host.pi.emit('session_shutdown', { reason: 'resume' }, ctx);
  await host.pi.emit('session_start', { reason: 'resume', previousSessionFile: 'other.jsonl' }, createCtx());
  assert.equal(state.userExpansion, false, 'per-session initial collapsed state');
  assert.equal(state.toolComponents.size, 0, 'component registry of the previous session dropped');

  component = makeTool('bash', 's1', { command: 'ls' }, textResult('a\nb\nc\nd'), builtinToolDefinition);
  // Simulate pi replaying the inherited expanded state on rebuild:
  component.setExpanded(true);
  assert.equal(component.expanded, false, 'plugin expansion policy overrides inherited pi state');
  assert.match(renderedText(component), /\u25c6/s, 'rebuilt session renders collapsed');

  // Deliberate expansion still works after the switch via the toggle event.
  assert.equal(emitToggle(host, ctx), true);
  assert.equal(component.expanded, true);
  assert.match(renderedText(component), /d/s);
});

test('off mode leaves the toggle unhandled (native app.tools.expand fallback) and stops forcing expansion', async () => {
  const host = createHost();
  compactTranscript(host.pi);
  const ctx = createCtx();
  await host.pi.emit('session_start', { reason: 'startup' }, ctx);
  state.currentTheme = fakeTheme;

  // Turn compact off via the command.
  await host.commands.get('compact-transcript').handler('off', ctx);
  assert.equal(state.config.enabled, false);

  const component = makeTool('bash', 'o1', { command: 'ls' }, textResult('a\nb\nc\nd'), builtinToolDefinition);
  // With compact off the plugin does not intercept setExpanded: pi's own
  // expansion value passes through natively (native control works).
  component.setExpanded(true);
  assert.equal(component.expanded, true, 'native expanded control passes through when compact is off');
  assert.match(renderedText(component), /d/s);
  component.setExpanded(false);
  assert.equal(component.expanded, false, 'native collapsed control passes through when compact is off');

  // The plugin must leave the envelope unclaimed so the sender falls back to
  // the native app.tools.expand handler (ctrl+o).
  assert.equal(emitToggle(host, ctx), 'native', 'off mode must not claim the toggle event');
  assert.equal(state.userExpansion, false);
});

test('legacy session-branch config no longer overrides the persisted enabled state, other preferences still apply', async () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  writeFileSync(path.join(agentDir, 'compact-transcript.json'), JSON.stringify({ enabled: true, summaryStyle: 'quote' }), 'utf8');

  const host = createHost();
  compactTranscript(host.pi);
  const ctx = createCtx({
    branch: [
      { type: 'custom', customType: 'compact-transcript-config', data: { enabled: false, summaryStyle: 'plain', highlightToolActions: true } },
    ],
  });
  await host.pi.emit('session_start', { reason: 'resume' }, ctx);

  assert.equal(state.config.enabled, true, 'branch entries must not override the global enabled state');
  assert.equal(state.config.summaryStyle, 'plain', 'branch non-enabled preferences still merge');
  assert.equal(state.config.highlightToolActions, true, 'branch non-enabled preferences still merge');

  // Branch entries without other preferences fall back to the file config.
  await host.pi.emit('session_start', { reason: 'resume' }, createCtx({
    branch: [{ type: 'custom', customType: 'compact-transcript-config', data: { enabled: false } }],
  }));
  assert.equal(state.config.enabled, true);
  assert.equal(state.config.summaryStyle, 'quote', 'file preference applies when the branch lacks it');

  // Compact stays enabled for ordinary tools despite the branch override.
  const git = makeTool('inspect_git', 'cfg1', { operation: 'log' }, textResult('commit abc'), undefined);
  assert.match(renderedText(git), /\u25c6/s);
});

test('/compact-transcript persists the global setting across sessions and reloads idempotently', async () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const configPath = path.join(agentDir, 'compact-transcript.json');
  writeFileSync(configPath, JSON.stringify({ enabled: true, summaryStyle: 'quote' }), 'utf8');

  const host = createHost();
  compactTranscript(host.pi);
  const handler = host.commands.get('compact-transcript').handler;

  const ctxA = createCtx();
  await host.pi.emit('session_start', { reason: 'startup' }, ctxA);
  await handler('off', ctxA);
  let persisted = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(persisted.enabled, false, 'off writes the single global setting');
  assert.equal(persisted.summaryStyle, 'quote', 'unrelated fields in the config file survive');

  // New session / reload picks up the persisted value, even with legacy
  // branch entries present.
  const ctxB = createCtx({
    branch: [{ type: 'custom', customType: 'compact-transcript-config', data: { enabled: true } }],
  });
  await host.pi.emit('session_start', { reason: 'resume' }, ctxB);
  assert.equal(state.config.enabled, false);

  await handler('on', ctxB);
  persisted = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(persisted.enabled, true);

  // Reload idempotence: loading the extension twice re-installs patches that
  // wrap the ORIGINAL methods (via Symbol-persisted originals), never the
  // previous forked wrapper, so no stacking occurs across /reload.
  const proto = ToolExecutionComponent.prototype;
  const setExpandedKey = Symbol.for('pi-compact-transcript.set-expanded-patch');
  const toolPatchKey = Symbol.for('pi-compact-transcript.tool-patch');
  const originalSetExpanded = proto[setExpandedKey].originalSetExpanded;
  const originalUpdateDisplay = proto[toolPatchKey].originalUpdateDisplay;
  compactTranscript(host.pi);
  assert.equal(proto[setExpandedKey].originalSetExpanded, originalSetExpanded, 'setExpanded patch wraps the original method, not the previous wrapper');
  assert.equal(proto[toolPatchKey].originalUpdateDisplay, originalUpdateDisplay, 'updateDisplay patch wraps the original method, not the previous wrapper');

  const ctxC = createCtx();
  await host.pi.emit('session_start', { reason: 'reload' }, ctxC);
  const component = makeTool('grep', 'id1', { pattern: 'z' }, textResult('match'), undefined);
  assert.match(renderedText(component), /\u25c6/s);
});

test('render-before-session_start ordering: rebuilt history hydrates pre-start and survives the reset (resume/reload)', async () => {
  const host = createHost();
  compactTranscript(host.pi);
  const ctx = createCtx();
  state.currentTheme = fakeTheme;
  await host.pi.emit('session_start', { reason: 'startup' }, ctx);

  // Outgoing session: a burst and a deliberately expanded row.
  makeTool('grep', 'old1', { pattern: 'a' }, textResult('old one'), undefined);
  makeTool('grep', 'old2', { pattern: 'b' }, textResult('old two'), undefined);
  assert.equal(state.hiddenToolIds.has('old1'), true);
  emitToggle(host, ctx);
  assert.equal(state.userExpansion, true);

  // Real resume/reload order: session_shutdown drops the old session, pi then
  // renders the rebuilt transcript BEFORE session_start (reload beforeSessionStart
  // hook; resume rebindCurrentSession renderBeforeBind), which replays pi's
  // inherited toolOutputExpanded onto the rebuilt mounts.
  await host.pi.emit('session_shutdown', { reason: 'resume' }, ctx);
  assert.equal(state.userExpansion, false, 'outgoing session policy dropped at shutdown');

  const first = makeTool('grep', 'new1', { pattern: 'r' }, textResult('row one'), undefined);
  const second = makeTool('grep', 'new2', { pattern: 's' }, textResult('row two'), undefined);
  second.setExpanded(true); // pi replays inherited toolOutputExpanded on rebuild
  assert.equal(state.hiddenToolIds.has('new1'), true, 'burst rebuilt pre-start: first row hidden');
  assert.equal(state.toolsById.get('new2')?.burstCount, 2, 'burst rebuilt pre-start; not lost');
  assert.match(renderedText(second), /row two/s);

  // session_start must reconcile the pre-start mounts, not wipe them.
  await host.pi.emit('session_start', { reason: 'resume', previousSessionFile: 'other.jsonl' }, ctx);
  assert.equal(state.userExpansion, false, 'fresh collapsed policy');
  assert.equal(second.expanded, false, 'reconciled to the collapsed policy');
  assert.match(renderedText(second), /\u25c6/s, 'row survives session_start as a compact line');
  assert.match(renderedText(second), /row two/s);
  assert.equal(state.hiddenToolIds.has('new1'), true, 'reconstructed burst grouping survives session_start');
  assert.equal(state.toolsById.get('new2')?.burstCount, 2, 'grouping survives session_start');
  assert.deepEqual(rendered(first), [], 'pre-start hidden row stays hidden (loss regression)');
  assert.equal(state.toolComponents.size, 2, 'pre-start mounts retained; old-session mounts dropped');

  // Ctrl+O still works on the reconciled session.
  assert.equal(emitToggle(host, ctx), true);
  assert.match(renderedText(second), /row two/);
});

test('/reload keeps the same session: pre-start hydration is retained and superseded mounts deduped', async () => {
  const host = createHost();
  compactTranscript(host.pi);
  const ctx = createCtx();
  state.currentTheme = fakeTheme;
  await host.pi.emit('session_start', { reason: 'startup' }, ctx);

  const rows = makeTool('grep', 'rel1', { pattern: 'q' }, textResult('hit one'), undefined);
  assert.equal(state.toolsById.get('rel1').burstCount, 1);

  // /reload: session_shutdown fires first, then the beforeSessionStart render,
  // then session_start(reason reload). The rebuilt rows rehydrate pre-start.
  await host.pi.emit('session_shutdown', { reason: 'reload' }, ctx);
  const rebuilt = makeTool('grep', 'rel1', { pattern: 'q' }, textResult('hit one'), undefined);
  await host.pi.emit('session_start', { reason: 'reload' }, ctx);
  // The key-by-id registry dedupes the superseded live mount.
  assert.equal(state.toolComponents.size, 1);
  assert.match(renderedText(rebuilt), /\u25c6/s, 'rebuilt row still compact after reload');
  assert.match(renderedText(rebuilt), /hit one/s);
});

test('delegate breaks historical bursts on first hydration only; repaints do not reset later bursts', async () => {
  const host = createHost();
  compactTranscript(host.pi);
  await host.pi.emit('session_start', { reason: 'startup' }, createCtx());
  state.currentTheme = fakeTheme;

  const delegateDefinition = {
    renderCall: args => ({ render: () => [clean('delegating')], invalidate() {} }),
    renderResult: (output, { expanded }) => ({ render: () => [clean(expanded ? 'full workers' : 'done')], invalidate() {} }),
  };
  const args = { tasks: [{ task: 'x' }] };

  // Historical grep → delegate → grep: the delegate must end the open burst on
  // first hydration, so the trailing grep is NOT grouped with the leading one.
  const grep1 = makeTool('grep', 'h1', { pattern: 'a' }, textResult('m1'), undefined);
  const delegate = makeTool('delegate', 'h2', args, textResult('workers done'), delegateDefinition);
  const grep2 = makeTool('grep', 'h3', { pattern: 'b' }, textResult('m2'), undefined);
  assert.equal(state.toolsById.get('h3').burstCount, 1, 'delegate ends the open burst at hydration');
  assert.equal(state.hiddenToolIds.has('h1'), false, 'leading grep must not be hidden across the delegate');
  assert.equal(state.toolsById.get('h1').burstCount, 1);
  assert.match(renderedText(grep1), /m1/s);

  // Repainting the delegate (result update / args stream) must not break the
  // burst that was formed after it.
  delegate.updateResult(textResult('repainted'), false);
  assert.equal(state.toolsById.get('h3').burstCount, 1, 'repaint does not split existing bursts');
  delegate.updateArgs(args);
  assert.equal(state.toolsById.get('h3').burstCount, 1);

  // A genuine same-tool repeat after the delegate still groups normally.
  const grep3 = makeTool('grep', 'h4', { pattern: 'c' }, textResult('m3'), undefined);
  assert.equal(state.toolsById.get('h4').burstCount, 2, 'trailing same-tool rows still group');
  assert.equal(state.hiddenToolIds.has('h3'), true);
  assert.match(renderedText(grep1), /m1/s);
});
