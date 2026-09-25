import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    key: process.env.COMMAND_CODE_API_KEY, classification: process.env.COMMANDCODE_MODEL_CLASSIFICATION,
    fetch: globalThis.fetch,
  };
  process.env.COMMANDCODE_MODEL_CLASSIFICATION = join(dir, "classification.json");
  if (options.classification !== undefined) {
    await writeFile(process.env.COMMANDCODE_MODEL_CLASSIFICATION, typeof options.classification === "string" ? options.classification : JSON.stringify(options.classification));
  }
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
        const env = { agent: "PI_CODING_AGENT_DIR", cache: "COMMANDCODE_MODELS_CACHE", base: "COMMANDCODE_API_BASE", models: "COMMANDCODE_MODELS_URL", key: "COMMAND_CODE_API_KEY", classification: "COMMANDCODE_MODEL_CLASSIFICATION" }[name];
        if (name === "fetch") continue;
        if (value === undefined) delete process.env[env]; else process.env[env] = value;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const latest = (pi, id) => [...pi.providers].reverse().find((p) => p.id === id)?.config;
const modelsFor = (pi, id) => latest(pi, id)?.getModels().map((model) => model.id);
const emit = async (pi, name, event, ctx) => pi.handlers.get(name)?.(event, ctx);
const noUi = { ui: { notify() {} }, waitForIdle: async () => {} };
const classification = (overrides = {}) => ({ version: 1, plan: ["gpt-5.6-sol"], free: ["poolside/laguna-s-2.1-free"], api: [], hidden: [], ...overrides });

test("cold discovery registers the login, plan and API providers and seeds the classification file", async () => {
  const env = await setup();
  try {
    assert.deepEqual(env.pi.providers.map((p) => p.id), ["commandcode", "commandcode-plan", "commandcode-api"]);
    assert.deepEqual(latest(env.pi, "commandcode").models, []);
    // Packaged defaults: Sol is a plan model and Laguna is free.
    assert.deepEqual(modelsFor(env.pi, "commandcode-plan"), ["gpt-5.6-sol", "poolside/laguna-s-2.1-free"]);
    assert.deepEqual(modelsFor(env.pi, "commandcode-api"), []);
    const seeded = JSON.parse(await readFile(join(env.dir, "classification.json"), "utf-8"));
    assert.ok(seeded.plan.includes("meta/muse-spark-1.3-contributor"));
  } finally { await env.close(); }
});

test("subscription failure keeps free models plan-facing and labels plan models under API", async () => {
  const env = await setup({ failSubscription: true });
  try {
    assert.deepEqual(modelsFor(env.pi, "commandcode-plan"), ["poolside/laguna-s-2.1-free"]);
    assert.deepEqual(latest(env.pi, "commandcode-api").getModels().map((m) => m.name), ["gpt-5.6-sol (Plan unverified)"]);
  } finally { await env.close(); }
});

test("warm-cache factory waits for delayed plan detection before registering plan models", async () => {
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
    assert.equal(modelsFor(env.pi, "commandcode-plan").length, 2);
  } finally { await env.close(); }
});

test("refresh reapplies plan classification when discovery falls back to cache", async () => {
  const env = await setup();
  try {
    const ctx = { modelRegistry: makeRegistry("canonical-key"), model: undefined, hasUI: false };
    await emit(env.pi, "session_start", {}, ctx);
    assert.equal(modelsFor(env.pi, "commandcode-plan").length, 2);
    globalThis.fetch = fakeFetch({ plan: "free", failModels: true }).fetch;
    await env.pi.commands.get("commandcode-refresh").handler("", noUi);
    assert.deepEqual(modelsFor(env.pi, "commandcode-plan"), ["poolside/laguna-s-2.1-free"]);
    assert.deepEqual(modelsFor(env.pi, "commandcode-api"), ["gpt-5.6-sol"]);
  } finally { await env.close(); }
});

test("/commandcode-refresh rereads JSON edits without reinstalling", async () => {
  const env = await setup({ classification: classification() });
  try {
    assert.deepEqual(modelsFor(env.pi, "commandcode-plan"), ["gpt-5.6-sol", "poolside/laguna-s-2.1-free"]);
    await writeFile(join(env.dir, "classification.json"), JSON.stringify(classification({ plan: [], api: ["gpt-5.6-sol"] })));
    await env.pi.commands.get("commandcode-refresh").handler("", noUi);
    assert.deepEqual(modelsFor(env.pi, "commandcode-plan"), ["poolside/laguna-s-2.1-free"]);
    assert.deepEqual(latest(env.pi, "commandcode-api").getModels().map((m) => m.name), ["gpt-5.6-sol (API / extra credits)"]);
  } finally { await env.close(); }
});

