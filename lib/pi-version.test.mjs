import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PI_PINNED_VERSION } from './pi-install.mjs';
import { RUNTIME_DEPS } from '../scripts/build-release.mjs';

// Guards Pi upgrades: every pin must move together, and the copies that
// extensions resolve must be the same ones the Pi runtime itself uses.
const PI_PACKAGES = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
];
const readJson = url => JSON.parse(readFileSync(url, 'utf8'));
const root = new URL('../', import.meta.url);

test('root manifest and lockfile pin every Pi package to PI_PINNED_VERSION', () => {
  const manifest = readJson(new URL('package.json', root));
  const lock = readJson(new URL('package-lock.json', root));
  for (const name of PI_PACKAGES) {
    assert.equal(manifest.dependencies[name], PI_PINNED_VERSION, `package.json ${name}`);
    assert.equal(lock.packages[''].dependencies[name], PI_PINNED_VERSION, `package-lock.json root ${name}`);
    assert.equal(lock.packages[`node_modules/${name}`].version, PI_PINNED_VERSION, `package-lock.json hoisted ${name}`);
    assert.equal(RUNTIME_DEPS[name], PI_PINNED_VERSION, `release RUNTIME_DEPS ${name}`);
  }
});

test('installed Pi packages resolve to PI_PINNED_VERSION', () => {
  for (const name of PI_PACKAGES) {
    const entry = new URL(import.meta.resolve(name));
    let dir = new URL('./', entry);
    while (!dir.pathname.endsWith(`/${name}/`)) dir = new URL('../', dir);
    assert.equal(readJson(new URL('package.json', dir)).version, PI_PINNED_VERSION, `installed ${name}; run npm ci`);
  }
});
