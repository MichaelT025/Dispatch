import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FORK_DISABLED_AGENT_TOOLS } from '../extensions/piastra/policy.mjs';

/**
 * Fork UI launcher (experimental; see docs/FORK_PLAN.md).
 *
 * Runs the Dispatch fork of pi-web-ui (sibling checkout) from its built
 * artifacts: `<fork>/dist/server/index.js` serves `<fork>/web/dist`.
 *
 * Isolation:
 * - loopback bind, dedicated port (DISPATCH_FORK_PORT, legacy PIASTRA_FORK_PORT, default 8790);
 * - `.local/fork-agent`: its own settings.json (model defaults plus a
 *   deliberate absolute path reference to this checkout's Dispatch extension);
 *   auth/models files are copied ONCE from the existing local credential path
 *   `.local/agent` only when missing — the launcher copies bytes, it never
 *   prints or commits them (the copies stay in ignored `.local/`);
 * - `.local/fork-web`: its own UI state. client-state.json seeds
 *   disabledAgentTools with the upstream inline subagent/delegation tools so
 *   the fork server keeps only the Dispatch `delegate` tool active (the
 *   extension additionally hard-blocks them per tool call).
 *
 * Global Pi settings, the user's global extension install and the settings
 * used by `npm start` (`.local/agent`, `.local/web`) are not modified.
 */

import { DEFAULT_FORK_PORT, parseForkPortEnv, resolveForkDir } from './env.mjs';

export { DEFAULT_FORK_PORT };

/** Absolute paths the fork must provide before it can run. */
export function forkArtifactErrors(forkRoot) {
  const required = [
    join(forkRoot, 'package.json'),
    join(forkRoot, 'dist', 'server', 'index.js'),
    join(forkRoot, 'web', 'dist', 'index.html'),
  ];
  return required.filter(path => !existsSync(path));
}

export function resolveForkRoot(root, env = process.env) {
  const forkRoot = resolveForkDir(root, env);
  const missing = forkArtifactErrors(forkRoot);
  if (missing.length) {
    throw new Error(
      `Fork build artifacts missing in ${forkRoot} (${missing.map(p => p.split(/[\\/]/).pop()).join(', ')}). ` +
      'Build the fork first: cd ' + forkRoot + ' && npm ci && npm run build.',
    );
  }
  return forkRoot;
}

function seedOnce(target, write) {
  if (existsSync(target)) return false;
  mkdirSync(dirname(target), { recursive: true });
  write();
  return true;
}

/** Fork agent dir: model defaults + extension path reference; credential files copied once. */
export function seedForkAgentDir(root, agentDir) {
  const config = JSON.parse(readFileSync(join(root, 'config', 'agents.json'), 'utf8'));
  const orchestrator = config.orchestrator;
  const slash = orchestrator.model.indexOf('/');
  const extensionPath = join(root, 'extensions', 'piastra', 'index.ts');
  if (!existsSync(extensionPath)) throw new Error(`Dispatch extension missing: ${extensionPath}`);
  const seeded = seedOnce(join(agentDir, 'settings.json'), () => {
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: orchestrator.model.slice(0, slash),
      defaultModel: orchestrator.model.slice(slash + 1),
      defaultThinkingLevel: orchestrator.thinking,
      retry: { enabled: true, maxRetries: 2 },
      extensions: [extensionPath],
    }, null, 2) + '\n');
  });
  // One-time credential/model-catalog seed from the existing local credential
  // path (.local/agent). Copies bytes without inspecting them.
  for (const name of ['auth.json', 'models-store.json', 'models.json']) {
    const source = join(root, '.local', 'agent', name);
    const target = join(agentDir, name);
    if (existsSync(target) || !existsSync(source)) continue;
    mkdirSync(agentDir, { recursive: true });
    copyFileSync(source, target);
  }
  return { agentDir, settingsSeeded: seeded, extensionPath };
}

