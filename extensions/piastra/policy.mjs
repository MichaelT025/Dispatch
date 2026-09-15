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

export function gitArguments(operation, revision, filePath) {
  if (!['status', 'diff', 'log', 'show', 'blame', 'stat'].includes(operation)) throw new Error('Unsupported Git operation.');
  const hasRevision = revision !== undefined && revision !== null && revision !== '';
  if (hasRevision && (typeof revision !== 'string' || !/^[a-zA-Z0-9_./~^@{}-]+$/.test(revision) || revision.startsWith('-'))) throw new Error('Invalid revision.');
  const rev = hasRevision ? revision : 'HEAD';
  const args = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];
  if (operation === 'status') {
    if (hasRevision) throw new Error('status takes no revision.');
    if (filePath !== undefined) throw new Error('status takes no file path.');
    return [...args, 'status', '--short', '--untracked-files=normal'];
  }
  if (operation !== 'blame' && filePath !== undefined) throw new Error('This operation takes no file path.');
  if (operation === 'log') return [...args, 'log', '-12', '--oneline', rev, '--'];
  // `stat` is a read-only diff summary (who/how-big questions without bash).
  if (operation === 'stat') return [...args, 'diff', '--stat', '--no-ext-diff', '--no-textconv', '--no-color', rev, '--'];
  // `blame` answers "who last touched this" without a shell; it needs a file.
  // --no-textconv/--no-ext-diff keep repo .gitattributes/config from invoking
  // external helpers; -- always separates the file path from options.
  if (operation === 'blame') {
    if (filePath === undefined || filePath === null || filePath === '') throw new Error('blame requires a file path.');
    if (!isSafeGitPath(filePath)) throw new Error('Invalid file path.');
    return [...args, 'blame', '--no-ext-diff', '--no-textconv', '--no-color-lines', '--no-color-by-age', rev, '--', filePath.replace(/\\/g, '/')];
  }
  return [...args, operation, '--no-ext-diff', '--no-textconv', '--no-color', rev, '--'];
}

/** Relative repo paths only: no escapes, no option injection, no NUL.
 * Backslashes normalize to forward slashes; dotfiles, spaces and Unicode
 * names are allowed. Rejects absolute/drive paths, `.`/`..` segments,
 * empty segments and leading `-` (option injection). */
export function isSafeGitPath(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 512) return false;
  if (filePath.includes('\0')) return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('-') || normalized.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  const parts = normalized.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) return false;
  return true;
}
