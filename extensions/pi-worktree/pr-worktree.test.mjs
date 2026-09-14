/**
 * Regression tests for Finding #3: `/worktree pr N` must resolve the PR head
 * through an immutable, dedicated ref and a dedicated local branch instead of
 * reusing the GitHub `headRefName` (which can collide with the base branch or
 * with an unrelated local worktree).
 *
 * Contract under test:
 *   - `gh pr view N --json ...` requests `headRefOid` and `headRefName`.
 *   - `git fetch origin refs/pull/N/head` writes a dedicated non-local-head
 *     ref `refs/piastra/pull/N/head` (force update of that dedicated ref is
 *     allowed; user branches are never fetched into).
 *   - The fetch must succeed and the fetched commit must equal `headRefOid`.
 *   - The working branch is always `piastra/pr/N`, never `headRefName`.
 *   - Lookups use exact branch identity only; the fuzzy slug matching in
 *     `findWorktree` must not open an unrelated worktree.
 *   - A pre-existing dedicated branch/worktree whose HEAD differs from the PR
 *     commit is preserved and refused; no resets/force moves.
 *   - A pre-existing dedicated worktree at the same commit may be reused.
 *   - A new branch starts at the verified immutable OID, and the target HEAD
 *     and branch are verified before activation.
 *   - Existing busy/queued guards run before gh/fetch, and a newly created
 *     worktree is kept when the session switch fails.
 *
 * The tests use real temporary Git repositories. Only `gh` and `bash`
 * (clipboard) are mocked; every `git` call runs the real binary through
 * `execFile`, exactly like production passes `{ cwd }`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import worktreeExtension, { resolveWorktreePath } from './git-worktree.ts';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/* Git helpers (real git, async, status captured like production)      */
/* ------------------------------------------------------------------ */

async function runGitRaw(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error.message ?? error),
    };
  }
}

