import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  parseMainPort,
  parseForkPortEnv,
  parseTrialPort,
  parseTauPort,
  resolveForkDir,
  DEFAULT_FORK_SIBLING,
} from './env.mjs';
import { parseForkPort, resolveForkRoot } from './start-fork.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('defaults when neither new nor legacy is set', () => {
  assert.equal(parseMainPort({}), 8787);
  assert.equal(parseForkPortEnv({}), 8790);
  assert.equal(parseTrialPort({}), 30141);
  assert.equal(parseTauPort({}), 3001);
  assert.equal(resolveForkDir('/root', {}), resolve('/root', DEFAULT_FORK_SIBLING));
  assert.equal(DEFAULT_FORK_SIBLING, join('..', 'PiAstra-web-ui'));
});

test('legacy-only values are honored', () => {
  assert.equal(parseMainPort({ PIASTRA_PORT: '8001' }), 8001);
  assert.equal(parseForkPortEnv({ PIASTRA_FORK_PORT: '8002' }), 8002);
  assert.equal(parseTrialPort({ PIASTRA_TRIAL_PORT: '8003' }), 8003);
  assert.equal(parseTauPort({ PIASTRA_TAU_PORT: '8004' }), 8004);
  assert.equal(resolveForkDir('/root', { PIASTRA_FORK_DIR: '/legacy/fork' }), resolve('/legacy/fork'));
});

test('preferred DISPATCH_* wins over legacy aliases', () => {
  assert.equal(parseMainPort({ DISPATCH_PORT: '9001', PIASTRA_PORT: '8001' }), 9001);
  assert.equal(parseForkPortEnv({ DISPATCH_FORK_PORT: '9002', PIASTRA_FORK_PORT: '8002' }), 9002);
  assert.equal(parseTrialPort({ DISPATCH_TRIAL_PORT: '9003', PIASTRA_TRIAL_PORT: '8003' }), 9003);
  assert.equal(parseTauPort({ DISPATCH_TAU_PORT: '9004', PIASTRA_TAU_PORT: '8004' }), 9004);
  assert.equal(
    resolveForkDir('/root', { DISPATCH_FORK_DIR: '/new/fork', PIASTRA_FORK_DIR: '/legacy/fork' }),
    resolve('/new/fork'),
  );
});

test('empty string counts as unset for both names', () => {
  assert.equal(parseMainPort({ DISPATCH_PORT: '', PIASTRA_PORT: '8001' }), 8001);
  assert.equal(parseMainPort({ DISPATCH_PORT: '', PIASTRA_PORT: '' }), 8787);
  assert.equal(parseForkPortEnv({ DISPATCH_FORK_PORT: '', PIASTRA_FORK_PORT: '' }), 8790);
  assert.equal(resolveForkDir('/root', { DISPATCH_FORK_DIR: '', PIASTRA_FORK_DIR: '/legacy' }), resolve('/legacy'));
  assert.equal(resolveForkDir('/root', { DISPATCH_FORK_DIR: '', PIASTRA_FORK_DIR: '' }), resolve('/root', DEFAULT_FORK_SIBLING));
});

test('explicit invalid preferred value throws for the new name and never falls back to legacy', () => {
  for (const [fn, next, legacy] of [
    [parseMainPort, 'DISPATCH_PORT', 'PIASTRA_PORT'],
    [parseForkPortEnv, 'DISPATCH_FORK_PORT', 'PIASTRA_FORK_PORT'],
    [parseTrialPort, 'DISPATCH_TRIAL_PORT', 'PIASTRA_TRIAL_PORT'],
    [parseTauPort, 'DISPATCH_TAU_PORT', 'PIASTRA_TAU_PORT'],
  ]) {
    for (const bad of ['0', '70000', 'abc', '12.5']) {
      assert.throws(() => fn({ [next]: bad, [legacy]: '8000' }), new RegExp(`Invalid ${next}`));
    }
  }
});

test('invalid legacy value throws for the legacy name', () => {
  assert.throws(() => parseMainPort({ PIASTRA_PORT: 'nope' }), /Invalid PIASTRA_PORT/);
  assert.throws(() => parseForkPortEnv({ PIASTRA_FORK_PORT: '0' }), /Invalid PIASTRA_FORK_PORT/);
});

test('helpers do not mutate the passed env object', () => {
  const env = { DISPATCH_PORT: '9001', PIASTRA_PORT: '8001' };
  const snapshot = { ...env };
  parseMainPort(env);
  resolveForkDir('/root', env);
  assert.deepEqual(env, snapshot);
});

test('start-fork wrappers honor the same precedence', () => {
  assert.equal(parseForkPort({ DISPATCH_FORK_PORT: '9100', PIASTRA_FORK_PORT: '8002' }), 9100);
  assert.equal(parseForkPort({ PIASTRA_FORK_PORT: '8002' }), 8002);
  assert.throws(() => parseForkPort({ DISPATCH_FORK_PORT: 'bad', PIASTRA_FORK_PORT: '8002' }), /Invalid DISPATCH_FORK_PORT/);
  // resolveForkRoot prefers the new dir when both are set.
  const base = mkdtempSync(join(tmpdir(), 'dispatch-env-fork-'));
  try {
    for (const dir of ['new-fork', 'legacy-fork']) {
      const fork = join(base, dir);
      mkdirSync(join(fork, 'dist', 'server'), { recursive: true });
      mkdirSync(join(fork, 'web', 'dist'), { recursive: true });
      writeFileSync(join(fork, 'package.json'), '{}');
      writeFileSync(join(fork, 'dist', 'server', 'index.js'), '');
      writeFileSync(join(fork, 'web', 'dist', 'index.html'), '');
    }
    const picked = resolveForkRoot('/root', { DISPATCH_FORK_DIR: join(base, 'new-fork'), PIASTRA_FORK_DIR: join(base, 'legacy-fork') });
    assert.equal(picked, join(base, 'new-fork'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
