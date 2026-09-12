import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, gitArguments, validateTasks } from './policy.mjs';
test('only read helpers can overlap; review cannot edit', () => {
  const fast = { role: 'fast', access: 'read', task: 'Inspect files' };
  validateTasks([fast, fast, fast]);
  assert.throws(() => validateTasks([fast, { ...fast, access: 'write' }]));
  assert.throws(() => validateTasks([{ ...fast, role: 'review', access: 'write' }]));
  assert.throws(() => validateTasks([fast, { ...fast, role: 'review' }]));
  assert.throws(() => validateTasks([fast, fast, fast, fast]));
});
test('queue serializes batches and recovers after failures', async () => {
  const queue = createQueue(), order = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const first = queue(async () => { order.push(1); await gate; throw new Error('test failure'); });
  const failed = assert.rejects(first);
  const second = queue(async () => { order.push(2); });
  await Promise.resolve(); assert.deepEqual(order, [1]);
  release(); await failed; await second; assert.deepEqual(order, [1, 2]);
});
test('Git inspector rejects command and option injection', () => {
  assert.throws(() => gitArguments('commit'));
  assert.throws(() => gitArguments('diff', '--output=secret'));
  assert.throws(() => gitArguments('show', 'HEAD; echo x'));
  assert.ok(gitArguments('diff', 'HEAD~2').includes('--no-ext-diff'));
});
