import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { forkArtifactErrors } from '../../scripts/start-fork.mjs';

// tests/integration/fork-runtime.test.mjs lives two levels below the repo root.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultForkRoot = join(root, '..', 'PiAstra-web-ui');
const forkRoot = resolve(process.env.DISPATCH_FORK_DIR || process.env.PIASTRA_FORK_DIR || defaultForkRoot);
const sdkEntry = join(forkRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js');

/**
 * This is an explicit, opt-in integration test (`npm run test:integration`).
 * Unlike the offline unit suites it must not silently skip when the sibling
 * fork checkout is unavailable: missing fork artifacts or SDK are a hard
 * failure with setup instructions. The session it creates is fully synthetic
 * (temporary agent dir, in-memory session files) and makes no provider
 * network calls.
 */
function assertForkReady() {
  const missing = [
    ...forkArtifactErrors(forkRoot),
    ...(existsSync(sdkEntry) ? [] : [sdkEntry]),
  ];
  if (missing.length === 0) return;
  assert.fail(
    'Fork integration test cannot run: the sibling Dispatch Web checkout is not built.\n' +
    `Fork root: ${forkRoot}\n` +
    `Missing: ${missing.join(', ')}\n` +
    'Set up and build the fork checkout, then re-run `npm run test:integration`:\n' +
    `  cd ${forkRoot} && npm ci && npm run build\n` +
    `(Override the checkout location with DISPATCH_FORK_DIR (legacy PIASTRA_FORK_DIR); default: ${defaultForkRoot})\n`,
  );
}

/**
 * Fully temporary isolated agent dir: a settings.json referencing the repo
 * extension plus synthetic auth/model fixtures. No real credentials, no
 * provider network calls, nothing copied from `.local`.
 */
async function makeSyntheticAgentDir() {
  const agentDir = join(await mkdtemp(join(tmpdir(), 'piastra-fork-sdk-')), 'agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'openai-codex',
    defaultModel: 'gpt-6-astra',
    defaultThinkingLevel: 'low',
    retry: { enabled: true, maxRetries: 2 },
    extensions: [join(root, 'extensions', 'piastra', 'index.ts')],
  }, null, 2) + '\n');
  // Synthetic, non-functional credentials for the two built-in providers the
  // role models use; nothing here is a real secret and no request is made.
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
    'openai-codex': { type: 'api_key', key: 'sk-synthetic-test' },
    'opencode-go': { type: 'api_key', key: 'sk-synthetic-test' },
  }, null, 2) + '\n');
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: {} }) + '\n');
  return agentDir;
}

test('fork SDK sessions load Dispatch with canonical and legacy commands and only delegate as delegation', async () => {
  assertForkReady();
  const agentDir = await makeSyntheticAgentDir();
  // Extension getAgentDir() resolves the environment, not the services option.
  // Set both before loading the SDK so real user preferences are never read.
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session;
  try {
    const sdk = await import(pathToFileURL(sdkEntry).href);
    const services = await sdk.createAgentSessionServices({ cwd: root, agentDir });
    const extensionErrors = services.resourceLoader.getExtensions().errors;
    assert.deepEqual(extensionErrors, []);
    const extensions = services.resourceLoader.getExtensions().extensions;
    const commands = extensions.flatMap(extension => [...extension.commands.keys()]);
    assert.ok(commands.includes('dispatch'), 'canonical summary command is loaded');
    assert.ok(commands.includes('piastra'), 'legacy summary command is loaded');
    assert.ok(commands.includes('dispatch-help'), 'help command is loaded');
    ({ session } = await sdk.createAgentSessionFromServices({
      services,
      sessionManager: sdk.SessionManager.inMemory(root), // no session files written
    }));
    assert.deepEqual(session.getActiveToolNames().filter(name =>
      ['subagent_spawn', 'subagent_get_result', 'subagent_steer', 'subagent_list', 'subagent_stop', 'subagent_wait_all', 'subagent_templates', 'delegate_task'].includes(name)), []);
    // The fork server binds every session in rpc mode the same way.
    await session.bindExtensions({ mode: 'rpc' });
    const active = session.getActiveToolNames();
    assert.ok(active.includes('delegate'), `delegate should be active, got: ${active.join(', ')}`);
    assert.ok(!active.some(name => name.startsWith('subagent_')));
    // Commands are verified above before invoking: never send an unknown slash
    // command as a prompt. These commands make no model requests.
    await session.prompt('/dispatch');
    await session.prompt('/piastra');
    const beforeHelp = [...session.messages];
    await session.prompt('/dispatch-help');
    await session.prompt('/dispatch-help shortcuts');
    assert.deepEqual(session.messages, beforeHelp, 'help never enters model conversation history');
    await session.prompt('/agent general');
    assert.equal(session.model?.id, 'glm-5.3-flash');
  } finally {
    try { session?.dispose(); } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(dirname(agentDir), { recursive: true, force: true });
    }
  }
});
