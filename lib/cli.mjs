import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { formatTerminalHelp } from '../extensions/piastra/help.mjs';
import { resolveDispatchPaths, readDispatchState, seedDispatchConfiguration } from './state.mjs';
import { runSetup } from './setup.mjs';
import { createTerminalInteraction } from './terminal-prompts.mjs';
import { openBrowser } from './browser.mjs';

export const DEFAULT_DISPATCH_PORT = 8790;
const truthy = value => /^(1|true|yes|on)$/i.test(value || '');

function portNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  return port;
}

// Pi 0.85.1 consumes the next token for these options even if it starts with '-'.
// Keep flag-looking prompt/name/file values opaque to Dispatch's own parser.
const PI_VALUE_OPTIONS = new Set([
  '--mode', '--provider', '--model', '--api-key', '--system-prompt', '--append-system-prompt',
  '--name', '-n', '--session', '--session-id', '--fork', '--session-dir', '--models',
  '--tools', '-t', '--exclude-tools', '-xt', '--thinking', '--export', '--extension', '-e',
  '--skill', '--prompt-template', '--theme',
]);

function topLevelArgs(argv) {
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    args.push(arg);
    if ((PI_VALUE_OPTIONS.has(arg) || arg === '--port') && i + 1 < argv.length) i++;
    else if ((arg === '--use-theme' || arg === '--tui-mode') && argv[i + 1] && !argv[i + 1].startsWith('-')) i++;
  }
  return args;
}

/** Dispatch flags are parsed before Pi is loaded. Pi keeps its own CLI arguments. */
export function parseDispatchArgs(argv, env = {}) {
  const beforeSeparator = topLevelArgs(argv);
  if (beforeSeparator.some(arg => arg === '--help' || arg === '-h')) return { mode: 'help' };
  if (beforeSeparator.some(arg => arg === '--version' || arg === '-v')) return { mode: 'version' };
  if (argv[0] === 'setup' || argv[0] === 'update') {
    if (argv.length !== 1) throw new Error(`Unexpected arguments for dispatch ${argv[0]}. Run dispatch --help.`);
    return { mode: argv[0] };
  }
  if (!beforeSeparator.includes('--web')) {
    if (beforeSeparator.some(arg => arg === '--port' || arg.startsWith('--port=') || arg === '--no-open')) {
      throw new Error('--port and --no-open require --web.');
    }
    return { mode: 'cli', piArgs: [...argv], offline: beforeSeparator.includes('--offline') || truthy(env.DISPATCH_OFFLINE) || truthy(env.PI_OFFLINE) };
  }
  let port = env.DISPATCH_PORT || DEFAULT_DISPATCH_PORT;
  let noOpen = false;
  let offline = truthy(env.DISPATCH_OFFLINE) || truthy(env.PI_OFFLINE);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--web') continue;
    if (arg === '--no-open') noOpen = true;
    else if (arg === '--offline') offline = true;
    else if (arg === '--port') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--port requires a value.');
      port = portNumber(argv[++i]);
    } else if (arg.startsWith('--port=')) port = portNumber(arg.slice('--port='.length));
    else throw new Error(`Unsupported web argument: ${arg}. Run dispatch --help.`);
  }
  return { mode: 'web', port: portNumber(port), noOpen, offline };
}

export function dispatchEnvironment(paths, env = process.env, { cwd = process.cwd(), port, offline = false, version } = {}) {
  const result = { ...env };
  // Remove inherited lifecycle/session overrides; these belong to another host.
  for (const key of ['PI_CODING_AGENT_SESSION_DIR', 'PI_PACKAGE_DIR', 'PI_WEB_RESTART_CHILD', 'PI_WEB_SERVICE_NAME']) delete result[key];
  Object.assign(result, {
    PI_CODING_AGENT_DIR: paths.agentDir,
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    DISPATCH_ACTIVE: '1',
    DISPATCH_HOME: paths.home,
    DISPATCH_PACKAGE_ROOT: paths.packageRoot,
    DISPATCH_VERSION: version,
    PI_WEB_ENGINE: 'pi',
    PI_WEB_MANAGED: '1',
    PI_WEB_LAUNCHED_BY: 'dispatch',
    PI_WEB_HOST: '127.0.0.1',
    PI_WEB_CWD: cwd,
    PI_WEB_DATA_DIR: paths.webDir,
    PI_WEB_PKG_ROOT: join(paths.packageRoot, 'vendor', 'web-ui'),
  });
  if (port !== undefined) result.PI_WEB_PORT = String(port);
  if (offline) result.PI_OFFLINE = '1';
  return result;
}

