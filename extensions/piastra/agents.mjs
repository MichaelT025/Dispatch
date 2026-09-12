export const agentOrder = ['orchestrator', 'general', 'fast', 'review'];
const readTools = ['read', 'grep', 'find', 'ls', 'inspect_git', 'fetch_url'];
export function agentTools(role) {
  return role === 'review' ? readTools : [...readTools, 'bash', 'edit', 'write', ...(role === 'orchestrator' ? ['delegate'] : [])];
}

export function createAgents(pi, config) {
  let active = 'orchestrator';
  let switching = false;
  return {
    get active() { return active; },
    async select(role, ctx, persist = true) {
      if (!agentOrder.includes(role)) throw new Error(`Unknown agent. Choose ${agentOrder.join(', ')}.`);
      if (switching || !ctx.isIdle()) throw new Error('Wait for the current turn to finish, or stop it before switching agents.');
      switching = true;
      try {
        const selection = config[role];
        const slash = selection.model.indexOf('/');
        const model = ctx.modelRegistry.find(selection.model.slice(0, slash), selection.model.slice(slash + 1));
        if (!model || !await pi.setModel(model)) throw new Error(`Cannot activate ${selection.model}. Previous agent retained; no fallback used.`);
        pi.setThinkingLevel(selection.thinking || 'off');
        pi.setActiveTools(agentTools(role));
        active = role;
        if (persist) pi.appendEntry('piastra-agent', { role });
        ctx.ui.setStatus('piastra-agent', `Agent: ${role}`);
      } finally { switching = false; }
    },
    async restore(ctx) {
      const saved = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === 'custom' && e.customType === 'piastra-agent');
      await this.select(agentOrder.includes(saved?.data?.role) ? saved.data.role : 'orchestrator', ctx, false);
    },
    async cycle(ctx) { await this.select(agentOrder[(agentOrder.indexOf(active) + 1) % agentOrder.length], ctx); }
  };
}
