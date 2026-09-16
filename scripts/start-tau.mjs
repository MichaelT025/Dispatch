import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseTauPort } from './env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(process.argv[2] || root);
if (!statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory.');
const agentDir = join(root, '.local', 'tau-agent');
mkdirSync(agentDir, { recursive: true });
for (const name of ['settings.json', 'auth.json', 'models-store.json']) {
  const source = join(root, '.local', 'agent', name);
  const target = join(agentDir, name);
  if (!existsSync(target) && existsSync(source)) copyFileSync(source, target);
}
const port = parseTauPort(process.env);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.TAU_HOST = '127.0.0.1';
process.env.TAU_MIRROR_PORT = String(port);
process.env.TAU_STATIC_DIR = join(root, 'node_modules', 'tau-mirror', 'public');
process.env.TAU_DISABLED = '0';
process.chdir(workspace);
const cli = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
process.argv = [process.execPath, cli,
  '--offline', '--no-extensions', '--extension', join(root, 'node_modules', 'tau-mirror', 'extensions', 'mirror-server.ts'),
  '--provider', 'openai-codex', '--model', 'gpt-6-astra', '--thinking', 'low',
  '--name', 'Dispatch UI trial',
];
// Keep Pi itself as the foreground process: Tau lives inside its session.
await import(pathToFileURL(cli).href);