/** Fork UI data dir: client state with foreign delegation tools disabled, plus starter subagent templates. */
export async function seedForkDataDir(root, dataDir, forkRoot) {
  const clientSeeded = seedOnce(join(dataDir, 'client-state.json'), () => {
    writeFileSync(join(dataDir, 'client-state.json'), JSON.stringify({
      __settings__: {
        settings: {
          customSystemPrompt: 'Dispatch fork session. Delegation runs through the delegate tool; upstream subagent tools are intentionally disabled.',
          promptMode: 'append',
          goalModeEnabled: false,
          visionBridgeEnabled: false,
          retryMaxAttempts: 2,
          disabledAgentTools: [...FORK_DISABLED_AGENT_TOOLS],
        },
      },
    }, null, 2) + '\n');
  });
  // Mirror setup.mjs: piAstra role templates staged disabled, and the seeded
  // roster recorded so the fork server does not auto-add its built-ins.
  let roster = [];
  try {
    if (forkRoot) {
      const { DEFAULT_TEMPLATES } = await import(pathToFileURL(join(forkRoot, 'dist', 'server', 'subagent-templates.js')).href);
      roster = DEFAULT_TEMPLATES.map(t => t.name);
    }
  } catch { /* roster stays empty; delegation tools are blocked anyway */ }
  const seededNames = seedOnce(join(dataDir, 'subagent-templates.seeded.json'), () => {
    writeFileSync(join(dataDir, 'subagent-templates.seeded.json'), JSON.stringify(roster, null, 2) + '\n');
  });
  const templatesSeeded = seedOnce(join(dataDir, 'subagent-templates.json'), () => {
    const templates = ['general', 'fast', 'review'].map(name => {
      const selected = JSON.parse(readFileSync(join(root, 'config', 'agents.json'), 'utf8'))[name];
      return {
        name,
        description: `Dispatch ${name} (fork UI; delegation currently goes through the delegate tool)`,
        promptMode: 'append',
        systemPrompt: readFileSync(join(root, 'roles', `${name}.md`), 'utf8'),
        enabledSkills: [],
        enabledExtensions: [],
        model: selected.model ?? '',
        enabled: false,
      };
    });
    writeFileSync(join(dataDir, 'subagent-templates.json'), JSON.stringify(templates, null, 2) + '\n');
  });
  return { dataDir, clientSeeded, seededNames, templatesSeeded };
}

export function parseForkPort(env = process.env) {
  return parseForkPortEnv(env);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const workspace = resolve(process.argv[2] || root);
  if (!statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory.');
  const forkRoot = resolveForkRoot(root);
  const port = parseForkPort();
  const agentDir = join(root, '.local', 'fork-agent');
  const dataDir = join(root, '.local', 'fork-web');
  if (!existsSync(join(root, '.local', 'agent', 'settings.json'))) throw new Error('Run npm run setup before starting the fork UI.');
  const agent = seedForkAgentDir(root, agentDir);
  const data = await seedForkDataDir(root, dataDir, forkRoot);
  let version = ''; let commit = '';
  try { version = JSON.parse(readFileSync(join(forkRoot, 'package.json'), 'utf8')).version; } catch { /* best effort */ }
  try {
    commit = execFileSync('git', ['-C', forkRoot, 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { /* ignore */ }
  console.log(`Fork UI: ${forkRoot} v${version}${commit ? ` @${commit}` : ''}`);
  console.log(`http://127.0.0.1:${port} · agent dir ${agent.agentDir} · UI state ${data.dataDir}${agent.settingsSeeded ? ' · settings seeded' : ''}`);
  const child = spawn(process.execPath, [
    join(forkRoot, 'dist', 'server', 'index.js'),
    '--host', '127.0.0.1', '--port', String(port),
    '--cwd', workspace, '--data-dir', dataDir, '--agent-dir', agentDir,
  ], {
    stdio: 'inherit',
    // Pin the upstream engine explicitly (fork server reads PI_WEB_ENGINE; it
    // has no --engine CLI flag) so an inherited dsh setting cannot change it.
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_ENGINE: 'pi' },
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
