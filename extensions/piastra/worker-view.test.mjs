import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth, TuiMainScreen } from '@earendil-works/pi-tui';
import { renderTranscript } from './worker-render.ts';
initTheme('dark');
import { createWorkerView, messageText, workerOverlayOptions } from './worker-view.ts';
test('viewer navigates workers and returns to parent without mutating sessions', () => {
  let closed = false;
  const records = new Map([[1, { worker: { id: 1, role: 'general', task: 'test', status: 'running', activity: 'read a.ts', model: 'glm' }, getMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'Inspecting a.ts' }] }] }]]);
  const view = createWorkerView({ terminal: { rows: 25 }, requestRender() {} }, { fg: (_style, text) => text }, () => { closed = true; }, records);
  try {
    assert.match(view.render(100).join('\n'), /Parent › Workers/);
    view.handleInput('\t');
    assert.match(view.render(100).join('\n'), /Parent › #1 general/);
    assert.match(view.render(100).join('\n'), /Inspecting a.ts/);
    records.get(1).worker.status = 'completed';
    assert.match(view.render(100).join('\n'), /completed/);
    view.handleInput('\x1b[B'); assert.match(view.render(100).join('\n'), /Parent › Workers/);
    view.handleInput('\x1b'); assert.equal(closed, true);
  } finally { view.dispose(); }
});
test('transcript view includes messages and tools but not hidden reasoning', () => {
  const text = messageText([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } }] }, { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'source code' }] }]);
  assert.match(text, /a.ts/); assert.match(text, /source code/); assert.doesNotMatch(text, /hidden/);
});


test('paused streaming viewport and sibling reading positions remain stable', () => {
  const messages = Array.from({ length: 45 }, (_, i) => ({ role: 'assistant', content: `Message ${i}` }));
  const records = new Map([1, 2].map(id => [id, { worker: { id, role: 'general', task: 'trial', model: 'glm', status: 'running', activity: 'Responding' }, getMessages: () => messages }]));
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  const view = createWorkerView(tui, { fg: (_s, t) => t }, () => {}, records);
  try {
    view.handleInput('\r');
    view.render(80);
    view.handleInput('\x1b[5~');
    const before = view.render(80).slice(3, -1);
    messages.push({ role: 'assistant', content: 'New streaming output' });
    assert.deepEqual(view.render(80).slice(3, -1), before);
    view.handleInput('\x1b[C'); view.render(80);
    view.handleInput('\x1b[D');
    assert.deepEqual(view.render(80).slice(3, -1), before);
    records.get(1).worker.status = 'completed';
    assert.deepEqual(view.render(80).slice(3, -1), before);
    view.handleInput('\x1b[F');
    assert.match(view.render(80).join('\n'), /New streaming output/);
    for (const width of [30, 80, 160]) {
      const lines = view.render(width);
      assert.equal(lines.length, 24);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
    }
  } finally { view.dispose(); }
});

test('transcripts highlight source, collapse tools, and retain errors', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private thought' }, { type: 'toolCall', id: 'r', name: 'read', arguments: { path: 'a.ts' } }] },
    { role: 'toolResult', toolCallId: 'r', toolName: 'read', content: [{ type: 'text', text: 'const answer = 42;\nconsole.log(answer);' }] },
    { role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'failed first line\ncritical second line' }] }
  ];
  const theme = { fg: (_s, t) => t };
  const expanded = renderTranscript(messages, theme, 80).join('\n');
  assert.match(expanded, /\x1b\[/);
  assert.match(stripTerminalSequences(expanded), /const answer = 42/);
  assert.doesNotMatch(expanded, /private thought/);
  const collapsed = renderTranscript(messages, theme, 80, false).join('\n');
  assert.match(collapsed, /Ctrl\+O to expand/);
  assert.match(collapsed, /critical second line/);
});


test('real TUI overlay composition stays fixed when the parent grows', () => {
  const tui = new TuiMainScreen({ rows: 24, columns: 80, hideCursor() {} });
  tui.requestRender = () => {}; // Exercise the real compositor without terminal I/O.
  const view = createWorkerView(tui, { fg: (_s, t) => t }, () => {}, new Map());
  let handle;
  try {
    handle = tui.showOverlay(view, workerOverlayOptions.overlayOptions);
    const before = tui.compositeOverlays(['Parent line'], 80, 24).slice(-24);
    const after = tui.compositeOverlays(Array.from({ length: 100 }, (_, i) => `Parent update ${i}`), 80, 24).slice(-24);
    assert.deepEqual(after, before);
    assert.match(stripTerminalSequences(after.join('\n')), /Parent › Workers/);
    assert.doesNotMatch(stripTerminalSequences(after.join('\n')), /Parent update/);
  } finally { handle?.hide(); view.dispose(); }
});
