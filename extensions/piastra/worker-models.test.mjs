import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AssistantMessageEventStream, createProvider } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { mirrorExtensionProviders, resolveWorkerModel } from './worker-models.mjs';

// Regression: workers build their own ModelRuntime and load no extensions, so
// extension-registered providers (Command Code's commandcode-plan/-api
// selectors) were missing and every such role failed at startup with
// "Unavailable model …" while built-in providers (openai-codex) worked.
// Everything here is offline: real ModelRuntime/ModelRegistry instances over a
// scratch agent dir, and a fixture provider whose stream answers locally.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentDir = process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), 'piastra-worker-models-'));

const GENERAL = 'commandcode-plan/meta/muse-spark-1.3-contributor';
const FAST = 'commandcode-plan/deepseek/deepseek-v4.1-flash';

// Offline runtime: same files the worker path uses, never the network.
const offlineRuntime = () => ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'),
  modelsStorePath: join(agentDir, 'models-store.json'), allowModelNetwork: false,
});

function fixtureModel(provider, id) {
  return {
    id, name: id, provider, api: 'fixture-api', baseUrl: 'https://fixture.invalid/v1', reasoning: false,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192,
  };
}

// Mirrors the Command Code catalog alias: a native provider with ambient auth.
function fixtureProvider(id, modelIds, requests = []) {
  const stream = (model, context) => {
    requests.push({ provider: model.provider, model: model.id });
    const out = new AssistantMessageEventStream();
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const message = { role: 'assistant', content: [{ type: 'text', text: `PONG from ${model.provider}/${model.id}` }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: 'stop', timestamp: Date.now() };
    queueMicrotask(() => {
      out.push({ type: 'start', partial: message });
      out.push({ type: 'done', reason: 'stop', message });
    });
    return out;
  };
  return createProvider({
    id,
    auth: { apiKey: {
      name: 'Shared fixture login',
      login: async () => { throw new Error('fixture has no login'); },
      resolve: async () => ({ auth: { apiKey: 'fixture-key' }, source: 'fixture' }),
      check: async () => ({ type: 'api_key', source: 'fixture' }),
    } },
    models: modelIds.map(model => fixtureModel(id, model)),
    api: { stream, streamSimple: stream },
  });
}

async function parentRegistry(requests) {
  const registry = new ModelRegistry(await offlineRuntime());
  registry.registerProvider(fixtureProvider('commandcode-plan', ['meta/muse-spark-1.3-contributor', 'deepseek/deepseek-v4.1-flash'], requests));
  return registry;
}

test('a fresh worker runtime lacks extension providers until mirrored from the parent registry', async () => {
  const registry = await parentRegistry();
  const worker = await offlineRuntime();
  assert.ok(registry.find('commandcode-plan', 'meta/muse-spark-1.3-contributor'), 'parent resolves the plan model');
  assert.equal(worker.getModel('commandcode-plan', 'meta/muse-spark-1.3-contributor'), undefined, 'the reported failure');

  for (const selection of [GENERAL, FAST]) {
    const model = resolveWorkerModel(worker, registry, selection);
    assert.ok(model, `${selection} resolves on the worker runtime`);
    assert.equal(`${model.provider}/${model.id}`, selection, 'exact provider and slash-containing model ID');
  }
});

test('mirroring copies config providers, follows re-registration and unregistration, and skips unchanged ones', async () => {
  const registry = await parentRegistry();
  registry.registerProvider('fixture-config', {
    name: 'Fixture config', baseUrl: 'https://fixture.invalid/v1', apiKey: 'FIXTURE_KEY_ENV', api: 'openai-completions',
    models: [{ id: 'vendor/model-a', name: 'A', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
  });
  const worker = await offlineRuntime();
  const calls = [];
  for (const name of ['registerProvider', 'registerNativeProvider', 'unregisterProvider']) {
    const original = worker[name].bind(worker);
    worker[name] = (...args) => { calls.push(`${name}:${typeof args[0] === 'string' ? args[0] : args[0].id}`); return original(...args); };
  }

  mirrorExtensionProviders(worker, registry);
  assert.ok(worker.getModel('fixture-config', 'vendor/model-a'));
  assert.ok(worker.getModel('commandcode-plan', 'deepseek/deepseek-v4.1-flash'));
  assert.deepEqual(calls.sort(), ['registerNativeProvider:commandcode-plan', 'registerProvider:fixture-config']);

  calls.length = 0;
  mirrorExtensionProviders(worker, registry);
  assert.deepEqual(calls, [], 'an unchanged catalog is not recomposed for every worker');

  // A catalog refresh re-registers the selector with a different model list.
  registry.registerProvider(fixtureProvider('commandcode-plan', ['deepseek/deepseek-v4.1-flash']));
  registry.unregisterProvider('fixture-config');
  mirrorExtensionProviders(worker, registry);
  assert.equal(worker.getModel('commandcode-plan', 'meta/muse-spark-1.3-contributor'), undefined);
  assert.ok(worker.getModel('commandcode-plan', 'deepseek/deepseek-v4.1-flash'));
  assert.equal(worker.getModel('fixture-config', 'vendor/model-a'), undefined);
});

test('hosts without registry accessors keep the worker runtime as-is', async () => {
  const worker = await offlineRuntime();
  assert.doesNotThrow(() => mirrorExtensionProviders(worker, undefined));
  assert.doesNotThrow(() => mirrorExtensionProviders(worker, { find: () => undefined }));
  assert.equal(resolveWorkerModel(worker, { find: () => undefined }, GENERAL), undefined);
  assert.equal(resolveWorkerModel(worker, undefined, 'no-slash'), undefined);
});

// End to end through the REAL piastra extension: delegate general + fast on
// commandcode-plan selections, and check both workers create transcripts and
// make exactly one model request each with the exact model ID.
test('delegate: workers on extension-provider models start, request the exact model and complete', async () => {
  await mkdir(join(agentDir, 'piastra'), { recursive: true });
  await writeFile(join(agentDir, 'piastra', 'agents.json'), JSON.stringify({ roles: {
    general: { model: GENERAL, thinking: null },
    fast: { model: FAST, thinking: null },
  } }));
  const requests = [];
  const registry = await parentRegistry(requests);

  const handlers = new Map();
  const tools = [];
  const messages = [];
  const pi = {
    events: { emit() {}, on: () => () => {} },
    on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
    registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    registerTool: tool => { tools.push(tool); },
    getThinkingLevel: () => 'off', appendEntry() {}, getAllTools: () => [],
    setModel: async () => true, setThinkingLevel() {}, setActiveTools() {},
    sendMessage(message, options) { messages.push({ message, options }); },
  };
  const ctx = {
    mode: 'print', cwd: root, hasUI: false, isIdle: () => true,
    ui: { notify() {}, setStatus() {}, setWidget() {}, theme: { fg: (_s, t) => t } },
    sessionManager: { getBranch: () => [], getSessionId: () => 'worker-models-fixture' },
    isProjectTrusted: () => true,
    modelRegistry: registry,
  };
  const extension = await import(pathToFileURL(join(root, 'extensions', 'piastra', 'index.ts')).href);
  extension.default(pi);
  for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);

  const original = ModelRuntime.create;
  ModelRuntime.create = options => original.call(ModelRuntime, { ...options, allowModelNetwork: false });
  try {
    const delegate = tools.find(tool => tool.name === 'delegate');
    const awaitWorkers = tools.find(tool => tool.name === 'await_workers');
    const task = 'Reply with PONG.';
    const ack = await delegate.execute('call-1', { tasks: [{ role: 'general', access: 'read', task }, { role: 'fast', access: 'read', task }] }, undefined, () => {}, ctx);
    assert.match(ack.content[0].text, new RegExp(`#1 general \\(read\\) · ${GENERAL}`));
    const done = await awaitWorkers.execute('call-2', { ids: [1, 2] }, undefined, () => {}, ctx);
    const text = done.content.map(part => part.text).join('\n');
    assert.doesNotMatch(text, /Unavailable model/);
    assert.match(text, new RegExp(`#1 general · ${GENERAL} · completed[^\\n]*\\nPONG from ${GENERAL}`));
    assert.match(text, new RegExp(`#2 fast · ${FAST} · completed[^\\n]*\\nPONG from ${FAST}`));
    assert.doesNotMatch(text, /Transcript: \(none\)/);
    assert.deepEqual(done.details.workers.map(worker => worker.status), ['completed', 'completed']);
    assert.ok(done.details.workers.every(worker => worker.transcript?.startsWith(join(agentDir, 'piastra', 'runs'))));
    assert.deepEqual(requests.map(r => `${r.provider}/${r.model}`).sort(), [FAST, GENERAL]);
  } finally {
    ModelRuntime.create = original;
    for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, ctx);
  }
});
