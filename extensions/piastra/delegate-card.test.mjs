import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import piastra from './index.ts';

test('real delegate card has one content line with compact mode and expansion toggles', async () => {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'piastra-delegate-card-'));
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map();
  const tools = new Map();
  const listeners = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
    events: {
      on(name, handler) {
        listeners.set(name, [...(listeners.get(name) || []), handler]);
        return () => listeners.set(name, listeners.get(name).filter(h => h !== handler));
      },
      emit(name, value) { for (const handler of listeners.get(name) || []) handler(value); },
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {}, registerShortcut() {}, registerEntryRenderer() {},
    appendEntry() {}, getThinkingLevel: () => 'low', getAllTools: () => [],
    setModel: async () => true, setThinkingLevel() {}, setActiveTools() {},
  };
  const ctx = {
    cwd: dir, mode: 'tui', isProjectTrusted: () => false,
    sessionManager: { getBranch: () => [], getSessionId: () => 'delegate-card' },
    ui: { theme: { fg: (_style, text) => text, bg: (_style, text) => text, bold: text => text },
      notify() {}, setStatus() {}, setWorkingMessage() {} },
  };
  let compactHandlers;
  try {
    initTheme('dark');
    const { default: compact } = await import('../pi-compact-transcript/extensions/compact-transcript.ts');
    compact(pi);
    // Start only compact's lifecycle: no provider or real editor is needed.
    compactHandlers = new Map([...handlers].map(([name, values]) => [name, [...values]]));
    for (const handler of compactHandlers.get('session_start') || []) await handler({}, ctx);
    assert.equal(globalThis[Symbol.for('pi-compact-transcript.state')].config.enabled, true);
    piastra(pi);
    const definition = tools.get('delegate');
    const args = { tasks: [{ role: 'fast', access: 'read', task: 'secret task payload' }] };
    const ui = { requestRender() {} };
    const card = new ToolExecutionComponent('delegate', 'card-1', args, { showImages: false }, definition, ui, dir);
    const content = component => component.render(100).map(stripTerminalSequences).filter(line => line.trim());
    assert.match(content(card).join('\n'), /1 workers in parallel/);
    for (const [status, partial] of [['running', true], ['completed', false]]) {
      const output = {
        content: [{ type: 'text', text: 'secret full model-facing result\nsecond result line' }],
        details: { workers: [{ role: 'fast', status, task: args.tasks[0].task, model: 'secret model' }] },
        isError: false,
      };
      const before = structuredClone(output);
      card.updateResult(output, partial);
      for (const expanded of [false, true]) {
        card.setExpanded(expanded);
        const lines = content(card);
        assert.equal(lines.length, 1, JSON.stringify(lines));
        assert.match(lines[0], new RegExp(`Workers · 1 ${status}`));
        assert.ok(visibleWidth(lines[0]) <= 100);
        assert.doesNotMatch(lines[0], /secret|PiAstra ·|workers in parallel/);
      }
      const envelope = { handled: false, ctx };
      pi.events.emit('piastra:compact-transcript:toggle', envelope);
      assert.equal(envelope.handled, true);
      assert.equal(content(card).length, 1, 'Ctrl+O must not resurrect the call heading');
      assert.deepEqual(output, before, 'model-facing content stays untouched');
    }
    const other = new ToolExecutionComponent('delegate', 'card-2', args, { showImages: false }, definition, ui, dir);
    assert.match(content(other).join('\n'), /workers in parallel/, 'state is isolated per call');
    other.updateResult({ content: [{ type: 'text', text: 'early runtime failure\nstack details' }], isError: true });
    assert.equal(content(other).length, 1);
    assert.match(content(other)[0], /early runtime failure/);
  } finally {
    for (const handler of compactHandlers?.get('session_shutdown') || []) await handler({}, ctx);
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
});
