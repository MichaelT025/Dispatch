import { readFile, writeFile, mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { minimatch } from 'minimatch';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi', 'agent');
// The managed Atelier fork is strictly opt-in: pass --atelier once to install
// it. After that, reruns without the flag keep updating the managed copy
// because its registration is already present in settings.json.
const atelierOptIn = process.argv.slice(2).includes('--atelier');
await mkdir(agentDir, { recursive: true });
const target = path.join(agentDir, 'settings.json');
let settings = {};
try {
  settings = JSON.parse(await readFile(target, 'utf8'));
  await copyFile(target, `${target}.piastra-backup-${Date.now()}`);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const installed = path.join(agentDir, 'piastra', 'package');
for (const dir of ['extensions/piastra', 'extensions/pi-ui', 'extensions/pi-worktree', 'config', 'roles']) await mkdir(path.join(installed, dir), { recursive: true });
for (const file of ['extensions/piastra/index.ts', 'extensions/piastra/policy.mjs', 'extensions/piastra/agents.mjs', 'extensions/piastra/prefs.mjs', 'extensions/piastra/guard.mjs', 'extensions/piastra/progress.mjs', 'extensions/piastra/sidebar.mjs', 'extensions/piastra/worker-bridge.mjs', 'extensions/piastra/session-title.mjs', 'extensions/piastra/worker-view.ts', 'extensions/piastra/help.mjs', 'extensions/piastra/help-view.ts', 'extensions/piastra/worker-panel.ts', 'extensions/piastra/worker-render.ts', 'extensions/piastra/shortcuts.ts', 'extensions/piastra/image-paste.ts', 'extensions/piastra/custom-tools.ts', 'extensions/piastra/notes.mjs', 'extensions/piastra/web.mjs', 'extensions/piastra/checks.mjs', 'extensions/piastra/windows-check-job.ps1', 'extensions/pi-worktree/git-worktree.ts', 'extensions/pi-worktree/resume.mjs', 'extensions/pi-worktree/empty-sessions.mjs', 'extensions/pi-worktree/LICENSE', 'config/agents.json', 'config/checks.json', ...['orchestrator', 'general', 'fast', 'review'].map(role => `roles/${role}.md`)]) {
  await copyFile(path.join(root, file), path.join(installed, file));
}
// The installed copy needs plain npm runtime dependencies that Pi's loader
// does not alias: the preference store lock (proper-lockfile) plus the agent
// tool web runtime (html-to-text, ipaddr.js). Hoisted transitive dependencies
// are not inside the top-level package dirs, so copy the recursive runtime
// dependency closure (dependencies + resolvable optionalDependencies) with
// no network install. Each package resolves its own deps from its source
// location and vendors them nested under its target node_modules, preserving
// per-package versions exactly as Node would resolve them.
const standaloneDeps = { 'proper-lockfile': '^4.1.2', 'html-to-text': '10.0.1', 'ipaddr.js': '2.5.0' };
await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'piastra-user-extension', private: true, type: 'module', dependencies: standaloneDeps }) + '\n');
await mkdir(path.join(installed, 'node_modules'), { recursive: true });
// Locate a dependency's package.json from an importer's source dir. Most
// packages allow `<dep>/package.json`; exports-map packages (e.g.
// htmlparser2) block that subpath, so fall back to resolving the entry
// point and walking up to the owning package.json.
function findDependencyPackageJson(dep, fromDir) {
  const requireFrom = createRequire(path.join(fromDir, 'package.json'));
  try {
    return requireFrom.resolve(`${dep}/package.json`);
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && error?.code !== 'ERR_PACKAGE_SUBPATH_NOT_EXPORTED') throw error;
    const entry = requireFrom.resolve(dep);
    let dir = path.dirname(entry);
    while (true) {
      const candidate = path.join(dir, 'package.json');
      if (existsSync(candidate)) {
        try {
          if (JSON.parse(readFileSync(candidate, 'utf8')).name === dep) return candidate;
        } catch {}
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw error;
  }
}
async function copyPackageFiles(sourceDir, targetDir) {
  await cp(sourceDir, targetDir, {
    recursive: true,
    force: true,
    filter: (source) => {
      const relative = path.relative(sourceDir, source);
      if (!relative) return true;
      return !relative.split(path.sep).includes('node_modules');
    },
  });
}
async function installPackageTree(dep, fromSourceDir, fromTargetDir, chain = []) {
  const packageJsonPath = findDependencyPackageJson(dep, fromSourceDir);
  const sourceDir = path.dirname(packageJsonPath);
  if (chain.includes(sourceDir)) return;
  const targetDir = path.join(fromTargetDir, 'node_modules', dep);
  if (existsSync(targetDir)) return;
  await mkdir(path.dirname(targetDir), { recursive: true });
  await copyPackageFiles(sourceDir, targetDir);
  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const runtimeDeps = { ...(manifest.dependencies || {}) };
  for (const [name, range] of Object.entries(manifest.optionalDependencies || {})) {
    if (!(name in runtimeDeps)) runtimeDeps[name] = range;
  }
  const nextChain = [...chain, sourceDir];
  for (const child of Object.keys(runtimeDeps)) {
    try {
      await installPackageTree(child, sourceDir, targetDir, nextChain);
    } catch (error) {
      if (manifest.optionalDependencies?.[child] && (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND')) continue;
      throw error;
    }
  }
}
for (const dep of Object.keys(standaloneDeps)) {
  // Refresh the managed closure on reinstall, including installations made
  // by older shallow-copy versions of this script.
  await rm(path.join(installed, 'node_modules', dep), { recursive: true, force: true });
  await installPackageTree(dep, root, installed);
}
await copyFile(path.join(root, 'extensions/pi-ui/index.ts'), path.join(installed, 'extensions/pi-ui/index.ts'));
// Vendor the pi-queue fork runtime files (extension index + dependencies +
// LICENSE/README), excluding tests. The fork is required: bail out before
// writing settings.json if it is missing so the original queue plugin is never
// removed without its replacement being installed.
const queueSource = path.join(root, 'extensions', 'pi-queue');
const queueSourceIndex = path.join(queueSource, 'index.ts');
if (!existsSync(queueSourceIndex)) {
  throw new Error(
    `Missing pi-queue fork runtime: ${queueSourceIndex}\n` +
      'The vendored fork (extensions/pi-queue/index.ts) is required; refusing to update settings.json.',
  );
}
const queueTarget = path.join(installed, 'extensions', 'pi-queue');
const queueIndex = path.join(queueTarget, 'index.ts');
// Vendored forks ship runtime files only: tests never load in the installed copy.
// Root-relative so a checkout nested under `tests`/`__tests__` ancestors (e.g.
// C:/tests/PiAstra) does not filter the fork root itself: only paths relative
// to each fork source are tested.
const vendoredRuntimeFilter = (sourceRoot) => (source) => {
  const relative = path.relative(sourceRoot, source);
  return !/(^|[\\/])(__tests__|tests)([\\/]|$)/.test(relative) && !/\.test\.[a-z]+$|\.spec\.[a-z]+$/i.test(relative);
};
await cp(queueSource, queueTarget, { recursive: true, force: true, filter: vendoredRuntimeFilter(queueSource) });
// Vendor the compact-transcript fork runtime files the same way: extension
// index + dependencies + LICENSE/README/package.json, tests excluded.
const compactSource = path.join(root, 'extensions', 'pi-compact-transcript');
const compactTarget = path.join(installed, 'extensions', 'pi-compact-transcript');
const compactIndex = path.join(compactTarget, 'index.ts');
await cp(compactSource, compactTarget, { recursive: true, force: true, filter: vendoredRuntimeFilter(compactSource) });
// Vendor pi-usage as a self-contained extension. Its runtime tree includes
// provider adapters, parsers, service, polling, UI, types, and license; tests
// are excluded by the same filter used for the other vendored extensions.
const usageSource = path.join(root, 'extensions', 'pi-usage');
const usageTarget = path.join(installed, 'extensions', 'pi-usage');
const usageIndex = path.join(usageTarget, 'index.ts');
await cp(usageSource, usageTarget, { recursive: true, force: true, filter: vendoredRuntimeFilter(usageSource) });
// Vendor the managed Atelier fork runtime files the same way: full npm layout
// (extensions/index.ts, src/, assets/, LICENSE, README.md, package.json),
// tests excluded. Copies happen here, before any settings.json mutation, so a
// missing fork can never leave the config pointing at absent code.
const atelierManagedIndex = path.join(installed, 'extensions', 'pi-atelier', 'extensions', 'index.ts');
const atelierAlreadyManaged = (settings.extensions || []).includes(atelierManagedIndex);
const atelierActive = atelierOptIn || atelierAlreadyManaged;
if (atelierActive) {
  const atelierSource = path.join(root, 'extensions', 'pi-atelier');
  const atelierSourceIndex = path.join(atelierSource, 'extensions', 'index.ts');
  if (!existsSync(atelierSourceIndex)) {
    throw new Error(
      `Missing pi-atelier fork runtime: ${atelierSourceIndex}\n` +
        'The vendored fork (extensions/pi-atelier/extensions/index.ts) is required for the managed Atelier installation; refusing to update settings.json.',
    );
  }
  const atelierTarget = path.join(installed, 'extensions', 'pi-atelier');
  await cp(atelierSource, atelierTarget, { recursive: true, force: true, filter: vendoredRuntimeFilter(atelierSource) });
}
// The managed pi-todo fork (@juicesharp/rpiv-todo): it migrates automatically
// when the user has an enabled upstream npm entry, and afterwards stays in sync
// on every rerun because the managed registration itself counts as active.
// Without an enabled upstream entry and without a managed registration, todo
// packages/extensions are left completely alone (no copy, no disable, no
// registration) so users without rpiv-todo never gain it implicitly.
const todoManagedIndex = path.join(installed, 'extensions', 'pi-todo', 'index.ts');
const todoSource = path.join(root, 'extensions', 'pi-todo');
const todoSourceIndex = path.join(todoSource, 'index.ts');
const todoSourceVendorIndex = path.join(todoSource, 'vendor', 'rpiv-config', 'index.ts');
const upstreamTodo = /^npm:@juicesharp\/rpiv-todo(?:@.*)?$/i;
const todoEntrySource = (entry) => (typeof entry === 'string' ? entry : entry?.source);
// The upstream npm package lives at agentDir/npm/node_modules/@juicesharp/
// rpiv-todo (Pi's user-scope npm root) and its manifest declares exactly one
// extension file, index.ts. Whether a settings entry actually enables that
// file follows Pi's own pattern semantics (dist/core/package-manager.js
// applyPatterns), mirrored here with minimatch instead of importing Pi
// internals: a pattern is matched against the file's root-relative posix
// path, its basename, and its absolute posix path (root-relative and basename
// coincide for the sole file). Plain glob patterns include; with no plain
// pattern every file starts enabled. `!glob` excludes. `+path` and `-path`
// are exact overrides: `+` restores a file excluded earlier, `-` finally
// removes it even after a `+`. Applied in that fixed order.
const todoUpstreamRoot = path.join(agentDir, 'npm', 'node_modules', '@juicesharp', 'rpiv-todo');
const todoUpstreamFileRelative = 'index.ts';
const todoUpstreamFileAbsolute = path.join(todoUpstreamRoot, todoUpstreamFileRelative).split(path.sep).join('/');
const todoPatternGlob = (pattern) => {
  const normalized = pattern.split(path.sep).join('/');
  return minimatch(todoUpstreamFileRelative, normalized)
    || minimatch(path.basename(todoUpstreamFileRelative), normalized)
    || minimatch(todoUpstreamFileAbsolute, normalized);
};
const todoPatternExact = (pattern) => {
  const normalized = (pattern.startsWith('./') || pattern.startsWith('.\\') ? pattern.slice(2) : pattern).split(path.sep).join('/');
  return normalized === todoUpstreamFileRelative || normalized === todoUpstreamFileAbsolute;
};
const todoPatternsEnabled = (patterns) => {
  const includes = [];
  const excludes = [];
  const forceIncludes = [];
  const forceExcludes = [];
  for (const pattern of patterns) {
    if (pattern.startsWith('+')) forceIncludes.push(pattern.slice(1));
    else if (pattern.startsWith('-')) forceExcludes.push(pattern.slice(1));
    else if (pattern.startsWith('!')) excludes.push(pattern.slice(1));
    else includes.push(pattern);
  }
  let enabled = includes.length === 0 ? true : includes.some(todoPatternGlob);
  if (enabled && excludes.length > 0) enabled = !excludes.some(todoPatternGlob);
  if (!enabled && forceIncludes.length > 0) enabled = forceIncludes.some(todoPatternExact);
  if (enabled && forceExcludes.length > 0) enabled = !forceExcludes.some(todoPatternExact);
  return enabled;
};
const todoEntryEnabled = (entry) => {
  if (typeof entry === 'string') return true;
  if (!entry || typeof entry !== 'object') return false;
  if (entry.autoload === false) return false;
  const patterns = entry.extensions;
  if (patterns === undefined) return true;
  if (!Array.isArray(patterns) || !patterns.every(pattern => typeof pattern === 'string')) return false;
  if (patterns.length === 0) return false; // [] explicitly disables all resources
  return todoPatternsEnabled(patterns);
};
const todoAlreadyManaged = (settings.extensions || []).includes(todoManagedIndex);
const todoActive = (settings.packages || []).some(
  (entry) => upstreamTodo.test(todoEntrySource(entry) || '') && todoEntryEnabled(entry),
) || todoAlreadyManaged;
if (todoActive) {
  if (!existsSync(todoSourceIndex) || !existsSync(todoSourceVendorIndex)) {
    throw new Error(
      `Missing pi-todo fork runtime: ${todoSourceIndex}\n` +
        'The vendored fork (extensions/pi-todo) with its essential dependency file\n' +
        `(${todoSourceVendorIndex}) is required for the managed todo installation; refusing to update settings.json.`,
    );
  }
  // Copy before any settings.json mutation so a half-installed fork can never
  // be referenced by settings. Config/history/XDG layers are never touched: the
  // vendored copy resolves rpiv-todo config exactly like upstream.
  await cp(todoSource, path.join(installed, 'extensions', 'pi-todo'), {
    recursive: true,
    force: true,
    filter: vendoredRuntimeFilter(todoSource),
  });
}
const extension = path.join(installed, 'extensions', 'piastra', 'index.ts');
const worktreeExtension = path.join(installed, 'extensions', 'pi-worktree', 'git-worktree.ts');
const developmentPath = path.join(root, 'extensions', 'piastra', 'index.ts');
const developmentQueuePath = path.join(root, 'extensions', 'pi-queue', 'index.ts');
const developmentCompactPath = path.join(root, 'extensions', 'pi-compact-transcript', 'index.ts');
const developmentUsagePath = path.join(root, 'extensions', 'pi-usage', 'index.ts');
const installedExtensions = [extension, path.join(installed, 'extensions/pi-ui/index.ts'), worktreeExtension, queueIndex, compactIndex, usageIndex];
settings.extensions = [...new Set([
  ...(settings.extensions || []).filter((p) => p !== developmentPath && p !== developmentQueuePath && p !== developmentCompactPath && p !== developmentUsagePath),
  ...installedExtensions,
])];
// The upstream package remains installed for updates and its commands/docs, but
// its extension is disabled so the managed copy is the sole /worktree provider.
settings.packages = (settings.packages || []).map((entry) => {
  const source = typeof entry === 'string' ? entry : entry?.source;
  if (source === 'npm:@thisux/pi-worktree@1.2.0') {
    return { ...(typeof entry === 'string' ? { source: entry } : entry), extensions: [] };
  }
  return entry;
});
// The original steered-queue plugin is replaced by the vendored fork above.
// Drop every npm form (bare or versioned) and known Git upstream forms so the
// original and the fork are never loaded together.
const upstreamQueue = /^(?:npm:pi-queue-steer-factory(?:@[\w.~^>-]*)?|git:[^\s]*pi-queue-steer-factory(?:@[^\s]*)?|https?:\/\/[^\s]*pi-queue-steer-factory(?:@[^\s]*)?)$/i;
settings.packages = (settings.packages || []).filter((entry) => {
  const source = typeof entry === 'string' ? entry : entry?.source;
  return !upstreamQueue.test(source || '');
});
// The vendored compact-transcript fork replaces the upstream plugin: keep the
// package installed (updates, commands/docs) but disable its extension (bare
// or versioned, string or object form) so only the managed copy loads.
const upstreamCompact = /^npm:pi-compact-transcript(?:@[\w.~^>-]*)?$/i;
settings.packages = (settings.packages || []).map((entry) => {
  const source = typeof entry === 'string' ? entry : entry?.source;
  if (upstreamCompact.test(source || '')) {
    return { ...(typeof entry === 'string' ? { source: entry } : entry), extensions: [] };
  }
  return entry;
});
// The managed Atelier fork (opt-in via --atelier, then kept in sync by reruns
// without the flag because the managed entry is already registered): register
// the managed index exactly once, drop the current checkout's development
// entry for this fork, and disable the upstream npm package's extension (bare
// or versioned, string or object form) via extensions: [] so only the managed
// copy loads. The package entry itself stays installed for updates and its
// commands/docs, and the agent-dir config (pi-atelier.json) is never touched
// here. Without opt-in and without an existing managed entry, Atelier
// packages/settings are left completely alone.
if (atelierActive) {
  const developmentAtelierPath = path.join(root, 'extensions', 'pi-atelier', 'extensions', 'index.ts');
  settings.extensions = [...new Set([
    ...(settings.extensions || []).filter((p) => p !== developmentAtelierPath),
    atelierManagedIndex,
  ])];
  const upstreamAtelier = /^npm:pi-atelier(?:@.*)?$/i;
  settings.packages = (settings.packages || []).map((entry) => {
    const source = typeof entry === 'string' ? entry : entry?.source;
    if (upstreamAtelier.test(source || '')) {
      return { ...(typeof entry === 'string' ? { source: entry } : entry), extensions: [] };
    }
    return entry;
  });
}
// The managed pi-todo fork (migration conditions computed above): register the
// managed index exactly once, drop the current checkout's development entry for
// this fork, and disable every upstream npm entry (bare, versioned, or ranged;
// string or object form) via extensions: [] while preserving the package entry
// and its other fields. Nothing else — package config, history, other packages,
// or the XDG config layer — is modified.
if (todoActive) {
  const developmentTodoPath = path.join(root, 'extensions', 'pi-todo', 'index.ts');
  settings.extensions = [...new Set([
    ...(settings.extensions || []).filter((p) => p !== developmentTodoPath),
    todoManagedIndex,
  ])];
  settings.packages = (settings.packages || []).map((entry) => {
    if (upstreamTodo.test(todoEntrySource(entry) || '')) {
      return { ...(typeof entry === 'string' ? { source: entry } : entry), extensions: [] };
    }
    return entry;
  });
}
const config = JSON.parse(await readFile(path.join(root, 'config/agents.json'), 'utf8')).orchestrator;
const slash = config.model.indexOf('/');
settings.defaultProvider = config.model.slice(0, slash);
settings.defaultModel = config.model.slice(slash + 1);
settings.defaultThinkingLevel = config.thinking;
await writeFile(target, JSON.stringify(settings, null, 2) + '\n');
console.log(`Dispatch installed in ${target}\nRun pi from any directory. /dispatch shows the roles.\nStandalone extension copy: ${installed}\nRe-run this installer to update the installed code and role configuration.${atelierActive ? '\nManaged Atelier fork installed and upstream npm:pi-atelier extension disabled.' : ''}${todoActive ? '\nManaged pi-todo fork installed and upstream npm:@juicesharp/rpiv-todo extension disabled.' : ''}`);
