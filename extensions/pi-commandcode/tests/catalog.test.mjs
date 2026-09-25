import test from "node:test";
import assert from "node:assert/strict";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { composeModelProvider } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js';
import { API_PROVIDER_ID, LOGIN_PROVIDER_ID, PLAN_PROVIDER_ID, registerCommandCodeCatalog } from "../src/catalog.ts";

const classification = {
  version: 1,
  plan: ["gpt-5.6-sol"],
  free: ["poolside/laguna-s-2.1-free"],
  api: ["claude-opus-5"],
  hidden: ["typesafe/jev"],
};

const streamCalls = [];
const stream = (model) => {
  streamCalls.push(model);
  return { stream: "sentinel" };
};

function makeConfig() {
  return {
    name: "Command Code",
    baseUrl: "https://api.commandcode.test/provider/v1",
    headers: { "x-client": "catalog-test" },
    api: "commandcode-custom",
    streamSimple: stream,
    models: [
      {
        id: "gpt-5.6-sol",
        name: "Sol (CC)",
        api: "commandcode-custom",
        baseUrl: "https://model-specific.test",
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        contextWindow: 12345,
        maxTokens: 6789,
        headers: { "x-model": "sol" },
        compat: { supportsStore: false },
      },
      {
        id: "poolside/laguna-s-2.1-free",
        name: "Laguna (CC)",
        api: "commandcode-custom",
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      { id: "claude-opus-5", name: "Opus (CC)", api: "commandcode-custom", cost: { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 } },
      { id: "brand-new/model", name: "New (CC)", api: "commandcode-custom", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
      { id: "typesafe/jev", name: "Jev (CC)", api: "commandcode-custom", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
    ],
  };
}

function collect(config, plan = "individual-goat-monthly", auth = {}) {
  const registrations = [];
  const pi = {
    registerProvider(first, second) {
      registrations.push(second === undefined ? first : { id: first, config: second });
    },
  };
  const result = registerCommandCodeCatalog(pi, config, plan, {
    resolve: auth.resolve ?? (async () => ({ auth: { apiKey: "initial" }, source: "test" })),
    check: auth.check ?? (async () => ({ type: "api_key", source: "test" })),
  }, classification);
  return { registrations, result };
}

const ids = (provider) => provider.getModels().map((model) => model.id);
const names = (provider) => provider.getModels().map((model) => model.name);

test("registers the canonical login plus plan and API selectors without changing input", () => {
  const config = makeConfig();
  const beforeModels = JSON.parse(JSON.stringify(config.models));
  const beforeHeaders = { ...config.headers };
  const { registrations, result } = collect(config);
  assert.deepEqual(registrations.map((entry) => entry.id), [LOGIN_PROVIDER_ID, PLAN_PROVIDER_ID, API_PROVIDER_ID]);
  const login = registrations.find((entry) => entry.id === LOGIN_PROVIDER_ID).config;
  const plan = registrations.find((entry) => entry.id === PLAN_PROVIDER_ID);
  const alias = registrations.find((entry) => entry.id === API_PROVIDER_ID);

  assert.equal(LOGIN_PROVIDER_ID, "commandcode");
  assert.equal(PLAN_PROVIDER_ID, "commandcode-plan");
  assert.equal(API_PROVIDER_ID, "commandcode-api");
  assert.deepEqual(login.models, [], "the login provider owns credentials, not selector entries");
  assert.equal(typeof login.streamSimple, "function");
  assert.deepEqual(result, { planVerified: true, planCount: 2, apiCount: 2 });
  assert.deepEqual(ids(plan), ["gpt-5.6-sol", "poolside/laguna-s-2.1-free"]);
  assert.deepEqual(names(plan), ["Sol (GOAT)", "Laguna (Free)"]);
  assert.deepEqual(ids(alias), ["claude-opus-5", "brand-new/model"]);
  assert.deepEqual(names(alias), ["Opus (API / extra credits)", "New (Unclassified)"]);
  assert.equal(plan.name, "Command Code (Plan: GOAT)");
  assert.equal(alias.name, "Command Code (API / Extra credits)");
  assert.equal(alias.baseUrl, config.baseUrl);
  assert.deepEqual(alias.headers, config.headers);

  const planSol = plan.getModels()[0];
  assert.equal(planSol.provider, PLAN_PROVIDER_ID);
  assert.equal(planSol.baseUrl, config.models[0].baseUrl);
  assert.deepEqual(planSol.cost, config.models[0].cost);
  assert.deepEqual(planSol.headers, config.models[0].headers);
  assert.deepEqual(planSol.compat, config.models[0].compat);
  assert.equal(planSol.contextWindow, config.models[0].contextWindow);
  assert.equal(planSol.maxTokens, config.models[0].maxTokens);
  assert.equal(alias.getModels()[0].provider, API_PROVIDER_ID);
  assert.deepEqual(config.models, beforeModels);
  assert.deepEqual(config.headers, beforeHeaders);
});

test("every live model appears in at most one selector; hidden in none", () => {
  const { registrations } = collect(makeConfig());
  const listed = registrations.filter((entry) => entry.id !== LOGIN_PROVIDER_ID).flatMap((entry) => ids(entry));
  assert.equal(new Set(listed).size, listed.length);
  assert.ok(!listed.includes("typesafe/jev"));
});

test("unverified plans keep free models plan-facing and label plan models under API", () => {
  const { registrations, result } = collect(makeConfig(), "unrecognized-plan");
  const plan = registrations.find((entry) => entry.id === PLAN_PROVIDER_ID);
  const alias = registrations.find((entry) => entry.id === API_PROVIDER_ID);
  assert.equal(result.planVerified, false);
  assert.equal(plan.name, "Command Code (Plan unverified)");
  assert.deepEqual(ids(plan), ["poolside/laguna-s-2.1-free"]);
  assert.deepEqual(names(alias), ["Sol (Plan unverified)", "Opus (API / extra credits)", "New (Unclassified)"]);
});

test("plan alias shares the canonical login without its own credential flow", async () => {
  const { registrations } = collect(makeConfig(), "goat", {
    resolve: async () => ({ auth: { apiKey: "shared" }, source: "canonical" }),
  });
  const plan = registrations.find((entry) => entry.id === PLAN_PROVIDER_ID);
  assert.equal(plan.auth.oauth, undefined);
  await assert.rejects(plan.auth.apiKey.login(), /Sign in to Command Code \(commandcode\)/);
  assert.equal((await plan.auth.apiKey.resolve()).auth.apiKey, "shared");
});

test("the zero-model login provider composes in Pi", () => {
  const { registrations } = collect(makeConfig());
  const login = registrations.find((entry) => entry.id === LOGIN_PROVIDER_ID).config;
  const provider = composeModelProvider(LOGIN_PROVIDER_ID, undefined, { getProvider: () => undefined }, { ...login, apiKey: "$COMMAND_CODE_API_KEY", oauth: { name: "Command Code", login: async () => ({}), refreshToken: async (c) => c, getApiKey: (c) => c.access } });
  assert.deepEqual(provider.getModels(), []);
});

test("alias auth resolves dynamically and propagates errors",  async () => {
  let current = "rotated-1";
  let fail = false;
  const { registrations } = collect(makeConfig(), "goat", {
    resolve: async () => {
      if (fail) throw new Error("credential store unavailable");
      return { auth: { apiKey: current }, source: "dynamic" };
    },
    check: async () => ({ type: "api_key", source: "dynamic" }),
  });
  const alias = registrations.find((entry) => entry.id === API_PROVIDER_ID);
  assert.equal(alias.auth.oauth, undefined);
  assert.equal(alias.auth.apiKey.name, "Shared Command Code login");
  const models = createModels();
  models.setProvider(alias);
  assert.equal((await models.getAuth(API_PROVIDER_ID)).auth.apiKey, "rotated-1");
  current = "rotated-2";
  assert.equal((await models.getAuth(API_PROVIDER_ID)).auth.apiKey, "rotated-2");
  fail = true;
  await assert.rejects(() => models.getAuth(API_PROVIDER_ID), /credential store unavailable/);
  await assert.rejects(() => alias.auth.apiKey.resolve(), /credential store unavailable/);
});

test('host overlays cannot create a second alias credential flow', async () => {
  let key = 'canonical-one';
  const { registrations } = collect(makeConfig(), 'goat', {
    resolve: async () => ({ auth: { apiKey: key }, source: 'canonical' }),
  });
  const alias = registrations.find(entry => entry.id === API_PROVIDER_ID);
  const provider = composeModelProvider(API_PROVIDER_ID, alias, {
    getProvider: () => ({ headers: { 'x-test-overlay': 'yes' } }),
  }, undefined);
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  models.setProvider(provider);
  let prompted = false;
  await assert.rejects(models.login(API_PROVIDER_ID, 'api_key', {
    prompt: async () => { prompted = true; return 'must-not-be-stored'; },
    notify() {},
  }), /Sign in to Command Code/);
  assert.equal(prompted, false);
  assert.equal(await credentials.read(API_PROVIDER_ID), undefined);
  assert.equal((await models.getAuth(API_PROVIDER_ID)).auth.apiKey, 'canonical-one');
  key = 'canonical-two';
  assert.equal((await models.getAuth(API_PROVIDER_ID)).auth.apiKey, 'canonical-two');
});

test("both registrations route streaming through the same implementation and retain cost", () => {
  streamCalls.length = 0;
  const { registrations } = collect(makeConfig());
  const plan = registrations.find((entry) => entry.id === PLAN_PROVIDER_ID);
  const alias = registrations.find((entry) => entry.id === API_PROVIDER_ID);
  const context = {};
  plan.streamSimple(plan.getModels()[0], context);
  alias.streamSimple(alias.getModels()[0], context);
  assert.equal(streamCalls.length, 2);
  assert.equal(streamCalls[0], plan.getModels()[0]);
  assert.equal(streamCalls[1], alias.getModels()[0]);
  assert.deepEqual(plan.getModels()[0].cost, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
});
