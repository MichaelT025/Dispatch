import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgents, agentOrder } from './agents.mjs';
import { createFilePrefsStore, loadPrefs, savePrefs } from './prefs.mjs';

function fixture(store) {
  let agents;
  // Seed foreign fork tools to prove role switching strips them.
  const state = { tools: ['terminal_create', 'edit_soft', 'subagent_spawn', 'delegator_admin'], entries: [], idle: true, status: '', model: null, thinking: null, allowed: true, notices: [] };
  const config = Object.fromEntries(agentOrder.map(role => [role, { model: `provider/${role}`, thinking: role === 'review' ? 'medium' : 'low' }]));
  const ctx = { isIdle: () => state.idle, modelRegistry: { find: (provider, id) => ({ provider, id }) }, sessionManager: { getBranch: () => state.entries }, ui: { setStatus: (_key, value) => { state.status = value; }, notify: (message, level) => { state.notices.push({ message, level }); } } };
  const pi = {
    async setModel(model) { if (!state.allowed) return false; state.model = model; agents?.modelChanged({ model, source: 'set' }, ctx); return true; },
    setThinkingLevel(level) { state.thinking = level; agents?.thinkingChanged({ level }, ctx); },
    getThinkingLevel() { return state.thinking; },
    getActiveTools() { return [...state.tools]; },
    setActiveTools(tools) { state.tools = tools; },
    appendEntry(customType, data) { state.entries.push({ type: 'custom', customType, data }); }
  };
  agents = createAgents(pi, config, store);
  return { state, ctx, agents, pi, config };
}
test('cycling changes model, tools and label; review cannot write or delegate', async () => {
  const { agents, ctx, state } = fixture();
  for (const role of ['general', 'fast', 'review', 'orchestrator']) {
    await agents.cycle(ctx);
    assert.equal(agents.active, role); assert.equal(state.model.id, role);
    assert.equal(state.status, `Agent: ${role}`);
    assert.equal(state.tools.includes('delegate'), role === 'orchestrator');
    assert.equal(state.tools.includes('write'), role !== 'review');
    assert.equal(state.tools.includes('bash'), role !== 'review');
    // Unknown tools active before the role's selection must never survive it.
    for (const tool of ['terminal_create', 'edit_soft', 'subagent_spawn', 'delegator_admin']) {
      assert.equal(state.tools.includes(tool), false);
    }
  }
});

test('optional TODO planner survives role switches without enabling unrelated plugin tools', async () => {
  const { agents, pi, ctx, state } = fixture();
  pi.getAllTools = () => ['todo', 'subagent', 'code_rewrite'].map(name => ({ name }));
  for (const role of agentOrder) {
    await agents.select(role, ctx);
    assert.ok(state.tools.includes('todo'));
    assert.ok(!state.tools.includes('subagent'));
    assert.ok(!state.tools.includes('code_rewrite'));
    if (role === 'review') assert.ok(!state.tools.includes('write'));
  }
});
test('busy or unavailable switching retains the previous agent', async () => {
  const { agents, ctx, state } = fixture();
  await agents.select('review', ctx);
  state.idle = false; await assert.rejects(agents.select('fast', ctx));
  state.idle = true; state.allowed = false; await assert.rejects(agents.select('fast', ctx));
  assert.equal(agents.active, 'review'); assert.equal(state.thinking, 'medium');
  assert.ok(!state.tools.includes('write')); assert.equal(state.entries.length, 1);
});
test('restores role from current branch without adding a new entry', async () => {
  const { agents, ctx, state } = fixture();
  await agents.select('review', ctx); await agents.select('fast', ctx);
  state.entries.pop(); await agents.restore(ctx);
  assert.equal(agents.active, 'review'); assert.equal(state.entries.length, 1);
  state.entries.length = 0; await agents.restore(ctx); assert.equal(agents.active, 'orchestrator');
});


test('model and thinking overrides belong to the role and drive future worker selections', async () => {
  const { agents, ctx, state, pi } = fixture();
  await agents.select('general', ctx);
  await pi.setModel({ provider: 'other', id: 'experimental/model' });
  pi.setThinkingLevel('high');
  const snapshot = agents.selection('general');
  assert.deepEqual(snapshot, { model: 'other/experimental/model', thinking: 'high' });
  await agents.select('orchestrator', ctx);
  assert.equal(state.model.id, 'orchestrator');
  assert.deepEqual(agents.selection('general'), snapshot);
  assert.equal(agents.selection('fast').model, 'provider/fast');
  await agents.select('general', ctx);
  assert.equal(state.model.id, 'experimental/model');
  assert.equal(state.thinking, 'high');
  pi.setThinkingLevel('low');
  assert.equal(snapshot.thinking, 'high', 'an already launched worker keeps its selection snapshot');
  assert.equal(agents.selection('general').thinking, 'low');
});

