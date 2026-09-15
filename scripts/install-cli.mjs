import { readFile, writeFile, mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi', 'agent');
await mkdir(agentDir, { recursive: true });
const target = path.join(agentDir, 'settings.json');
let settings = {};
try {
  settings = JSON.parse(await readFile(target, 'utf8'));
  await copyFile(target, `${target}.piastra-backup-${Date.now()}`);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const installed = path.join(agentDir, 'piastra', 'package');
for (const dir of ['extensions/piastra', 'extensions/pi-ui', 'extensions/pi-worktree', 'config', 'roles']) await mkdir(path.join(installed, dir), { recursive: true });
for (const file of ['extensions/piastra/index.ts', 'extensions/piastra/policy.mjs', 'extensions/piastra/agents.mjs', 'extensions/piastra/prefs.mjs', 'extensions/piastra/guard.mjs', 'extensions/piastra/progress.mjs', 'extensions/piastra/sidebar.mjs', 'extensions/piastra/worker-bridge.mjs', 'extensions/piastra/worker-view.ts', 'extensions/piastra/worker-render.ts', 'extensions/piastra/shortcuts.ts', 'extensions/piastra/image-paste.ts', 'extensions/piastra/custom-tools.ts', 'extensions/piastra/notes.mjs', 'extensions/piastra/web.mjs', 'extensions/piastra/checks.mjs', 'extensions/piastra/windows-check-job.ps1', 'extensions/pi-worktree/git-worktree.ts', 'extensions/pi-worktree/LICENSE', 'config/agents.json', 'config/checks.json', ...['orchestrator', 'general', 'fast', 'review'].map(role => `roles/${role}.md`)]) {
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
const vendoredRuntimeFilter = (source) =>
  !/(^|[\\/])__tests__([\\/]|$)/.test(source) && !/\.test\.[a-z]+$|\.spec\.[a-z]+$/i.test(source);
await cp(queueSource, queueTarget, { recursive: true, force: true, filter: vendoredRuntimeFilter });
// Vendor the compact-transcript fork runtime files the same way: extension
// index + dependencies + LICENSE/README/package.json, tests excluded.
const compactSource = path.join(root, 'extensions', 'pi-compact-transcript');
const compactTarget = path.join(installed, 'extensions', 'pi-compact-transcript');
const compactIndex = path.join(compactTarget, 'index.ts');
await cp(compactSource, compactTarget, { recursive: true, force: true, filter: vendoredRuntimeFilter });
const extension = path.join(installed, 'extensions', 'piastra', 'index.ts');
const worktreeExtension = path.join(installed, 'extensions', 'pi-worktree', 'git-worktree.ts');
const developmentPath = path.join(root, 'extensions', 'piastra', 'index.ts');
const developmentQueuePath = path.join(root, 'extensions', 'pi-queue', 'index.ts');
const developmentCompactPath = path.join(root, 'extensions', 'pi-compact-transcript', 'index.ts');
const installedExtensions = [extension, path.join(installed, 'extensions/pi-ui/index.ts'), worktreeExtension, queueIndex, compactIndex];
settings.extensions = [...new Set([
  ...(settings.extensions || []).filter((p) => p !== developmentPath && p !== developmentQueuePath && p !== developmentCompactPath),
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
const config = JSON.parse(await readFile(path.join(root, 'config/agents.json'), 'utf8')).orchestrator;
const slash = config.model.indexOf('/');
settings.defaultProvider = config.model.slice(0, slash);
settings.defaultModel = config.model.slice(slash + 1);
settings.defaultThinkingLevel = config.thinking;
await writeFile(target, JSON.stringify(settings, null, 2) + '\n');
console.log(`PiAstra installed in ${target}\nRun pi from any directory. /piastra shows the roles.\nStandalone extension copy: ${installed}\nRe-run this installer to update the installed code and role configuration.`);
