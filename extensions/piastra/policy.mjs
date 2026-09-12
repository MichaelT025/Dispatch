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
