import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Explicit offline allowlist: never glob the upstream authenticated/live tests.
const files = [
  'test-api-key.ts', 'test-pure-functions.ts', 'test-models.ts',
  'test-runtime.ts', 'test-pricing.ts', 'test-cost.ts', 'test-oauth.ts',
  'test-abort.ts', 'test-overflow.ts', 'test-stream.ts', 'test-quota.ts',
  'test-quota-command.ts', 'test-retry.ts', 'test-transport.ts',
];

test('retained upstream offline unit tests', { timeout: 125_000 }, (t) => {
  const env = { ...process.env };
  // The parent's node:test IPC marker must not suppress the nested runner.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--experimental-transform-types', '--test',
    ...files.map(file => fileURLToPath(new URL(file, import.meta.url))),
  ], { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# tests [1-9]\d*/, 'nested unit tests must actually execute');
  t.diagnostic(result.stdout.match(/# tests (\d+)/)?.[0] + ' in the upstream offline suite');
});
