import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  WORKER_GUARD_CHANNEL,
  branchSlug,
  piastraActivity,
  resolveWorktreePath,
  worktreeSwitchRefusal,
} from './git-worktree.ts';
import worktreeExtension from './git-worktree.ts';

function fakePi(guard) {
  const commands = new Map();
  const execCalls = [];
  const pi = {
    events: {
      emit(channel, data) {
        if (channel === WORKER_GUARD_CHANNEL && guard) Object.assign(data, guard);
      },
      on: () => () => {},
    },
    exec: async (command, args) => {
      execCalls.push({ command, args: [...args] });
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return { code: 0, stdout: 'true', stderr: '' };
      }
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { code: 0, stdout: 'C:/repo', stderr: '' };
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return { code: 0, stdout: JSON.stringify({ headRefName: 'feat-pr', title: 'PR title' }), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    registerCommand: (name, options) => { commands.set(name, options); },
    registerTool: () => {},
    registerShortcut: () => {},
    on: () => {},
  };
  return { pi, commands, execCalls };
}

function fakeCtx(notices) {
  return {
    cwd: 'C:/repo',
    mode: 'tui',
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { notify: (message, type = 'info') => notices.push({ message, type }) },
  };
}

test('/wt shares the worktree handler and argument completions', async () => {
  const { pi, commands } = fakePi(undefined);
  worktreeExtension(pi);
  const worktree = commands.get('worktree');
  const alias = commands.get('wt');

  assert.ok(alias);
  assert.equal(alias.handler, worktree.handler);
  assert.equal(alias.getArgumentCompletions, worktree.getArgumentCompletions);
  assert.deepEqual(alias.getArgumentCompletions(''),
    ['ls', 'add', 'open', 'rm', 'pr', 'resume', 'help'].map((value) => ({ value, label: value })));
  assert.deepEqual(alias.getArgumentCompletions('a'), [{ value: 'add', label: 'add' }]);
  assert.equal(alias.getArgumentCompletions('add feat/example'), null);

  const notices = [];
  await alias.handler('help', fakeCtx(notices));
  assert.match(notices[0].message, /\/wt is an alias for \/worktree/);
});

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

test('switching refuses while PiAstra reports workers, compaction, or a branch summary', () => {
  assert.equal(worktreeSwitchRefusal({ idle: true, pending: false, activeWorkers: 0 }), undefined);
  assert.match(
    worktreeSwitchRefusal({ idle: true, pending: false, activeWorkers: 0, compacting: true }),
    /compaction is still running/,
  );
  assert.match(
    worktreeSwitchRefusal({ idle: true, pending: false, activeWorkers: 0, summarizing: true }),
    /branch summary is still running/,
  );
  // The turn check stays first: a streaming turn is the stronger refusal.
  assert.match(
    worktreeSwitchRefusal({ idle: false, pending: false, activeWorkers: 0, compacting: true }),
    /current turn/,
  );
});

test('piastraActivity reads the optional phase flags and defaults unknown hosts to idle', () => {
  const busy = fakePi({ active: 2, busy: true, compacting: true, summarizing: false });
  assert.deepEqual(piastraActivity(busy.pi), { activeWorkers: 2, compacting: true, summarizing: false });

  const legacy = fakePi({ active: 1, busy: true });
  assert.deepEqual(piastraActivity(legacy.pi), { activeWorkers: 1, compacting: false, summarizing: false });

  const absent = fakePi(undefined);
  assert.deepEqual(piastraActivity(absent.pi), { activeWorkers: 0, compacting: false, summarizing: false });
});

test('/worktree pr refuses before gh or the first mutating fetch', async () => {
  const notices = [];
  const { pi, commands, execCalls } = fakePi({ active: 2, busy: true });
  worktreeExtension(pi);
  const ctx = fakeCtx(notices);

  await commands.get('worktree').handler('pr 5', ctx);

  assert.match(notices.map((entry) => entry.message).join('\n'), /2 PiAstra workers are still running/);
  assert.match(notices.map((entry) => entry.message).join('\n'), /The worktree was not created/);
  assert.ok(
    !execCalls.some((call) => call.command === 'gh'),
    `gh pr view must not run before the guard: ${JSON.stringify(execCalls)}`,
  );
  assert.ok(
    !execCalls.some((call) => call.command === 'git' && call.args[0] === 'fetch'),
    `no fetch may run before the guard: ${JSON.stringify(execCalls)}`,
  );
});

test('/worktree pr refuses during compaction before touching refs', async () => {
  const notices = [];
  const { pi, commands, execCalls } = fakePi({ active: 0, busy: true, compacting: true });
  worktreeExtension(pi);
  const ctx = fakeCtx(notices);

  await commands.get('worktree').handler('pr 5', ctx);

  assert.match(notices.map((entry) => entry.message).join('\n'), /compaction is still running/);
  assert.ok(!execCalls.some((call) => call.command === 'gh'));
  assert.ok(!execCalls.some((call) => call.command === 'git' && call.args[0] === 'fetch'));
});

test('/worktree rm refuses the worktree this session is running in', async () => {
  const notices = [];
  const { pi, commands, execCalls } = fakePi(undefined);
  const porcelain = [
    'worktree C:/repo/main',
    'HEAD aaaa',
    'branch refs/heads/main',
    '',
    'worktree C:/repo/feature',
    'HEAD bbbb',
    'branch refs/heads/feature',
    '',
  ].join('\n');
  const originalExec = pi.exec;
  pi.exec = async (command, args, options) => {
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'list') {
      return { code: 0, stdout: porcelain, stderr: '' };
    }
    return originalExec(command, args, options);
  };
  worktreeExtension(pi);
  const ctx = fakeCtx(notices);
  ctx.cwd = 'C:/repo/feature';

  await commands.get('worktree').handler('rm feature', ctx);

  assert.match(
    notices.map((entry) => entry.message).join('\n'),
    /Refusing to remove the worktree this session is running in/,
  );
  assert.ok(
    !execCalls.some((call) => call.command === 'git' && call.args[0] === 'worktree' && call.args[1] === 'remove'),
    `the running worktree must not be removed: ${JSON.stringify(execCalls)}`,
  );
});

test('/worktree rm refuses without interactive confirmation', async () => {
  const notices = [];
  const { pi, commands, execCalls } = fakePi(undefined);
  const porcelain = [
    'worktree C:/repo/main',
    'HEAD aaaa',
    'branch refs/heads/main',
    '',
    'worktree C:/repo/feature',
    'HEAD bbbb',
    'branch refs/heads/feature',
    '',
  ].join('\n');
  const originalExec = pi.exec;
  pi.exec = async (command, args, options) => {
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'list') {
      return { code: 0, stdout: porcelain, stderr: '' };
    }
    return originalExec(command, args, options);
  };
  worktreeExtension(pi);
  const ctx = fakeCtx(notices);
  ctx.hasUI = false;
  ctx.cwd = 'C:/repo/main';

  await commands.get('worktree').handler('rm feature', ctx);

  assert.match(
    notices.map((entry) => entry.message).join('\n'),
    /Refusing to remove a worktree without interactive confirmation/,
  );
  assert.ok(
    !execCalls.some((call) => call.command === 'git' && call.args[0] === 'worktree' && call.args[1] === 'remove'),
    `removal must not proceed without confirmation: ${JSON.stringify(execCalls)}`,
  );
});
