import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { RUNTIME_DEPS, MANAGED_ENTRIES, MANAGED_TREES } from '../scripts/build-release.mjs';
import { managedExtensionPaths } from './state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = 'extensions/pi-commandcode/index.ts';

test('Command Code is pinned and included in managed runtime and release extensions', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['pi-commandcode-provider'], '0.7.1');
  assert.equal(RUNTIME_DEPS['pi-commandcode-provider'], '0.7.1');
  assert.ok(MANAGED_ENTRIES.includes(entry));
  assert.ok(MANAGED_TREES.includes('extensions/pi-commandcode'));
  assert.ok(managedExtensionPaths(root).includes(join(root, entry)));
});

test('bundled Command Code provider loads through Pi offline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-commandcode-'));
  const previousCache = process.env.COMMANDCODE_MODELS_CACHE;
  const previousFetch = globalThis.fetch;
  process.env.COMMANDCODE_MODELS_CACHE = join(dir, 'models.json');
  globalThis.fetch = async () => { throw new Error('Offline test: network disabled'); };
  try {
    const result = await loadExtensions([join(root, entry)], root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.ok(result.extensions[0].commands.has('commandcode-status'));
    assert.ok(result.extensions[0].commands.has('commandcode-quota'));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCache === undefined) delete process.env.COMMANDCODE_MODELS_CACHE;
    else process.env.COMMANDCODE_MODELS_CACHE = previousCache;
    await rm(dir, { recursive: true, force: true });
  }
});
