import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { FORK_DISABLED_AGENT_TOOLS } from '../extensions/piastra/policy.mjs';
import {
  completeDispatchSetup,
  managedExtensionPaths,
  readDispatchState,
  resolveDispatchPaths,
  seedDispatchConfiguration,
} from './state.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makePaths(tag) {
  const home = mkdtempSync(join(tmpdir(), `dispatch-${tag}-`));
  const packageRoot = mkdtempSync(join(tmpdir(), `dispatch-pkg-${tag}-`));
  return { home, paths: resolveDispatchPaths({ env: {}, home, packageRoot }) };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('managedExtensionPaths returns eight entries in order', () => {
  const root = '/pkg';
  assert.deepEqual(managedExtensionPaths(root), [
    join(root, 'extensions/piastra/index.ts'),
    join(root, 'extensions/pi-ui/index.ts'),
    join(root, 'extensions/pi-worktree/git-worktree.ts'),
    join(root, 'extensions/pi-queue/index.ts'),
    join(root, 'extensions/pi-compact-transcript/index.ts'),
    join(root, 'extensions/pi-atelier/extensions/index.ts'),
    join(root, 'extensions/pi-todo/index.ts'),
    join(root, 'extensions/pi-commandcode/index.ts'),
  ]);
});

test('resolveDispatchPaths honors DISPATCH_HOME and ignores PI_* inheritance', () => {
  const home = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  const env = {
    DISPATCH_HOME: '',
    PI_CODING_AGENT_DIR: '/elsewhere/agent',
    PI_CODING_AGENT_SESSION_DIR: '/elsewhere/sessions',
  };
  const paths = resolveDispatchPaths({ env, home, packageRoot: REPO_ROOT });
  assert.equal(paths.home, join(home, '.dispatch'));
  assert.equal(paths.agentDir, join(home, '.dispatch', 'agent'));
  assert.equal(paths.webDir, join(home, '.dispatch', 'web'));
  assert.equal(paths.stateFile, join(home, '.dispatch', 'state.json'));

  const custom = resolveDispatchPaths({
    env: { DISPATCH_HOME: join(home, 'custom'), PI_CODING_AGENT_DIR: '/x' },
    home,
    packageRoot: REPO_ROOT,
  });
  assert.equal(custom.home, join(home, 'custom'));
});

test('first setup seeds eight extensions, defaults, web policy; no auth touched', async () => {
  const { paths } = makePaths('first');
  const state = await seedDispatchConfiguration({ ...paths, packageRoot: REPO_ROOT });
  assert.equal(state.formatVersion, 1);
  assert.equal(state.setupComplete, false);
  assert.equal(state.managedExtensionPaths.length, 8);

  const settings = await readJson(join(paths.agentDir, 'settings.json'));
  assert.equal(settings.defaultProvider, 'openai-codex');
  assert.equal(settings.defaultModel, 'gpt-6-astra');
  assert.equal(settings.defaultThinkingLevel, 'low');
  assert.deepEqual(settings.retry, { enabled: true, maxRetries: 2 });
  assert.deepEqual(settings.extensions, managedExtensionPaths(REPO_ROOT));

  const client = await readJson(join(paths.webDir, 'client-state.json'));
  assert.deepEqual(client.__settings__.settings.disabledAgentTools, [...FORK_DISABLED_AGENT_TOOLS]);

  // No auth file is created or copied.
  let authMissing = false;
  try {
    await readFile(join(paths.agentDir, 'auth.json'), 'utf8');
  } catch (error) {
    authMissing = error?.code === 'ENOENT';
  }
  assert.ok(authMissing);
});

