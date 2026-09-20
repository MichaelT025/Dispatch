import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent';
import {
  RESULT_TEXT_LIMIT,
  WORKER_RESULT_TYPE,
  WORKER_TOOL_NAMES,
  createCompletionQueue,
  formatElapsed,
  formatStarted,
  formatWorkerResult,
  formatWorkerResults,
  mergeRestoredWorkers,
} from './worker-runtime.mjs';
import { createWorkerResultCard } from './worker-render.ts';

initTheme('dark');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('formatWorkerResult: header, capped text and transcript; failures are upper-cased', () => {
  const ok = formatWorkerResult({ id: 3, role: 'general', model: 'p/m', status: 'completed', text: 'done', transcript: '/t.jsonl', elapsed: '1m02s' });
  assert.equal(ok, '#3 general · p/m · completed · 1m02s\ndone\nTranscript: /t.jsonl');
  const failed = formatWorkerResult({ id: 4, role: 'fast', model: 'p/m', status: 'failed', text: 'boom' });
  assert.equal(failed, '#4 fast · p/m · FAILED\nboom\nTranscript: (none)');
  const long = formatWorkerResult({ id: 5, role: 'fast', model: 'p/m', ok: true, text: 'x'.repeat(RESULT_TEXT_LIMIT + 10) });
  assert.match(long, /\[Truncated; see transcript\.\]/);
  assert.ok(long.length < RESULT_TEXT_LIMIT + 200);
  assert.equal(formatWorkerResults([]), 'No worker results.');
  assert.match(formatWorkerResults([{ id: 1, role: 'fast', model: 'm', status: 'completed', text: 'a' }, { id: 2, role: 'fast', model: 'm', status: 'cancelled', text: 'b' }]), /^Worker results \(2\):\n\n#1 fast[\s\S]*\n\n#2 fast · m · CANCELLED/);
});

test('formatStarted lists workers with access and points at the result messages and await_workers', () => {
  const text = formatStarted([{ id: 1, role: 'fast', access: 'read', model: 'm', status: 'starting' }, { id: 2, role: 'general', access: 'write', model: 'n', status: 'starting' }], { notesDir: '/notes' });
  assert.match(text, /^Started 2 workers; results arrive as \[dispatch-worker-result\] messages/);
  assert.match(text, /#1 fast \(read\) · m · starting\n#2 general \(write\) · n · starting/);
  assert.match(text, /Shared session notes: \/notes/);
  assert.match(text, /await_workers only when/);
  assert.match(formatStarted([{ id: 7, role: 'general', model: 'n', status: 'starting' }], { continued: true }), /^Continued worker #7;/);
  assert.match(formatStarted([{ id: 1, role: 'fast', model: 'm', status: 'starting' }]), /^Started 1 worker;/);
});

test('formatElapsed uses ended when present and minutes past 60s', () => {
  assert.equal(formatElapsed({ started: 1000, ended: 4000 }), '3s');
  assert.equal(formatElapsed({ started: 0, ended: 62_000 }), '1m02s');
  assert.equal(formatElapsed({ started: Date.now() - 2000 }), '2s');
});

test('completion queue coalesces results inside the window and delivers once', async () => {
  const sent = [];
  const queue = createCompletionQueue({ send: batch => sent.push(batch), delay: 40 });
  queue.push({ id: 1 });
  queue.push({ id: 2 });
  assert.deepEqual(queue.pending(), [1, 2]);
  await sleep(80);
  assert.deepEqual(sent, [[{ id: 1 }, { id: 2 }]]);
  queue.push({ id: 3 });
  await sleep(80);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], [{ id: 3 }]);
});

test('completion queue: take removes buffered results so a direct return never duplicates a message', async () => {
  const sent = [];
  const queue = createCompletionQueue({ send: batch => sent.push(batch), delay: 40 });
  queue.push({ id: 1 });
  queue.push({ id: 2 });
  assert.deepEqual(queue.take([1]), [{ id: 1 }]);
  assert.deepEqual(queue.pending(), [2]);
  assert.deepEqual(queue.take([1]), []);
  assert.deepEqual(queue.take([2]), [{ id: 2 }]);
  await sleep(80);
  assert.deepEqual(sent, [], 'nothing left to flush');
});

test('completion queue defers delivery while the session is busy and drops everything on dispose', async () => {
  const sent = [];
  let busy = true;
  const queue = createCompletionQueue({ send: batch => sent.push(batch), isBusy: () => busy, delay: 20, retry: 20 });
  queue.push({ id: 1 });
  await sleep(70);
  assert.deepEqual(sent, [], 'no delivery during compaction');
  busy = false;
  await sleep(60);
  assert.deepEqual(sent, [[{ id: 1 }]]);
  queue.push({ id: 2 });
  queue.dispose();
  await sleep(60);
  assert.equal(sent.length, 1, 'disposed queue delivers nothing');
  queue.push({ id: 3 });
  assert.deepEqual(queue.pending(), []);
});

test('completion queue survives a throwing sender', async () => {
  let calls = 0;
  const queue = createCompletionQueue({ send: () => { calls += 1; throw new Error('ui gone'); }, delay: 10 });
  queue.push({ id: 1 });
  await sleep(40);
  queue.push({ id: 2 });
  await sleep(40);
  assert.equal(calls, 2);
});

test('mergeRestoredWorkers: later entries win per id, live statuses become interrupted, other entries are ignored', () => {
  const branch = [
    { type: 'message', message: { role: 'toolResult', toolName: 'delegate', details: { workers: [
      { id: 1, role: 'fast', status: 'starting', task: 'a' }, { id: 2, role: 'general', status: 'starting', task: 'b' },
    ] } } },
    { type: 'custom_message', customType: WORKER_RESULT_TYPE, details: { workers: [{ id: 1, role: 'fast', status: 'completed', ended: 5 }] } },
    { type: 'message', message: { role: 'toolResult', toolName: 'continue_worker', details: { workers: [{ id: 1, role: 'fast', status: 'running' }] } } },
    { type: 'custom_message', customType: 'something-else', details: { workers: [{ id: 3, status: 'completed' }] } },
    { type: 'message', message: { role: 'toolResult', toolName: 'read', details: { workers: [{ id: 4, status: 'completed' }] } } },
    { type: 'message', message: { role: 'toolResult', toolName: 'cancel_worker', details: { workers: [{ id: 'x', status: 'completed' }] } } },
  ];
  const workers = mergeRestoredWorkers(branch);
  assert.deepEqual([...workers.keys()], [1, 2]);
  assert.equal(workers.get(1).status, 'interrupted', 'a continuation left running restores as interrupted');
  assert.equal(workers.get(1).task, 'a', 'fields from earlier entries are kept');
  assert.equal(workers.get(2).status, 'interrupted');
  assert.equal(workers.get(2).activity, 'This worker is no longer attached.');
  assert.deepEqual(mergeRestoredWorkers(undefined).size, 0);
  assert.deepEqual(WORKER_TOOL_NAMES, ['delegate', 'await_workers', 'cancel_worker', 'continue_worker']);
});

test('worker result card: one status line per worker, preview collapsed, Markdown when expanded, no ANSI leaks', () => {
  const theme = { fg: (_style, text) => text };
  const message = { customType: WORKER_RESULT_TYPE, details: {
    workers: [{ id: 1, role: 'general', status: 'completed' }, { id: 2, role: 'fast', status: 'failed' }],
    results: [
      { id: 1, role: 'general', status: 'completed', elapsed: '12s', text: '# Done\n\nChanged `a.ts`\x1b[31m and more text that goes on for a while' },
      { id: 2, role: 'fast', status: 'failed', elapsed: '3s', text: '' },
    ],
  } };
  const collapsed = createWorkerResultCard(message, { expanded: false }, theme).render(80).map(stripTerminalSequences);
  assert.equal(collapsed[0], 'Worker results · 2');
  assert.equal(collapsed[1], '✓ #1 general · completed · 12s');
  assert.match(collapsed[2], /^ {2}# Done Changed `a\.ts` and more/);
  assert.equal(collapsed[3], '✗ #2 fast · failed · 3s');
  assert.equal(collapsed.at(-1), 'Ctrl+O to expand');
  assert.ok(!collapsed.join('\n').includes('\x1b[31m'));
  const expanded = createWorkerResultCard(message, { expanded: true }, theme).render(80).map(stripTerminalSequences);
  assert.ok(expanded.length > collapsed.length, 'expanded view renders the Markdown body');
  assert.ok(expanded.some(line => /Done/.test(line)));
  assert.ok(!expanded.includes('Ctrl+O to expand'));
  const empty = createWorkerResultCard({ details: {} }, {}, theme).render(40);
  assert.deepEqual(empty, ['Worker results · none']);
});
