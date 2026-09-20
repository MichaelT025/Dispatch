import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { FORK_DISABLED_AGENT_TOOLS } from '../extensions/piastra/policy.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = resolve(MODULE_DIR, '..');

const MANAGED_RELATIVE_PATHS = [
  'extensions/piastra/index.ts',
  'extensions/pi-ui/index.ts',
  'extensions/pi-worktree/git-worktree.ts',
  'extensions/pi-queue/index.ts',
  'extensions/pi-compact-transcript/index.ts',
  'extensions/pi-atelier/extensions/index.ts',
  'extensions/pi-todo/index.ts',
  'extensions/pi-commandcode/index.ts',
  'extensions/pi-usage/index.ts',
];

const STATE_FORMAT_VERSION = 1;
const LUNA_MODEL = 'openai-codex/gpt-5.6-luna';
// Default Go worker models live in config/agents.json (general/fast entries).
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const GO_CHOICES = ['configured', 'skipped'];

const LOCK_OPTIONS = {
  retries: { retries: 40, factor: 1, minTimeout: 20, maxTimeout: 100, randomize: false },
  stale: 10_000,
  // Never resolve symlinks: the target may not exist yet and Dispatch home
  // itself is the canonical path.
  realpath: false,
};

/**
 * Resolve isolated Dispatch directories. `home` replaces the OS user home
 * directory for tests; `env.DISPATCH_HOME` (when !== '') wins, otherwise
 * `<home || os.homedir()>/.dispatch`. A whitespace-only value is a (weird
 * but valid) path and is never trimmed or treated as empty. Relative values
 * are resolved to absolute paths. Inherited PI_* dirs are ignored here
 * (and must never be consulted); callers set child config from the result.
 */
export function resolveDispatchPaths({ env = process.env, home, packageRoot } = {}) {
  const dispatchHomeRaw = env?.DISPATCH_HOME;
  const base = resolve(home ?? homedir());
  const homeDir = (typeof dispatchHomeRaw === 'string' && dispatchHomeRaw !== '')
    ? resolve(dispatchHomeRaw)
    : join(base, '.dispatch');
  const root = resolve(packageRoot ?? DEFAULT_PACKAGE_ROOT);
  return {
    home: homeDir,
    agentDir: join(homeDir, 'agent'),
    webDir: join(homeDir, 'web'),
    stateFile: join(homeDir, 'state.json'),
    packageRoot: root,
  };
}

/** Managed extension entry points in established order. */
export function managedExtensionPaths(packageRoot = DEFAULT_PACKAGE_ROOT) {
  return MANAGED_RELATIVE_PATHS.map((rel) => join(packageRoot, rel));
}

function settingsPath(paths) {
  return join(paths.agentDir, 'settings.json');
}

function clientStatePath(paths) {
  return join(paths.webDir, 'client-state.json');
}

