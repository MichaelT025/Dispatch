import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { branchSlug, resolveWorktreePath } from './git-worktree.ts';

test('branch slugs are safe for Windows directory names', () => {
  assert.equal(branchSlug('Feature/Windows: names?'), 'feature-windows-names');
  assert.equal(branchSlug('refs/heads/Fix\\login'), 'fix-login');
  assert.match(branchSlug('---'), /^branch-[0-9a-f]{6}$/);
});

test('branch slugs remain distinct and Windows-safe for Unicode and reserved names', () => {
  const unicode = branchSlug('修复');
  assert.match(unicode, /^branch-[0-9a-f]{6}$/);
  assert.notEqual(unicode, branchSlug('功能'));
  for (const branch of ['CON', 'aux.txt', 'NuL', 'COM1.md', 'lpt9']) {
    assert.match(branchSlug(branch), /^branch-[0-9a-f]{6}$/);
  }
  assert.equal(branchSlug('refs/heads/修复'), unicode);
});

test('default worktree path is portable under homedir/.pi/worktrees', () => {
  assert.equal(
    resolveWorktreePath('C:/src/PiAstra', 'feat/piastra-cli', 'C:/Users/tester'),
    path.join('C:/Users/tester', '.pi', 'worktrees', 'PiAstra', 'feat-piastra-cli'),
  );
});
