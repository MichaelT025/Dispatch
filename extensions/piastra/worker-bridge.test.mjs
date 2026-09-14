import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerBridge, WORKER_CHANNEL, workerSummary } from './worker-bridge.mjs';
import { makeWorker, trackEvent } from './progress.mjs';

function bus() {
  const listeners = new Map(), emitted = [];
  return {
    emitted,
    on(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(fn);
      return () => listeners.get(channel).delete(fn);
    },
    emit(channel, event) { emitted.push({ channel, event }); for (const fn of listeners.get(channel) || []) fn(event); },
    size() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
  };
}

test('summary is plain data linked to its delegate call', () => {
  const worker = makeWorker({ role: 'fast', task: 'Read docs' }, 3, 'p/m', 'call-1');
  trackEvent(worker, { type: 'tool_execution_start', toolName: 'read', args: { path: 'README.md' } });
  const summary = workerSummary(worker);
  assert.deepEqual(Object.keys(summary).sort(), ['activity', 'ended', 'id', 'model', 'recent', 'role', 'started', 'status', 'task', 'text', 'toolCallId', 'transcript'].sort());
  assert.equal(summary.toolCallId, 'call-1');
  assert.equal(summary.id, 4);
  assert.notEqual(summary.recent, worker.recent);
});

test('bridge publishes deduplicated lists, answers discovery and routes cancel', () => {
  const events = bus();
  const records = new Map();
  const bridge = createWorkerBridge(events, records);
  bridge.publish(); bridge.publish();
  assert.equal(events.emitted.length, 1);
  assert.deepEqual(events.emitted[0], { channel: WORKER_CHANNEL, event: { version: 1, type: 'workers', workers: [] } });
  const worker = makeWorker({ role: 'general', task: 'Edit' }, 0, 'p/m', 'call-2');
  let cancelled = 0;
  records.set(worker.id, { worker, cancel: () => cancelled++, getMessages: () => [{ role: 'user', content: 'Edit' }] });
  bridge.publish();
  assert.equal(events.emitted.at(-1).event.workers[0].toolCallId, 'call-2');
  events.emit(WORKER_CHANNEL, { version: 1, type: 'discover' });
  assert.equal(events.emitted.at(-1).event.type, 'workers');
  events.emit(WORKER_CHANNEL, { version: 1, type: 'transcript_request', workerId: worker.id });
  assert.deepEqual(events.emitted.at(-1).event, { version: 1, type: 'transcript', workerId: 1, messages: [{ role: 'user', content: 'Edit' }], streaming: null });
  events.emit(WORKER_CHANNEL, { version: 1, type: 'transcript_request', workerId: 99 });
  assert.equal(events.emitted.at(-1).event.type, 'transcript_request');
  events.emit(WORKER_CHANNEL, { version: 1, type: 'cancel', workerId: worker.id });
  events.emit(WORKER_CHANNEL, { version: 1, type: 'cancel', workerId: 42 });
  events.emit(WORKER_CHANNEL, { version: 2, type: 'cancel', workerId: worker.id });
  assert.equal(cancelled, 1);
  const streaming = { role: 'assistant', content: [] };
  bridge.transcript(worker.id, undefined, streaming);
  assert.deepEqual(events.emitted.at(-1).event, { version: 1, type: 'transcript', workerId: 1, messages: [], streaming });
  bridge.dispose();
  assert.equal(events.size(), 0);
});
