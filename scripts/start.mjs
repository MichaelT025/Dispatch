import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(process.argv[2] || root);
if (!existsSync(join(root, '.local', 'agent', 'settings.json'))) {
  throw new Error('Run npm run setup before starting PiAstra.');
}
if (!statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory.');
const port = Number(process.env.PIASTRA_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PIASTRA_PORT.');

const child = spawn(process.execPath, [
  join(root, 'node_modules', 'pi-web-ui', 'bin', 'pi-web-ui.mjs'),
  '--engine', 'pi', '--host', '127.0.0.1', '--port', String(port),
  '--cwd', workspace, '--data-dir', join(root, '.local', 'web'),
  '--agent-dir', join(root, '.local', 'agent'), '--no-browser',
], { stdio: 'inherit', env: { ...process.env, PI_WEB_ENGINE: 'pi' } });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
