/** Upstream pi-web-ui first-party subagent/delegation tool names (fork
 *  server tool catalog, server/tool-manager.ts). Foreign delegation systems:
 *  disabled in the fork UI state and blocked in every PiAstra session so the
 *  PiAstra `delegate` tool stays the single delegation system. */
export const UPSTREAM_DELEGATION_TOOLS = [
  'subagent_spawn', 'subagent_get_result', 'subagent_steer', 'subagent_list',
  'subagent_stop', 'subagent_wait_all', 'subagent_templates', 'delegate_task',
];

/** Fork server AI-side terminal tools (kept enabled for editing roles, but
 *  review stays read-only, so they are part of its removal set). */
export const FORK_TERMINAL_TOOLS = [
  'terminal_create', 'terminal_list', 'terminal_close', 'terminal_input',
  'terminal_key', 'terminal_read', 'terminal_wait',
];

/** Tools seeded disabled in the fork UI client state (fork-specific
 *  `.local/fork-web` settings): every foreign delegation tool, the AI-side
 *  terminal tools and the redundant soft-edit tool. Terminal tools are listed
 *  explicitly because an explicit list replaces the fork's legacy defaults;
 *  bash itself stays available. */
export const FORK_DISABLED_AGENT_TOOLS = [...UPSTREAM_DELEGATION_TOOLS, ...FORK_TERMINAL_TOOLS, 'edit_soft'];

export function validateTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('Supply at least one task.');
  for (const task of tasks) {
    if (!['general', 'fast', 'review'].includes(task.role)) throw new Error('Unknown worker role.');
    if (!['read', 'write'].includes(task.access)) throw new Error('Specify read or write access.');
    if (typeof task.task !== 'string' || !task.task.trim()) throw new Error('Task must be nonempty.');
    if (task.role === 'review' && task.access !== 'read') throw new Error('Reviewers cannot edit.');
  }
}

export function gitArguments(operation, revision) {
  if (!['status', 'diff', 'log', 'show'].includes(operation)) throw new Error('Unsupported Git operation.');
  if (revision && (!/^[a-zA-Z0-9_./~^@{}-]+$/.test(revision) || revision.startsWith('-'))) throw new Error('Invalid revision.');
  const args = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];
  if (operation === 'status') return [...args, 'status', '--short', '--untracked-files=normal'];
  if (operation === 'log') return [...args, 'log', '-12', '--oneline', revision || 'HEAD', '--'];
  return [...args, operation, '--no-ext-diff', '--no-textconv', '--no-color', revision || 'HEAD', '--'];
}