test('role overrides restore from branch history and do not leak into another session', async () => {
  const { agents, ctx, state, pi } = fixture();
  await agents.select('fast', ctx);
  await pi.setModel({ provider: 'custom', id: 'fast-model' });
  pi.setThinkingLevel('medium');
  const checkpoint = structuredClone(state.entries);
  await agents.select('general', ctx);
  await pi.setModel({ provider: 'custom', id: 'general-model' });
  state.entries = checkpoint;
  await agents.restore(ctx);
  assert.equal(agents.active, 'fast');
  assert.equal(state.model.id, 'fast-model');
  assert.equal(state.thinking, 'medium');
  assert.equal(agents.selection('general').model, 'provider/general');
  assert.equal(state.entries.length, checkpoint.length);
  state.entries = [];
  await agents.restore(ctx);
  assert.equal(agents.selection('fast').model, 'provider/fast');
});

test('internal role switches and restore events never overwrite another role', async () => {
  const { agents, ctx, state } = fixture();
  await agents.select('general', ctx);
  await agents.select('review', ctx);
  assert.equal(state.entries.length, 2);
  assert.equal(agents.selection('general').model, 'provider/general');
  agents.modelChanged({ source: 'restore', model: { provider: 'other', id: 'restored' } });
  assert.equal(state.entries.length, 2);
  assert.equal(agents.selection('review').model, 'provider/review');
});

// --- cross-session persistence (injected store, backed by a temp file) ---

async function tempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piastra-prefs-'));
  const fileStore = createFilePrefsStore(path.join(dir, 'agents.json'));
  const pending = [];
  return { store: { file: fileStore.file, load: fileStore.load,
      save(role, entry) { const promise = fileStore.save(role, entry); pending.push(promise); return promise; } },
    cleanup: () => rm(dir, { recursive: true, force: true }),
    file: fileStore.file, settled: () => Promise.allSettled(pending) };
}

test('explicit model/thinking changes persist for the role across fresh agents', async () => {
  const temp = await tempStore();
  try {
    const first = fixture(temp.store);
    await first.agents.select('general', first.ctx);
    first.pi.setModel({ provider: 'other', id: 'experimental/model' });
    first.pi.setThinkingLevel('high');
    await temp.settled();
    assert.deepEqual(await loadPrefs(temp.file),
      { general: { model: 'other/experimental/model', thinking: 'high' } });
    // A fresh agent instance restores the persisted override from the store.
    const second = fixture(temp.store);
    await second.agents.restore(second.ctx);
    // The active role stays branch scoped; the stored override is ready.
    assert.equal(second.agents.active, 'orchestrator');
    assert.deepEqual(second.agents.selection('general'),
      { model: 'other/experimental/model', thinking: 'high' });
    await second.agents.select('general', second.ctx);
    assert.equal(second.state.model.id, 'experimental/model');
    assert.equal(second.state.thinking, 'high');
  } finally { await temp.cleanup(); }
});

test('persisted overrides stay isolated per role and defaults remain untouched', async () => {
  const temp = await tempStore();
  try {
    const { agents, ctx, pi } = fixture(temp.store);
    await agents.select('fast', ctx);
    pi.setModel({ provider: 'custom', id: 'fast-model' });
    pi.setThinkingLevel('medium');
    await temp.settled();
    assert.deepEqual(await loadPrefs(temp.file),
      { fast: { model: 'custom/fast-model', thinking: 'medium' } });
    const second = fixture(temp.store);
    await second.agents.restore(second.ctx);
    // Branch-less restore exits to the default active role, but the changed
    // role keeps its persisted override and other roles keep their defaults.
    assert.equal(second.agents.active, 'orchestrator');
    assert.deepEqual(second.agents.selection('fast'), { model: 'custom/fast-model', thinking: 'medium' });
    assert.deepEqual(second.agents.selection('general'), { model: 'provider/general', thinking: 'low' });
    assert.deepEqual(second.agents.selection('review'), { model: 'provider/review', thinking: 'medium' });
    assert.deepEqual(second.agents.selection('orchestrator'), { model: 'provider/orchestrator', thinking: 'low' });
  } finally { await temp.cleanup(); }
});

test('branch selections outrank persisted overrides and restoring preserves the store', async () => {
  const temp = await tempStore();
  try {
    const first = fixture(temp.store);
    await first.agents.select('general', first.ctx);
    first.pi.setModel({ provider: 'persisted', id: 'from-store' });
    first.pi.setThinkingLevel('low');
    await temp.settled();
    const second = fixture(temp.store);
    // Branch history contains a later explicit choice for the same role.
    second.state.entries.push({ type: 'custom', customType: 'piastra-agent',
      data: { role: 'general', selections: { general: { model: 'branch/model', thinking: 'high' } } } });
    await second.agents.restore(second.ctx);
    assert.equal(second.agents.active, 'general');
    assert.deepEqual(second.agents.selection('general'), { model: 'branch/model', thinking: 'high' });
    assert.equal(second.state.model.id, 'model');
    assert.equal(second.state.thinking, 'high');
    // Restore stays read-only for the persistent store.
    await temp.settled();
    assert.deepEqual(await loadPrefs(temp.file),
      { general: { model: 'persisted/from-store', thinking: 'low' } });
  } finally { await temp.cleanup(); }
});

