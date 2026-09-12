import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgents, agentOrder } from './agents.mjs';

function fixture() {
  const state = { tools: [], entries: [], idle: true, status: '', model: null, thinking: null, allowed: true };
  const config = Object.fromEntries(agentOrder.map(role => [role, { model: `provider/${role}`, thinking: role === 'review' ? 'medium' : 'low' }]));
  const pi = {
    async setModel(model) { if (!state.allowed) return false; state.model = model; return true; },
    setThinkingLevel(level) { state.thinking = level; },
    setActiveTools(tools) { state.tools = tools; },
    appendEntry(customType, data) { state.entries.push({ type: 'custom', customType, data }); }
  };
  const ctx = { isIdle: () => state.idle, modelRegistry: { find: (provider, id) => ({ provider, id }) }, sessionManager: { getBranch: () => state.entries }, ui: { setStatus: (_key, value) => { state.status = value; } } };
  return { state, ctx, agents: createAgents(pi, config) };
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
