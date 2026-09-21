import { execFile } from 'node:child_process';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

export function stoppingPoint(worker) {
  return {
    activity: worker.activity || 'No activity recorded',
    pending: Object.values(worker.pendingTools || {}).map(tool => tool.description),
    recent: [...(worker.recent || [])].slice(-10),
    partialResponse: worker.text || '',
  };
}

export function formatStoppingPoint(point) {
  if (!point) return '';
  return ['Stopping point (observed; not a completion report):',
    `Last activity: ${point.activity}`,
    ...point.pending.map(tool => `In flight (outcome unknown): ${tool}`),
    ...point.recent.map(line => `  ${line}`),
    point.partialResponse ? `Latest assistant text (may be incomplete):\n${point.partialResponse}` : '',
  ].filter(Boolean).join('\n');
}

const git = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', ['--literal-pathspecs', ...args], {
    cwd, timeout: 5000, maxBuffer: 65536, windowsHide: true,
  }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
});

// Shared worktree evidence, not worker attribution. Shell-based edits cannot
// be inferred from edit/write events; untracked files have no ordinary diff.
export async function collectFileEvidence(worker, cwd) {
  const files = [...new Set(worker.changedFiles || [])];
  if (!files.length) return { files, stat: '' };
  try {
    // Git resolves directory aliases (Windows junctions/short names and
    // POSIX symlinks). Resolve cwd too before comparing repository paths.
    const canonicalCwd = await realpath(cwd);
    const root = await realpath(await git(canonicalCwd, ['rev-parse', '--show-toplevel']));
    const paths = await Promise.all(files.map(async file => {
      const target = path.resolve(canonicalCwd, file);
      // Resolve directory aliases, not a tracked symlink's file target.
      // A deleted file still needs to appear in the diff stat.
      const parent = await realpath(path.dirname(target)).catch(() => path.dirname(target));
      return path.relative(root, path.join(parent, path.basename(target)));
    }));
    const inside = paths.filter(file => file && file !== '..' && !file.startsWith(`..${path.sep}`) && !path.isAbsolute(file));
    const outside = paths.length - inside.length;
    const stat = inside.length ? await git(root, ['diff', 'HEAD', '--stat', '--', ...inside]) : '';
    const untracked = inside.length ? await git(root, ['ls-files', '--others', '--exclude-standard', '--', ...inside]) : '';
    return { files, stat: [stat || '(No tracked diff against HEAD.)', untracked ? `Untracked files (not in diff stat):\n${untracked}` : '', outside ? `${outside} path(s) outside repository; omitted from stat.` : ''].filter(Boolean).join('\n') };
  } catch (error) {
    return { files, stat: `Git diff stat unavailable: ${String(error.message).slice(0, 400)}` };
  }
}

export function formatFileEvidence(evidence) {
  if (!evidence) return '';
  return `Files changed (observed successful edit/write calls only): ${evidence.files.length ? evidence.files.map(file => JSON.stringify(file)).join(', ') : '(none observed)'}\nShell edits are not tracked here.${evidence.stat ? `\nShared-worktree git diff --stat against HEAD (may include others' edits):\n${evidence.stat}` : ''}`;
}
