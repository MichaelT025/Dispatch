import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { trackEvent } from './progress.mjs';
import { stoppingPoint, collectFileEvidence } from './worker-evidence.mjs';
import { formatWorkerResult, RESULT_TEXT_LIMIT } from './worker-runtime.mjs';

test('correlates successful writes and captures interruption evidence before abort', () => {
  const worker = { recent: [], text: 'Partial explanation' };
  const start = (id, name, file) => trackEvent(worker, { type: 'tool_execution_start', toolCallId: id, toolName: name, args: { path: file } });
  const end = (id, name, isError = false) => trackEvent(worker, { type: 'tool_execution_end', toolCallId: id, toolName: name, isError });
  start('1', 'edit', 'a.ts'); start('2', 'write', 'b.ts');
  end('2', 'write'); end('1', 'edit', true);
  start('3', 'edit', 'b.ts'); end('3', 'edit');
  start('4', 'write', 'unfinished.ts');
  const point = stoppingPoint(worker);
  end('4', 'write', true);
  assert.deepEqual(worker.changedFiles, ['b.ts']);
  assert.match(point.pending[0], /unfinished.ts/);
  assert.equal(point.partialResponse, 'Partial explanation');
  const text = formatWorkerResult({ id: 1, role: 'general', model: 'test', status: 'cancelled', text: 'x'.repeat(RESULT_TEXT_LIMIT + 1), stoppingPoint: point, fileEvidence: { files: worker.changedFiles, stat: 'b.ts | 1 +' } });
  assert.match(text, /Truncated/);
  assert.match(text, /In flight \(outcome unknown\).*unfinished.ts/);
  assert.match(text, /Files changed.*b.ts/);
  assert.match(text, /Shared-worktree git diff --stat/);
});

test('scoped Git evidence includes staged and unstaged changes and identifies untracked files', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dispatch-evidence-'));
  const git = (...args) => execFileSync('git', args, { cwd, windowsHide: true });
  try {
    git('init');
    await writeFile(path.join(cwd, 'a.txt'), 'before\n');
    await writeFile(path.join(cwd, 'other.txt'), 'before\n');
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'baseline');
    await writeFile(path.join(cwd, 'a.txt'), 'staged\n'); git('add', 'a.txt');
    await writeFile(path.join(cwd, 'a.txt'), 'unstaged\nmore\n');
    await writeFile(path.join(cwd, 'other.txt'), 'unrelated\n');
    await writeFile(path.join(cwd, 'new.txt'), 'new\n');
    const evidence = await collectFileEvidence({ changedFiles: ['a.txt', 'new.txt'] }, cwd);
    assert.match(evidence.stat, /a.txt/);
    assert.match(evidence.stat, /Untracked files.*\nnew.txt/);
    assert.doesNotMatch(evidence.stat, /other.txt/);
    assert.deepEqual((await collectFileEvidence({}, cwd)).files, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Git evidence resolves cwd and absolute file directory aliases', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-alias-'));
  const cwd = path.join(dir, 'repository');
  const alias = path.join(dir, 'alias');
  const git = (...args) => execFileSync('git', args, { cwd, windowsHide: true });
  try {
    await mkdir(cwd);
    git('init');
    await writeFile(path.join(cwd, 'a.txt'), 'before\n');
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'baseline');
    await symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(cwd, 'a.txt'), 'after\n');
    for (const file of ['a.txt', path.join(alias, 'a.txt')]) {
      const evidence = await collectFileEvidence({ changedFiles: [file] }, alias);
      assert.match(evidence.stat, /a\.txt/);
      assert.doesNotMatch(evidence.stat, /outside repository|unavailable/);
    }
    await rm(path.join(cwd, 'a.txt'));
    const deleted = await collectFileEvidence({ changedFiles: ['a.txt'] }, alias);
    assert.match(deleted.stat, /a\.txt/);
    assert.doesNotMatch(deleted.stat, /outside repository|unavailable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Git failure preserves observed file list', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dispatch-no-git-'));
  try {
    const evidence = await collectFileEvidence({ changedFiles: ['a.txt'] }, cwd);
    assert.deepEqual(evidence.files, ['a.txt']);
    assert.match(evidence.stat, /unavailable/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
