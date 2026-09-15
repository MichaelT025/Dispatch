import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gitArguments, isSafeGitPath, validateTasks } from './policy.mjs';

const execFileAsync = promisify(execFile);

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
test('Git inspector supports blame and stat without shell access', () => {
  assert.deepEqual(
    gitArguments('stat', 'abc123'),
    ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', 'diff', '--stat', '--no-ext-diff', '--no-textconv', '--no-color', 'abc123', '--'],
  );
  const blame = gitArguments('blame', 'HEAD', 'src/index.ts');
  assert.ok(blame.includes('blame') && blame[blame.length - 1] === 'src/index.ts');
  assert.throws(() => gitArguments('blame', 'HEAD'));
  assert.throws(() => gitArguments('blame', 'HEAD', '../escape.ts'));
  assert.throws(() => gitArguments('diff', 'HEAD', '--output=x'));
});
test('Git path validation keeps blame inside the repo', () => {
  assert.ok(isSafeGitPath('src/index.ts'));
  assert.ok(!isSafeGitPath('../secret') && !isSafeGitPath('/abs') && !isSafeGitPath('-evil') && !isSafeGitPath(''));
});

test('Git paths allow dotfiles, spaces and Unicode; backslashes normalize', () => {
  assert.ok(isSafeGitPath('.gitignore'));
  assert.ok(isSafeGitPath('.config/settings.json'));
  assert.ok(isSafeGitPath('space name.txt'));
  assert.ok(isSafeGitPath('dir/space name.txt'));
  assert.ok(isSafeGitPath('ünicode-✓.txt'));
  assert.ok(isSafeGitPath('docs/ünicode name ✓.md'));
  assert.ok(isSafeGitPath('sub\\file.txt'));
  assert.ok(isSafeGitPath('dir\\sub\\space name.txt'));
  // Absolute, drive, traversal, NUL and option injection stay rejected.
  assert.ok(!isSafeGitPath('/abs/path'));
  assert.ok(!isSafeGitPath('\\abs\\path'));
  assert.ok(!isSafeGitPath('C:\\secret'));
  assert.ok(!isSafeGitPath('C:/secret'));
  assert.ok(!isSafeGitPath('D:secret'));
  assert.ok(!isSafeGitPath('a/../b'));
  assert.ok(!isSafeGitPath('a\\..\\b'));
  assert.ok(!isSafeGitPath('../escape'));
  assert.ok(!isSafeGitPath('a/./b'));
  assert.ok(!isSafeGitPath('a//b'));
  assert.ok(!isSafeGitPath('nul\0byte'));
  assert.ok(!isSafeGitPath('-evil'));
  assert.ok(!isSafeGitPath(''));
});

test('Git arguments normalize separators, lock helpers and reject unsupported fields', () => {
  const backslash = gitArguments('blame', 'HEAD', 'sub\\file.txt');
  assert.equal(backslash[backslash.length - 1], 'sub/file.txt');
  assert.ok(backslash.indexOf('--') < backslash.length - 1);

  const blame = gitArguments('blame', 'HEAD', 'space name.txt');
  assert.ok(blame.includes('--no-textconv'));
  assert.ok(blame.includes('--no-ext-diff'));
  assert.ok(blame.includes('--no-color-lines') && blame.includes('--no-color-by-age'));
  assert.ok(blame.includes('--'));

  const stat = gitArguments('stat', 'HEAD');
  assert.ok(stat.includes('--no-ext-diff') && stat.includes('--no-textconv') && stat.includes('--no-color'));
  const diff = gitArguments('diff', 'HEAD');
  for (const flag of ['--no-ext-diff', '--no-textconv', '--no-color']) {
    assert.ok(stat.includes(flag) && diff.includes(flag));
  }

  assert.throws(() => gitArguments('diff', 'HEAD', 'src/index.ts'));
  assert.throws(() => gitArguments('stat', 'HEAD', 'src/index.ts'));
  assert.throws(() => gitArguments('log', 'HEAD', 'src/index.ts'));
  assert.throws(() => gitArguments('show', 'HEAD', 'src/index.ts'));
  assert.throws(() => gitArguments('status', undefined, 'src/index.ts'));
  assert.throws(() => gitArguments('status', 'HEAD'));
  assert.throws(() => gitArguments('blame', 'HEAD', '/abs'));
  assert.throws(() => gitArguments('blame', 'HEAD', 'C:/win'));
  assert.throws(() => gitArguments('blame', 'HEAD', 'a/../b'));
  assert.throws(() => gitArguments('blame', 'HEAD', 'nul\0byte'));
});

async function makeTempRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piastra-git-'));
  const git = (args) => execFileAsync('git', args, { cwd: dir });
  await git(['init']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(path.join(dir, '.gitignore'), '*.log\n');
  await writeFile(path.join(dir, 'space name.txt'), 'hello\n');
  await writeFile(path.join(dir, 'ünicode-✓.txt'), 'unicode\n');
  await mkdir(path.join(dir, 'sub'), { recursive: true });
  await writeFile(path.join(dir, 'sub', 'file.txt'), 'sub\n');
  await git(['add', '-A']);
  await git(['commit', '-m', 'init']);
  return { dir, git };
}

test('blame executes on valid odd paths in a temp repo', async () => {
  const { dir } = await makeTempRepo();
  try {
    for (const odd of ['.gitignore', 'space name.txt', 'ünicode-✓.txt', 'sub/file.txt']) {
      const args = gitArguments('blame', 'HEAD', odd);
      const { stdout } = await execFileAsync('git', args, { cwd: dir });
      assert.ok(stdout.trim().length > 0, `blame output for ${odd}`);
    }
    // Windows-style separator normalizes and still blames the same file.
    const args = gitArguments('blame', 'HEAD', 'sub\\file.txt');
    assert.equal(args[args.length - 1], 'sub/file.txt');
    const { stdout } = await execFileAsync('git', args, { cwd: dir });
    assert.match(stdout, /sub/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('diff stat executes against the HEAD baseline in a temp repo', async () => {
  const { dir } = await makeTempRepo();
  try {
    await appendFile(path.join(dir, 'space name.txt'), 'more\n');
    const args = gitArguments('stat', 'HEAD');
    assert.ok(args.includes('--no-ext-diff') && args.includes('--no-textconv') && args.includes('--no-color'));
    const { stdout } = await execFileAsync('git', args, { cwd: dir });
    assert.match(stdout, /space name\.txt/);
    assert.match(stdout, /1 file changed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
