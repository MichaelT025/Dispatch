import test from "node:test";
import assert from "node:assert/strict";
import { isVerifiedGoatPlan, splitCommandCodeModels } from "../src/plan-models.ts";

const classification = {
  version: 1,
  plan: ["gpt-5.6-sol", "meta/muse-spark-1.3-contributor"],
  free: ["poolside/laguna-s-2.1-free"],
  api: ["claude-opus-5"],
  hidden: ["typesafe/jev"],
};

const catalog = [
  { id: "gpt-5.6-sol" },
  { id: "claude-opus-5" },
  { id: "poolside/laguna-s-2.1-free" },
  { id: "meta/muse-spark-1.3-contributor" },
  { id: "brand-new/model" },
  { id: "typesafe/jev" },
];

const view = (entries) => entries.map(({ model, label }) => `${model.id}:${label}`);

test("verified GOAT puts plan and free models plan-facing, API and unknown models API-facing", () => {
  const result = splitCommandCodeModels(catalog, "individual-goat-monthly", classification);
  assert.equal(result.planVerified, true);
  assert.deepEqual(view(result.planModels), [
    "gpt-5.6-sol:plan",
    "poolside/laguna-s-2.1-free:free",
    "meta/muse-spark-1.3-contributor:plan",
  ]);
  assert.deepEqual(view(result.apiModels), ["claude-opus-5:api", "brand-new/model:unclassified"]);
});

test("unknown IDs are never assumed plan or API, whatever their name or price", () => {
  const models = [{ id: "made-up-free-model", price: 0 }, { id: "gpt-5.6-terra", price: 0 }];
  const result = splitCommandCodeModels(models, "goat", classification);
  assert.deepEqual(result.planModels, []);
  assert.deepEqual(view(result.apiModels), ["made-up-free-model:unclassified", "gpt-5.6-terra:unclassified"]);
});

test("unverified plans keep free models plan-facing and label plan models API-facing", () => {
  const result = splitCommandCodeModels(catalog, "go", classification);
  assert.equal(result.planVerified, false);
  assert.deepEqual(view(result.planModels), ["poolside/laguna-s-2.1-free:free"]);
  assert.deepEqual(view(result.apiModels), [
    "gpt-5.6-sol:plan-unverified",
    "claude-opus-5:api",
    "meta/muse-spark-1.3-contributor:plan-unverified",
    "brand-new/model:unclassified",
  ]);
});

test("hidden models appear in neither selector", () => {
  const result = splitCommandCodeModels(catalog, "goat", classification);
  const all = [...result.planModels, ...result.apiModels].map(({ model }) => model.id);
  assert.ok(!all.includes("typesafe/jev"));
  assert.equal(new Set(all).size, all.length);
});

test("matching is exact and cadence suffixes do not turn Go into GOAT", () => {
  assert.equal(isVerifiedGoatPlan("GOAT_YEARLY"), true);
  assert.equal(isVerifiedGoatPlan("individual-goat"), true);
  assert.equal(isVerifiedGoatPlan("go"), false);
  assert.equal(isVerifiedGoatPlan("goat-ish"), false);
  assert.equal(isVerifiedGoatPlan(undefined), false);
});

test("preserves model objects, order, and input arrays", () => {
  const input = [{ id: "poolside/laguna-s-2.1-free", nested: { value: 1 } }, { id: "gpt-5.6-sol", nested: { value: 2 } }];
  const original = [...input];
  const result = splitCommandCodeModels(input, "goat", classification);
  assert.equal(result.planModels[0].model, input[0]);
  assert.equal(result.planModels[1].model, input[1]);
  assert.deepEqual(input, original);
});