function prefsPath(paths) {
  return join(paths.agentDir, 'piastra', 'agents.json');
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Private home before any lock: proper-lockfile sidecars live beside targets. */
async function ensureHomePrivate(paths) {
  // Creation is private; preserve permissions on an existing user-selected directory.
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
}

async function readJsonStrict(path) {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

/**
 * Atomic write via temp file plus rename. Skips the write entirely when the
 * serialized JSON is unchanged so routine syncs don't churn files. New files
 * default to 0600; existing files keep their current mode.
 */
let tempSequence = 0;
async function writeJsonAtomic(path, value, { mode } = {}) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  let prev = null;
  try {
    prev = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (prev === text) return false;
  let fileMode = mode;
  if (fileMode === undefined) {
    if (prev !== null) {
      try {
        fileMode = (await stat(path)).mode & 0o777;
      } catch {
        fileMode = 0o600;
      }
    } else {
      fileMode = 0o600;
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.${++tempSequence}.tmp`;
  try {
    await writeFile(temp, text, { encoding: 'utf8', mode: fileMode });
    try {
      await chmod(temp, fileMode);
    } catch {
      /* best effort on non-POSIX filesystems */
    }
    await rename(temp, path);
  } catch (error) {
    try { await unlink(temp); } catch { /* temp may not exist */ }
    throw error;
  }
  return true;
}

async function acquireFileLock(file) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // realpath:false, so no placeholder file is needed (or wanted): a missing
  // state file must stay missing when setup fails instead of lingering as
  // an empty artifact.
  const release = await lockfile.lock(file, LOCK_OPTIONS);
  return async () => { try { await release(); } catch { /* stale takeover cleans up */ } };
}

function validateRoleEntry(entry) {
  if (typeof entry?.model !== 'string' || !entry.model.includes('/')) return null;
  if (!(entry.thinking === null || THINKING_LEVELS.includes(entry.thinking))) return null;
  return { model: entry.model, thinking: entry.thinking };
}

function validateStateShape(state, file) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`Dispatch state is malformed: ${file}`);
  }
  if (state.formatVersion !== STATE_FORMAT_VERSION) {
    throw new Error(`Dispatch state is malformed: ${file}`);
  }
  if (state.setupComplete !== undefined && typeof state.setupComplete !== 'boolean') {
    throw new Error(`Dispatch state is malformed: ${file}`);
  }
  if (state.go !== undefined && !GO_CHOICES.includes(state.go)) {
    throw new Error(`Dispatch state is malformed: ${file}`);
  }
  if (state.managedExtensionPaths !== undefined) {
    if (!Array.isArray(state.managedExtensionPaths) ||
        !state.managedExtensionPaths.every((p) => typeof p === 'string')) {
      throw new Error(`Dispatch state is malformed: ${file}`);
    }
  }
  if (state.packageRoot !== undefined && typeof state.packageRoot !== 'string') {
    throw new Error(`Dispatch state is malformed: ${file}`);
  }
  return state;
}

function validateSettingsShape(settings, file) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`Dispatch settings are malformed: ${file}`);
  }
  if (settings.extensions !== undefined) {
    if (!Array.isArray(settings.extensions) ||
        !settings.extensions.every((e) => typeof e === 'string')) {
      throw new Error(`Dispatch settings are malformed: ${file}`);
    }
  }
  return settings;
}

function validateWebShape(client, file) {
  if (!client || typeof client !== 'object' || Array.isArray(client)) {
    throw new Error(`Dispatch web state is malformed: ${file}`);
  }
  if (client.__settings__ !== undefined &&
      (!client.__settings__ || typeof client.__settings__ !== 'object' || Array.isArray(client.__settings__))) {
    throw new Error(`Dispatch web state is malformed: ${file}`);
  }
  const settings = client.__settings__?.settings;
  if (client.__settings__ !== undefined && settings !== undefined &&
      (!settings || typeof settings !== 'object' || Array.isArray(settings))) {
    throw new Error(`Dispatch web state is malformed: ${file}`);
  }
  const disabled = settings?.disabledAgentTools;
  if (disabled !== undefined && !Array.isArray(disabled)) {
    throw new Error(`Dispatch web state is malformed: ${file}`);
  }
  return client;
}

/**
 * Parsed dispatch state, or null when the file is missing. Empty, malformed
 * JSON or schema violations throw; callers must not overwrite in that case.
 */
export async function readDispatchState(paths) {
  let text;
  try {
    text = await readFile(paths.stateFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (text.trim() === '') {
    throw new Error(`Dispatch state is malformed: ${paths.stateFile}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Dispatch state is malformed: ${paths.stateFile}`);
  }
  return validateStateShape(parsed, paths.stateFile);
}

async function readDefaultAgentConfig(packageRoot) {
  let text;
  try {
    text = await readFile(join(packageRoot, 'config', 'agents.json'), 'utf8');
  } catch (error) {
    throw new Error(`Dispatch package config is missing or malformed: ${join(packageRoot, 'config', 'agents.json')}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Dispatch package config is missing or malformed: ${join(packageRoot, 'config', 'agents.json')}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Dispatch package config is missing or malformed: ${join(packageRoot, 'config', 'agents.json')}`);
  }
  return parsed;
}

function defaultSettingsFromConfig(config) {
  const orchestrator = config?.orchestrator;
  const slash = typeof orchestrator?.model === 'string' ? orchestrator.model.indexOf('/') : -1;
  if (!orchestrator || slash < 0) {
    throw new Error('Dispatch package config is missing or malformed: orchestrator.model.');
  }
  return {
    defaultProvider: orchestrator.model.slice(0, slash),
    defaultModel: orchestrator.model.slice(slash + 1),
    defaultThinkingLevel: orchestrator.thinking ?? null,
    retry: { enabled: true, maxRetries: 2 },
  };
}

/**
 * Seed isolated dirs, Pi settings, web client state and dispatch state.
 * Never touches auth files. Existing valid JSON is preserved and merged;
 * malformed existing JSON throws without overwriting. Returns the state
 * without marking setup complete.
 */
export async function seedDispatchConfiguration(paths) {
  await ensureHomePrivate(paths);
  const release = await acquireFileLock(paths.stateFile);
  try {
    return await seedUnderLock(paths);
  } finally {
    await release();
  }
}

async function seedUnderLock(paths) {
  const packageRoot = paths.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const managed = managedExtensionPaths(packageRoot);

  await mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.webDir, { recursive: true, mode: 0o700 });

  // Previous state determines move/update mapping. Missing means fresh;
  // empty or malformed state fails closed (never treated as new).
  let previous = null;
  if (await exists(paths.stateFile)) {
    const text = await readFile(paths.stateFile, 'utf8');
    if (text.trim() === '') {
      throw new Error(`Dispatch state is malformed: ${paths.stateFile}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Dispatch state is malformed: ${paths.stateFile}`);
    }
    previous = validateStateShape(parsed, paths.stateFile);
  }
  const previousManaged = Array.isArray(previous?.managedExtensionPaths)
    ? previous.managedExtensionPaths.filter((p) => typeof p === 'string')
    : [];

  // --- Prevalidate everything before any write (fail closed) ---
  const settingsFile = settingsPath(paths);
  let settings;
  if (await exists(settingsFile)) {
    try {
      settings = await readJsonStrict(settingsFile);
    } catch {
      throw new Error(`Dispatch settings are malformed: ${settingsFile}`);
    }
    validateSettingsShape(settings, settingsFile);
  } else {
    settings = {};
  }
  const clientFile = clientStatePath(paths);
  let client;
  if (await exists(clientFile)) {
    try {
      client = await readJsonStrict(clientFile);
    } catch {
      throw new Error(`Dispatch web state is malformed: ${clientFile}`);
    }
    validateWebShape(client, clientFile);
  } else {
    client = {};
  }
  const config = await readDefaultAgentConfig(packageRoot);
  const defaults = defaultSettingsFromConfig(config);

  const previousSet = new Set(previousManaged);
  const moved = !previous ||
    previousManaged.length !== managed.length ||
    previousManaged.some((p, i) => p !== managed[i]);
  // Two-phase journal: when registered paths move, persist the union of
  // old+new known paths first so a crash after the journal or after the
  // settings write still recovers (next move normalizes from the union).
  let knownUnion = previousManaged;
  if (moved) {
    const union = [...previousManaged];
    for (const p of managed) if (!previousSet.has(p)) union.push(p);
    knownUnion = union;
    if (previous) {
      const journal = {
        ...(previous && typeof previous === 'object' ? previous : {}),
        formatVersion: STATE_FORMAT_VERSION,
        setupComplete: previous?.setupComplete ?? false,
        managedExtensionPaths: union,
        packageRoot,
      };
      if (previous?.go !== undefined) journal.go = previous.go;
      await writeJsonAtomic(paths.stateFile, journal);
    }
  }
  const knownSet = new Set(knownUnion);

  function matchesRel(p, rel) {
    const platformRel = rel.split('/').join(sep);
    return p === rel || p.endsWith(`/${rel}`) || p.endsWith(sep + platformRel);
  }
  const candidatesByIndex = MANAGED_RELATIVE_PATHS.map((rel) =>
    knownUnion.filter((p) => matchesRel(p, rel)));

  // --- settings.json (strict: invalid extensions reject, never drop) ---
  if (settings.defaultProvider === undefined) settings.defaultProvider = defaults.defaultProvider;
  if (settings.defaultModel === undefined) settings.defaultModel = defaults.defaultModel;
  if (settings.defaultThinkingLevel === undefined) settings.defaultThinkingLevel = defaults.defaultThinkingLevel;
  if (settings.retry === undefined) settings.retry = defaults.retry;

  const currentList = settings.extensions ?? [];
  const hadExtensions = settings.extensions !== undefined;
  const extensionSet = new Set(currentList);
  for (let i = 0; i < MANAGED_RELATIVE_PATHS.length; i++) {
    const candidates = candidatesByIndex[i];
    const newPath = managed[i];
    const present = candidates.filter((c) => extensionSet.has(c));
    if (present.length > 0) {
      for (const c of candidates) extensionSet.delete(c);
      extensionSet.add(newPath);
    } else if (!hadExtensions || !previous || previousManaged.length === 0 ||
        !candidates.some((c) => previousSet.has(c))) {
      // Fresh seeding (or a suffix never previously managed): add.
      extensionSet.add(newPath);
    }
    // Else: known candidates exist and none are present — an intentional
    // user removal stays absent.
  }
  // Managed entries first in established order, then user additions in
  // their original relative order.
  {
    const userKept = currentList.filter((e) => !knownSet.has(e) && extensionSet.has(e));
    const ordered = [...managed.filter((m) => extensionSet.has(m)), ...userKept];
    for (const e of extensionSet) if (!ordered.includes(e)) ordered.push(e);
    settings.extensions = ordered;
  }
  await writeJsonAtomic(settingsFile, settings);
  if (client.__settings__ === undefined) client.__settings__ = {};
  if (client.__settings__.settings === undefined) client.__settings__.settings = {};
  // Seed the policy list only when absent: an existing array (even edited)
  // keeps the user's choices and unrelated tools untouched on every launch.
  if (client.__settings__.settings.disabledAgentTools === undefined) {
    client.__settings__.settings.disabledAgentTools = [...FORK_DISABLED_AGENT_TOOLS];
  }
  await writeJsonAtomic(clientFile, client);

  // --- state.json ---
  const next = {
    ...(previous && typeof previous === 'object' ? previous : {}),
    formatVersion: STATE_FORMAT_VERSION,
    setupComplete: previous?.setupComplete ?? false,
    managedExtensionPaths: managed,
    packageRoot,
  };
  if (previous?.go !== undefined) next.go = previous.go;
  await writeJsonAtomic(paths.stateFile, next);
  return next;
}

/** Strict prefs read returning the raw document plus validated roles. */
async function readPrefsFileStrict(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { raw: {}, roles: {} };
    throw error;
  }
  if (text.trim() === '') {
    throw new Error(`Dispatch role preferences are malformed: ${file}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Dispatch role preferences are malformed: ${file}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Dispatch role preferences are malformed: ${file}`);
  }
  const roles = parsed.roles;
  if (roles === undefined) return { raw: parsed, roles: {} };
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) {
    throw new Error(`Dispatch role preferences are malformed: ${file}`);
  }
  const out = {};
  for (const [role, entry] of Object.entries(roles)) {
    const valid = validateRoleEntry(entry);
    if (!valid) throw new Error(`Dispatch role preferences are malformed: ${file}`);
    out[role] = valid;
  }
  return { raw: parsed, roles: out };
}

/**
 * Record `go: 'configured' | 'skipped'` and mark setup complete. Only seeds
 * MISSING general/fast role preferences (skipped → Luna medium/medium,
 * otherwise Go defaults from config/agents.json); existing valid entries —
 * including later user choices — are preserved. All existing state, settings,
 * web and prefs JSON is prevalidated before any write, so a bad file fails
 * closed with no partial rewrite. The prefs file lock (same proper-lockfile,
 * realpath:false) is held across the strict read/merge/write so a concurrent
 * Pi prefs save cannot be clobbered. Resumable: only sets setupComplete at
 * the end.
 */
export async function completeDispatchSetup(paths, { go } = {}) {
  if (go !== 'configured' && go !== 'skipped') {
    throw new Error(`Invalid go choice: ${go}`);
  }
  await ensureHomePrivate(paths);
  const prefsFile = prefsPath(paths);
  let releaseState = null;
  try {
    releaseState = await acquireFileLock(paths.stateFile);
    let releasePrefs = null;
    let prefsAcquired = false;
    try {
      await mkdir(dirname(prefsFile), { recursive: true, mode: 0o700 });
      releasePrefs = await lockfile.lock(prefsFile, LOCK_OPTIONS);
      prefsAcquired = true;
    // Prevalidate everything before any config write.
    let previous = null;
    if (await exists(paths.stateFile)) {
      const text = await readFile(paths.stateFile, 'utf8');
      if (text.trim() === '') throw new Error(`Dispatch state is malformed: ${paths.stateFile}`);
      try {
        previous = validateStateShape(JSON.parse(text), paths.stateFile);
      } catch (error) {
        if (error?.message?.startsWith('Dispatch state is malformed:')) throw error;
        throw new Error(`Dispatch state is malformed: ${paths.stateFile}`);
      }
    }
    const settingsFile = settingsPath(paths);
    if (await exists(settingsFile)) {
      let settings;
      try {
        settings = await readJsonStrict(settingsFile);
      } catch {
        throw new Error(`Dispatch settings are malformed: ${settingsFile}`);
      }
      validateSettingsShape(settings, settingsFile);
    }
    const clientFile = clientStatePath(paths);
    if (await exists(clientFile)) {
      let client;
      try {
        client = await readJsonStrict(clientFile);
      } catch {
        throw new Error(`Dispatch web state is malformed: ${clientFile}`);
      }
      validateWebShape(client, clientFile);
    }
    const { raw: prefsRaw, roles: current } = await readPrefsFileStrict(prefsFile);

    const packageRoot = paths.packageRoot ?? DEFAULT_PACKAGE_ROOT;
    const config = await readDefaultAgentConfig(packageRoot);

    let seedPrefs;
    if (go === 'skipped') {
      seedPrefs = {
        general: { model: LUNA_MODEL, thinking: 'medium' },
        fast: { model: LUNA_MODEL, thinking: 'medium' },
      };
    } else {
      const general = validateRoleEntry(config?.general);
      const fast = validateRoleEntry(config?.fast);
      if (!general || !fast) {
        throw new Error('Dispatch package config is missing or malformed: general/fast role defaults.');
      }
      seedPrefs = { general, fast };
    }

    const state = await seedUnderLock(paths);

    // Merge under the held prefs lock: only fill missing roles, preserving
    // unrelated top-level fields and extra per-role entries.
    const merged = { ...current };
    for (const role of ['general', 'fast']) {
      if (merged[role] === undefined) {
        const valid = validateRoleEntry(seedPrefs[role]);
        if (!valid) throw new Error(`Invalid default Dispatch preference for ${role}.`);
        merged[role] = valid;
      }
    }
    const nextPrefs = { ...prefsRaw, roles: merged };
    await writeJsonAtomic(prefsFile, nextPrefs);
    void previous;

    const next = { ...state, go, setupComplete: true };
    await writeJsonAtomic(paths.stateFile, next);
    return next;
    } finally {
      if (prefsAcquired) {
        try { await releasePrefs(); } catch { /* stale takeover cleans up */ }
      }
    }
  } finally {
    if (releaseState) await releaseState();
  }
}