test('seed preserves custom settings and nested web settings', async () => {
  const { paths } = makePaths('preserve');
  await mkdir(paths.agentDir, { recursive: true });
  await writeFile(join(paths.agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'custom', customField: 42, extensions: ['/user/extra.ts'],
  }));
  await mkdir(paths.webDir, { recursive: true });
  await writeFile(join(paths.webDir, 'client-state.json'), JSON.stringify({
    __settings__: { settings: { customSystemPrompt: 'keep me', retryMaxAttempts: 9 } },
    otherTop: true,
  }));
  await seedDispatchConfiguration({ ...paths, packageRoot: REPO_ROOT });
  const settings = await readJson(join(paths.agentDir, 'settings.json'));
  assert.equal(settings.defaultProvider, 'custom');
  assert.equal(settings.customField, 42);
  assert.ok(settings.extensions.includes('/user/extra.ts'));
  assert.equal(settings.extensions.length, 9);
  const client = await readJson(join(paths.webDir, 'client-state.json'));
  assert.equal(client.__settings__.settings.customSystemPrompt, 'keep me');
  assert.equal(client.otherTop, true);
  assert.deepEqual(client.__settings__.settings.disabledAgentTools, [...FORK_DISABLED_AGENT_TOOLS]);
});

test('completeDispatchSetup skipped seeds Luna; configured seeds Go defaults', async () => {
  const skipped = makePaths('skipped');
  const done = await completeDispatchSetup({ ...skipped.paths, packageRoot: REPO_ROOT }, { go: 'skipped' });
  assert.equal(done.go, 'skipped');
  assert.equal(done.setupComplete, true);
  const prefs = await readJson(join(skipped.paths.agentDir, 'piastra', 'agents.json'));
  assert.deepEqual(prefs.roles.general, { model: 'openai-codex/gpt-5.6-luna', thinking: 'medium' });
  assert.deepEqual(prefs.roles.fast, { model: 'openai-codex/gpt-5.6-luna', thinking: 'medium' });

  const configured = makePaths('configured');
  await completeDispatchSetup({ ...configured.paths, packageRoot: REPO_ROOT }, { go: 'configured' });
  const prefs2 = await readJson(join(configured.paths.agentDir, 'piastra', 'agents.json'));
  assert.deepEqual(prefs2.roles.general, { model: 'opencode-go/glm-5.3-flash', thinking: null });
  assert.deepEqual(prefs2.roles.fast, { model: 'opencode-go/deepseek-v4.1-flash', thinking: null });

  await assert.rejects(() => completeDispatchSetup(configured.paths, { go: 'bogus' }));
});

test('later role preferences survive repeated setup', async () => {
  const { paths } = makePaths('laterprefs');
  const full = { ...paths, packageRoot: REPO_ROOT };
  await completeDispatchSetup(full, { go: 'skipped' });
  const prefsFile = join(paths.agentDir, 'piastra', 'agents.json');
  const current = await readJson(prefsFile);
  current.roles.general = { model: 'custom/pro-model', thinking: 'high' };
  await writeFile(prefsFile, JSON.stringify(current, null, 2));
  const again = await completeDispatchSetup(full, { go: 'configured' });
  assert.equal(again.go, 'configured');
  const prefs = await readJson(prefsFile);
  assert.deepEqual(prefs.roles.general, { model: 'custom/pro-model', thinking: 'high' });
  assert.deepEqual(prefs.roles.fast, { model: 'openai-codex/gpt-5.6-luna', thinking: 'medium' });
});

test('install move replaces managed paths; intentional removal stays removed; user additions kept', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dispatch-move-'));
  const rootA = mkdtempSync(join(tmpdir(), 'dispatch-rootA-'));
  const rootB = mkdtempSync(join(tmpdir(), 'dispatch-rootB-'));
  const pkgConfig = JSON.stringify({
    orchestrator: { model: 'openai-codex/gpt-6-astra', thinking: 'low' },
    general: { model: 'opencode-go/glm-5.3-flash', thinking: null },
    fast: { model: 'opencode-go/deepseek-v4.1-flash', thinking: null },
  });
  for (const root of [rootA, rootB]) {
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'agents.json'), pkgConfig);
  }
  const pathsA = resolveDispatchPaths({ env: {}, home, packageRoot: rootA });
  await seedDispatchConfiguration(pathsA);
  // User adds an entry and intentionally removes one managed entry.
  const settingsFile = join(pathsA.agentDir, 'settings.json');
  const settings = await readJson(settingsFile);
  const removed = managedExtensionPaths(rootA)[6];
  settings.extensions = [...settings.extensions.filter((e) => e !== removed), '/user/keep.ts'];
  await writeFile(settingsFile, JSON.stringify(settings, null, 2));

  const pathsB = resolveDispatchPaths({ env: {}, home, packageRoot: rootB });
  const state = await seedDispatchConfiguration(pathsB);
  assert.deepEqual(state.managedExtensionPaths, managedExtensionPaths(rootB));
  assert.equal(state.setupComplete, false);
  const after = await readJson(settingsFile);
  assert.ok(!after.extensions.some((e) => e.startsWith(rootA)), 'old root paths replaced');
  assert.ok(after.extensions.includes('/user/keep.ts'));
  assert.ok(!after.extensions.includes(managedExtensionPaths(rootB)[6]), 'intentional removal preserved');
  assert.ok(after.extensions.includes(managedExtensionPaths(rootB)[0]));
});