test("unknown live IDs are unclassified with a warning; stale IDs are reported", async () => {
  const env = await setup({
    classification: classification({ api: ["retired/model"] }),
    models: modelsBody(["gpt-5.6-sol", "poolside/laguna-s-2.1-free", "brand-new/model"]),
  });
  try {
    assert.deepEqual(latest(env.pi, "commandcode-api").getModels().map((m) => m.name), ["brand-new/model (Unclassified)"]);
    const notices = [];
    await env.pi.commands.get("commandcode-refresh").handler("", { ui: { notify: (m, level) => notices.push({ m, level }) }, waitForIdle: async () => {} });
    assert.equal(notices[0].level, "warning");
    assert.match(notices[0].m, /1 live Command Code model\(s\) are unclassified.*brand-new\/model/);
    assert.match(notices[0].m, /not in the live catalog: retired\/model/);
    const status = [];
    await env.pi.commands.get("commandcode-status").handler("", { ui: { notify: (m) => status.push(m) } });
    assert.match(status[0], /Unclassified live IDs: brand-new\/model/);
    assert.match(status[0], /Stale classified IDs: retired\/model/);
    assert.match(status[0], /Classified IDs: plan 1, free 1, api 1, hidden 0/);
  } finally { await env.close(); }
});

test("a malformed classification file is kept and reported; the last good copy stays in use", async () => {
  const env = await setup({ classification: classification() });
  try {
    const path = join(env.dir, "classification.json");
    await writeFile(path, "{ broken");
    const notices = [];
    await env.pi.commands.get("commandcode-refresh").handler("", { ui: { notify: (m) => notices.push(m) }, waitForIdle: async () => {} });
    assert.match(notices[0], /Ignoring .*invalid JSON.*Keeping the classification loaded before the edit/);
    assert.deepEqual(modelsFor(env.pi, "commandcode-plan"), ["gpt-5.6-sol", "poolside/laguna-s-2.1-free"]);
    assert.equal(await readFile(path, "utf-8"), "{ broken");
  } finally { await env.close(); }
});

test("session auth is canonical, legacy commandcode/<id> is restored, and shutdown aborts runtime", async () => {
  const env = await setup({ seedCache: true });
  try {
    assert.ok(env.pi.handlers.has("session_shutdown"));
    const planModel = { provider: "commandcode-plan", id: "gpt-5.6-sol" };
    const notices = [];
    const ctx = {
      modelRegistry: makeRegistry("canonical-key", [planModel]),
      model: { provider: "openai-codex", id: "fallback" },
      sessionManager: { getBranch: () => [{ type: "model_change", provider: "commandcode", modelId: "gpt-5.6-sol" }, { type: "message" }] },
      hasUI: true,
      ui: { notify: (m) => notices.push(m) },
    };
    await emit(env.pi, "session_start", {}, ctx);
    const plan = latest(env.pi, "commandcode-plan");
    assert.equal((await plan.auth.apiKey.resolve()).auth.apiKey, "canonical-key");
    assert.equal((await plan.auth.apiKey.resolve()).source, "canonical registry");
    assert.equal(env.pi.setModels.at(-1), planModel);
    assert.match(notices[0], /commandcode\/gpt-5\.6-sol is now commandcode-plan\/gpt-5\.6-sol/);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const shutdownRoute = fakeFetch({ gate });
    globalThis.fetch = shutdownRoute.fetch;
    const refreshing = emit(env.pi, "session_start", {}, { ...ctx, model: undefined, sessionManager: undefined, hasUI: false });
    await new Promise((resolve) => setImmediate(resolve));
    await emit(env.pi, "session_shutdown", {}, ctx);
    release();
    await refreshing;
    const modelCall = shutdownRoute.calls.find((call) => call.url.endsWith("/models"));
    assert.equal(modelCall.init.signal.aborted, true);
  } finally { await env.close(); }
});

