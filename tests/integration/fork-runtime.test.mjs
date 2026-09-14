import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { forkArtifactErrors } from '../../scripts/start-fork.mjs';

// tests/integration/fork-runtime.test.mjs lives two levels below the repo root.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultForkRoot = join(root, '..', 'PiAstra-web-ui');
const forkRoot = resolve(process.env.PIASTRA_FORK_DIR || defaultForkRoot);
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
    'Fork integration test cannot run: the sibling PiAstra fork checkout is not built.\n' +
    `Fork root: ${forkRoot}\n` +
    `Missing: ${missing.join(', ')}\n` +
    'Set up and build the fork checkout, then re-run `npm run test:integration`:\n' +
    `  cd ${forkRoot} && npm ci && npm run build\n` +
    `(Override the checkout location with PIASTRA_FORK_DIR; default: ${defaultForkRoot})\n`,
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

test('fork SDK sessions load the PiAstra extension with only the delegate tool as delegation', async () => {
  assertForkReady();
  const agentDir = await makeSyntheticAgentDir();
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const services = await sdk.createAgentSessionServices({ cwd: root, agentDir });
  const extensionErrors = services.resourceLoader.getExtensions().errors;
  assert.deepEqual(extensionErrors, []);
  const { session } = await sdk.createAgentSessionFromServices({
    services,
    sessionManager: sdk.SessionManager.inMemory(root), // in-memory: no session files written
  });
  assert.deepEqual(session.getActiveToolNames().filter(name =>
    ['subagent_spawn', 'subagent_get_result', 'subagent_steer', 'subagent_list', 'subagent_stop', 'subagent_wait_all', 'subagent_templates', 'delegate_task'].includes(name)), []);
  // The extension only exposes `delegate` after bindExtensions fires session_start
  // (the fork server binds every session in rpc mode the same way).
  await session.bindExtensions({ mode: 'rpc' });
  const active = session.getActiveToolNames();
  assert.ok(active.includes('delegate'), `delegate should be active, got: ${active.join(', ')}`);
  assert.ok(!active.some(name => name.startsWith('subagent_')));
  // Role switching via the /agent command (no model request; only setModel).
  await session.prompt('/agent general');
  assert.equal(session.model?.id, 'glm-5.3-flash');
  session.dispose();
});
