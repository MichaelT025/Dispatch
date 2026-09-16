import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, dirname } from 'node:path';

// Windows can report os.tmpdir() through an 8.3 short name while git and the
// session runtime return the long canonical path. Canonicalize both sides of
// path assertions so they survive that difference on Windows runners.
const resolve = (...segments) => {
  const absolute = resolvePath(...segments);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
};
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
} from '@earendil-works/pi-coding-agent';
import {
  activePiastraWorkers,
  persistFreshSessionHeader,
  piastraActivity,
  worktreeSwitchRefusal,
} from './git-worktree.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const worktreeExtension = join(root, 'extensions', 'pi-worktree', 'git-worktree.ts');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true }).toString();
}

async function makeRepo(base, name) {
  const repo = join(base, name);
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'PiAstra Test');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

function addWorktree(repo, worktreePath, branch) {
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktreePath);
}

function messageText(message) {
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((block) => block.text).join('');
}

function seedConversation(manager, exchanges = 1) {
  for (let index = 0; index < exchanges; index += 1) {
    manager.appendMessage({ role: 'user', content: `question ${index + 1}`, timestamp: Date.now() });
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `answer ${index + 1}` }],
      api: 'openai-codex',
      provider: 'openai-codex',
      model: 'gpt-6-astra',
      usage: {},
      stopReason: 'stop',
      timestamp: Date.now(),
    });
  }
}

async function makeAgentDir(base, extraExtensions = []) {
  const agentDir = join(base, 'agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'openai-codex',
    defaultModel: 'gpt-6-astra',
    defaultThinkingLevel: 'low',
    extensions: [worktreeExtension, ...extraExtensions],
  }, null, 2) + '\n');
  // Synthetic, non-functional credentials: no provider request is made.
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
    'openai-codex': { type: 'api_key', key: 'sk-synthetic-test' },
  }, null, 2) + '\n');
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: {} }) + '\n');
  return agentDir;
}

async function writeExtension(base, name, source) {
  const dir = join(base, 'extensions');
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, source + '\n');
  return file;
}

async function listJsonl(dir) {
  const found = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.jsonl')) found.push(full);
    }
  };
  await walk(dir);
  return found.sort();
}

const whereamiExtension = `
export default function (pi) {
  pi.registerCommand('whereami', {
    description: 'Report the extension command cwd',
    handler: async (_args, ctx) => ctx.ui.notify('cwd:' + ctx.cwd, 'info'),
  });
}`;

const busyWorkerExtension = `
export default function (pi) {
  pi.events.on('piastra:worker-guard', request => {
    if (request && request.type === 'query') { request.active = 2; request.busy = true; }
  });
}`;

const compactingGuardExtension = `
export default function (pi) {
  pi.events.on('piastra:worker-guard', request => {
    if (request && request.type === 'query') { request.compacting = true; request.busy = true; }
  });
}`;

// Reports idle for the creation preflight, then busy for the switch re-check.
const lateBusyExtension = `
let queries = 0;
export default function (pi) {
  pi.events.on('piastra:worker-guard', request => {
    if (request && request.type === 'query') {
      queries += 1;
      if (queries > 1) { request.active = 1; request.busy = true; }
    }
  });
}`;

const cancelSwitchExtension = `
export default function (pi) {
  pi.on('session_before_switch', async () => ({ cancel: true }));
}`;

/**
 * Build a real interactive runtime around the worktree extension.
 *
 * `trustFactory` mimics the production host wrapper that attaches a
 * cwd-aware project-trust context to ctx.switchSession. `switchSessionOverride`
 * lets a test observe the exact extension call or fail the switch.
 */
