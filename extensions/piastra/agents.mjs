import { validateRoleEntry } from './prefs.mjs';
import { WORKER_TOOL_NAMES } from './worker-runtime.mjs';

export const agentOrder = ['orchestrator', 'general', 'fast', 'review'];
// Review has constrained check execution, not a filesystem sandbox: trusted
// test commands may write artifacts. It cannot edit source or publish notes.
const readTools = ['read', 'grep', 'find', 'ls', 'inspect_git', 'fetch_url', 'web_search', 'run_checks', 'read_note', 'list_notes'];
const writeTools = ['bash', 'edit', 'write', 'write_note'];

export function workerTools(access) {
  if (!['read', 'write'].includes(access)) throw new Error('Unknown worker access.');
  return access === 'write' ? [...readTools, ...writeTools] : [...readTools];
}

/**
 * Exact active tool set per role (the original CLI contract). The set
 * replaces whatever is currently active, so unknown tools — including any
 * fork/server extras such as terminal_*, edit_soft, upstream subagent_* or
 * other mutation/delegation tools — cannot leak into a role after switching.
 * Model-facing terminal tools are not needed: the fork UI terminal owns its
 * own session and does not depend on the agent's active tool set.
 */
export function agentTools(role) {
  if (role === 'review') return [...readTools];
  if (role === 'orchestrator') return [...readTools, ...writeTools, ...WORKER_TOOL_NAMES];
  return [...readTools, ...writeTools];
}

export function createAgents(pi, config, store) {
  let active = 'orchestrator';
  let switching = false;
  const defaults = () => Object.fromEntries(agentOrder.map(role => [role, { ...config[role] }]));
  let selections = defaults();
  const save = () => pi.appendEntry('piastra-agent', { role: active, selections: structuredClone(selections) });
  // Writes an explicitly changed role to the optional cross-session store.
  // Switching agents or restoring only reapplies known selections, so the
  // gained value never differs from what the role already had and is not
  // persisted (that would, for example, roll a branch back to stale prefs).
  const persist = (previousModel, previousThinking, ctx) => {
    if (!store) return;
    if (selections[active].model === previousModel && selections[active].thinking === previousThinking) return;
    // Capture the role now: the write is async, and switching agents while it
    // is still pending must not mislabel the failure notice with the new role.
    const role = active;
    store.save(role, selections[role]).catch(error =>
      ctx?.ui?.notify?.(`Dispatch could not remember ${role} agent preferences: ${error.message}`, 'error'));
  };
  return {
    get active() { return active; },
    selection(role) { return { ...selections[role] }; },
    modelChanged(event, ctx) {
      if (switching || event.source === 'restore') return;
      const previous = { model: selections[active].model, thinking: selections[active].thinking };
      selections[active] = { model: `${event.model.provider}/${event.model.id}`, thinking: pi.getThinkingLevel() };
      save();
      persist(previous.model, previous.thinking, ctx);
    },
    thinkingChanged(event, ctx) {
      if (switching) return;
      const previous = { model: selections[active].model, thinking: selections[active].thinking };
      selections[active] = { ...selections[active], thinking: event.level };
      save();
      persist(previous.model, previous.thinking, ctx);
    },
    async select(role, ctx, persist = true) {
      if (!agentOrder.includes(role)) throw new Error(`Unknown agent. Choose ${agentOrder.join(', ')}.`);
      if (switching || !ctx.isIdle()) throw new Error('Wait for the current turn to finish, or stop it before switching agents.');
      switching = true;
      try {
        const selection = selections[role];
        const slash = selection.model.indexOf('/');
        const model = ctx.modelRegistry.find(selection.model.slice(0, slash), selection.model.slice(slash + 1));
        if (!model || !await pi.setModel(model)) throw new Error(`Cannot activate ${selection.model}. Previous agent retained; no fallback used.`);
        pi.setThinkingLevel(selection.thinking || 'off');
        // Preserve the optional session planner without admitting other plugins'
        // delegation or write tools into a role's allowlist.
        const planner = pi.getAllTools?.().some(tool => tool.name === 'todo') ? ['todo'] : [];
        pi.setActiveTools([...agentTools(role), ...planner]);
        active = role;
        if (persist) save();
        ctx.ui.setStatus('piastra-agent', `Agent: ${role}`);
      } finally { switching = false; }
    },
    async restore(ctx) {
      const saved = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === 'custom' && e.customType === 'piastra-agent');
      selections = defaults();
      // Persisted user overrides are lower precedence than the session branch
      // (branch selections win, active role stays branch scoped); they seed
      // sessions without branch history. Restoring never writes the store.
      let persisted = {};
      if (store) { try { persisted = await store.load(); } catch { persisted = {}; } }
      for (const role of agentOrder) {
        for (const choice of [persisted[role], saved?.data?.selections?.[role]]) {
          const valid = validateRoleEntry(choice);
          if (valid) selections[role] = valid;
        }
      }
      await this.select(agentOrder.includes(saved?.data?.role) ? saved.data.role : 'orchestrator', ctx, false);
    },
    async cycle(ctx) { await this.select(agentOrder[(agentOrder.indexOf(active) + 1) % agentOrder.length], ctx); }
  };
}