async function gitOk(cwd, ...args) {
  const result = await runGitRaw(args, cwd);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (cwd=${cwd}, code=${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

async function gitHead(cwd) {
  return (await gitOk(cwd, 'rev-parse', 'HEAD')).trim();
}

async function gitBranch(cwd) {
  return (await gitOk(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
}

async function worktreeEntries(repo) {
  const porcelain = await gitOk(repo, 'worktree', 'list', '--porcelain');
  const entries = [];
  let current = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: null, branch: null };
      entries.push(current);
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function initRepo(base, name) {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await gitOk(dir, 'init', '-q', '-b', 'main');
  await gitOk(dir, 'config', 'user.email', 'test@example.com');
  await gitOk(dir, 'config', 'user.name', 'PiAstra Test');
  await gitOk(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/**
 * Bare origin with `refs/pull/<n>/head` for each requested PR number, a local
 * clone whose `main` is advanced by a divergent local commit, and the OIDs of
 * every PR head. The PR heads are only exposed as pull refs, so the local
 * `main` can never fast-forward to them: this models a fork PR whose
 * `headRefName` is itself `main`.
 */
async function createRepos(base, prNumbers) {
  const origin = join(base, 'origin.git');
  await mkdir(origin, { recursive: true });
  await gitOk(origin, 'init', '--bare', '-q', '-b', 'main');

  const seed = await initRepo(base, 'seed');
  await writeFile(join(seed, 'README.md'), '# base\n');
  await gitOk(seed, 'add', '.');
  await gitOk(seed, 'commit', '-q', '-m', 'base');
  const baseOid = await gitHead(seed);
  await gitOk(seed, 'remote', 'add', 'origin', origin);
  await gitOk(seed, 'push', '-q', 'origin', 'main');

  const repo = join(base, 'repo');
  await gitOk(base, 'clone', '-q', origin, repo);
  await gitOk(repo, 'config', 'user.email', 'test@example.com');
  await gitOk(repo, 'config', 'user.name', 'PiAstra Test');
  await gitOk(repo, 'config', 'commit.gpgsign', 'false');

  const prHeads = new Map();
  for (const n of prNumbers) {
    await writeFile(join(seed, `pr-${n}.txt`), `pr ${n}\n`);
    await gitOk(seed, 'add', '.');
    await gitOk(seed, 'commit', '-q', '-m', `pr ${n}`);
    const oid = await gitHead(seed);
    await gitOk(seed, 'push', '-q', 'origin', `HEAD:refs/pull/${n}/head`);
    prHeads.set(n, oid);
  }

  await writeFile(join(repo, 'local.txt'), 'local divergent\n');
  await gitOk(repo, 'add', '.');
  await gitOk(repo, 'commit', '-q', '-m', 'local divergent');
  const localOid = await gitHead(repo);
  const mainPath = (await gitOk(repo, 'rev-parse', '--show-toplevel')).trim();

  return { origin, seed, repo, baseOid, prHeads, localOid, mainPath };
}

/* ------------------------------------------------------------------ */
/* pi / ctx test doubles: git is real, gh + clipboard are mocked       */
/* ------------------------------------------------------------------ */

function createPi({ gh, guard } = {}) {
  const commands = new Map();
  const calls = [];
  const pi = {
    events: {
      emit(channel, data) {
        if (channel === 'piastra:worker-guard' && guard) Object.assign(data, guard);
      },
      on: () => () => {},
    },
    exec: async (command, args, options) => {
      const call = { command, args: [...args], cwd: options?.cwd };
      calls.push(call);
      if (command === 'git') return runGitRaw(args, options?.cwd);
      if (command === 'gh') {
        if (typeof gh === 'function') return gh(args);
        return gh ?? { code: 1, stdout: '', stderr: 'gh not configured' };
      }
      if (command === 'bash') {
        // Force the no-clipboard branch; the path is still reported.
        return { code: 1, stdout: '', stderr: 'no clipboard' };
      }
      return { code: 1, stdout: '', stderr: `unexpected command: ${command}` };
    },
    registerCommand: (name, options) => commands.set(name, options),
    registerTool() {},
    registerShortcut() {},
    on() {},
  };
  return { pi, commands, calls };
}

function ghResult(headRefOid, number, headRefName = 'main') {
  return {
    code: 0,
    stdout: JSON.stringify({
      headRefOid,
      headRefName,
      number,
      title: `PR ${number}`,
      isCrossRepository: true,
    }),
    stderr: '',
  };
}

function createRpcCtx(repo, notices) {
  return {
    cwd: repo,
    mode: 'rpc',
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      notify: (message, type = 'info') => notices.push({ message, type }),
      confirm: async () => false,
      select: async () => undefined,
      setStatus() {},
    },
  };
}

function createTuiCtx(repo, notices, { sourceFile, switchImpl } = {}) {
  return {
    cwd: repo,
    mode: 'tui',
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionFile: () => sourceFile },
    ui: {
      notify: (message, type = 'info') => notices.push({ message, type }),
      confirm: async () => true,
      select: async () => undefined,
      setStatus() {},
    },
    switchSession: switchImpl,
  };
}

async function runPr(commands, number, ctx) {
  await commands.get('worktree').handler(`pr ${number}`, ctx);
}

/* ------------------------------------------------------------------ */
/* Assertion helpers                                                   */
/* ------------------------------------------------------------------ */

function noticeText(notices) {
  return notices.map((entry) => entry.message).join('\n');
}

function assertNotActivated(notices, context = '') {
  const activated = notices.filter(
    (entry) =>
      /Started a fresh session in/.test(entry.message) ||
      /^(Created|Worktree):/.test(entry.message),
  );
  assert.equal(
    activated.length,
    0,
    `${context} should not activate a worktree:\n${noticeText(notices)}`,
  );
}

function ghJsonFields(calls) {
  const call = calls.find(
    (entry) => entry.command === 'gh' && entry.args[0] === 'pr' && entry.args[1] === 'view',
  );
  assert.ok(call, `expected a gh pr view call, got: ${JSON.stringify(calls)}`);
  const index = call.args.indexOf('--json');
  assert.notEqual(index, -1, 'gh pr view must use --json');
  return call.args[index + 1].split(',').map((field) => field.trim());
}

function prFetchCalls(calls, number) {
  const source = new RegExp(`pull/${number}/head`);
  return calls.filter(
    (entry) =>
      entry.command === 'git' &&
      entry.args[0] === 'fetch' &&
      entry.args.some((arg) => source.test(arg)),
  );
}

function assertDedicatedFetch(calls, number, headRefName = 'main') {
  const fetches = prFetchCalls(calls, number);
  assert.ok(
    fetches.length >= 1,
    `expected a fetch of the PR head for #${number}:\n${JSON.stringify(calls)}`,
  );
  const dedicated = new RegExp(`refs/piastra/pull/${number}/head`);
  assert.ok(
    fetches.some((entry) => entry.args.some((arg) => dedicated.test(arg))),
    `fetch must write refs/piastra/pull/${number}/head:\n${JSON.stringify(fetches)}`,
  );
  for (const entry of fetches) {
    for (const arg of entry.args) {
      const colon = arg.lastIndexOf(':');
      if (colon < 0) continue;
      const dest = arg.slice(colon + 1).replace(/^\+/, '');
      assert.ok(
        !/^refs\/heads\//.test(dest),
        `fetch must never write a local head (${dest}):\n${JSON.stringify(entry)}`,
      );
      assert.notEqual(
        dest,
        headRefName,
        `fetch must never target the PR headRefName (${headRefName}):\n${JSON.stringify(entry)}`,
      );
    }
  }
}

function assertNoDestructiveCalls(calls) {
  for (const entry of calls) {
    if (entry.command !== 'git') continue;
    const [sub, ...rest] = entry.args;
    assert.notEqual(sub, 'reset', `no git reset is permitted: ${JSON.stringify(entry)}`);
    assert.notEqual(sub, 'clean', `no git clean is permitted: ${JSON.stringify(entry)}`);
    if (sub === 'branch' || sub === 'checkout' || sub === 'switch') {
      assert.ok(
        !rest.includes('-f') && !rest.includes('--force'),
        `no forced ${sub} is permitted: ${JSON.stringify(entry)}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Environment isolation                                               */
/* ------------------------------------------------------------------ */

function saveEnv() {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function prepareEnvironment(base) {
  const home = join(base, 'home');
  const agentDir = join(base, 'agent');
  await mkdir(home, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { home, agentDir };
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

test('/worktree pr creates piastra/pr/N at the PR OID without touching a colliding checked-out main', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    await prepareEnvironment(base);
    const { repo, prHeads, localOid, mainPath } = await createRepos(base, [101]);
    const prOid = prHeads.get(101);

    const { pi, commands, calls } = createPi({ gh: ghResult(prOid, 101, 'main') });
    worktreeExtension(pi);
    const notices = [];

    await runPr(commands, 101, createRpcCtx(repo, notices));

    const expectedPath = resolveWorktreePath(mainPath, 'piastra/pr/101');
    assert.equal(await gitHead(expectedPath), prOid, 'worktree is checked out at the PR OID');
    assert.equal(await gitBranch(expectedPath), 'piastra/pr/101', 'working branch ignores headRefName');

    // The colliding checked-out main is untouched: same commit, same branch.
    assert.equal(await gitHead(repo), localOid, 'local main commit is unchanged');
    assert.equal(await gitBranch(repo), 'main');
    assert.equal((await gitOk(repo, 'rev-parse', 'refs/heads/main')).trim(), localOid);

    const fields = ghJsonFields(calls);
    assert.ok(fields.includes('headRefOid'), `gh JSON must request headRefOid: ${fields}`);
    assert.ok(fields.includes('headRefName'), `gh JSON must request headRefName: ${fields}`);
    assertDedicatedFetch(calls, 101, 'main');
    assertNoDestructiveCalls(calls);

    assert.ok(noticeText(notices).includes(expectedPath), 'created path is reported');
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr stores the PR head in refs/piastra/pull/N/head and never in a local head', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    await prepareEnvironment(base);
    const { repo, prHeads, mainPath } = await createRepos(base, [202]);
    const prOid = prHeads.get(202);

    const { pi, commands, calls } = createPi({ gh: ghResult(prOid, 202, 'main') });
    worktreeExtension(pi);
    const notices = [];

    await runPr(commands, 202, createRpcCtx(repo, notices));

    const dedicated = (await gitOk(repo, 'rev-parse', 'refs/piastra/pull/202/head')).trim();
    assert.equal(dedicated, prOid, 'dedicated ref holds the fetched PR commit');

    // The dedicated local branch exists, and no branch named after headRefName
    // or the raw pull ref was created for the PR.
    const heads = (await gitOk(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads'))
      .split('\n')
      .filter(Boolean);
    assert.ok(heads.includes('refs/heads/piastra/pr/202'), 'the dedicated local branch exists');
    assert.ok(!heads.includes('refs/heads/pull/202/head'));
    assert.ok(heads.includes('refs/heads/main'), 'the base branch is still present');

    assertDedicatedFetch(calls, 202, 'main');
    assertNoDestructiveCalls(calls);

    const expectedPath = resolveWorktreePath(mainPath, 'piastra/pr/202');
    assert.equal(await gitHead(expectedPath), prOid);
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr fails closed when the fetched head does not match gh headRefOid', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    await prepareEnvironment(base);
    const { repo, prHeads, mainPath } = await createRepos(base, [303]);
    const realPrOid = prHeads.get(303);
    const bogusOid = '1234567890abcdef1234567890abcdef12345678';

    const { pi, commands, calls } = createPi({ gh: ghResult(bogusOid, 303, 'main') });
    worktreeExtension(pi);
    const notices = [];

    await runPr(commands, 303, createRpcCtx(repo, notices));

    const expectedPath = resolveWorktreePath(mainPath, 'piastra/pr/303');
    const entries = await worktreeEntries(repo);
    assert.ok(
      !entries.some((entry) => entry.path === expectedPath),
      'no worktree is created when the fetched commit is not the expected OID',
    );
    assertNotActivated(notices, 'mismatched fetch');
    assert.ok(
      notices.some((entry) => entry.type === 'error' || entry.type === 'warning'),
      `a clear refusal is reported:\n${noticeText(notices)}`,
    );
    assertDedicatedFetch(calls, 303, 'main');
    // If the fetched dedicated ref was kept, it must hold the real commit, not
    // the bogus OID gh claimed: the comparison is what failed the flow closed.
    const fetched = await runGitRaw(
      ['rev-parse', '--verify', '--quiet', 'refs/piastra/pull/303/head'],
      repo,
    );
    if (fetched.code === 0) {
      assert.equal(fetched.stdout.trim(), realPrOid);
      assert.notEqual(fetched.stdout.trim(), bogusOid);
    }
    assertNoDestructiveCalls(calls);
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr never activates an existing dedicated branch/worktree when the fetch fails', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    await prepareEnvironment(base);
    const { origin, repo, prHeads, mainPath } = await createRepos(base, [404]);
    const prOid = prHeads.get(404);
    const expectedPath = resolveWorktreePath(mainPath, 'piastra/pr/404');

    const first = createPi({ gh: ghResult(prOid, 404, 'main') });
    worktreeExtension(first.pi);
    await runPr(first.commands, 404, createRpcCtx(repo, []));
    assert.equal(await gitHead(expectedPath), prOid, 'first run creates the verified worktree');

    // Break the origin source ref so the second fetch fails even though the
    // dedicated branch and worktree already exist locally.
    await gitOk(origin, 'update-ref', '-d', 'refs/pull/404/head');

    const second = createPi({ gh: ghResult(prOid, 404, 'main') });
    worktreeExtension(second.pi);
    const notices = [];

    await runPr(second.commands, 404, createRpcCtx(repo, notices));

    assertNotActivated(notices, 'failed fetch with an existing worktree');
    assert.ok(
      notices.some((entry) => entry.type === 'error' || entry.type === 'warning'),
      `fetch failure is reported:\n${noticeText(notices)}`,
    );
    assert.equal(await gitHead(expectedPath), prOid, 'existing worktree is preserved');
    assert.equal(await gitBranch(expectedPath), 'piastra/pr/404');
    assertNoDestructiveCalls(second.calls);
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr reuses an already verified same-commit dedicated worktree', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    await prepareEnvironment(base);
    const { repo, prHeads, mainPath } = await createRepos(base, [505]);
    const prOid = prHeads.get(505);
    const expectedPath = resolveWorktreePath(mainPath, 'piastra/pr/505');

    const first = createPi({ gh: ghResult(prOid, 505, 'main') });
    worktreeExtension(first.pi);
    await runPr(first.commands, 505, createRpcCtx(repo, []));

    const afterFirst = await worktreeEntries(repo);
    const matches = afterFirst.filter((entry) => entry.branch === 'piastra/pr/505');
    assert.equal(matches.length, 1);

    const second = createPi({ gh: ghResult(prOid, 505, 'main') });
    worktreeExtension(second.pi);
    const notices = [];
    await runPr(second.commands, 505, createRpcCtx(repo, notices));

    const afterSecond = await worktreeEntries(repo);
    assert.equal(
      afterSecond.filter((entry) => entry.branch === 'piastra/pr/505').length,
      1,
      'the repeat run reuses the existing worktree instead of creating another',
    );
    assert.equal(await gitHead(expectedPath), prOid);
    assert.equal(
      notices.filter((entry) => entry.type === 'error').length,
      0,
      `reuse must not report an error:\n${noticeText(notices)}`,
    );
    // Git's porcelain paths use forward slashes even on Windows.
    assert.ok(noticeText(notices).replaceAll('\\', '/').includes(expectedPath.replaceAll('\\', '/')), 'the reused path is reported');
    assertNoDestructiveCalls(second.calls);
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr refuses and preserves a diverged dedicated worktree', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    await prepareEnvironment(base);
    const { repo, prHeads, baseOid, mainPath } = await createRepos(base, [606]);
    const prOid = prHeads.get(606);
    const expectedPath = resolveWorktreePath(mainPath, 'piastra/pr/606');

    // Pre-existing dedicated worktree already parked on a different commit.
    await gitOk(repo, 'worktree', 'add', '-q', '-b', 'piastra/pr/606', expectedPath, baseOid);
    assert.equal(await gitHead(expectedPath), baseOid);
    assert.notEqual(baseOid, prOid);

    const { pi, commands, calls } = createPi({ gh: ghResult(prOid, 606, 'main') });
    worktreeExtension(pi);
    const notices = [];

    await runPr(commands, 606, createRpcCtx(repo, notices));

    assert.equal(await gitHead(expectedPath), baseOid, 'diverged dedicated worktree is not reset');
    assert.equal(await gitBranch(expectedPath), 'piastra/pr/606');
    assertNotActivated(notices, 'diverged dedicated worktree');
    assert.ok(
      notices.some((entry) => entry.type === 'error' || entry.type === 'warning'),
      `a clear refusal is reported:\n${noticeText(notices)}`,
    );
    assertNoDestructiveCalls(calls);
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr refuses and preserves a diverged dedicated branch without a worktree', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    await prepareEnvironment(base);
    const { repo, prHeads, baseOid, mainPath } = await createRepos(base, [707]);
    const prOid = prHeads.get(707);
    const expectedPath = resolveWorktreePath(mainPath, 'piastra/pr/707');

    await gitOk(repo, 'branch', 'piastra/pr/707', baseOid);
    assert.notEqual(baseOid, prOid);

    const { pi, commands, calls } = createPi({ gh: ghResult(prOid, 707, 'main') });
    worktreeExtension(pi);
    const notices = [];

    await runPr(commands, 707, createRpcCtx(repo, notices));

    assert.equal(
      (await gitOk(repo, 'rev-parse', 'refs/heads/piastra/pr/707')).trim(),
      baseOid,
      'the diverged dedicated branch is not force-moved',
    );
    const entries = await worktreeEntries(repo);
    assert.ok(
      !entries.some((entry) => entry.path === expectedPath),
      'no worktree is created on top of the diverged branch',
    );
    assertNotActivated(notices, 'diverged dedicated branch');
    assert.ok(
      notices.some((entry) => entry.type === 'error' || entry.type === 'warning'),
      `a clear refusal is reported:\n${noticeText(notices)}`,
    );
    assertNoDestructiveCalls(calls);
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr keeps two PRs that share headRefName main separate', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    await prepareEnvironment(base);
    const { repo, prHeads, localOid, mainPath } = await createRepos(base, [808, 809]);
    const firstOid = prHeads.get(808);
    const secondOid = prHeads.get(809);
    assert.notEqual(firstOid, secondOid);

    const first = createPi({ gh: ghResult(firstOid, 808, 'main') });
    worktreeExtension(first.pi);
    await runPr(first.commands, 808, createRpcCtx(repo, []));

    const second = createPi({ gh: ghResult(secondOid, 809, 'main') });
    worktreeExtension(second.pi);
    await runPr(second.commands, 809, createRpcCtx(repo, []));

    const firstPath = resolveWorktreePath(mainPath, 'piastra/pr/808');
    const secondPath = resolveWorktreePath(mainPath, 'piastra/pr/809');
    assert.notEqual(firstPath, secondPath);
    assert.equal(await gitHead(firstPath), firstOid);
    assert.equal(await gitBranch(firstPath), 'piastra/pr/808');
    assert.equal(await gitHead(secondPath), secondOid);
    assert.equal(await gitBranch(secondPath), 'piastra/pr/809');

    // Both PRs report headRefName "main"; the shared base branch is untouched.
    assert.equal(await gitHead(repo), localOid);
    assert.equal(await gitBranch(repo), 'main');
    assertNoDestructiveCalls([...first.calls, ...second.calls]);
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr does not open a slug-alias branch worktree', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    await prepareEnvironment(base);
    const { repo, prHeads, baseOid, mainPath } = await createRepos(base, [910]);
    const prOid = prHeads.get(910);

    // `branchSlug('piastra/pr/910') === 'piastra-pr-910'`, an unrelated branch
    // with the literal dashed name must never be selected.
    const unrelatedPath = join(base, 'unrelated alias');
    await gitOk(repo, 'worktree', 'add', '-q', '-b', 'piastra-pr-910', unrelatedPath, baseOid);

    const { pi, commands, calls } = createPi({ gh: ghResult(prOid, 910, 'main') });
    worktreeExtension(pi);
    const notices = [];

    await runPr(commands, 910, createRpcCtx(repo, notices));

    const expectedPath = resolveWorktreePath(mainPath, 'piastra/pr/910');
    assert.equal(await gitHead(expectedPath), prOid, 'a fresh exact-identity worktree is created');
    assert.equal(await gitBranch(expectedPath), 'piastra/pr/910');

    // The unrelated worktree is untouched and was not activated.
    assert.equal(await gitHead(unrelatedPath), baseOid, 'unrelated alias worktree is unchanged');
    assert.equal(await gitBranch(unrelatedPath), 'piastra-pr-910');
    assert.ok(
      !notices.some((entry) => entry.message.includes(unrelatedPath)),
      `the unrelated alias worktree must not be opened:\n${noticeText(notices)}`,
    );
    assert.ok(noticeText(notices).includes(expectedPath), 'the exact-identity path is reported');
    assertNoDestructiveCalls(calls);
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr does not open a slug-alias worktree occupying the managed path', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    await prepareEnvironment(base);
    const { repo, prHeads, baseOid, mainPath } = await createRepos(base, [911]);
    const prOid = prHeads.get(911);

    // The managed path for piastra/pr/911 is also the slug path of the literal
    // branch piastra-pr-911. Park that unrelated worktree exactly there.
    const expectedPath = resolveWorktreePath(mainPath, 'piastra/pr/911');
    await gitOk(repo, 'worktree', 'add', '-q', '-b', 'piastra-pr-911', expectedPath, baseOid);

    const { pi, commands, calls } = createPi({ gh: ghResult(prOid, 911, 'main') });
    worktreeExtension(pi);
    const notices = [];

    await runPr(commands, 911, createRpcCtx(repo, notices));

    assert.equal(await gitHead(expectedPath), baseOid, 'the path-occupying worktree is preserved');
    assert.equal(await gitBranch(expectedPath), 'piastra-pr-911');
    const activated = notices.filter((entry) =>
      /Started a fresh session in|^(Created|Worktree):/.test(entry.message),
    );
    for (const entry of activated) {
      assert.ok(
        !entry.message.includes('piastra-pr-911') && !entry.message.includes(expectedPath),
        `the unrelated path-occupying worktree must not be activated:\n${entry.message}`,
      );
    }
    const entries = await worktreeEntries(repo);
    for (const entry of entries) {
      if (entry.branch === 'piastra/pr/911') {
        assert.notEqual(entry.path, expectedPath, 'a fresh worktree is never mapped onto the alias path');
      }
    }
    assertNoDestructiveCalls(calls);
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr refuses before gh or fetch while PiAstra workers are busy', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    const { agentDir } = await prepareEnvironment(base);
    const { repo } = await createRepos(base, [1012]);

    const { pi, commands, calls } = createPi({ guard: { active: 2, busy: true } });
    worktreeExtension(pi);
    const notices = [];
    const switchCalls = [];
    // The busy guard is part of the interactive switch preflight; use tui and
    // fail the test if the switch is ever reached.
    const ctx = createTuiCtx(repo, notices, {
      sourceFile: join(agentDir, 'source.jsonl'),
      switchImpl: async (sessionPath, options) => {
        switchCalls.push({ sessionPath, options });
        return { cancelled: false };
      },
    });

    await runPr(commands, 1012, ctx);

    assert.match(noticeText(notices), /2 PiAstra workers are still running/);
    assert.equal(switchCalls.length, 0, 'the session switch must not be reached');
    assert.ok(
      !calls.some((entry) => entry.command === 'gh'),
      `gh must not run before the guard:\n${JSON.stringify(calls)}`,
    );
    assert.ok(
      !calls.some((entry) => entry.command === 'git' && entry.args[0] === 'fetch'),
      `no fetch may run before the guard:\n${JSON.stringify(calls)}`,
    );
    assertNotActivated(notices, 'busy guard');
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr reuses a verified branch without an existing worktree', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    await prepareEnvironment(base);
    const { repo, prHeads, mainPath } = await createRepos(base, [1214]);
    const prOid = prHeads.get(1214);
    await gitOk(repo, 'fetch', 'origin', 'refs/pull/1214/head');
    await gitOk(repo, 'branch', 'piastra/pr/1214', prOid);
    const { pi, commands } = createPi({ gh: ghResult(prOid, 1214) });
    worktreeExtension(pi);
    const notices = [];
    await runPr(commands, 1214, createRpcCtx(repo, notices));
    const target = resolveWorktreePath(mainPath, 'piastra/pr/1214');
    assert.equal(await gitHead(target), prOid);
    assert.equal(await gitBranch(target), 'piastra/pr/1214');
    assert.equal(notices.filter(n => n.type === 'error').length, 0, noticeText(notices));
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr verifies the actual checked-out branch even when the commit still matches', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    await prepareEnvironment(base);
    const { repo, prHeads, mainPath } = await createRepos(base, [1215]);
    const prOid = prHeads.get(1215);
    const { pi, commands } = createPi({ gh: ghResult(prOid, 1215) });
    const originalExec = pi.exec;
    let changedCheckout = false;
    pi.exec = async (command, args, options) => {
      const result = await originalExec(command, args, options);
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add' && result.code === 0) {
        // Simulate another Git client changing the checkout before activation.
        // HEAD's commit remains identical, but the branch identity is wrong.
        const target = resolveWorktreePath(mainPath, 'piastra/pr/1215');
        await gitOk(target, 'switch', '-q', '-c', 'another-branch');
        changedCheckout = true;
      }
      return result;
    };
    worktreeExtension(pi);
    const notices = [];
    await runPr(commands, 1215, createRpcCtx(repo, notices));
    assert.equal(changedCheckout, true);
    assertNotActivated(notices, 'checkout changed concurrently');
    assert.match(noticeText(notices), /Refusing to open|no longer matches/);
    assert.equal(await gitHead(resolveWorktreePath(mainPath, 'piastra/pr/1215')), prOid);
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('/worktree pr keeps a newly created worktree when the session switch fails', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-pr-'));
  const saved = saveEnv();
  try {
    const { agentDir } = await prepareEnvironment(base);
    const { repo, prHeads, mainPath } = await createRepos(base, [1113]);
    const prOid = prHeads.get(1113);
    const sourceFile = join(agentDir, 'source.jsonl');
    await writeFile(sourceFile, '{"type":"session"}\n');

    const switchCalls = [];
    const { pi, commands, calls } = createPi({ gh: ghResult(prOid, 1113, 'main') });
    worktreeExtension(pi);
    const notices = [];
    const ctx = createTuiCtx(repo, notices, {
      sourceFile,
      switchImpl: async (sessionPath, options) => {
        switchCalls.push({ sessionPath, options });
        throw new Error('synthetic switch failure');
      },
    });

    await runPr(commands, 1113, ctx);

    const expectedPath = resolveWorktreePath(mainPath, 'piastra/pr/1113');
    assert.equal(switchCalls.length, 1, 'the switch was attempted');
    assert.equal(await gitHead(expectedPath), prOid, 'the new worktree is kept after the failure');
    assert.equal(await gitBranch(expectedPath), 'piastra/pr/1113');
    const text = noticeText(notices);
    assert.match(text, /Fresh worktree session did not start|did not start|synthetic switch failure/);
    assert.ok(text.includes(expectedPath), 'the kept path is reported for recovery');
    assertNoDestructiveCalls(calls);
  } finally {
    restoreEnv(saved);
    await rm(base, { recursive: true, force: true });
  }
});
