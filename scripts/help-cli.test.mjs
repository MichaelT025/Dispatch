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
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const run = (dir, args) => spawnSync(process.execPath, [bin, ...args], {
  cwd: dir, encoding: 'utf8', timeout: 15_000,
  env: { ...process.env, DISPATCH_HOME: dir, PI_CODING_AGENT_DIR: join(dir, 'untouched-pi'), PI_OFFLINE: '1' },
});

test('package exposes Dispatch while publication remains disabled', () => {
  assert.equal(pkg.bin.dispatch, 'bin/dispatch.mjs');
  assert.equal(pkg.private, true);
  for (const name of ['preinstall', 'install', 'postinstall']) assert.equal(pkg.scripts[name], undefined);
});

test('help and version work without setup, credentials, or any state mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-cli-help-'));
  try {
    const auth = '{ not credentials or valid JSON';
    writeFileSync(join(dir, 'auth.json'), auth);
    const before = readdirSync(dir);
    for (const args of [['-h'], ['--help'], ['setup', '--help'], ['--web', '--help'], ['--version']]) {
      const result = run(dir, args);
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, args[0] === '--version' ? `${pkg.version}\n` : formatTerminalHelp() + '\n');
      assert.deepEqual(readdirSync(dir), before);
      assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), auth);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unconfigured launch requests explicit setup and invalid commands never run onboarding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-cli-unconfigured-'));
  try {
    for (const args of [[], ['--web'], ['--web', '--port', '9000', '--no-open']]) {
      const result = run(dir, args);
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Run dispatch setup/);
      assert.deepEqual(readdirSync(dir), []);
    }
    for (const args of [['--port', '9000'], ['--web', '--host', '0.0.0.0'], ['setup', '--unknown']]) {
      const result = run(dir, args);
      assert.ifError(result.error);
      assert.equal(result.status, 2);
      assert.deepEqual(readdirSync(dir), []);
    }
    const setup = run(dir, ['setup']);
    assert.equal(setup.status, 2);
    assert.match(setup.stderr, /interactive terminal/);
    assert.deepEqual(readdirSync(dir), [], 'non-TTY setup never starts authentication or installation');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
