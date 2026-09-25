import test from "node:test";
import assert from "node:assert/strict";
import { findCommandCodeModelToRestore, hasExplicitModelArg } from "../src/restore.ts";

const registry = [
  { provider: "commandcode-plan", id: "meta/muse-spark-1.3-contributor" },
  { provider: "commandcode-api", id: "claude-opus-5" },
  { provider: "openai-codex", id: "gpt-6-astra" },
  { provider: "anthropic", id: "claude-opus-5-5" },
];
const find = (provider, id) => registry.find((model) => model.provider === provider && model.id === id);
const fallback = { provider: "openai-codex", id: "gpt-6-astra" };
const explicit = { provider: "anthropic", id: "claude-opus-5-5" };
const change = (provider, modelId) => ({ type: "model_change", provider, modelId });
const message = { type: "message" };
const legacyResume = [change("commandcode", "meta/muse-spark-1.3-contributor"), message];
const restore = (overrides) => findCommandCodeModelToRestore({
  current: fallback, branch: [], defaultModel: undefined, explicitModel: false, find, ...overrides,
});

test("a resumed legacy commandcode/<id> choice replaces Pi's fallback", () => {
  const result = restore({ branch: legacyResume });
  assert.equal(result.action, "switch");
  assert.equal(result.model, registry[0]);
  assert.match(result.reason, /commandcode\/meta\/muse-spark-1\.3-contributor is now commandcode-plan\//);
  // Pi fell back to a resolvable default: that is still a fallback.
  assert.equal(restore({ branch: legacyResume, defaultModel: fallback }).action, "switch");
  assert.equal(restore({ branch: [change("commandcode", "claude-opus-5"), message] }).model, registry[1]);
});

test("an explicit --model on resume is never overridden", () => {
  assert.equal(restore({ branch: legacyResume, current: explicit, explicitModel: true }), undefined);
  assert.equal(restore({ branch: legacyResume, current: fallback, explicitModel: true }), undefined);
});

test("a resumed model that is not Pi's default fallback is treated as a deliberate choice", () => {
  // Default resolves to gpt-6-astra, so Pi's fallback would have been that; an
  // SDK caller (e.g. a Dispatch worker) passed a different model explicitly.
  assert.equal(restore({ branch: legacyResume, current: explicit, defaultModel: fallback }), undefined);
});

test("a legacy default on a new session produces a notice, never a switch", () => {
  const result = restore({
    branch: [change(fallback.provider, fallback.id)],
    defaultModel: { provider: "commandcode", id: "claude-opus-5" },
  });
  assert.equal(result.action, "notify");
  assert.equal(result.model, registry[1]);
  assert.match(result.reason, /default model commandcode\/claude-opus-5 is now commandcode-api\/claude-opus-5; select it with \/model/);
  assert.equal(restore({ branch: [change(explicit.provider, explicit.id)], current: explicit, explicitModel: true, defaultModel: { provider: "commandcode", id: "claude-opus-5" } }).action, "notify");
});

test("a later deliberate non-Command Code choice is left alone", () => {
  assert.equal(restore({
    branch: [change("commandcode", "claude-opus-5"), message, change(fallback.provider, fallback.id)],
    defaultModel: { provider: "commandcode", id: "claude-opus-5" },
  }), undefined);
});

test("a model reclassified between selectors is re-homed; unchanged choices are not", () => {
  const moved = restore({ current: { provider: "commandcode-api", id: "meta/muse-spark-1.3-contributor" } });
  assert.equal(moved.action, "switch");
  assert.equal(moved.model, registry[0]);
  assert.match(moved.reason, /moved from commandcode-api to commandcode-plan/);
  assert.equal(restore({ current: registry[0] }), undefined);
});

test("hidden or retired IDs are not restored", () => {
  assert.equal(restore({ branch: [change("commandcode", "typesafe/jev"), message] }), undefined);
  assert.equal(restore({ defaultModel: { provider: "commandcode", id: "typesafe/jev" } }), undefined);
});

test("explicit --model detection follows Pi's CLI parser", () => {
  assert.equal(hasExplicitModelArg(["--model", "anthropic/claude-opus-5-5"]), true);
  assert.equal(hasExplicitModelArg(["-c", "--provider", "anthropic", "--model", "x"]), true);
  assert.equal(hasExplicitModelArg(["--models", "anthropic/*"]), false);
  assert.equal(hasExplicitModelArg(["--model"]), false);
  assert.equal(hasExplicitModelArg(["explain --model flag"]), false);
});
