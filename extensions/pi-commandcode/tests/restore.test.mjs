import test from "node:test";
import assert from "node:assert/strict";
import { findCommandCodeModelToRestore } from "../src/restore.ts";

const registry = [
  { provider: "commandcode-plan", id: "meta/muse-spark-1.3-contributor" },
  { provider: "commandcode-api", id: "claude-opus-5" },
];
const find = (provider, id) => registry.find((model) => model.provider === provider && model.id === id);
const fallback = { provider: "openai-codex", id: "gpt-6-astra" };
const change = (provider, modelId) => ({ type: "model_change", provider, modelId });
const message = { type: "message" };

test("a resumed legacy commandcode/<id> choice moves to the selector that lists it", () => {
  const result = findCommandCodeModelToRestore({
    current: fallback,
    branch: [change("commandcode", "meta/muse-spark-1.3-contributor"), message],
    defaultModel: undefined,
    find,
  });
  assert.equal(result.model, registry[0]);
  assert.match(result.reason, /commandcode\/meta\/muse-spark-1\.3-contributor is now commandcode-plan\//);
});

test("a legacy API-classified choice moves to commandcode-api", () => {
  const result = findCommandCodeModelToRestore({ current: fallback, branch: [change("commandcode", "claude-opus-5")], defaultModel: undefined, find });
  assert.equal(result.model, registry[1]);
});

test("a new session recovers a legacy default model", () => {
  const result = findCommandCodeModelToRestore({
    current: fallback,
    branch: [change(fallback.provider, fallback.id)],
    defaultModel: { provider: "commandcode", id: "claude-opus-5" },
    find,
  });
  assert.equal(result.model, registry[1]);
});

test("a later deliberate non-Command Code choice is left alone", () => {
  assert.equal(findCommandCodeModelToRestore({
    current: fallback,
    branch: [change("commandcode", "claude-opus-5"), message, change(fallback.provider, fallback.id)],
    defaultModel: { provider: "commandcode", id: "claude-opus-5" },
    find,
  }), undefined);
});

test("a model reclassified between selectors is re-homed; unchanged choices are not", () => {
  const moved = findCommandCodeModelToRestore({ current: { provider: "commandcode-api", id: "meta/muse-spark-1.3-contributor" }, branch: [], defaultModel: undefined, find });
  assert.equal(moved.model, registry[0]);
  assert.match(moved.reason, /moved from commandcode-api to commandcode-plan/);
  assert.equal(findCommandCodeModelToRestore({ current: registry[0], branch: [], defaultModel: undefined, find }), undefined);
});

test("hidden or retired IDs are not restored", () => {
  assert.equal(findCommandCodeModelToRestore({ current: fallback, branch: [change("commandcode", "typesafe/jev")], defaultModel: undefined, find }), undefined);
});
