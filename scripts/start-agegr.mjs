import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTrialPort } from './env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(process.argv[2] || root);
if (!statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory.');
const agentDir = join(root, '.local', 'agegr-agent');
mkdirSync(agentDir, { recursive: true });
// Give the UI trial its own settings and credential copy; leave both the
// existing UI and the user's global Pi installation untouched.
for (const name of ['settings.json', 'auth.json']) {
  const source = join(root, '.local', 'agent', name);
  const target = join(agentDir, name);
  if (!existsSync(target) && existsSync(source)) copyFileSync(source, target);
}
const port = parseTrialPort(process.env);
const child = spawn(process.execPath, [
  join(root, 'node_modules', '@agegr', 'pi-web', 'bin', 'pi-web.js'),
  '--port', String(port), '--hostname', '127.0.0.1', '--no-open',
], {
  cwd: workspace,
  stdio: 'inherit',
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_WEB_SKIP_VERSION_CHECK: '1',
  },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
