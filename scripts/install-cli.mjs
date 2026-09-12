import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
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
for (const dir of ['extensions/piastra', 'config', 'roles']) await mkdir(path.join(installed, dir), { recursive: true });
for (const file of ['extensions/piastra/index.ts', 'extensions/piastra/policy.mjs', 'extensions/piastra/agents.mjs', 'extensions/piastra/progress.mjs', 'extensions/piastra/worker-view.ts', 'extensions/piastra/worker-render.ts', 'config/agents.json', ...['orchestrator', 'general', 'fast', 'review'].map(role => `roles/${role}.md`)]) {
  await copyFile(path.join(root, file), path.join(installed, file));
}
await writeFile(path.join(installed, 'package.json'), JSON.stringify({ name: 'piastra-user-extension', private: true, type: 'module' }) + '\n');
const extension = path.join(installed, 'extensions', 'piastra', 'index.ts');
const developmentPath = path.join(root, 'extensions', 'piastra', 'index.ts');
settings.extensions = [...new Set([...(settings.extensions || []).filter(p => p !== developmentPath), extension])];
const config = JSON.parse(await readFile(path.join(root, 'config/agents.json'), 'utf8')).orchestrator;
const slash = config.model.indexOf('/');
settings.defaultProvider = config.model.slice(0, slash);
settings.defaultModel = config.model.slice(slash + 1);
settings.defaultThinkingLevel = config.thinking;
await writeFile(target, JSON.stringify(settings, null, 2) + '\n');
console.log(`PiAstra installed in ${target}\nRun pi from any directory. /piastra shows the roles.\nStandalone extension copy: ${installed}\nRe-run this installer to update the installed code and role configuration.`);
