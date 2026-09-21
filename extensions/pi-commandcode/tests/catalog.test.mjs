import test from "node:test";
import assert from "node:assert/strict";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { composeModelProvider } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js';
import { API_PROVIDER_ID, PLAN_PROVIDER_ID, registerCommandCodeCatalog } from "../src/catalog.ts";

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
      { id: "not-in-goat", name: "Other (CC)", api: "commandcode-custom", cost: { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 } },
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
  });
  return { registrations, result };
}

test("registers a GOAT primary catalog and a full API alias without changing input", () => {
  const config = makeConfig();
  const beforeModels = JSON.parse(JSON.stringify(config.models));
  const beforeHeaders = { ...config.headers };
  const { registrations, result } = collect(config);
  const primary = registrations.find((entry) => entry.id === PLAN_PROVIDER_ID).config;
  const alias = registrations.find((entry) => entry.id === API_PROVIDER_ID);

  assert.deepEqual(result, { planVerified: true, planCount: 2, apiCount: 3 });
  assert.deepEqual(primary.models.map((model) => model.id), ["gpt-5.6-sol", "poolside/laguna-s-2.1-free"]);
  assert.deepEqual(alias.getModels().map((model) => model.id), config.models.map((model) => model.id));
  assert.equal(primary.name, "Command Code (GOAT)");
  assert.equal(alias.name, "Command Code (API / Extra credits)");
  assert.equal(alias.baseUrl, config.baseUrl);
  assert.deepEqual(alias.headers, config.headers);

  const apiSol = alias.getModels()[0];
  assert.equal(apiSol.provider, API_PROVIDER_ID);
  assert.equal(apiSol.baseUrl, config.models[0].baseUrl);
  assert.deepEqual(apiSol.cost, config.models[0].cost);
  assert.deepEqual(apiSol.headers, config.models[0].headers);
  assert.deepEqual(apiSol.compat, config.models[0].compat);
  assert.equal(apiSol.contextWindow, config.models[0].contextWindow);
  assert.equal(apiSol.maxTokens, config.models[0].maxTokens);
  assert.deepEqual(config.models, beforeModels);
  assert.deepEqual(config.headers, beforeHeaders);
  assert.notEqual(primary.models, config.models);
  assert.notEqual(alias.getModels(), config.models);
});

test("unknown plans expose only free primary models and API keeps every model", () => {
  const config = makeConfig();
  const { registrations } = collect(config, "unrecognized-plan");
  const primary = registrations.find((entry) => entry.id === PLAN_PROVIDER_ID).config;
  const alias = registrations.find((entry) => entry.id === API_PROVIDER_ID);
  assert.equal(primary.name, "Command Code (Plan unverified)");
  assert.deepEqual(primary.models.map((model) => model.id), ["poolside/laguna-s-2.1-free"]);
  assert.deepEqual(alias.getModels().map((model) => model.id), config.models.map((model) => model.id));
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
  const primary = registrations.find((entry) => entry.id === PLAN_PROVIDER_ID).config;
  const alias = registrations.find((entry) => entry.id === API_PROVIDER_ID);
  const context = {};
  primary.streamSimple(primary.models[0], context);
  alias.streamSimple(alias.getModels()[0], context);
  assert.equal(streamCalls.length, 2);
  assert.equal(streamCalls[0], primary.models[0]);
  assert.equal(streamCalls[1], alias.getModels()[0]);
  assert.deepEqual(alias.getModels()[0].cost, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
});