test('malformed settings/state/prefs fail closed without overwrite', async () => {
  const { paths } = makePaths('corrupt');
  const full = { ...paths, packageRoot: REPO_ROOT };
  await seedDispatchConfiguration(full);

  const settingsFile = join(paths.agentDir, 'settings.json');
  await writeFile(settingsFile, '{not json');
  await assert.rejects(() => seedDispatchConfiguration(full));
  assert.equal(await readFile(settingsFile, 'utf8'), '{not json');

  await writeFile(settingsFile, JSON.stringify({ extensions: [] }));
  await writeFile(paths.stateFile, '{bad');
  await assert.rejects(() => readDispatchState(full));
  await assert.rejects(() => seedDispatchConfiguration(full));
  assert.equal(await readFile(paths.stateFile, 'utf8'), '{bad');

  await seedDispatchConfiguration({ ...paths, packageRoot: REPO_ROOT, stateFile: join(paths.home, 'fresh-state.json'), agentDir: join(paths.home, 'fresh-agent'), webDir: join(paths.home, 'fresh-web') });
  const fresh = { ...paths, packageRoot: REPO_ROOT, stateFile: join(paths.home, 'fresh-state.json'), agentDir: join(paths.home, 'fresh-agent'), webDir: join(paths.home, 'fresh-web') };
  await mkdir(join(fresh.agentDir, 'piastra'), { recursive: true });
  await writeFile(join(fresh.agentDir, 'piastra', 'agents.json'), '{bad');
  await assert.rejects(() => completeDispatchSetup(fresh, { go: 'skipped' }));
  assert.equal(await readFile(join(fresh.agentDir, 'piastra', 'agents.json'), 'utf8'), '{bad');
  const st = await readJson(fresh.stateFile);
  assert.equal(st.setupComplete, false);
});

test('readDispatchState returns null when missing', async () => {
  const { paths } = makePaths('missing');
  assert.equal(await readDispatchState({ ...paths, packageRoot: REPO_ROOT }), null);
});

test('resolveDispatchPaths returns absolute paths; nonempty means !== \'\'', () => {
  const home = mkdtempSync(join(tmpdir(), 'dispatch-abs-'));
  const rel = resolveDispatchPaths({ env: { DISPATCH_HOME: 'rel-custom-dir' }, home, packageRoot: REPO_ROOT });
  assert.ok(isAbsolute(rel.home), 'relative DISPATCH_HOME resolves absolute');
  assert.equal(rel.home, resolve('rel-custom-dir'));
  assert.ok(isAbsolute(rel.packageRoot));
  // Whitespace is a valid (weird) path: never trimmed, never treated as empty.
  const ws = resolveDispatchPaths({ env: { DISPATCH_HOME: ' ' }, home, packageRoot: REPO_ROOT });
  assert.equal(ws.home, resolve(' '));
  const empty = resolveDispatchPaths({ env: { DISPATCH_HOME: '' }, home, packageRoot: REPO_ROOT });
  assert.equal(empty.home, join(resolve(home), '.dispatch'));
});