async function createHarness({
  repo,
  agentDir,
  mode = 'tui',
  manager,
  trustFactory,
  switchSessionOverride,
}) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sessionManager = manager ?? SessionManager.create(repo);
  const notifications = [];
  const errors = [];
  const switchCalls = [];
  const trustContexts = [];
  const ui = {
    notify: (message, type = 'info') => { notifications.push({ message, type }); },
    select: async () => undefined,
    confirm: async () => false,
    setStatus: () => {},
  };
  const createRuntime = async ({ cwd, sessionManager: replacementManager, sessionStartEvent, projectTrustContext }) => {
    trustContexts.push(projectTrustContext);
    const services = await createAgentSessionServices({ cwd, agentDir });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: replacementManager,
      sessionStartEvent,
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: repo,
    agentDir,
    sessionManager,
  });
  const commandContextActions = {
    waitForIdle: () => runtime.session.waitForIdle(),
    newSession: (options) => runtime.newSession(options),
    fork: (entryId, options) => runtime.fork(entryId, options),
    navigateTree: (targetId, options) => runtime.session.navigateTree(targetId, options),
    switchSession: async (sessionPath, options) => {
      const extensionOptions = options ?? {};
      switchCalls.push({ sessionPath, options: extensionOptions });
      if (switchSessionOverride) {
        return switchSessionOverride({ runtime, sessionPath, options: extensionOptions });
      }
      const forwarded = { ...extensionOptions };
      if (trustFactory) forwarded.projectTrustContextFactory = trustFactory;
      return runtime.switchSession(sessionPath, forwarded);
    },
    reload: async () => {},
  };
  const bind = (session) => session.bindExtensions({
    uiContext: ui,
    mode,
    commandContextActions,
    onError: (error) => errors.push(error),
  });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  return {
    runtime,
    ui,
    notifications,
    errors,
    switchCalls,
    trustContexts,
    text: () => notifications.map((entry) => entry.message).join('\n'),
    newText: (mark) => notifications.slice(mark).map((entry) => entry.message).join('\n'),
    dispose: () => runtime.dispose(),
  };
}

