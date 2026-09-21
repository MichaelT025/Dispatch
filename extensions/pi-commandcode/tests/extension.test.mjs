import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const { createJiti } = await import(pathToFileURL(fileURLToPath(new URL("../../../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-static.mjs", import.meta.url))).href);
const index = join(root, "extensions/pi-commandcode/index.ts");
const loader = createJiti(import.meta.url, { interopDefault: true });
const extensionFactory = (await loader.import(index, { default: true }));

const modelsBody = (ids = ["gpt-5.6-sol", "poolside/laguna-s-2.1-free"]) => ({
  object: "list",
  data: ids.map((id) => ({ id, name: id, context_length: 100000 })),
});
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 503, statusText: ok ? "OK" : "down", json: async () => body });

function fakeFetch({ plan = "individual-goat-monthly", models = modelsBody(), failSubscription = false, failModels = false, gate, planGate } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (gate) await gate;
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/models")) return failModels ? response({}, false) : response(models);
    if (parsed.pathname.endsWith("/whoami")) return response({ user: { id: "user-1" }, org: null });
    if (parsed.pathname.endsWith("/billing/subscriptions")) {
      if (planGate) await planGate;
      if (failSubscription) return response({}, false);
      return response({ data: { status: "active", planId: plan } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetch, calls };
}

function makeRegistry(auth = "canonical-key", models = []) {
  return {
    find(provider, id) { return models.find((m) => m.provider === provider && m.id === id); },
    getProviderAuth() { return { auth: { apiKey: auth }, source: "canonical registry" }; },
    getProviderAuthStatus() { return { configured: true }; },
  };
}

function makePi() {
  const handlers = new Map();
  const providers = [];
  const commands = new Map();
  const setModels = [];
  const pi = {
    handlers, providers, commands, setModels,
    on(name, fn) { handlers.set(name, fn); },
    registerCommand(name, config) { commands.set(name, config); },
    registerProvider(id, config) { providers.push({ id: typeof id === "string" ? id : id.id, config: typeof id === "string" ? config : id }); },
    setModel(model) { setModels.push(model); return Promise.resolve(true); },
  };
  return pi;
}

async function setup(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "commandcode-extension-"));
  const previous = {
    agent: process.env.PI_CODING_AGENT_DIR, cache: process.env.COMMANDCODE_MODELS_CACHE,
    base: process.env.COMMANDCODE_API_BASE, models: process.env.COMMANDCODE_MODELS_URL,
    key: process.env.COMMAND_CODE_API_KEY, fetch: globalThis.fetch,
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.COMMANDCODE_MODELS_CACHE = join(dir, "models.json");
  process.env.COMMANDCODE_API_BASE = "https://cc.test/provider/v1";
  process.env.COMMANDCODE_MODELS_URL = "https://cc.test/provider/v1/models";
  process.env.COMMAND_CODE_API_KEY = options.key ?? "ambient-key";
  if (options.seedCache) {
    await writeFile(process.env.COMMANDCODE_MODELS_CACHE, JSON.stringify({ version: 1, models: [
      { id: "gpt-5.6-sol", name: "gpt-5.6-sol (CC)", reasoning: false, contextWindow: 100000, maxTokens: 65536 },
      { id: "poolside/laguna-s-2.1-free", name: "poolside/laguna-s-2.1-free (CC)", reasoning: false, contextWindow: 100000, maxTokens: 65536 },
    ] }));
  }
  const route = fakeFetch(options);
  globalThis.fetch = route.fetch;
  const pi = makePi();
  const factoryPromise = extensionFactory(pi);
  if (options.awaitFactory !== false) await factoryPromise;
  return {
    dir, pi, calls: route.calls, factoryPromise,
    async close() {
      if (previous.fetch) globalThis.fetch = previous.fetch; else delete globalThis.fetch;
      for (const [name, value] of Object.entries(previous)) {
        const env = { agent: "PI_CODING_AGENT_DIR", cache: "COMMANDCODE_MODELS_CACHE", base: "COMMANDCODE_API_BASE", models: "COMMANDCODE_MODELS_URL", key: "COMMAND_CODE_API_KEY" }[name];
        if (name === "fetch") continue;
        if (value === undefined) delete process.env[env]; else process.env[env] = value;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const modelsFor = (pi, id) => [...pi.providers].reverse().find((p) => p.id === id)?.config;
const emit = async (pi, name, event, ctx) => pi.handlers.get(name)?.(event, ctx);

 test("cold discovery registers GOAT and API groups", async () => {
  const env = await setup();
  try {
    assert.deepEqual(env.pi.providers.map((p) => p.id), ["commandcode", "commandcode-api"]);
    assert.equal(modelsFor(env.pi, "commandcode").models.length, 2);
    assert.equal(modelsFor(env.pi, "commandcode-api").getModels().length, 2);
  } finally { await env.close(); }
});

 test("subscription failure keeps API catalog and downgrades primary to free-only", async () => {
  const env = await setup({ failSubscription: true });
  try {
    assert.equal(modelsFor(env.pi, "commandcode").models.length, 1);
    assert.equal(modelsFor(env.pi, "commandcode").models[0].id, "poolside/laguna-s-2.1-free");
    assert.equal(modelsFor(env.pi, "commandcode-api").getModels().length, 2);
  } finally { await env.close(); }
});

test("warm-cache factory waits for delayed plan detection before registering full GOAT", async () => {
  let release;
  const planGate = new Promise((resolve) => { release = resolve; });
  const env = await setup({ seedCache: true, awaitFactory: false, planGate });
  try {
    let settled = false;
    env.factoryPromise.finally(() => { settled = true; });
    await new Promise((resolve) => queueMicrotask(resolve));
    assert.equal(settled, false);
    release();
    await env.factoryPromise;
    assert.equal(modelsFor(env.pi, "commandcode").models.length, 2);
  } finally { await env.close(); }
});

test("refresh reapplies plan classification when discovery falls back to cache", async () => {
  const env = await setup();
  try {
    const registry = makeRegistry("canonical-key");
    const ctx = { modelRegistry: registry, model: undefined, hasUI: false };
    await emit(env.pi, "session_start", {}, ctx);
    assert.equal(modelsFor(env.pi, "commandcode").models.length, 2);
    // The live model request fails, but cached models are re-registered after
    // the account lookup changes to a non-GOAT subscription.
    globalThis.fetch = fakeFetch({ plan: "free", failModels: true }).fetch;
    await env.pi.commands.get("commandcode-refresh").handler("", { ui: { notify() {} }, waitForIdle: async () => {} });
    assert.equal(modelsFor(env.pi, "commandcode").models.length, 1);
    assert.equal(modelsFor(env.pi, "commandcode-api").getModels().length, 2);
  } finally { await env.close(); }
});

 test("session auth is canonical, migrates legacy premium selection, and shutdown aborts runtime", async () => {
  const env = await setup({ seedCache: true });
  try {
    assert.ok(env.pi.handlers.has("session_shutdown"));
    const premium = { provider: "commandcode", id: "gpt-5.6-sol" };
    const apiModel = { provider: "commandcode-api", id: premium.id };
    const notices = [];
    const ctx = { modelRegistry: makeRegistry("canonical-key", [apiModel]), model: premium, hasUI: true, ui: { notify: (m) => notices.push(m) } };
    await emit(env.pi, "session_start", {}, ctx);
    const api = modelsFor(env.pi, "commandcode-api");
    assert.equal((await api.auth.apiKey.resolve()).auth.apiKey, "canonical-key");
    assert.equal((await api.auth.apiKey.resolve()).source, "canonical registry");
    assert.equal(env.pi.setModels.at(-1), apiModel);
    assert.match(notices[0], /API \/ Extra credits/);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const shutdownRoute = fakeFetch({ gate });
    globalThis.fetch = shutdownRoute.fetch;
    const refreshing = emit(env.pi, "session_start", {}, { ...ctx, model: undefined, hasUI: false });
    await new Promise((resolve) => setImmediate(resolve));
    await emit(env.pi, "session_shutdown", {}, ctx);
    release();
    await refreshing;
    const modelCall = shutdownRoute.calls.find((call) => call.url.endsWith("/models"));
    assert.equal(modelCall.init.signal.aborted, true);
  } finally { await env.close(); }
});
