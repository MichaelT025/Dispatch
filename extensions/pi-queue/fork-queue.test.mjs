// Integration tests through the real PiAstra fork SDK entrypoint (0.85.1):
// the vendored pi-queue extension is loaded by the actual extension loader the
// fork uses, then driven via session.prompt so /q, /st, idle parking, pause
// and the Atelier sidebar publisher run end-to-end. The configured model is
// an offline provider (127.0.0.1:9) so no network call ever completes.
//
// Run: node --experimental-strip-types --test extensions/pi-queue/fork-queue.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { forkArtifactErrors } from '../../scripts/start-fork.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const forkRoot = resolve(process.env.DISPATCH_FORK_DIR || process.env.PIASTRA_FORK_DIR || join(root, '..', 'DispatchWeb'));
const sdkEntry = join(forkRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js');
const ready = existsSync(sdkEntry) && forkArtifactErrors(forkRoot).length === 0;

const queueIndex = join(root, 'extensions', 'pi-queue', 'index.ts');

// Co-extension tap: records input deliveries and Atelier panel publications on
// a globalThis handle so the test reads them from the same process.
const tapSource = String.raw`
export default function (pi) {
  globalThis.__piQueueTap = { inputs: [], panels: [] };
  pi.on('input', (event) => {
    globalThis.__piQueueTap.inputs.push({
      text: event.text,
      source: event.source,
      streamingBehavior: event.streamingBehavior,
    });
  });
  pi.events.on('pi-atelier:sidebar-panels', (event) => {
    if (event?.version === 1 && event.type === 'register' && event.panel?.id === 'piastra:queue') {
      globalThis.__piQueueTap.panels.push(event.panel);
    }
  });
};
`;

async function makeSyntheticAgentDir() {
  const agentDir = join(await mkdtemp(join(tmpdir(), 'piastra-queue-fork-')), 'agent');
  await mkdir(agentDir, { recursive: true });
  const tapPath = join(agentDir, 'tap-extension.ts');
  await writeFile(tapPath, tapSource, 'utf8');
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'offline',
    defaultModel: 'offline-1',
    defaultThinkingLevel: 'low',
    extensions: [queueIndex, tapPath],
  }, null, 2) + '\n');
  // Offline provider: port 9 (discard) refuses instantly; no secrets, no network.
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
    offline: { type: 'api_key', key: 'sk-synthetic-test' },
  }, null, 2) + '\n');
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      offline: {
        name: 'Offline',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-synthetic-test',
        models: [{
          id: 'offline-1',
          name: 'Offline 1',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 4096,
        }],
      },
    },
    order: ['offline'],
  }, null, 2) + '\n');
  return agentDir;
}

const settled = async () => new Promise(resolveStep => setImmediate(resolveStep));

test('fork SDK session loads the pi-queue fork and parks idle /q paused', {
  skip: !ready && 'fork checkout or build artifacts missing',
}, async () => {
  const agentDir = await makeSyntheticAgentDir();
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const services = await sdk.createAgentSessionServices({ cwd: root, agentDir });
  const extensionErrors = services.resourceLoader.getExtensions().errors;
  assert.deepEqual(extensionErrors, [], 'the vendored queue fork must load cleanly');
  const { session } = await sdk.createAgentSessionFromServices({
    services,
    sessionManager: sdk.SessionManager.inMemory(root),
  });
  await session.bindExtensions({ mode: 'rpc' });

  // Idle /q parks the queue paused (same as stopped Alt+Enter).
  await session.prompt('/q first');
  await settled();
  assert.equal(globalThis.__piastraPiQueueState.pending, 1);
  assert.equal(globalThis.__piastraPiQueueState.paused, true);

  await session.prompt('/q second');
  await settled();
  assert.equal(globalThis.__piastraPiQueueState.pending, 2);

  // Idle /st with a backlog never starts a run and never overtakes.
  await session.prompt('/st seg');
  await settled();
  const inputs = globalThis.__piQueueTap.inputs;
  assert.deepEqual(inputs, [], '/st with a parked backlog must not dispatch anything');
  assert.equal(globalThis.__piastraPiQueueState.pending, 3);
  assert.equal(globalThis.__piastraPiQueueState.paused, true, 'the parked timeline stays paused');

  // Whitespace-only usage notifications change nothing.
  await session.prompt('/st   ');
  await settled();
  assert.equal(globalThis.__piastraPiQueueState.pending, 3);

  // The sidebar panel reflects the actual snapshot with lane labels.
  const panels = globalThis.__piQueueTap.panels;
  const panel = panels.at(-1);
  assert.equal(panel.id, 'piastra:queue');
  const joined = panel.rows.map(row => row.text).join('\n');
  assert.ok(joined.includes('[Queued]'), `explicit Queued labels expected, got: ${joined}`);
  assert.ok(joined.includes('[Steer]'), `explicit Steer labels expected, got: ${joined}`);
  assert.ok(panel.title.includes('paused'), 'paused state in the panel title');
  for (const row of panel.rows) {
    assert.ok(panel.rows.length <= 24 && row.text.length <= 160);
  }

  session.dispose();
});
