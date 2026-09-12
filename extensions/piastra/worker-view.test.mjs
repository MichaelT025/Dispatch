import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerView, messageText } from './worker-view.ts';
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
    view.handleInput('\t'); assert.match(view.render(100).join('\n'), /Parent › Workers/);
    view.handleInput('\x1b'); assert.equal(closed, true);
  } finally { view.dispose(); }
});
test('transcript view includes messages and tools but not hidden reasoning', () => {
  const text = messageText([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } }] }, { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'source code' }] }]);
  assert.match(text, /a.ts/); assert.match(text, /source code/); assert.doesNotMatch(text, /hidden/);
});
