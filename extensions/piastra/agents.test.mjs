import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgents, agentOrder } from './agents.mjs';

function fixture() {
  let agents;
  const state = { tools: [], entries: [], idle: true, status: '', model: null, thinking: null, allowed: true };
  const config = Object.fromEntries(agentOrder.map(role => [role, { model: `provider/${role}`, thinking: role === 'review' ? 'medium' : 'low' }]));
  const pi = {
    async setModel(model) { if (!state.allowed) return false; state.model = model; agents?.modelChanged({ model, source: 'set' }); return true; },
    setThinkingLevel(level) { state.thinking = level; agents?.thinkingChanged({ level }); },
    getThinkingLevel() { return state.thinking; },
    setActiveTools(tools) { state.tools = tools; },
    appendEntry(customType, data) { state.entries.push({ type: 'custom', customType, data }); }
  };
  const ctx = { isIdle: () => state.idle, modelRegistry: { find: (provider, id) => ({ provider, id }) }, sessionManager: { getBranch: () => state.entries }, ui: { setStatus: (_key, value) => { state.status = value; } } };
  agents = createAgents(pi, config);
  return { state, ctx, agents, pi };
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