test('a fresh session header is written exclusively into the per-cwd session directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const agentDir = join(base, 'agent');
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const worktreePath = join(base, 'work tree with spaces');
    await mkdir(worktreePath, { recursive: true });

    const manager = SessionManager.create(worktreePath);
    const created = await persistFreshSessionHeader(manager);

    const text = await readFile(created.file, 'utf8');
    assert.equal(text, created.line);
    const lines = text.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const header = JSON.parse(lines[0]);
    assert.equal(header.type, 'session');
    assert.equal(header.version, 3);
    assert.equal(header.id, manager.getSessionId());
    assert.equal(resolve(header.cwd), resolve(worktreePath));
    assert.equal(header.parentSession, undefined);
    assert.ok(resolve(created.file).startsWith(resolve(agentDir, 'sessions')));

    // Exclusive create: the reserved file is never clobbered.
    await assert.rejects(persistFreshSessionHeader(manager), /EEXIST/);

    const reopened = SessionManager.open(created.file);
    assert.equal(resolve(reopened.getCwd()), resolve(worktreePath));
    assert.deepEqual(reopened.getEntries(), []);
    assert.deepEqual(reopened.buildSessionContext().messages, []);

    // Standard per-cwd and global /resume discovery both find the file.
    const listed = await SessionManager.list(worktreePath);
    assert.ok(listed.some((session) => resolve(session.path) === resolve(created.file)));
    const all = await SessionManager.listAll();
    assert.ok(all.some((session) => resolve(session.path) === resolve(created.file)));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('open starts a fresh empty session in the worktree and keeps the original saved', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'my repo');
    const worktreePath = join(base, 'work trees', 'feat-x');
    addWorktree(repo, worktreePath, 'feat-x');
    const whereami = await writeExtension(base, 'whereami.ts', whereamiExtension);
    const agentDir = await makeAgentDir(base, [whereami]);
    const harness = await createHarness({ repo, agentDir });
    try {
      const source = harness.runtime.session.sessionManager;
      seedConversation(source, 2);
      const sourceFile = source.getSessionFile();
      const sourceBefore = await readFile(sourceFile, 'utf8');

      await harness.runtime.session.prompt('/worktree open feat-x');

      const replacement = harness.runtime.session.sessionManager;
      assert.equal(resolve(replacement.getCwd()), resolve(worktreePath));
      assert.equal(harness.runtime.services.cwd, resolve(worktreePath));
      assert.notEqual(replacement.getSessionFile(), sourceFile);
      assert.ok(existsSync(replacement.getSessionFile()));

      const header = replacement.getHeader();
      assert.equal(resolve(header.cwd), resolve(worktreePath));
      assert.equal(header.parentSession, undefined, 'fresh session is not forked from the source');
      assert.notEqual(replacement.getSessionId(), source.getSessionId());
      assert.deepEqual(replacement.buildSessionContext().messages, []);
      assert.ok(
        !replacement.getEntries().some((entry) => entry.type === 'message'),
        'no source messages are copied',
      );

      // The previous conversation stays saved and untouched.
      assert.equal(await readFile(sourceFile, 'utf8'), sourceBefore);
      assert.deepEqual(source.buildSessionContext().messages.map(messageText), [
        'question 1',
        'answer 1',
        'question 2',
        'answer 2',
      ]);

      assert.match(harness.text(), /Started a fresh session in feat-x/);
      assert.match(harness.text(), /The earlier conversation stays saved at:/);
      assert.ok(harness.text().includes(sourceFile), 'recovery path is shown');
      assert.ok(
        harness.text().includes(replacement.getSessionFile()),
        'the prepared session file is shown before/after the switch',
      );

      // Extension ctx.cwd is rebuilt for the replacement session, not faked.
      await harness.runtime.session.prompt('/whereami');
      assert.match(harness.notifications.at(-1).message, /^cwd:/);
      assert.equal(harness.notifications.at(-1).message.slice(4), resolve(worktreePath));
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('add creates a managed worktree and starts a fresh session there', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    const home = join(base, 'home');
    await mkdir(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const repo = await makeRepo(base, 'add repo');
    const agentDir = await makeAgentDir(base);
    const harness = await createHarness({ repo, agentDir });
    try {
      const source = harness.runtime.session.sessionManager;
      seedConversation(source, 1);
      const sourceFile = source.getSessionFile();

      await harness.runtime.session.prompt('/worktree add feat-new');

      const managedPath = join(home, '.pi', 'worktrees', 'add repo', 'feat-new');
      const replacement = harness.runtime.session.sessionManager;
      assert.equal(resolve(replacement.getCwd()), resolve(managedPath));
      assert.ok(git(managedPath, 'rev-parse', '--is-inside-work-tree').trim() === 'true');
      assert.deepEqual(replacement.buildSessionContext().messages, []);
      assert.equal(resolve(replacement.getHeader().cwd), resolve(managedPath));
      assert.equal(replacement.getHeader().parentSession, undefined);
      assert.notEqual(replacement.getSessionFile(), sourceFile);
      assert.match(harness.text(), /Started a fresh session in new worktree feat-new/);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    if (previousHome.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome.HOME;
    if (previousHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousHome.USERPROFILE;
    await rm(base, { recursive: true, force: true });
  }
});

test('add and the bare branch form both start a fresh session in an existing worktree', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'existing repo');
    const existingPath = join(base, 'existing worktree');
    addWorktree(repo, existingPath, 'feat-existing');
    const agentDir = await makeAgentDir(base);
    const harness = await createHarness({ repo, agentDir });
    try {
      const source = harness.runtime.session.sessionManager;
      seedConversation(source, 1);
      const firstSession = source.getSessionFile();

      await harness.runtime.session.prompt('/worktree add feat-existing');
      let replacement = harness.runtime.session.sessionManager;
      assert.equal(resolve(replacement.getCwd()), resolve(existingPath));
      assert.deepEqual(replacement.buildSessionContext().messages, []);
      assert.notEqual(replacement.getSessionFile(), firstSession);
      assert.match(harness.text(), /Started a fresh session in feat-existing/);

      // The default `/worktree <branch>` form resolves through the same add path.
      const secondSession = replacement.getSessionFile();
      await harness.runtime.session.prompt('/worktree feat-existing');
      replacement = harness.runtime.session.sessionManager;
      assert.equal(resolve(replacement.getCwd()), resolve(existingPath));
      assert.deepEqual(replacement.buildSessionContext().messages, []);
      assert.notEqual(replacement.getSessionFile(), secondSession);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a worktree picked from bare /worktree or /worktree ls starts a fresh session there', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'picker repo');
    const pickerPath = join(base, 'picker worktree');
    const secondPath = join(base, 'second worktree');
    addWorktree(repo, pickerPath, 'feat-pick');
    addWorktree(repo, secondPath, 'feat-two');
    const agentDir = await makeAgentDir(base);
    const harness = await createHarness({ repo, agentDir });
    try {
      seedConversation(harness.runtime.session.sessionManager, 1);

      harness.ui.select = async (_title, options) => options.find((option) => option.includes('feat-pick'));
      await harness.runtime.session.prompt('/worktree');
      let replacement = harness.runtime.session.sessionManager;
      assert.equal(resolve(replacement.getCwd()), resolve(pickerPath));
      assert.deepEqual(replacement.buildSessionContext().messages, []);
      assert.match(harness.text(), /Started a fresh session in feat-pick/);

      const mark = harness.notifications.length;
      harness.ui.select = async (_title, options) => options.find((option) => option.includes('feat-two'));
      await harness.runtime.session.prompt('/worktree ls');
      replacement = harness.runtime.session.sessionManager;
      assert.equal(resolve(replacement.getCwd()), resolve(secondPath));
      assert.deepEqual(replacement.buildSessionContext().messages, []);
      assert.match(harness.newText(mark), /Started a fresh session in feat-two/);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('open on the current worktree still starts a fresh session in place', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'same repo');
    const worktreePath = join(base, 'same worktree');
    addWorktree(repo, worktreePath, 'feat-same');
    const agentDir = await makeAgentDir(base);
    const harness = await createHarness({ repo, agentDir });
    try {
      seedConversation(harness.runtime.session.sessionManager, 1);

      await harness.runtime.session.prompt('/worktree open feat-same');
      const firstSession = harness.runtime.session.sessionManager.getSessionFile();
      assert.equal(resolve(harness.runtime.session.sessionManager.getCwd()), resolve(worktreePath));

      const mark = harness.notifications.length;
      await harness.runtime.session.prompt('/worktree open feat-same');
      const replacement = harness.runtime.session.sessionManager;
      assert.equal(resolve(replacement.getCwd()), resolve(worktreePath));
      assert.notEqual(replacement.getSessionFile(), firstSession);
      assert.deepEqual(replacement.buildSessionContext().messages, []);
      assert.ok(existsSync(firstSession), 'the earlier worktree session stays saved');
      assert.match(harness.newText(mark), /Started a fresh session in feat-same/);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('running Dispatch workers refuse switching and creation before Git work', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'busy repo');
    const worktreePath = join(base, 'busy worktree');
    addWorktree(repo, worktreePath, 'feat-busy');
    const busy = await writeExtension(base, 'busy.ts', busyWorkerExtension);
    const agentDir = await makeAgentDir(base, [busy]);
    const harness = await createHarness({ repo, agentDir });
    try {
      const manager = harness.runtime.session.sessionManager;
      seedConversation(manager, 1);
      const before = await listJsonl(join(agentDir, 'sessions'));

      await harness.runtime.session.prompt('/worktree add feat-new');
      assert.match(harness.text(), /2 Dispatch workers are still running/);
      assert.match(harness.text(), /The worktree was not created/);
      assert.ok(!git(repo, 'worktree', 'list', '--porcelain').includes('feat-new'));

      const mark = harness.notifications.length;
      await harness.runtime.session.prompt('/worktree open feat-busy');
      assert.match(harness.newText(mark), /The session was not changed/);
      assert.equal(resolve(manager.getCwd()), resolve(repo));
      assert.deepEqual(await listJsonl(join(agentDir, 'sessions')), before);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a busy turn and queued messages each refuse the switch before any session file is written', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'guard repo');
    const worktreePath = join(base, 'guard worktree');
    addWorktree(repo, worktreePath, 'feat-guard');
    const agentDir = await makeAgentDir(base);
    const harness = await createHarness({ repo, agentDir });
    try {
      const manager = harness.runtime.session.sessionManager;
      seedConversation(manager, 1);
      const before = await listJsonl(join(agentDir, 'sessions'));

      harness.runtime.session._isAgentRunActive = true;
      let mark = harness.notifications.length;
      await harness.runtime.session.prompt('/worktree open feat-guard');
      assert.match(harness.newText(mark), /current turn/);
      harness.runtime.session._isAgentRunActive = false;

      harness.runtime.session._steeringMessages.push({ role: 'user', content: 'queued', timestamp: Date.now() });
      mark = harness.notifications.length;
      await harness.runtime.session.prompt('/worktree open feat-guard');
      assert.match(harness.newText(mark), /Queued messages/);

      assert.equal(resolve(manager.getCwd()), resolve(repo));
      assert.deepEqual(await listJsonl(join(agentDir, 'sessions')), before);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an ephemeral source session still switches to a fresh worktree session', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'ephemeral repo');
    const worktreePath = join(base, 'ephemeral worktree');
    addWorktree(repo, worktreePath, 'feat-ephemeral');
    const agentDir = await makeAgentDir(base);
    const manager = SessionManager.inMemory(repo);
    seedConversation(manager, 1);
    const harness = await createHarness({ repo, agentDir, manager });
    try {
      const before = await listJsonl(join(agentDir, 'sessions'));
      await harness.runtime.session.prompt('/worktree open feat-ephemeral');

      const replacement = harness.runtime.session.sessionManager;
      assert.equal(resolve(replacement.getCwd()), resolve(worktreePath));
      assert.deepEqual(replacement.buildSessionContext().messages, []);
      assert.equal(resolve(manager.getCwd()), resolve(repo));
      assert.deepEqual(manager.buildSessionContext().messages.map(messageText), ['question 1', 'answer 1']);
      assert.match(harness.text(), /not saved to a file/);
      assert.match(harness.text(), /Started a fresh session in feat-ephemeral/);
      assert.equal((await listJsonl(join(agentDir, 'sessions'))).length, before.length + 1);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an active compaction refuses creation and switching before Git work', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'compacting repo');
    const worktreePath = join(base, 'compacting worktree');
    addWorktree(repo, worktreePath, 'feat-compacting');
    const compacting = await writeExtension(base, 'compacting.ts', compactingGuardExtension);
    const agentDir = await makeAgentDir(base, [compacting]);
    const harness = await createHarness({ repo, agentDir });
    try {
      const manager = harness.runtime.session.sessionManager;
      seedConversation(manager, 1);
      const before = await listJsonl(join(agentDir, 'sessions'));

      await harness.runtime.session.prompt('/worktree add feat-compaction-new');
      assert.match(harness.text(), /compaction is still running/);
      assert.match(harness.text(), /The worktree was not created/);
      assert.ok(!git(repo, 'worktree', 'list', '--porcelain').includes('feat-compaction-new'));

      const mark = harness.notifications.length;
      await harness.runtime.session.prompt('/worktree open feat-compacting');
      assert.match(harness.newText(mark), /compaction is still running/);
      assert.match(harness.newText(mark), /The session was not changed/);
      assert.equal(resolve(manager.getCwd()), resolve(repo));
      assert.deepEqual(await listJsonl(join(agentDir, 'sessions')), before);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a worktree created before a cancelled switch is kept and its path reported', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    const home = join(base, 'home');
    await mkdir(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const repo = await makeRepo(base, 'kept repo');
    const cancelSwitch = await writeExtension(base, 'cancel-switch.ts', cancelSwitchExtension);
    const agentDir = await makeAgentDir(base, [cancelSwitch]);
    const harness = await createHarness({ repo, agentDir });
    try {
      const source = harness.runtime.session.sessionManager;
      seedConversation(source, 1);
      const sourceFile = source.getSessionFile();

      await harness.runtime.session.prompt('/worktree add feat-kept');

      const managedPath = join(home, '.pi', 'worktrees', 'kept repo', 'feat-kept');
      assert.equal(git(managedPath, 'rev-parse', '--is-inside-work-tree').trim(), 'true', 'the worktree is kept on disk');
      const text = harness.text();
      assert.match(text, /Session switch was cancelled/);
      assert.match(text, /Worktree created, but the session was not switched/);
      assert.ok(text.includes(managedPath), 'the created path is reported for recovery');
      assert.match(text, /worktree open feat-kept/);
      assert.equal(resolve(harness.runtime.session.sessionManager.getCwd()), resolve(repo));
      assert.equal(harness.runtime.session.sessionManager.getSessionFile(), sourceFile);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    if (previousHome.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome.HOME;
    if (previousHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousHome.USERPROFILE;
    await rm(base, { recursive: true, force: true });
  }
});

test('a worktree created before a failed switch is kept and both recovery paths reported', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    const home = join(base, 'home');
    await mkdir(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const repo = await makeRepo(base, 'kept failure repo');
    const agentDir = await makeAgentDir(base);
    const harness = await createHarness({
      repo,
      agentDir,
      switchSessionOverride: async () => {
        throw new Error('synthetic worktree runtime failure');
      },
    });
    try {
      const source = harness.runtime.session.sessionManager;
      seedConversation(source, 1);
      const sourceFile = source.getSessionFile();

      await harness.runtime.session.prompt('/worktree add feat-kept-fail');

      const managedPath = join(home, '.pi', 'worktrees', 'kept failure repo', 'feat-kept-fail');
      assert.equal(git(managedPath, 'rev-parse', '--is-inside-work-tree').trim(), 'true', 'the worktree is kept on disk');
      const text = harness.text();
      assert.match(text, /Fresh worktree session did not start/);
      assert.match(text, /synthetic worktree runtime failure/);
      assert.match(text, /Worktree created, but the session was not switched/);
      assert.ok(text.includes(managedPath), 'the created path is reported for recovery');
      assert.equal(resolve(harness.runtime.session.sessionManager.getCwd()), resolve(repo));
      assert.equal(harness.runtime.session.sessionManager.getSessionFile(), sourceFile);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    if (previousHome.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome.HOME;
    if (previousHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousHome.USERPROFILE;
    await rm(base, { recursive: true, force: true });
  }
});

test('a worktree created before a late busy switch is kept and its path reported', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    const home = join(base, 'home');
    await mkdir(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const repo = await makeRepo(base, 'late busy repo');
    const lateBusy = await writeExtension(base, 'late-busy.ts', lateBusyExtension);
    const agentDir = await makeAgentDir(base, [lateBusy]);
    const harness = await createHarness({ repo, agentDir });
    try {
      const source = harness.runtime.session.sessionManager;
      seedConversation(source, 1);
      const sourceFile = source.getSessionFile();

      await harness.runtime.session.prompt('/worktree add feat-late-busy');

      const managedPath = join(home, '.pi', 'worktrees', 'late busy repo', 'feat-late-busy');
      assert.equal(git(managedPath, 'rev-parse', '--is-inside-work-tree').trim(), 'true', 'the worktree is kept on disk');
      const text = harness.text();
      assert.match(text, /Dispatch worker is still running/);
      assert.match(text, /The session was not changed/);
      assert.match(text, /Worktree created, but the session was not switched/);
      assert.ok(text.includes(managedPath), 'the created path is reported for recovery');
      assert.equal(resolve(harness.runtime.session.sessionManager.getCwd()), resolve(repo));
      assert.equal(harness.runtime.session.sessionManager.getSessionFile(), sourceFile);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    if (previousHome.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome.HOME;
    if (previousHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousHome.USERPROFILE;
    await rm(base, { recursive: true, force: true });
  }
});

test('a session with no file yet still switches and reports that it is unsaved', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'unsaved repo');
    const worktreePath = join(base, 'unsaved worktree');
    addWorktree(repo, worktreePath, 'feat-unsaved');
    const agentDir = await makeAgentDir(base);
    const harness = await createHarness({ repo, agentDir });
    try {
      const manager = harness.runtime.session.sessionManager;
      const reserved = manager.getSessionFile();
      assert.ok(!existsSync(reserved), 'source file is still absent before the first assistant turn');

      await harness.runtime.session.prompt('/worktree open feat-unsaved');

      const replacement = harness.runtime.session.sessionManager;
      assert.equal(resolve(replacement.getCwd()), resolve(worktreePath));
      assert.deepEqual(replacement.buildSessionContext().messages, []);
      assert.match(harness.text(), /not saved to a file/);
      assert.equal(resolve(manager.getCwd()), resolve(repo));
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a cancelled switch keeps the session and removes only its own unused file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'cancel repo');
    const worktreePath = join(base, 'cancel worktree');
    addWorktree(repo, worktreePath, 'feat-cancel');
    const cancelSwitch = await writeExtension(base, 'cancel-switch.ts', cancelSwitchExtension);
    const agentDir = await makeAgentDir(base, [cancelSwitch]);
    const harness = await createHarness({ repo, agentDir });
    try {
      const manager = harness.runtime.session.sessionManager;
      seedConversation(manager, 1);
      const sourceFile = manager.getSessionFile();
      const sourceBefore = await readFile(sourceFile, 'utf8');
      const before = await listJsonl(join(agentDir, 'sessions'));

      await harness.runtime.session.prompt('/worktree open feat-cancel');

      assert.equal(manager.getSessionFile(), sourceFile);
      assert.equal(resolve(manager.getCwd()), resolve(repo));
      assert.deepEqual(
        manager.buildSessionContext().messages.map(messageText),
        ['question 1', 'answer 1'],
      );
      assert.match(harness.text(), /Session switch was cancelled/);
      assert.deepEqual(await listJsonl(join(agentDir, 'sessions')), before);
      assert.equal(await readFile(sourceFile, 'utf8'), sourceBefore);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a failed switch keeps both session paths truthful and leaves the new file on disk', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'failure repo');
    const worktreePath = join(base, 'failure worktree');
    addWorktree(repo, worktreePath, 'feat-fail');
    const agentDir = await makeAgentDir(base);
    const harness = await createHarness({
      repo,
      agentDir,
      switchSessionOverride: async () => {
        throw new Error('synthetic worktree runtime failure');
      },
    });
    try {
      const manager = harness.runtime.session.sessionManager;
      seedConversation(manager, 1);
      const sourceFile = manager.getSessionFile();
      const before = await listJsonl(join(agentDir, 'sessions'));

      await harness.runtime.session.prompt('/worktree open feat-fail');

      assert.equal(manager.getSessionFile(), sourceFile);
      assert.match(harness.text(), /Fresh worktree session did not start/);
      assert.match(harness.text(), /synthetic worktree runtime failure/);
      assert.ok(harness.text().includes(sourceFile), 'original session path is reported');

      const after = await listJsonl(join(agentDir, 'sessions'));
      assert.equal(after.length, before.length + 1);
      const newFile = after.find((file) => !before.includes(file));
      assert.ok(newFile, 'the prepared session file is left for recovery');
      const header = JSON.parse((await readFile(newFile, 'utf8')).trim().split('\n')[0]);
      assert.equal(resolve(header.cwd), resolve(worktreePath));
      assert.equal(header.parentSession, undefined);
      assert.ok(harness.text().includes(newFile), 'new session path is reported');
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('session switching goes through the host trust context instead of bypassing it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'trust repo');
    const worktreePath = join(base, 'trust worktree');
    addWorktree(repo, worktreePath, 'feat-trust');
    const agentDir = await makeAgentDir(base);
    const sentinelUi = { notify: () => {} };
    const harness = await createHarness({
      repo,
      agentDir,
      trustFactory: (cwd) => ({ cwd, mode: 'tui', hasUI: true, ui: sentinelUi, sentinelTrust: true }),
    });
    try {
      seedConversation(harness.runtime.session.sessionManager, 1);
      await harness.runtime.session.prompt('/worktree open feat-trust');

      assert.equal(harness.switchCalls.length, 1, 'switch went through the host command action');
      const call = harness.switchCalls[0];
      assert.equal(typeof call.options.withSession, 'function');
      assert.deepEqual(Object.keys(call.options), ['withSession'], 'no trust or cwd override is passed');
      assert.ok(resolve(call.sessionPath).startsWith(resolve(agentDir, 'sessions')));

      // The production host adds projectTrustContextFactory; it must receive
      // the worktree cwd so the new runtime re-evaluates trust for that path.
      const context = harness.trustContexts.at(-1);
      assert.deepEqual(context, {
        cwd: resolve(worktreePath),
        mode: 'tui',
        hasUI: true,
        ui: sentinelUi,
        sentinelTrust: true,
      });
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('non-interactive hosts keep the path hint and never create a session', async () => {
  const base = await mkdtemp(join(tmpdir(), 'piastra-switch-'));
  try {
    const repo = await makeRepo(base, 'rpc repo');
    const worktreePath = join(base, 'rpc worktree');
    addWorktree(repo, worktreePath, 'feat-rpc');
    const agentDir = await makeAgentDir(base);
    const harness = await createHarness({ repo, agentDir, mode: 'rpc' });
    try {
      const manager = harness.runtime.session.sessionManager;
      seedConversation(manager, 1);
      const before = await listJsonl(join(agentDir, 'sessions'));

      await harness.runtime.session.prompt('/worktree open feat-rpc');

      assert.equal(resolve(manager.getCwd()), resolve(repo));
      assert.doesNotMatch(harness.text(), /fresh session/);
      assert.match(harness.text(), /Worktree: feat-rpc/);
      assert.match(harness.text(), /Next: cd /);
      assert.deepEqual(await listJsonl(join(agentDir, 'sessions')), before);
      assert.deepEqual(harness.errors, []);
    } finally {
      await harness.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('worktree switch helpers expose the documented refusal reasons and guard handshake', () => {
  assert.equal(worktreeSwitchRefusal({ idle: true, pending: false, activeWorkers: 0 }), undefined);
  assert.match(worktreeSwitchRefusal({ idle: false, pending: false, activeWorkers: 0 }), /current turn/);
  assert.match(worktreeSwitchRefusal({ idle: true, pending: true, activeWorkers: 0 }), /Queued messages/);
  assert.match(worktreeSwitchRefusal({ idle: true, pending: false, activeWorkers: 3 }), /3 Dispatch workers/);
  assert.match(worktreeSwitchRefusal({ idle: true, pending: false, activeWorkers: 0, compacting: true }), /compaction is still running/);
  assert.match(worktreeSwitchRefusal({ idle: true, pending: false, activeWorkers: 0, summarizing: true }), /branch summary is still running/);

  const listeners = new Map();
  const events = {
    emit: (channel, data) => listeners.get(channel)?.(data),
    on: (channel, handler) => {
      listeners.set(channel, handler);
      return () => listeners.delete(channel);
    },
  };
  const fakePi = { events };
  assert.equal(activePiastraWorkers(fakePi), 0);
  assert.deepEqual(piastraActivity(fakePi), { activeWorkers: 0, compacting: false, summarizing: false });
  listeners.set('piastra:worker-guard', (request) => {
    if (request?.type === 'query') {
      request.active = 1;
      request.busy = true;
      request.compacting = true;
      request.summarizing = true;
    }
  });
  assert.equal(activePiastraWorkers(fakePi), 1);
  assert.deepEqual(piastraActivity(fakePi), { activeWorkers: 1, compacting: true, summarizing: true });
});
