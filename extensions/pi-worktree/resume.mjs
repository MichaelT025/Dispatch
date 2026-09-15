/**
 * `/worktree resume` — pick a session from ANY checkout of the repository.
 *
 * Pi's `/resume` lists one directory's sessions (`sessions/--<cwd>--/`), so
 * work started in a linked worktree is invisible from the main checkout and
 * vice versa. This module groups every session of the repository by the
 * checkout it ran in (main first, then the current checkout, then the rest
 * by recency), newest first within a checkout, hides sessions that never
 * received a message, and renders the picker lines. Pure: the caller feeds
 * it `git worktree list` entries and `SessionManager.listAll()` results.
 */

/** Session summaries the picker keeps: empty sessions are never offered. */
export function listableSessions(infos) {
  return infos.filter(info => info && info.messageCount > 0);
}

function norm(p) {
  const s = String(p || '').replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

export function samePath(a, b) {
  return norm(a) === norm(b);
}

/**
 * Group sessions under the checkout whose path matches their cwd. A session
 * from a directory that is no longer a checkout is dropped (it belongs to a
 * removed worktree; `pi` in that path would not find it either).
 *
 * Order: main checkout, then the current checkout (if different), then the
 * remaining checkouts by their newest session; checkouts without sessions
 * come last, so a fresh worktree is still offered as a target. Sessions in
 * a group are newest first.
 */
export function groupSessions(worktrees, infos, currentCwd) {
  const groups = worktrees.map((wt, index) => ({ worktree: wt, isMain: index === 0, isCurrent: samePath(wt.path, currentCwd), sessions: [] }));
  for (const info of listableSessions(infos)) {
    const group = groups.find(g => samePath(g.worktree.path, info.cwd));
    if (group) group.sessions.push(info);
  }
  for (const group of groups) group.sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  const newest = g => g.sessions[0]?.modified.getTime() ?? -1;
  return groups.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return newest(b) - newest(a);
  });
}

/** "2h ago" style label, coarse on purpose (the picker is a list). */
export function relativeTime(date, now = Date.now()) {
  const s = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  return date.toISOString().slice(0, 10);
}

/** What a session is called in lists: its name, else the first message. */
export function sessionLabel(info, max = 48) {
  const raw = (info.name || info.firstMessage || '').replace(/\s+/g, ' ').trim() || '(untitled)';
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

function shortenHome(p, home) {
  const n = String(p).replace(/[\\/]+/g, '/');
  const h = String(home || '').replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return h && (norm(n) === norm(h) || norm(n).startsWith(`${norm(h)}/`)) ? `~${n.slice(h.length)}` : n;
}

/**
 * Picker lines with a parallel index of what each line means. A checkout
 * header line is selectable too: picking it starts a fresh session there.
 * Session lines are indented under their checkout; the live session is
 * marked with ●.
 */
export function renderPicker(groups, { currentSessionFile, home, now = Date.now() } = {}) {
  const lines = [];
  const targets = [];
  for (const group of groups) {
    const wt = group.worktree;
    const branch = wt.branch ?? `(detached ${String(wt.head || '').slice(0, 8)})`;
    const tags = [group.isMain ? 'main' : null, group.isCurrent ? 'current' : null].filter(Boolean).join(', ');
    lines.push(`${branch}  →  ${shortenHome(wt.path, home)}${tags ? `  (${tags})` : ''}`);
    targets.push({ kind: 'worktree', path: wt.path, branch });
    if (group.sessions.length === 0) {
      lines.push('    (no sessions — pick the checkout to start one)');
      targets.push({ kind: 'worktree', path: wt.path, branch });
      continue;
    }
    for (const info of group.sessions) {
      const live = currentSessionFile && samePath(info.path, currentSessionFile);
      const count = `${info.messageCount} msg${info.messageCount === 1 ? '' : 's'}`;
      lines.push(`  ${live ? '●' : ' '} ${sessionLabel(info)}  ·  ${count} · ${relativeTime(info.modified, now)}`);
      targets.push({ kind: 'session', path: info.path, cwd: info.cwd, live: !!live, label: sessionLabel(info) });
    }
  }
  return { lines, targets };
}