test('empty state.json fails closed; missing state stays missing on failed setup', async () => {
  const { paths } = makePaths('empty-state');
  const full = { ...paths, packageRoot: REPO_ROOT };
  await mkdir(dirname(paths.stateFile), { recursive: true });
  await writeFile(paths.stateFile, '');
  await assert.rejects(() => readDispatchState(full));
  await assert.rejects(() => seedDispatchConfiguration(full));
  assert.equal(await readFile(paths.stateFile, 'utf8'), '');
  await writeFile(paths.stateFile, '   \n');
  await assert.rejects(() => readDispatchState(full));
  await assert.rejects(() => seedDispatchConfiguration(full));

  // Failed setup must not create a state file from nothing.
  const { paths: paths2 } = makePaths('no-state-create');
  const full2 = { ...paths2, packageRoot: REPO_ROOT };
  await mkdir(paths2.agentDir, { recursive: true });
  await writeFile(join(paths2.agentDir, 'settings.json'), '{bad');
  await assert.rejects(() => seedDispatchConfiguration(full2));
  let missing = false;
  try {
    await readFile(paths2.stateFile, 'utf8');
  } catch (error) {
    missing = error?.code === 'ENOENT';
  }
  assert.ok(missing, 'state file stays missing after failed setup');
});

test('corrupt schema fails closed: state fields, settings extensions, web shapes', async () => {
  const { paths } = makePaths('schema');
  const full = { ...paths, packageRoot: REPO_ROOT };
  await seedDispatchConfiguration(full);
  const settingsFile = join(paths.agentDir, 'settings.json');
  const clientFile = join(paths.webDir, 'client-state.json');

  for (const bad of [
    { formatVersion: 1, setupComplete: 'yes' },
    { formatVersion: 1, go: 'maybe' },
    { formatVersion: 1, managedExtensionPaths: [42] },
    { formatVersion: 1, packageRoot: 42 },
    { formatVersion: 999 },
  ]) {
    await writeFile(paths.stateFile, JSON.stringify(bad));
    await assert.rejects(() => readDispatchState(full), 'bad state shape');
    await assert.rejects(() => seedDispatchConfiguration(full), 'bad state shape');
  }
  await writeFile(paths.stateFile, JSON.stringify({ formatVersion: 1 }));

  await writeFile(settingsFile, JSON.stringify({ extensions: 'nope' }));
  await assert.rejects(() => seedDispatchConfiguration(full));
  await writeFile(settingsFile, JSON.stringify({ extensions: ['ok', 42] }));
  await assert.rejects(() => seedDispatchConfiguration(full), 'non-string extension must reject, not drop');

  await writeFile(settingsFile, JSON.stringify({ extensions: [] }));
  await writeFile(clientFile, JSON.stringify({ __settings__: 'nope' }));
  await assert.rejects(() => seedDispatchConfiguration(full));
  await writeFile(clientFile, JSON.stringify({ __settings__: { settings: 'nope' } }));
  await assert.rejects(() => seedDispatchConfiguration(full));
});

test('complete prevalidates all JSON before any write: no partial rewrite on bad web/prefs', async () => {
  const { paths } = makePaths('nopartial');
  const full = { ...paths, packageRoot: REPO_ROOT };
  await completeDispatchSetup(full, { go: 'skipped' });
  const settingsFile = join(paths.agentDir, 'settings.json');
  const clientFile = join(paths.webDir, 'client-state.json');
  const prefsFile = join(paths.agentDir, 'piastra', 'agents.json');
  const before = {
    settings: await readFile(settingsFile, 'utf8'),
    client: await readFile(clientFile, 'utf8'),
    state: await readFile(paths.stateFile, 'utf8'),
    prefs: await readFile(prefsFile, 'utf8'),
  };
  await writeFile(clientFile, '{bad');
  await assert.rejects(() => completeDispatchSetup(full, { go: 'configured' }));
  assert.equal(await readFile(settingsFile, 'utf8'), before.settings, 'settings untouched');
  assert.equal(await readFile(paths.stateFile, 'utf8'), before.state, 'state untouched');
  assert.equal(await readFile(prefsFile, 'utf8'), before.prefs, 'prefs untouched');

  await writeFile(clientFile, before.client);
  await writeFile(prefsFile, JSON.stringify({ roles: { general: { model: 'x' } } }));
  await assert.rejects(() => completeDispatchSetup(full, { go: 'configured' }));
  assert.equal(await readFile(settingsFile, 'utf8'), before.settings, 'settings untouched on bad prefs');
  assert.equal(await readFile(clientFile, 'utf8'), before.client, 'web untouched on bad prefs');
  assert.equal(await readFile(paths.stateFile, 'utf8'), before.state, 'state untouched on bad prefs');
});

