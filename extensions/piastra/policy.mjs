export function validateTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 3) throw new Error('Supply 1–3 tasks.');
  for (const task of tasks) {
    if (!['general', 'fast', 'review'].includes(task.role)) throw new Error('Unknown worker role.');
    if (!['read', 'write'].includes(task.access)) throw new Error('Specify read or write access.');
    if (typeof task.task !== 'string' || !task.task.trim()) throw new Error('Task must be nonempty.');
    if (task.role === 'review' && task.access !== 'read') throw new Error('Reviewers cannot edit.');
  }
  if (tasks.length > 1 && tasks.some(t => t.access === 'write' || t.role === 'review')) throw new Error('Editing and review require a single-task batch. Only read-only research can run in parallel.');
}

// A promise queue shared by every dispatch in one Pi process. Research inside
// a batch can overlap; a second batch waits for the first to finish.
export function createQueue() {
  let tail = Promise.resolve();
  return function enqueue(work) {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
}

export function gitArguments(operation, revision) {
  if (!['status', 'diff', 'log', 'show'].includes(operation)) throw new Error('Unsupported Git operation.');
  if (revision && (!/^[a-zA-Z0-9_./~^@{}-]+$/.test(revision) || revision.startsWith('-'))) throw new Error('Invalid revision.');
  const args = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];
  if (operation === 'status') return [...args, 'status', '--short', '--untracked-files=normal'];
  if (operation === 'log') return [...args, 'log', '-12', '--oneline', revision || 'HEAD', '--'];
  return [...args, operation, '--no-ext-diff', '--no-textconv', '--no-color', revision || 'HEAD', '--'];
}
