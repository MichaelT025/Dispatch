import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitArguments, validateTasks } from './policy.mjs';
test('uncapped mixed batches allow parallel writers; reviewers remain read-only', () => {
  const fast = { role: 'fast', access: 'read', task: 'Inspect files' };
  validateTasks([fast, fast, fast]);
  validateTasks([fast, { ...fast, access: 'write' }]);
  assert.throws(() => validateTasks([{ ...fast, role: 'review', access: 'write' }]));
  validateTasks([fast, { ...fast, role: 'review' }]);
  validateTasks(Array.from({ length: 100 }, () => ({ role: 'general', access: 'write', task: 'Edit assigned file' })));
  assert.throws(() => validateTasks([]));
});
test('Git inspector rejects command and option injection', () => {
  assert.throws(() => gitArguments('commit'));
  assert.throws(() => gitArguments('diff', '--output=secret'));
  assert.throws(() => gitArguments('show', 'HEAD; echo x'));
  assert.ok(gitArguments('diff', 'HEAD~2').includes('--no-ext-diff'));
});
