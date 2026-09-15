import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTerminalHelp } from '../extensions/piastra/help.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'dispatch.mjs');

test('package exposes the Dispatch executable with no new installation lifecycle', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.dispatch, 'bin/dispatch.mjs');
  assert.equal(pkg.private, true, 'release publication is still deferred');
  for (const name of ['preinstall', 'install', 'postinstall']) assert.equal(pkg.scripts[name], undefined);
});

test('help flags and no arguments print the shared overview from any directory without setup or mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-cli-help-'));
  try {
    // Invalid auth proves that help does not initialize provider storage.
    const auth = '{ not credentials or valid JSON';
    writeFileSync(join(dir, 'auth.json'), auth);
    const before = readdirSync(dir);
    for (const args of [[], ['-h'], ['--help']]) {
      const result = spawnSync(process.execPath, [bin, ...args], {
        cwd: dir, encoding: 'utf8',
        env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: '1' },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, formatTerminalHelp() + '\n');
      assert.match(result.stdout, /\/dispatch-help/);
      assert.match(result.stdout, /Shift\+Tab/);
      assert.deepEqual(readdirSync(dir), before, 'help never seeds settings, logs, or sessions');
      assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), auth);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unimplemented setup and launch flags fail clearly, never masquerade as working commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-cli-help-'));
  try {
    for (const args of [['setup'], ['--web'], ['--port', '9000'], ['--unknown'], ['--help', '--web']]) {
      const result = spawnSync(process.execPath, [bin, ...args], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, PI_CODING_AGENT_DIR: dir },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /help only/);
      assert.match(result.stderr, /not available yet/);
      assert.deepEqual(readdirSync(dir), []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