test('new files are private (0600) where POSIX; unchanged content is not rewritten', async () => {
  const { paths } = makePaths('modes');
  const full = { ...paths, packageRoot: REPO_ROOT };
  await seedDispatchConfiguration(full);
  const settingsFile = join(paths.agentDir, 'settings.json');
  const clientFile = join(paths.webDir, 'client-state.json');
  const prefsFile = join(paths.agentDir, 'piastra', 'agents.json');
  await completeDispatchSetup(full, { go: 'skipped' });
  if (process.platform !== 'win32') {
    for (const file of [paths.stateFile, settingsFile, clientFile, prefsFile]) {
      assert.equal((await stat(file)).mode & 0o777, 0o600, file);
    }
    assert.equal((await stat(paths.home)).mode & 0o777, 0o700, 'home dir');
  }
  const stamp = async (f) => (await stat(f)).mtimeMs;
  const before = {
    settings: await stamp(settingsFile),
    client: await stamp(clientFile),
    state: await stamp(paths.stateFile),
  };
  await new Promise((r) => setTimeout(r, 25));
  await seedDispatchConfiguration(full);
  assert.equal(await stamp(settingsFile), before.settings, 'settings not rewritten when unchanged');
  assert.equal(await stamp(clientFile), before.client, 'web state not rewritten when unchanged');
  assert.equal(await stamp(paths.stateFile), before.state, 'state not rewritten when unchanged');
});

test('existing web disabledAgentTools array is preserved, never forced', async () => {
  const { paths } = makePaths('webtools');
  const full = { ...paths, packageRoot: REPO_ROOT };
  await mkdir(paths.webDir, { recursive: true });
  await writeFile(join(paths.webDir, 'client-state.json'), JSON.stringify({
    __settings__: { settings: { disabledAgentTools: ['custom/tool', ...FORK_DISABLED_AGENT_TOOLS], retryMaxAttempts: 3 } },
  }));
  await seedDispatchConfiguration(full);
  const client = await readJson(join(paths.webDir, 'client-state.json'));
  assert.ok(client.__settings__.settings.disabledAgentTools.includes('custom/tool'));
  assert.equal(client.__settings__.settings.retryMaxAttempts, 3);
  const stamp = (await stat(join(paths.webDir, 'client-state.json'))).mtimeMs;
  await new Promise((r) => setTimeout(r, 25));
  await seedDispatchConfiguration(full);
  assert.equal((await stat(join(paths.webDir, 'client-state.json'))).mtimeMs, stamp, 'no rewrite when unchanged');
});

test('prefs merge preserves top-level and per-role additions when filling missing roles', async () => {
  const { paths } = makePaths('prefsmeta');
  const full = { ...paths, packageRoot: REPO_ROOT };
  await seedDispatchConfiguration(full);
  const prefsFile = join(paths.agentDir, 'piastra', 'agents.json');
  await mkdir(dirname(prefsFile), { recursive: true });
  await writeFile(prefsFile, JSON.stringify({
    version: 7,
    roles: { general: { model: 'custom/pro-model', thinking: 'high' }, review: { model: 'custom/rev', thinking: 'low' } },
  }));
  const done = await completeDispatchSetup(full, { go: 'configured' });
  assert.equal(done.setupComplete, true);
  const prefs = await readJson(prefsFile);
  assert.equal(prefs.version, 7, 'top-level preserved');
  assert.deepEqual(prefs.roles.general, { model: 'custom/pro-model', thinking: 'high' });
  assert.deepEqual(prefs.roles.review, { model: 'custom/rev', thinking: 'low' }, 'extra role preserved');
  assert.deepEqual(prefs.roles.fast, { model: 'opencode-go/deepseek-v4.1-flash', thinking: null });
});

test('missing/malformed package config throws rather than falling back', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dispatch-pkgcfg-'));
  const emptyRoot = mkdtempSync(join(tmpdir(), 'dispatch-emptyroot-'));
  const paths = resolveDispatchPaths({ env: {}, home, packageRoot: emptyRoot });
  await assert.rejects(() => seedDispatchConfiguration(paths));
  await mkdir(join(emptyRoot, 'config'), { recursive: true });
  await writeFile(join(emptyRoot, 'config', 'agents.json'), '{bad');
  await assert.rejects(() => seedDispatchConfiguration(resolveDispatchPaths({ env: {}, home, packageRoot: emptyRoot })));
});