function applyEnvironment(env) {
  for (const key of ['PI_CODING_AGENT_SESSION_DIR', 'PI_PACKAGE_DIR', 'PI_WEB_RESTART_CHILD', 'PI_WEB_SERVICE_NAME']) {
    if (!(key in env)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = String(value);
}

export function resolvePiCli() {
  // Pi's package exports are ESM-only; resolving through require fails.
  const sdk = new URL(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const root = new URL('../', sdk);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  if (manifest.version !== '0.85.1' || typeof manifest.bin?.pi !== 'string') {
    throw new Error('Dispatch requires its pinned Pi 0.85.1 runtime. Reinstall the Dispatch package.');
  }
  return new URL(manifest.bin.pi, root);
}

async function startPi({ paths, args, env }) {
  applyEnvironment(env);
  const entry = resolvePiCli();
  process.argv = [process.execPath, fileURLToPath(entry), ...args];
  // Pi owns foreground terminal input and signal cleanup; no Windows child.kill shortcuts.
  await import(entry.href);
}

export async function waitForOwnedWebServer(url, { pid = process.pid, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(Math.min(500, Math.max(1, deadline - Date.now()))) });
      if (response.ok) {
        const health = await response.json();
        if (health.ok === true && health.pid === pid) return;
        if (typeof health.pid === 'number' && health.pid !== pid) throw new Error('The requested port belongs to another process.');
      }
    } catch (error) {
      if (error?.message === 'The requested port belongs to another process.') throw error;
    }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw new Error('Dispatch Web did not become ready. Check the server output above.');
}

async function startWeb({ paths, options, env, output }) {
  const entry = join(paths.packageRoot, 'vendor', 'web-ui', 'dist', 'server', 'index.js');
  try { await stat(entry); } catch {
    throw new Error('Packaged WebUI is missing. Build the release package first (npm run build:release).');
  }
  applyEnvironment(env);
  // The server parses argv as well as env: only pass our validated, loopback-only values.
  process.argv = [process.execPath, entry, '--host', '127.0.0.1', '--port', String(options.port), '--cwd', env.PI_WEB_CWD, '--data-dir', paths.webDir];
  await import(pathToFileURL(entry).href);
  const url = `http://127.0.0.1:${options.port}`;
  await waitForOwnedWebServer(url);
  output.write(`Dispatch Web: ${url}\nKeep this terminal open. Ctrl+C stops the server; closing the browser does not.\n`);
  if (!options.noOpen) {
    try { await openBrowser(url); } catch { output.write(`Open ${url} in your browser.\n`); }
  }
}

/** Injectable coordinator. Help/version never initialize Pi, credentials, or user state. */
export async function runDispatch(argv, {
  env = process.env,
  cwd = process.cwd(),
  paths = resolveDispatchPaths({ env }),
  output = process.stdout,
  errorOutput = process.stderr,
  setup = runSetup,
  interaction = createTerminalInteraction,
  launchPi = startPi,
  launchWeb = startWeb,
  update,
} = {}) {
  const options = parseDispatchArgs(argv, env);
  if (options.mode === 'help') { output.write(formatTerminalHelp() + '\n'); return 0; }
  const manifest = JSON.parse(await readFile(join(paths.packageRoot, 'package.json'), 'utf8'));
  if (options.mode === 'version') { output.write(`${manifest.version}\n`); return 0; }
  if (options.mode === 'setup') {
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    let terminal;
    try {
      terminal = interaction({ signal: controller.signal, openBrowser });
      await setup({ paths, io: terminal.io, signal: controller.signal });
      output.write('Run dispatch for the CLI, or dispatch --web for Dispatch Web.\n');
      return 0;
    } finally {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      terminal?.dispose();
    }
  }
  if (options.mode === 'update') {
    if (!update) throw new Error('Dispatch update support is not available in this development phase yet.');
    return await update({ paths, env, output, errorOutput });
  }
  const state = await readDispatchState(paths);
  if (!state?.setupComplete) { errorOutput.write('Dispatch is not configured. Run dispatch setup.\n'); return 1; }
  if (!(await stat(cwd)).isDirectory()) throw new Error('Workspace must be a directory.');
  await seedDispatchConfiguration(paths);
  const runtimeEnv = dispatchEnvironment(paths, env, { cwd, port: options.port, offline: options.offline, version: manifest.version });
  if (options.mode === 'web') await launchWeb({ paths, options, env: runtimeEnv, output });
  else await launchPi({ paths, args: options.piArgs, env: runtimeEnv });
  return 0;
}
