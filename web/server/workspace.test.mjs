import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { workspace } from './workspace.mjs';

test('workspace previews reject traversal, private state, binary and oversized files', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'piastra-files-'));
  try {
    const root = path.join(tmp, 'project'); await mkdir(root);
    await writeFile(path.join(tmp, 'outside'), 'private');
    await writeFile(path.join(root, 'visible.txt'), 'hello');
    await writeFile(path.join(root, '.env'), 'SECRET=x');
    await writeFile(path.join(root, 'binary'), Buffer.from([0, 1]));
    await writeFile(path.join(root, 'large'), 'x'.repeat(512001));
    const fs = workspace(root);
    assert.equal(await fs.file('visible.txt'), 'hello');
    assert.ok(!(await fs.files('')).some(e => e.name === '.env'));
    for (const p of ['../outside', path.join(tmp, 'outside'), '.env', 'binary', 'large']) await assert.rejects(fs.file(p));
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test('diff includes staged, unstaged and untracked content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'piastra-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git('init'); await writeFile(path.join(root, 'a.txt'), 'original\n'); git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture');
    await writeFile(path.join(root, 'a.txt'), 'staged\n'); git('add', '.');
    await writeFile(path.join(root, 'a.txt'), 'working\n');
    await writeFile(path.join(root, 'new.txt'), 'new\n');
    await writeFile(path.join(root, '.env'), 'secret');
    const result = await workspace(root).diff();
    assert.match(result.patch, /-original/); assert.match(result.patch, /\+working/);
    assert.deepEqual(result.untracked, [{ path: 'new.txt', content: 'new\n' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
