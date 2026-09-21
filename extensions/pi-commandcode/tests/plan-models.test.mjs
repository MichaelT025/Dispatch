import test from "node:test";
import assert from "node:assert/strict";
import {
  FREE_MODEL_IDS,
  GOAT_MODEL_IDS,
  GOAT_SOURCE_URL,
  GOAT_VERIFIED_ON,
  splitCommandCodeModels,
} from "../src/plan-models.ts";

const catalog = [
  { id: "gpt-5.6-sol", price: 5 },
  { id: "gpt-5.6-luna", price: 0.2 },
  { id: "deepseek/deepseek-v4-pro", price: 0.66 },
  { id: "claude-opus-5", price: 0 },
  { id: FREE_MODEL_IDS[0], price: 0 },
  { id: FREE_MODEL_IDS[1], price: 0 },
];

test("exports the reviewed source and exact free IDs", () => {
  assert.equal(GOAT_SOURCE_URL, "https://commandcode.ai/docs/plans/goat");
  assert.match(GOAT_VERIFIED_ON, /^20\d\d-\d\d-\d\d$/);
  assert.deepEqual([...FREE_MODEL_IDS], [
    "poolside/laguna-s-2.1-free",
    "inclusionai/ling-3.0-flash-sante:free",
  ]);
  assert.equal(new Set(GOAT_MODEL_IDS).size, GOAT_MODEL_IDS.length);
  assert.equal(GOAT_MODEL_IDS.length, 52);
});

test("verified GOAT gets included premium models and both free models", () => {
  const result = splitCommandCodeModels(catalog, "individual-goat-monthly");
  assert.equal(result.planVerified, true);
  assert.deepEqual(result.planModels.map(({ id }) => id), [
    "gpt-5.6-sol", "gpt-5.6-luna", "deepseek/deepseek-v4-pro",
    "poolside/laguna-s-2.1-free", "inclusionai/ling-3.0-flash-sante:free",
  ]);
  assert.deepEqual(result.apiModels, catalog);
});

test("premium exclusions are not inferred from price, prefixes, or unknown IDs", () => {
  const models = [
    { id: "claude-opus-5", price: 0 },
    { id: "gpt-5.6-terra", price: 0 },
    { id: "made-up-free-model", price: 0 },
  ];
  const result = splitCommandCodeModels(models, "goat");
  assert.deepEqual(result.planModels, []);
  assert.deepEqual(result.apiModels, models);
});

test("unknown plans make no GOAT claim but retain free models", () => {
  const result = splitCommandCodeModels(catalog, "go");
  assert.equal(result.planVerified, false);
  assert.deepEqual(result.planModels.map(({ id }) => id), [...FREE_MODEL_IDS]);
});

test("matching is exact and cadence suffixes do not turn Go into GOAT", () => {
  assert.equal(splitCommandCodeModels([], "GOAT_YEARLY").planVerified, true);
  assert.equal(splitCommandCodeModels([], "individual-goat").planVerified, true);
  assert.equal(splitCommandCodeModels([], "go").planVerified, false);
  assert.equal(splitCommandCodeModels([], "goat-ish").planVerified, false);
});

test("preserves metadata, order, and input arrays", () => {
  const input = [{ id: FREE_MODEL_IDS[0], nested: { value: 1 } }, { id: "gpt-5.6-sol", nested: { value: 2 } }];
  const original = [...input];
  const result = splitCommandCodeModels(input, "goat");
  assert.deepEqual(result.planModels, [input[0], input[1]]);
  assert.deepEqual(result.apiModels, original);
  assert.equal(result.planModels[0], input[0]);
  assert.deepEqual(input, original);
});