test('concurrent prefs file lock: late user choice under contention is preserved', async () => {
  const { default: lockfile } = await import('proper-lockfile');
  const { paths } = makePaths('contention');
  const full = { ...paths, packageRoot: REPO_ROOT };
  await seedDispatchConfiguration(full);
  const prefsFile = join(paths.agentDir, 'piastra', 'agents.json');
  await mkdir(dirname(prefsFile), { recursive: true });
  await writeFile(prefsFile, JSON.stringify({
    roles: { general: { model: 'custom/pro-model', thinking: 'high' } },
  }));
  // Hold the SAME prefs lock while setup runs: it must block, then read the
  // late user choice written by the holder instead of clobbering it.
  const releaseHolder = await lockfile.lock(prefsFile, { retries: 0, stale: 10_000, realpath: false });
  const pending = completeDispatchSetup(full, { go: 'configured' });
  await new Promise((r) => setTimeout(r, 200));
  const late = {
    roles: {
      general: { model: 'custom/pro-model', thinking: 'high' },
      fast: { model: 'late/user-choice', thinking: 'low' },
    },
  };
  await writeFile(prefsFile, JSON.stringify(late, null, 2));
  await releaseHolder();
  const done = await pending;
  assert.equal(done.setupComplete, true);
  const prefs = await readJson(prefsFile);
  assert.deepEqual(prefs.roles.fast, { model: 'late/user-choice', thinking: 'low' }, 'late choice preserved');
  assert.deepEqual(prefs.roles.general, { model: 'custom/pro-model', thinking: 'high' });
});

test('prefs lock contention fails closed without leaking the state lock', async () => {
  const { default: lockfile } = await import('proper-lockfile');
  const { paths } = makePaths('lockleak');
  const full = { ...paths, packageRoot: REPO_ROOT };
  await seedDispatchConfiguration(full);
  const prefsFile = join(paths.agentDir, 'piastra', 'agents.json');
  await mkdir(dirname(prefsFile), { recursive: true });
  await writeFile(prefsFile, JSON.stringify({ roles: {} }));
  // Hold the prefs lock past the bounded retry so setup must reject.
  const releaseHolder = await lockfile.lock(prefsFile, { retries: 0, stale: 10_000, realpath: false });
  await assert.rejects(() => completeDispatchSetup(full, { go: 'skipped' }));
  // The state lock must not have leaked: it is acquirable while the prefs
  // holder is still held.
  const releaseProbe = await lockfile.lock(paths.stateFile, { retries: 0, stale: 10_000, realpath: false });
  await releaseProbe();
  await releaseHolder();
  // Immediate retry after release works.
  const done = await completeDispatchSetup(full, { go: 'skipped' });
  assert.equal(done.setupComplete, true);
});

test('seed prevalidates web before settings write: bad web A->B leaves files unchanged, fixed C skips B', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dispatch-seedpre-'));
  const mkRoot = async (tag) => {
    const root = mkdtempSync(join(tmpdir(), `dispatch-seedpre-${tag}-`));
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'agents.json'), JSON.stringify({
      orchestrator: { model: 'openai-codex/gpt-6-astra', thinking: 'low' },
      general: { model: 'opencode-go/glm-5.3-flash', thinking: null },
      fast: { model: 'opencode-go/deepseek-v4.1-flash', thinking: null },
    }));
    return root;
  };
  const rootA = await mkRoot('A');
  const rootB = await mkRoot('B');
  const rootC = await mkRoot('C');
  const pathsA = resolveDispatchPaths({ env: {}, home, packageRoot: rootA });
  await seedDispatchConfiguration(pathsA);
  const settingsFile = join(pathsA.agentDir, 'settings.json');
  const clientFile = join(pathsA.webDir, 'client-state.json');
  const before = {
    settings: await readFile(settingsFile, 'utf8'),
    client: await readFile(clientFile, 'utf8'),
    state: await readFile(pathsA.stateFile, 'utf8'),
  };
  // Malformed web must fail before any settings rewrite A->B.
  await writeFile(clientFile, '{bad');
  await assert.rejects(() => seedDispatchConfiguration(resolveDispatchPaths({ env: {}, home, packageRoot: rootB })));
  assert.equal(await readFile(settingsFile, 'utf8'), before.settings, 'settings unchanged on bad web');
  assert.equal(await readFile(pathsA.stateFile, 'utf8'), before.state, 'state unchanged on bad web');
  // Fix web, move to C: must contain C paths without retaining B.
  await writeFile(clientFile, before.client);
  await seedDispatchConfiguration(resolveDispatchPaths({ env: {}, home, packageRoot: rootC }));
  const after = await readJson(settingsFile);
  const state = await readJson(pathsA.stateFile);
  assert.deepEqual(state.managedExtensionPaths, managedExtensionPaths(rootC));
  assert.ok(after.extensions.every((e) => !e.startsWith(rootA) && !e.startsWith(rootB)), 'no A/B paths retained');
  assert.ok(after.extensions.includes(managedExtensionPaths(rootC)[0]));
});

