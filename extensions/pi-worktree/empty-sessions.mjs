/**
 * Empty session files.
 *
 * Pi writes a session file lazily — the header lands with the first entry —
 * but `/worktree add|open` must create the file up front (pi's `newSession`
 * cannot target another cwd, so the extension writes the header and hands
 * the path to `switchSession`). Leave such a session without sending
 * anything and a header-only file stays behind, listed as "(no messages)"
 * everywhere. These helpers recognise a session that holds no conversation
 * and remove it once the runtime has let go of it (session_shutdown), and
 * `/wt resume` sweeps any older leftovers in the repository's checkouts.
 *
 * "Empty" is decided on entry types, not line count: a fresh session also
 * records model / thinking selections and PiAstra's agent entry before the
 * first message. A user-named session (`session_info`) is never empty.
 */
import { readFile, unlink } from 'node:fs/promises';

/** Entry types that mean a session carries a conversation worth keeping. */
const CONTENT_TYPES = new Set(['message', 'custom_message', 'session_info', 'compaction', 'branch_summary']);

/**
 * True when `text` (a session JSONL) holds a session header and no content
 * entry. Unparseable input is never empty — we only delete what we can read.
 */
export function isEmptySessionText(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return false;
  let header = false;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { return false; }
    if (!entry || typeof entry !== 'object') return false;
    if (entry.type === 'session') { header = true; continue; }
    if (CONTENT_TYPES.has(entry.type)) return false;
  }
  return header;
}

/** Read `file` and report whether it is an empty session; missing → false. */
export async function isEmptySessionFile(file) {
  try {
    return isEmptySessionText(await readFile(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Delete `file` when it is an empty session. Returns true when removed.
 * Re-checks right before unlinking so a session that just received its
 * first message is left alone.
 */
export async function removeEmptySession(file) {
  if (!file || !(await isEmptySessionFile(file))) return false;
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove every empty session among `infos` (SessionManager list entries),
 * except `keep` (the live session's file). Returns the removed paths.
 */
export async function pruneEmptySessions(infos, keep) {
  const removed = [];
  for (const info of infos) {
    if (!info?.path || (keep && samePath(info.path, keep))) continue;
    if (info.messageCount > 0 || info.name) continue;
    if (await removeEmptySession(info.path)) removed.push(info.path);
  }
  return removed;
}

function samePath(a, b) {
  const norm = p => String(p).replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}