test('switching agents and replays of applied selections do not rewrite prefs', async () => {
  const temp = await tempStore();
  const store = fixture(temp.store);
  try {
    await store.agents.select('review', store.ctx);
    store.pi.setModel({ provider: 'custom', id: 'review-model' });
    await temp.settled(); // flush the review write before capturing the baseline
    const before = await readFile(temp.file, 'utf8');
    // Pure role switching applies the role's known selection; no new choice.
    await store.agents.select('general', store.ctx);
    assert.equal(store.agents.active, 'general');
    // A host may deliver the applied model event after switching finished;
    // it carries no new choice because the model already matches the role.
    store.agents.modelChanged({ source: 'set', model: { provider: 'provider', id: 'general' } });
    assert.equal(await readFile(temp.file, 'utf8'), before);
    // A genuinely new model still writes only the active role.
    store.agents.modelChanged({ source: 'set', model: { provider: 'other', id: 'general-x' } });
    await temp.settled();
    assert.deepEqual(await loadPrefs(temp.file),
      { review: { model: 'custom/review-model', thinking: 'medium' },
        general: { model: 'other/general-x', thinking: 'low' } });
  } finally { await temp.cleanup(); }
});

test('corrupt storage degrades to defaults and remains writable', async () => {
  const temp = await tempStore();
  try {
    await writeFile(temp.file, '{not json');
    assert.deepEqual(await temp.store.load(), {});
    const instance = fixture(temp.store);
    await instance.agents.restore(instance.ctx);
    assert.deepEqual(instance.agents.selection('general'), { model: 'provider/general', thinking: 'low' });
    // Preference saving self-heals the corrupt file (merge over an empty base).
    await instance.agents.select('fast', instance.ctx);
    instance.pi.setThinkingLevel('high');
    await temp.settled();
    assert.deepEqual(await loadPrefs(temp.file), { fast: { model: 'provider/fast', thinking: 'high' } });
  } finally { await temp.cleanup(); }
});

test('invalid stored role entries are dropped, valid ones survive', async () => {
  const temp = await tempStore();
  try {
    await writeFile(temp.file, JSON.stringify({ roles: {
      general: { model: 'no-slash', thinking: 'low' },
      fast: { model: 'p/fast', thinking: 'banana' },
      review: { model: 'p/review', thinking: 'high' },
      orchestrator: 'junk'
    } }));
    const { agents, ctx } = fixture(temp.store);
    await agents.restore(ctx);
    assert.deepEqual(agents.selection('review'), { model: 'p/review', thinking: 'high' });
    assert.deepEqual(agents.selection('general'), { model: 'provider/general', thinking: 'low' });
    assert.deepEqual(agents.selection('fast'), { model: 'provider/fast', thinking: 'low' });
    assert.deepEqual(agents.selection('orchestrator'), { model: 'provider/orchestrator', thinking: 'low' });
  } finally { await temp.cleanup(); }
});

test('persist a changed role without clobbering another role stored concurrently', async () => {
  const temp = await tempStore();
  try {
    await savePrefs(temp.file, 'review', { model: 'a/review', thinking: 'high' });
    await savePrefs(temp.file, 'general', { model: 'b/general', thinking: null });
    assert.deepEqual(await loadPrefs(temp.file), {
      review: { model: 'a/review', thinking: 'high' },
      general: { model: 'b/general', thinking: null }
    });
  } finally { await temp.cleanup(); }
});