test('interrupted move journal recovers: union state + A/B/removed settings all converge on C', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dispatch-journal-'));
  const mkRoot = async (tag) => {
    const root = mkdtempSync(join(tmpdir(), `dispatch-journal-${tag}-`));
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'agents.json'), JSON.stringify({
      orchestrator: { model: 'openai-codex/gpt-6-astra', thinking: 'low' },
      general: { model: 'opencode-go/glm-5.3-flash', thinking: null },
      fast: { model: 'opencode-go/deepseek-v4.1-flash', thinking: null },
    }));
    return root;
  };
  const rootA = await mkRoot('A');
  const rootB = await mkRoot('B');
  const rootC = await mkRoot('C');
  const manA = managedExtensionPaths(rootA);
  const manB = managedExtensionPaths(rootB);
  const manC = managedExtensionPaths(rootC);
  const unionAB = [...manA];
  for (const p of manB) if (!unionAB.includes(p)) unionAB.push(p);

  async function scenario(settingsExtensions, label) {
    const paths = resolveDispatchPaths({ env: {}, home: mkdtempSync(join(home, `h-${label}-`)), packageRoot: rootC });
    // Seed fresh at A to create valid defaults, then overwrite with the
    // manual interrupted state (journal union[A,B]) and chosen settings.
    await seedDispatchConfiguration(resolveDispatchPaths({ env: {}, home: paths.home, packageRoot: rootA }));
    const p = resolveDispatchPaths({ env: {}, home: paths.home, packageRoot: rootC });
    const settingsFile = join(p.agentDir, 'settings.json');
    const cur = await readJson(settingsFile);
    await writeFile(p.stateFile, JSON.stringify({
      formatVersion: 1, setupComplete: false, managedExtensionPaths: unionAB, packageRoot: rootB,
    }));
    await writeFile(settingsFile, JSON.stringify({ ...cur, extensions: settingsExtensions }, null, 2));
    const next = await seedDispatchConfiguration(p);
    const after = await readJson(settingsFile);
    assert.deepEqual(next.managedExtensionPaths, manC, `${label}: final state is C-only`);
    return after.extensions;
  }

  // Crash after journal: settings still A -> C with no duplicates.
  const fromA = await scenario([...manA, '/user/keep.ts'], 'journal-A');
  assert.ok(fromA.includes('/user/keep.ts'));
  assert.ok(fromA.includes(manC[0]));
  assert.ok(!fromA.some((e) => e.startsWith(rootA) || e.startsWith(rootB)), 'no old duplicates');
  // Crash after settings: settings already B -> C with no duplicates.
  const fromB = await scenario([...manB, '/user/keep.ts'], 'journal-B');
  assert.ok(fromB.includes(manC[0]));
  assert.ok(!fromB.some((e) => e.startsWith(rootA) || e.startsWith(rootB)), 'no old duplicates');
  // Intentional removal stays absent: settings lack index 6 in both A and B.
  const removedA = manA.filter((_, i) => i !== 6);
  const extRemoved = await scenario([...removedA, '/user/keep.ts'], 'journal-removed');
  assert.ok(!extRemoved.includes(manC[6]), 'intentional removal preserved');
  assert.ok(extRemoved.includes(manC[0]));
  assert.ok(extRemoved.includes('/user/keep.ts'));
});
