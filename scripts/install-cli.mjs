import { readFile, writeFile, mkdir, copyFile, cp } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
for (const file of ['extensions/piastra/index.ts', 'extensions/piastra/policy.mjs', 'extensions/piastra/agents.mjs', 'extensions/piastra/guard.mjs', 'extensions/piastra/progress.mjs', 'extensions/piastra/sidebar.mjs', 'extensions/piastra/worker-view.ts', 'extensions/piastra/worker-render.ts', 'extensions/pi-worktree/git-worktree.ts', 'extensions/pi-worktree/LICENSE', 'config/agents.json', ...['orchestrator', 'general', 'fast', 'review'].map(role => `roles/${role}.md`)]) {
  await copyFile(path.join(root, file), path.join(installed, file));
}
await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'piastra-user-extension', private: true, type: 'module' }) + '\n');
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
const extension = path.join(installed, 'extensions', 'piastra', 'index.ts');
const worktreeExtension = path.join(installed, 'extensions', 'pi-worktree', 'git-worktree.ts');
const developmentPath = path.join(root, 'extensions', 'piastra', 'index.ts');
const developmentQueuePath = path.join(root, 'extensions', 'pi-queue', 'index.ts');
const installedExtensions = [extension, path.join(installed, 'extensions/pi-ui/index.ts'), worktreeExtension, queueIndex];
settings.extensions = [...new Set([
  ...(settings.extensions || []).filter((p) => p !== developmentPath && p !== developmentQueuePath),
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
const config = JSON.parse(await readFile(path.join(root, 'config/agents.json'), 'utf8')).orchestrator;
const slash = config.model.indexOf('/');
settings.defaultProvider = config.model.slice(0, slash);
settings.defaultModel = config.model.slice(slash + 1);
settings.defaultThinkingLevel = config.thinking;
await writeFile(target, JSON.stringify(settings, null, 2) + '\n');
console.log(`PiAstra installed in ${target}\nRun pi from any directory. /piastra shows the roles.\nStandalone extension copy: ${installed}\nRe-run this installer to update the installed code and role configuration.`);
