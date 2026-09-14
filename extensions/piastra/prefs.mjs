import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Validates one stored per-role preference entry. Returns a normalized
 * { model, thinking } pair or null when the entry must be ignored.
 */
export function validateRoleEntry(entry) {
  if (typeof entry?.model !== 'string' || !entry.model.includes('/')) return null;
  if (!(entry.thinking === null || thinkingLevels.includes(entry.thinking))) return null;
  return { model: entry.model, thinking: entry.thinking };
}

/**
 * Reads per-role {model, thinking} preferences from a JSON file. A missing or
 * corrupt file, or invalid entries, degrade gracefully to an empty map — the
 * configuration defaults stay in force. Only plain objects are accepted.
 * Reads need no lock: saves replace the file atomically via rename, so a
 * reader always sees one complete generation.
 */
export async function loadPrefs(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
  const roles = parsed?.roles;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return {};
  return Object.fromEntries(Object.entries(roles)
    .map(([role, entry]) => [role, validateRoleEntry(entry)])
    .filter(([, entry]) => entry));
}

// --- cross-process serialization -------------------------------------------
//
// A save must serialize its whole read/merge/write cycle against other
// processes (independent Pi sessions share one prefs file). An in-process
// queue alone cannot do that: two processes can both read the same snapshot
// and the later rename then drops the other process's role write. The file
// lock below is held across read, merge and rename.

// Bounded acquisition: never wait forever for a lock.
const LOCK_ATTEMPTS = 40;
const LOCK_MIN_MS = 20;
const LOCK_MAX_MS = 100;
// A lock older than this belongs to a crashed holder and may be taken over.
const LOCK_STALE_MS = 10_000;

/**
 * Acquires an exclusive lock for writes to `file`. Returns a release
 * function; rejects when no lock could be acquired within the bounded
 * attempts, so the caller can surface the failure to the user instead of
 * silently writing without serialization.
 */
async function acquireLock(file) {
  const release = await lockfile.lock(file, {
    retries: { retries: LOCK_ATTEMPTS, factor: 1, minTimeout: LOCK_MIN_MS, maxTimeout: LOCK_MAX_MS, randomize: false },
    stale: LOCK_STALE_MS,
    realpath: false
  });
  return async () => { try { await release(); } catch { /* a stale takeover cleans the lock up */ } };
}

// In-process chains, keyed by resolved file path, keep same-process stores
// (and the mkdir/rename sequence of one save) ordered; the file lock above
// adds the cross-process guarantee on top.
const fileChains = new Map();

function runExclusively(file, task) {
  const key = path.resolve(file);
  const previous = fileChains.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  // The stored chain swallows the outcome so a failed save never blocks
  // later saves on the same file.
  fileChains.set(key, run.then(() => {}, () => {}));
  return run;
}

let tempSequence = 0;

/**
 * Persists one role's preference entry by merging the latest on-disk roles
 * (other roles keep their stored values, so concurrent or older sessions
 * cannot clobber unrelated roles) and replacing the file atomically via a
 * temp file plus rename. The whole read/merge/write cycle runs under a
 * cross-process file lock with bounded acquisition: when the lock cannot be
 * acquired within the bounded attempts the save rejects (the lock file is
 * left for the holder/stale takeover) so callers can notify the user — an
 * unlocked write would risk clobbering a concurrent session's role.
 */
export async function savePrefs(file, role, entry) {
  const valid = validateRoleEntry(entry);
  if (!valid) throw new Error(`Invalid persisted PiAstra preference for ${role}.`);
  return runExclusively(file, () => persistUnderLock(file, role, valid));
}

async function persistUnderLock(file, role, valid) {
  await mkdir(path.dirname(file), { recursive: true });
  const release = await acquireLock(file);
  try {
    const merged = { ...await loadPrefs(file), [role]: valid };
    const temp = `${file}.${process.pid}.${Date.now()}.${++tempSequence}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ roles: merged }, null, 2), 'utf8');
      await rename(temp, file);
    } catch (error) {
      try { await unlink(temp); } catch { /* temp may not exist yet */ }
      throw error;
    }
    return merged;
  } finally {
    await release?.();
  }
}

/** File-backed preferences store used by index.ts; inject any {load, save}. */
export function createFilePrefsStore(file) {
  // savePrefs serializes the entire read/merge/write per file within this
  // process and, via a file lock, across independent processes — a
  // per-instance queue alone cannot stop two processes from merging the same
  // stale snapshot and dropping each other's role writes.
  return {
    file,
    load: () => loadPrefs(file),
    save: (role, entry) => savePrefs(file, role, entry)
  };
}