const legacyBranch = (id) => [{ type: "model_change", provider: "commandcode", modelId: id }, { type: "message" }];
const newSessionBranch = (model) => [{ type: "model_change", provider: model.provider, modelId: model.id }];
const selectorModels = [
  { provider: "commandcode-plan", id: "gpt-5.6-sol" },
  { provider: "commandcode-plan", id: "poolside/laguna-s-2.1-free" },
];

async function startSession(env, overrides) {
  const notices = [];
  const ctx = {
    modelRegistry: makeRegistry("canonical-key", [...selectorModels, { provider: "anthropic", id: "explicit" }, { provider: "openai-codex", id: "fallback" }]),
    model: { provider: "openai-codex", id: "fallback" },
    sessionManager: { getBranch: () => [] },
    cwd: env.dir,
    isProjectTrusted: () => true,
    hasUI: true,
    ui: { notify: (m) => notices.push(m) },
    ...overrides,
  };
  await emit(env.pi, "session_start", {}, ctx);
  return notices;
}

test("an explicit --model on resume is not overridden by a legacy session model", async () => {
  const env = await setup({ classification: classification() });
  const argv = process.argv;
  try {
    process.argv = [argv[0], argv[1], "-c", "--model", "anthropic/explicit"];
    const notices = await startSession(env, { model: { provider: "anthropic", id: "explicit" }, sessionManager: { getBranch: () => legacyBranch("gpt-5.6-sol") } });
    assert.deepEqual(env.pi.setModels, []);
    assert.deepEqual(notices, []);
  } finally { process.argv = argv; await env.close(); }
});

test("a resumed model that is not Pi's default fallback (e.g. an SDK worker model) is kept", async () => {
  const env = await setup({ classification: classification() });
  try {
    await writeFile(join(env.dir, "settings.json"), JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "fallback" }));
    await startSession(env, { model: { provider: "anthropic", id: "explicit" }, sessionManager: { getBranch: () => legacyBranch("gpt-5.6-sol") } });
    assert.deepEqual(env.pi.setModels, []);
    await startSession(env, { sessionManager: { getBranch: () => legacyBranch("gpt-5.6-sol") } });
    assert.deepEqual(env.pi.setModels.map((m) => `${m.provider}/${m.id}`), ["commandcode-plan/gpt-5.6-sol"]);
  } finally { await env.close(); }
});

test("legacy defaults honour a trusted project .pi/settings.json and only notify on new sessions", async () => {
  const env = await setup({ classification: classification() });
  try {
    await writeFile(join(env.dir, "settings.json"), JSON.stringify({ defaultProvider: "commandcode", defaultModel: "gpt-5.6-sol" }));
    await mkdir(join(env.dir, ".pi"), { recursive: true });
    await writeFile(join(env.dir, ".pi", "settings.json"), JSON.stringify({ defaultModel: "poolside/laguna-s-2.1-free" }));
    const branch = { getBranch: () => newSessionBranch({ provider: "openai-codex", id: "fallback" }) };

    const trusted = await startSession(env, { sessionManager: branch });
    assert.match(trusted[0], /default model commandcode\/poolside\/laguna-s-2\.1-free is now commandcode-plan\/poolside\/laguna-s-2\.1-free/);
    const untrusted = await startSession(env, { sessionManager: branch, isProjectTrusted: () => false });
    assert.match(untrusted[0], /default model commandcode\/gpt-5\.6-sol is now commandcode-plan\/gpt-5\.6-sol/);
    assert.deepEqual(env.pi.setModels, [], "a new session's model may be an explicit caller choice");

    await writeFile(join(env.dir, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "fallback" }));
    assert.deepEqual(await startSession(env, { sessionManager: branch }), [], "a project default that is not legacy wins");
  } finally { await env.close(); }
});

test("context-length errors are normalized for overflow recovery on every Command Code selector", async () => {
  const env = await setup({ classification: classification() });
  try {
    for (const provider of ["commandcode-plan", "commandcode-api"]) {
      const message = { role: "assistant", provider, stopReason: "error", errorMessage: "Prompt too large for this model" };
      const result = await emit(env.pi, "message_end", { message }, { model: { provider, id: "gpt-5.6-sol" } });
      assert.match(result?.message.errorMessage ?? "", /^context_length_exceeded:/, provider);
    }
  } finally { await env.close(); }
});
