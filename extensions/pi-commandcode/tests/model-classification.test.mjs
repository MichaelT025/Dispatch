import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyModelId,
  describeClassificationReport,
  loadModelClassification,
  MODEL_CLASSES,
  PACKAGED_CLASSIFICATION_PATH,
  parseModelClassification,
  reconcileModelClassification,
} from "../src/model-classification.ts";

const packagedText = await readFile(PACKAGED_CLASSIFICATION_PATH, "utf-8");
const packaged = parseModelClassification(JSON.parse(packagedText));
const valid = { version: 1, plan: ["a"], free: ["b"], api: ["c"], hidden: [] };

async function tempDir() {
  return mkdtemp(join(tmpdir(), "commandcode-classification-"));
}

test("packaged defaults classify each ID exactly once", () => {
  const all = MODEL_CLASSES.flatMap((name) => packaged[name]);
  assert.equal(new Set(all).size, all.length);
  assert.match(packaged.reviewedOn, /^20\d\d-\d\d-\d\d$/);
  // Reviewed 2026-09-25 against the live Provider API (81 IDs) and the GOAT
  // page (60 entries = 56 plan + 3 free + headless-only Jev).
  assert.equal(packaged.plan.length, 56);
  assert.equal(packaged.free.length, 3);
  assert.equal(packaged.api.length, 22);
  assert.equal(all.length, 81);
});

test("packaged defaults place current models in the documented class", () => {
  const expected = {
    "meta/muse-spark-1.3-contributor": "plan",
    "meta/muse-spark-1.3": "plan",
    "gpt-5.6-sol": "plan",
    "xai/grok-4.7": "plan",
    "stealth/space-bunny-alpha": "free",
    "poolside/laguna-s-2.1-free": "free",
    "inclusionai/ling-3.0-flash-sante:free": "free",
    "claude-opus-5-5": "api",
    "gpt-6-astra": "api",
    "meta/muse-spark-1.1": "api",
    "claude-haiku-4-5-20251001": "api",
  };
  for (const [id, modelClass] of Object.entries(expected)) {
    assert.equal(classifyModelId(packaged, id), modelClass, id);
  }
  // Jev is headless/Provider-API only and absent from the interactive catalog.
  assert.equal(classifyModelId(packaged, "typesafe/jev"), undefined);
});

test("rejects duplicates within and across lists, bad types and versions, reporting all errors", () => {
  assert.throws(() => parseModelClassification({ ...valid, api: ["c", "a"] }), /"a" is listed in both "plan" and "api"/);
  assert.throws(() => parseModelClassification({ ...valid, free: ["b", "b"] }), /listed more than once in "free"/);
  assert.throws(() => parseModelClassification({ ...valid, version: 2 }), /"version" must be 1/);
  assert.throws(() => parseModelClassification({ ...valid, plan: "a" }), /"plan" must be an array/);
  assert.throws(() => parseModelClassification({ ...valid, api: [" c"] }), /surrounding whitespace/);
  assert.throws(() => parseModelClassification([]), /JSON object/);
  assert.throws(
    () => parseModelClassification({ version: 1, plan: [1], free: [], api: [""] }),
    (error) => /plan\[0\]/.test(error.message) && /api\[0\]/.test(error.message),
  );
  const { hidden, ...withoutHidden } = valid;
  assert.deepEqual(parseModelClassification({ ...withoutHidden, $comment: "ignored" }).hidden, []);
});

test("reconciliation reports unclassified live IDs and stale classified IDs", () => {
  const report = reconcileModelClassification(valid, ["a", "b", "new-1", "new-2"]);
  assert.deepEqual(report, { unclassified: ["new-1", "new-2"], stale: ["c"] });
  const lines = describeClassificationReport(report, "/x/c.json");
  assert.match(lines[0], /2 live Command Code model\(s\) are unclassified.*new-1, new-2.*\/x\/c\.json/);
  assert.match(lines[1], /1 classified Command Code model\(s\) are not in the live catalog: c/);
  assert.deepEqual(describeClassificationReport({ unclassified: [], stale: [] }, "p"), []);
});

test("missing file is seeded from packaged defaults, then edits are reread", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "nested", "classification.json");
    const first = await loadModelClassification({ path });
    assert.equal(first.source, "seeded");
    assert.match(first.notes[0], /Created .*classification\.json/);
    assert.equal(await readFile(path, "utf-8"), packagedText);
    await writeFile(path, JSON.stringify({ ...valid, plan: ["edited"] }));
    const second = await loadModelClassification({ path });
    assert.equal(second.source, "user");
    assert.deepEqual(second.classification.plan, ["edited"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("malformed file is never overwritten; last good copy, then packaged defaults, are used", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "classification.json");
    await writeFile(path, "{ not json");
    const fresh = await loadModelClassification({ path });
    assert.equal(fresh.source, "packaged");
    assert.match(fresh.warnings[0], /Ignoring .*invalid JSON.*packaged model classification/);
    assert.equal(await readFile(path, "utf-8"), "{ not json");

    await writeFile(path, JSON.stringify({ ...valid, api: ["a"] }));
    const kept = await loadModelClassification({ path, lastGood: valid });
    assert.equal(kept.source, "last-good");
    assert.equal(kept.classification, valid);
    assert.match(kept.warnings[0], /"a" is listed in both "plan" and "api".*Keeping the classification loaded before the edit/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an unwritable location falls back to packaged defaults with a warning", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const dir = await tempDir();
  try {
    const locked = join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o500);
    const result = await loadModelClassification({ path: join(locked, "classification.json") });
    assert.equal(result.source, "packaged");
    assert.match(result.warnings[0], /Could not create/);
    await chmod(locked, 0o700);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
