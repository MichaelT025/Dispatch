import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLsRemote, resolveNextVersion, withWebSha } from './release.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';

test('resolveNextVersion bumps keywords and accepts explicit stable versions', () => {
  assert.equal(resolveNextVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(resolveNextVersion('0.1.0', 'minor'), '0.2.0');
  assert.equal(resolveNextVersion('0.1.0', 'major'), '1.0.0');
  assert.equal(resolveNextVersion('0.1.0', '0.3.0'), '0.3.0');
  assert.equal(resolveNextVersion('0.1.0', 'v0.3.0'), '0.3.0');
});

test('resolveNextVersion rejects prereleases, junk and non-increasing versions', () => {
  assert.throws(() => resolveNextVersion('0.1.0', '0.2.0-beta.1'), /stable/);
  assert.throws(() => resolveNextVersion('0.1.0', 'banana'), /stable/);
  assert.throws(() => resolveNextVersion('0.1.0', '0.1.0'), /greater/);
  assert.throws(() => resolveNextVersion('0.2.0', '0.1.9'), /greater/);
});

test('parseLsRemote extracts the main branch SHA', () => {
  assert.equal(parseLsRemote(`${SHA}\trefs/heads/main\n`), SHA);
  assert.equal(parseLsRemote(`${'f'.repeat(40)}\trefs/heads/dev\r\n${SHA}\trefs/heads/main\r\n`), SHA);
  assert.throws(() => parseLsRemote(''), /refs\/heads\/main/);
});

test('withWebSha replaces only web.sha', () => {
  const text = JSON.stringify({ $comment: 'keep', web: { repository: 'MichaelT025/DispatchWeb', sha: 'a'.repeat(40) } });
  const updated = JSON.parse(withWebSha(text, SHA));
  assert.deepEqual(updated, { $comment: 'keep', web: { repository: 'MichaelT025/DispatchWeb', sha: SHA } });
  assert.throws(() => withWebSha(text, 'abc123'), /40-hex/);
});
