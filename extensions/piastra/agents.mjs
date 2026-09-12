export const agentOrder = ['orchestrator', 'general', 'fast', 'review'];
const readTools = ['read', 'grep', 'find', 'ls', 'inspect_git', 'fetch_url'];
export function agentTools(role) {
  return role === 'review' ? readTools : [...readTools, 'bash', 'edit', 'write', ...(role === 'orchestrator' ? ['delegate'] : [])];
}

export function createAgents(pi, config) {
  let active = 'orchestrator';
  let switching = false;
  const defaults = () => Object.fromEntries(agentOrder.map(role => [role, { ...config[role] }]));
  let selections = defaults();
  const save = () => pi.appendEntry('piastra-agent', { role: active, selections: structuredClone(selections) });
  return {
    get active() { return active; },
    selection(role) { return { ...selections[role] }; },
    modelChanged(event) {
      if (switching || event.source === 'restore') return;
      selections[active] = { model: `${event.model.provider}/${event.model.id}`, thinking: pi.getThinkingLevel() };
      save();
    },
    thinkingChanged(event) {
      if (switching) return;
      selections[active] = { ...selections[active], thinking: event.level };
      save();
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
      for (const role of agentOrder) {
        const choice = saved?.data?.selections?.[role];
        if (typeof choice?.model === 'string' && choice.model.includes('/') &&
          (choice.thinking === null || ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(choice.thinking))) {
          selections[role] = { model: choice.model, thinking: choice.thinking };
        }
      }
      await this.select(agentOrder.includes(saved?.data?.role) ? saved.data.role : 'orchestrator', ctx, false);
    },
    async cycle(ctx) { await this.select(agentOrder[(agentOrder.indexOf(active) + 1) % agentOrder.length], ctx); }
  };
}