test('independent store instances on one file serialize their read/merge/write cycles', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piastra-prefs-multi-'));
  const file = path.join(dir, 'agents.json');
  try {
    await savePrefs(file, 'orchestrator', { model: 'a/orchestrator', thinking: 'low' });
    // Two unrelated store instances (as separate Pi processes would be) issue
    // overlapping saves; each must merge on top of the other's result.
    const first = createFilePrefsStore(file);
    const second = createFilePrefsStore(file);
    await Promise.all([
      first.save('general', { model: 'a/general', thinking: 'high' }),
      second.save('fast', { model: 'b/fast', thinking: null }),
      first.save('review', { model: 'a/review', thinking: 'medium' }),
      second.save('orchestrator', { model: 'b/orchestrator', thinking: 'low' })
    ]);
    assert.deepEqual(await loadPrefs(file), {
      orchestrator: { model: 'b/orchestrator', thinking: 'low' },
      general: { model: 'a/general', thinking: 'high' },
      fast: { model: 'b/fast', thinking: null },
      review: { model: 'a/review', thinking: 'medium' }
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// --- cross-process concurrency (real child processes, one prefs file) ---

const CHILD_WRITES = 8;

async function spawnPrefWriters(file) {
  // Each child is an independent process with its own store state; all write
  // a distinct role repeatedly and concurrently to the same prefs file.
  const script = path.join(path.dirname(file), `write-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(script, `
    import { savePrefs } from ${JSON.stringify(new URL('./prefs.mjs', import.meta.url).href)};
    const [file, role, count] = process.argv.slice(2);
    for (let i = 0; i < Number(count); i++) {
      await savePrefs(file, role, { model: 'p/' + role + '-' + i, thinking: role === 'review' ? 'high' : 'low' });
    }
  `);
  const roles = ['general', 'fast', 'review', 'orchestrator'];
  const children = roles.map(role => spawn(process.execPath, [script, file, role, String(CHILD_WRITES)], {
    stdio: ['ignore', 'ignore', 'pipe']
  }));
  const failures = await Promise.all(children.map(child => new Promise(resolve => {
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve(code === 0 ? null : `exit ${code}: ${stderr.trim()}`));
  })));
  await rm(script, { force: true }).catch(() => {});
  assert.deepEqual(failures, roles.map(() => null));
  // Every role's last write must survive; a lost update would show up as an
  // older model id or a role missing entirely.
  const prefs = await loadPrefs(file);
  for (const role of roles) {
    assert.deepEqual(prefs[role],
      { model: `p/${role}-${CHILD_WRITES - 1}`, thinking: role === 'review' ? 'high' : 'low' },
      `role ${role} lost a concurrent update`);
  }
}

test('truly concurrent independent processes persist distinct roles without clobbering', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piastra-prefs-proc-'));
  try {
    await spawnPrefWriters(path.join(dir, 'agents.json'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a held lock makes a bounded save reject and leaves the original file untouched', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piastra-prefs-hold-'));
  const file = path.join(dir, 'agents.json');
  const { default: lockfile } = await import('proper-lockfile');
  try {
    await writeFile(file, JSON.stringify({ roles: { general: { model: 'p/general', thinking: 'low' } } }));
    const before = await readFile(file, 'utf8');
    // Simulate another process holding the lock beyond the bounded
    // acquisition window (40 attempts x max 100 ms): the save must reject,
    // not steal the lock or degrade to an unlocked write. The holder only
    // releases once the save has finished (it always exhausts its bounded
    // retries on its own), so the test cannot race the release.
    const release = await lockfile.lock(file, { retries: 0, stale: 60_000, realpath: false });
    await assert.rejects(
      savePrefs(file, 'fast', { model: 'p/fast', thinking: 'high' }),
      error => /lock/i.test(error.message)
    );
    assert.equal(await readFile(file, 'utf8'), before, 'the held file must remain untouched');
    await release();
    // Once the holder released, the same save succeeds and merges on top.
    await savePrefs(file, 'fast', { model: 'p/fast', thinking: 'high' });
    assert.deepEqual(await loadPrefs(file), {
      general: { model: 'p/general', thinking: 'low' },
      fast: { model: 'p/fast', thinking: 'high' }
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failure notice names the role whose write failed even if the agent switched meanwhile', async () => {
  let failSave;
  const store = {
    load: async () => ({}),
    save(role) {
      return new Promise((resolve, reject) => { failSave = () => reject(new Error('disk unavailable')); });
    }
  };
  const f = fixture(store);
  await f.agents.select('general', f.ctx);
  f.pi.setModel({ provider: 'other', id: 'general-x' }); // schedules the general write
  // Switch roles while the write is still pending: the notice must not be
  // mislabeled with the newly active role.
  await f.agents.select('review', f.ctx);
  assert.equal(f.agents.active, 'review');
  failSave();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.notices.length, 1);
  assert.equal(f.state.notices[0].level, 'error');
  assert.match(f.state.notices[0].message, /could not remember general agent preferences/);
  assert.doesNotMatch(f.state.notices[0].message, /review/);
});

test('a rejected store save surfaces an error notice for the active role', async () => {
  const store = {
    load: async () => ({}),
    save: async () => { throw new Error('read-only volume'); }
  };
  const f = fixture(store);
  f.pi.setModel({ provider: 'other', id: 'orchestrator-x' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.notices.length, 1);
  assert.equal(f.state.notices[0].level, 'error');
  assert.match(f.state.notices[0].message, /could not remember orchestrator agent preferences/);
  assert.match(f.state.notices[0].message, /read-only volume/);
});
