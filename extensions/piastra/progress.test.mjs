import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorker, trackEvent, progressText } from './progress.mjs';
test('interleaved workers retain separate live activity and bounded output', () => {
  const first = makeWorker({ role: 'general', task: 'Edit a' }, 0, 'glm');
  const second = makeWorker({ role: 'fast', task: 'Inspect b' }, 1, 'ds');
  trackEvent(first, { type: 'tool_execution_start', toolName: 'edit', args: { path: 'a.ts' } });
  trackEvent(second, { type: 'tool_execution_start', toolName: 'read', args: { path: 'b.ts' } });
  assert.match(progressText([first, second]), /edit a.ts/);
  assert.match(progressText([first, second]), /read b.ts/);
  trackEvent(first, { type: 'tool_execution_end', toolName: 'edit', isError: true, result: { content: [{ type: 'text', text: 'bad patch' }] } });
  assert.match(progressText([first], true), /bad patch/);
  for (let i = 0; i < 30; i++) trackEvent(second, { type: 'tool_execution_start', toolName: 'read', args: { path: String(i) } });
  assert.equal(second.recent.length, 20);
  trackEvent(second, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(2000) } });
  assert.equal(second.text.length, 1200);
  assert.equal(trackEvent(second, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'private' } }), false);
});
