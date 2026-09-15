import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CHECKS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS,
  buildWindowsSupervisorSpawn, executeCheck, findNpmCli, killTree, loadCatalog,
  resolveExecutable, runChecks, summarizeTap,
} from './checks.mjs';

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeCatalog(dir, checks) {
  await mkdir(path.join(dir, 'config'), { recursive: true });
  await writeFile(path.join(dir, 'config', 'checks.json'), JSON.stringify({ checks }));
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {};
  return child;
}

// --- catalog loading and validation ---

test('missing catalog falls back to the default npm checks', async () => {
  const dir = await tempDir('piastra-checks-default-');
  try {
    const { checks, source } = loadCatalog(dir);
    assert.equal(source, 'default');
    assert.deepEqual([...checks.keys()], ['test', 'test-cli']);
    assert.deepEqual(checks.get('test').command, ['npm', 'test']);
    assert.deepEqual(checks.get('test-cli').command, ['npm', 'run', 'test:cli']);
    assert.deepEqual(DEFAULT_CHECKS.map(c => c.name), ['test', 'test-cli']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('catalog validation rejects duplicate names, bad names and bad commands', async () => {
  const dir = await tempDir('piastra-checks-validate-');
  try {
    await writeCatalog(dir, [
      { name: 'test', command: ['npm', 'test'] },
      { name: 'test', command: ['npm', 'test'] },
    ]);
    assert.throws(() => loadCatalog(dir), /Duplicate check name: test/);

    await writeCatalog(dir, [{ name: '../bad', command: ['npm', 'test'] }]);
    assert.throws(() => loadCatalog(dir), /Invalid check name/);

    await writeCatalog(dir, [{ name: 'test', command: [] }]);
    assert.throws(() => loadCatalog(dir), /nonempty command array/);

    await writeCatalog(dir, [{ name: 'test', command: ['npm', ''] }]);
    assert.throws(() => loadCatalog(dir), /nonempty strings/);

    await writeCatalog(dir, { checks: 'nope' });
    assert.throws(() => loadCatalog(dir), /must define a checks array/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('timeoutMs is validated and bounded to MAX_TIMEOUT_MS', async () => {
  const dir = await tempDir('piastra-checks-timeout-');
  try {
    await writeCatalog(dir, [
      { name: 'short', command: ['npm', 'test'], timeoutMs: 10 },
      { name: 'long', command: ['npm', 'test'], timeoutMs: 999999999 },
      { name: 'default', command: ['npm', 'test'] },
    ]);
    const { checks } = loadCatalog(dir);
    assert.equal(checks.get('short').timeoutMs, 10);
    assert.equal(checks.get('long').timeoutMs, MAX_TIMEOUT_MS);
    assert.equal(checks.get('default').timeoutMs, DEFAULT_TIMEOUT_MS);

    for (const bad of [0, -5, 'abc', null]) {
      await writeCatalog(dir, [{ name: 'bad', command: ['npm', 'test'], timeoutMs: bad }]);
      assert.throws(() => loadCatalog(dir), /timeoutMs/, `should reject timeoutMs=${bad}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// --- executable resolution ---

test('node resolves to process.execPath and npm to a trusted npm-cli.js via node', () => {
  const nodeResolved = resolveExecutable(['node', '--version'], { execPath: '/fake/node.exe' });
  assert.equal(nodeResolved.executable, '/fake/node.exe');
  assert.deepEqual(nodeResolved.args, ['--version']);

  const npmCli = findNpmCli();
  assert.ok(npmCli.endsWith('npm-cli.js'), `expected npm-cli.js, got ${npmCli}`);
  assert.ok(existsSync(npmCli), `npm-cli.js should exist: ${npmCli}`);
  const npmResolved = resolveExecutable(['npm', 'test']);
  assert.equal(npmResolved.executable, process.execPath);
  assert.deepEqual(npmResolved.args, [npmCli, 'test']);
});

test('findNpmCli requires an absolute npm-cli.js and prefers it over search paths', () => {
  const absoluteCli = path.join(os.tmpdir(), 'npm-cli.js');
  const good = {
    statSync: (p) => ({ isFile: () => p === absoluteCli }),
  };
  assert.equal(
    findNpmCli({ env: { npm_execpath: absoluteCli }, execPath: '/node/node.exe', fs: good }),
    absoluteCli,
  );

  // A relative path is never trusted, even when it looks like a script file.
  const relativeGood = {
    statSync: (p) => ({ isFile: () => p === 'node_modules/npm/bin/npm-cli.js' }),
  };
  assert.throws(
    () => findNpmCli({ env: { npm_execpath: 'node_modules/npm/bin/npm-cli.js' }, execPath: '/node/node.exe', fs: relativeGood }),
    /Cannot locate/,
  );

  // Shell wrappers are rejected outright.
  const empty = { statSync: () => { throw new Error('missing'); } };
  assert.throws(
    () => findNpmCli({ env: { npm_execpath: 'C:/npm/npm.cmd' }, execPath: '/node/node.exe', fs: empty }),
    /Cannot locate/,
  );
});

test('findNpmCli falls back to the distro Linux npm-cli.js location', () => {
  const fsImpl = {
    statSync: (p) => ({ isFile: () => p === '/usr/share/nodejs/npm/bin/npm-cli.js' }),
  };
  assert.equal(
    findNpmCli({ env: {}, execPath: '/usr/bin/node', fs: fsImpl }),
    '/usr/share/nodejs/npm/bin/npm-cli.js',
  );
});

test('buildWindowsSupervisorSpawn transports the command as base64 JSON env, never as shell text', () => {
  const sup = buildWindowsSupervisorSpawn({
    executable: 'C:/node/node.exe',
    args: ['-e', 'console.log("a b")'],
    cwd: 'C:/work',
    env: { EXISTING: '1' },
    timeoutMs: 1234,
    powershell: 'C:/powershell.exe',
    ps1Path: 'C:/supervisor.ps1',
    execPath: 'C:/node/node.exe',
  });
  assert.equal(sup.executable, 'C:/powershell.exe');
  assert.deepEqual(sup.args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:/supervisor.ps1']);
  assert.equal(sup.env.EXISTING, '1');
  assert.equal(sup.env.PIASTRA_CHECK_JOB_NODE, 'C:/node/node.exe');
  const decoded = JSON.parse(Buffer.from(sup.env.PIASTRA_CHECK_JOB, 'base64').toString('utf8'));
  assert.deepEqual(decoded, {
    executable: 'C:/node/node.exe',
    args: ['-e', 'console.log("a b")'],
    cwd: 'C:/work',
    timeoutMs: 1234,
  });
  // The command must not leak into the argv that PowerShell would parse.
  const argv = JSON.stringify([sup.executable, ...sup.args]);
  assert.ok(!argv.includes('console.log'));
  assert.ok(!argv.includes('a b'));
});

test('killTree SIGKILLs the process group on POSIX', () => {
  let killed = null;
  const processRef = { kill: (pid, sig) => { killed = [pid, sig]; } };
  killTree({ pid: 42, exitCode: null, signalCode: null, kill: () => {} }, { platform: 'linux', processRef });
  assert.deepEqual(killed, [-42, 'SIGKILL']);
});

test('killTree still kills the process group when the leader has already exited', () => {
  let killed = null;
  const processRef = { kill: (pid, sig) => { killed = [pid, sig]; } };
  killTree({ pid: 42, exitCode: 0, signalCode: null, kill: () => {} }, { platform: 'linux', processRef });
  assert.deepEqual(killed, [-42, 'SIGKILL']);
});

test('killTree on Windows only terminates the direct child (supervisor owns the tree)', () => {
  let directKilled = 0;
  const child = fakeChild();
  child.kill = () => { directKilled++; };
  killTree(child, { platform: 'win32', processRef: process });
  assert.equal(directKilled, 1);
});

// --- TAP summarization ---

test('TAP failures keep diagnostic blocks and nested failures only', () => {
  const output = [
    'TAP version 13',
    '# Subtest: passes',
    'ok 1 - passes',
    '  ---',
    '  duration_ms: 1',
    '  ...',
    '# Subtest: fails with diagnostics',
    'not ok 2 - fails with diagnostics',
    '  ---',
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    1 !== 2',
    '  ...',
    '# Subtest: nested',
    '    # Subtest: inner ok',
    '    ok 1 - inner ok',
    '      ---',
    '      ...',
    '    # Subtest: inner fail',
    '    not ok 2 - inner fail',
    '      ---',
    "      error: 'boom inner'",
    '      ...',
    '    1..2',
    'not ok 3 - nested',
    '  ---',
    "  error: '1 subtest failed'",
    '  ...',
    '1..3',
    '# tests 5',
    '# pass 2',
    '# fail 3',
  ].join('\n');
  const summarized = summarizeTap(output);
  assert.ok(summarized.isTap);
  assert.equal(summarized.fail, 3);
  assert.ok(summarized.summary.includes('fails with diagnostics'));
  assert.ok(summarized.summary.includes('nested > inner fail'));
  assert.ok(summarized.summary.includes('1 !== 2'));
  assert.ok(summarized.summary.includes('boom inner'));
  assert.ok(summarized.summary.includes('not ok 3 - nested'));
  assert.ok(!summarized.summary.includes('ok 1 - passes'));
  assert.ok(!summarized.summary.includes('ok 1 - inner ok'));
});

test('partial TAP is never inferred as an all-pass', () => {
  const summarized = summarizeTap('TAP version 13\nok 1 - fine\n');
  assert.ok(summarized.isTap);
  assert.ok(!summarized.explicitPass);
  assert.ok(!summarized.summary.includes('All tests passed'));
  assert.ok(summarized.summary.includes('partial TAP'));
});

test('an explicit zero-fail summary is an all-pass', () => {
  const summarized = summarizeTap('TAP version 13\nok 1 - fine\n# tests 1\n# pass 1\n# fail 0\n');
  assert.ok(summarized.explicitPass);
  assert.ok(summarized.summary.includes('All tests passed'));
});

test('non-TAP output passes through bounded', () => {
  const summarized = summarizeTap('plain output');
  assert.ok(!summarized.isTap);
  assert.ok(summarized.summary.includes('plain output'));
});

test('TAP treats # TODO and # SKIP directives as non-failures', () => {
  const output = [
    'TAP version 13',
    'ok 1 - skip me # SKIP unsupported',
    'not ok 2 - todo fail # TODO known bug',
    'ok 3 - fine',
    '1..3',
    '# tests 3',
    '# pass 1',
    '# fail 0',
    '# skipped 1',
    '# todo 1',
  ].join('\n');
  const summarized = summarizeTap(output);
  assert.equal(summarized.fail, 0);
  assert.equal(summarized.pass, 1);
  assert.equal(summarized.total, 3);
  assert.ok(summarized.explicitPass);
  assert.ok(summarized.complete);
  assert.ok(summarized.summary.includes('All tests passed'));
  assert.ok(!summarized.summary.includes('todo fail'));
});

test('reported top-level summary counts win over raw point counting', () => {
  const output = [
    'TAP version 13',
    'not ok 1 - parent',
    '  # Subtest: inner',
    '  not ok 1 - inner fail',
    '  ...',
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 1',
  ].join('\n');
  const summarized = summarizeTap(output);
  assert.equal(summarized.fail, 1);
  assert.equal(summarized.pass, 0);
  assert.equal(summarized.total, 1);
  assert.ok(summarized.summary.includes('inner fail'));
});

test('a #fail 0 summary never erases an observed failure', () => {
  const output = [
    'TAP version 13',
    'not ok 1 - boom',
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 0',
  ].join('\n');
  const summarized = summarizeTap(output);
  assert.equal(summarized.fail, 1);
  assert.equal(summarized.failures.length, 1);
  assert.ok(!summarized.explicitPass);
  assert.ok(summarized.summary.includes('boom'));
  assert.ok(!summarized.summary.includes('All tests passed'));
});

test('an explicit plan must agree with the observed points even when the summary claims pass', () => {
  const output = [
    'TAP version 13',
    'ok 1 - fine',
    '1..2',
    '# tests 2',
    '# pass 1',
    '# fail 0',
  ].join('\n');
  const summarized = summarizeTap(output);
  assert.ok(!summarized.complete);
  assert.ok(!summarized.explicitPass);
  assert.ok(!summarized.summary.includes('All tests passed'));
});

test('an explicit plan is also violated by extra observed points', () => {
  const output = [
    'TAP version 13',
    'ok 1 - one',
    'ok 2 - two',
    '1..1',
    '# tests 1',
    '# pass 1',
    '# fail 0',
  ].join('\n');
  const summarized = summarizeTap(output);
  assert.ok(!summarized.complete);
  assert.ok(!summarized.explicitPass);
});

test('a TAP bailout is preserved and never reported as an all-pass', () => {
  const summarized = summarizeTap('TAP version 13\nok 1 - fine\nBail out! disk on fire\n');
  assert.ok(summarized.isTap);
  assert.ok(summarized.bailout);
  assert.equal(summarized.bailoutReason, 'disk on fire');
  assert.ok(!summarized.explicitPass);
  assert.ok(!summarized.complete);
  assert.ok(summarized.summary.includes('Bail out! disk on fire'));
  assert.ok(!summarized.summary.includes('All tests passed'));
});

test('non-TAP stdout diagnostics are preserved inside a TAP stream', () => {
  const summarized = summarizeTap('TAP version 13\nok 1 - fine\nfree-form warning here\n');
  assert.ok(summarized.isTap);
  assert.deepEqual(summarized.unstructured, ['free-form warning here']);
});

// --- lifecycle (injected spawn/kill, no real processes) ---

test('timeout terminates the process and reports timed out', async () => {
  const dir = await tempDir('piastra-checks-timeout-run-');
  try {
    const child = fakeChild();
    let killed = null;
    const kill = (c) => {
      killed = c;
      c.exitCode = null;
      c.signalCode = 'SIGKILL';
      c.emit('close', null, 'SIGKILL');
    };
    const res = await executeCheck(
      { name: 'hang', command: ['node', '-e', 'while(1){}'] },
      { cwd: dir, logDir: dir, spawn: () => child, kill, platform: 'linux', timeoutMs: 1 },
    );
    assert.equal(killed, child);
    assert.equal(res.details.status, 'timeout');
    assert.equal(res.details.timedOut, true);
    assert.ok(res.text.includes('TIMED OUT'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancellation terminates the process and reports cancelled', async () => {
  const dir = await tempDir('piastra-checks-cancel-run-');
  try {
    const child = fakeChild();
    const ac = new AbortController();
    let killed = null;
    const spawn = () => {
      setTimeout(() => ac.abort(), 5);
      return child;
    };
    const kill = (c) => {
      killed = c;
      c.emit('close', null, 'SIGKILL');
    };
    const res = await executeCheck(
      { name: 'hang', command: ['node', '-e', 'while(1){}'] },
      { cwd: dir, logDir: dir, spawn, kill, platform: 'linux', signal: ac.signal },
    );
    assert.equal(killed, child);
    assert.equal(res.details.status, 'cancelled');
    assert.equal(res.details.cancelled, true);
    assert.ok(res.text.includes('CANCELLED'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// --- real execution (node success/failure, npm resolution) ---

test('a Node check succeeds and reports PASSED', async () => {
  const dir = await tempDir('piastra-checks-node-ok-');
  try {
    const res = await executeCheck(
      { name: 'node-ok', command: ['node', '-e', 'console.log("hello from node")'] },
      { cwd: dir, logDir: dir },
    );
    assert.equal(res.details.status, 'passed');
    assert.equal(res.details.exitCode, 0);
    assert.ok(res.text.includes('PASSED (exit 0)'));
    assert.ok(res.text.includes('hello from node'));
    assert.ok(existsSync(res.details.logPath));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a Node check failure keeps its exit code and stderr', async () => {
  const dir = await tempDir('piastra-checks-node-fail-');
  try {
    const res = await executeCheck(
      { name: 'node-fail', command: ['node', '-e', 'console.error("boom"); process.exit(3)'] },
      { cwd: dir, logDir: dir },
    );
    assert.equal(res.details.status, 'failed');
    assert.equal(res.details.exitCode, 3);
    assert.ok(res.text.includes('FAILED (exit 3)'));
    assert.ok(res.text.includes('boom'));
    assert.ok(!res.text.includes('PASSED'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a non-zero exit is never overridden by clean-looking TAP output', async () => {
  const dir = await tempDir('piastra-checks-node-exit-');
  try {
    const res = await executeCheck(
      { name: 'lying-tap', command: ['node', '-e', "console.log('TAP version 13'); console.log('ok 1 - fine'); console.log('# fail 0'); process.exit(1)"] },
      { cwd: dir, logDir: dir },
    );
    assert.equal(res.details.status, 'failed');
    assert.equal(res.details.exitCode, 1);
    assert.ok(res.text.includes('FAILED (exit 1)'));
    assert.ok(!res.text.includes('PASSED'));
    assert.ok(!res.text.includes('All tests passed'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an observed TAP failure is not erased by a #fail 0 summary even with exit 0', async () => {
  const dir = await tempDir('piastra-checks-fail0-');
  try {
    const res = await executeCheck(
      { name: 'fail0', command: ['node', '-e', "console.log('TAP version 13'); console.log('not ok 1 - boom'); console.log('1..1'); console.log('# tests 1'); console.log('# fail 0')"] },
      { cwd: dir, logDir: dir },
    );
    assert.equal(res.details.status, 'failed');
    assert.equal(res.details.exitCode, 0);
    assert.ok(res.text.includes('boom'));
    assert.ok(!res.text.includes('All tests passed'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an explicit plan mismatch is reported failed even with a passing summary and exit 0', async () => {
  const dir = await tempDir('piastra-checks-plan-mismatch-');
  try {
    const res = await executeCheck(
      { name: 'plan-mismatch', command: ['node', '-e', "console.log('TAP version 13'); console.log('ok 1 - fine'); console.log('1..2'); console.log('# tests 2'); console.log('# pass 1'); console.log('# fail 0')"] },
      { cwd: dir, logDir: dir },
    );
    assert.equal(res.details.status, 'failed');
    assert.equal(res.details.exitCode, 0);
    assert.ok(res.text.includes('TAP incomplete or truncated'));
    assert.ok(!res.text.includes('All tests passed'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('npm resolves to the real npm-cli.js and runs via node', async () => {
  const dir = await tempDir('piastra-checks-npm-');
  try {
    const res = await executeCheck(
      { name: 'npm-version', command: ['npm', '--version'] },
      { cwd: dir, logDir: dir },
    );
    assert.equal(res.details.status, 'passed');
    assert.equal(res.details.exitCode, 0);
    assert.match(res.text, /\d+\.\d+\.\d+/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stdout and stderr are bounded and marked truncated', async () => {
  const dir = await tempDir('piastra-checks-bounded-');
  try {
    const res = await executeCheck(
      { name: 'big', command: ['node', '-e', "process.stdout.write('a'.repeat(10000)); process.stderr.write('b'.repeat(10000))"] },
      { cwd: dir, logDir: dir, stdoutCap: 200, stderrCap: 200 },
    );
    assert.equal(res.details.status, 'passed');
    assert.equal(res.details.stdoutTruncated, true);
    assert.equal(res.details.stderrTruncated, true);
    const log = await readFile(res.details.logPath, 'utf8');
    const stdoutSection = log.split('--- stdout ---\n')[1].split('\n--- stderr ---')[0];
    const stderrSection = log.split('--- stderr ---\n')[1].trimEnd();
    assert.ok(stdoutSection.length <= 200);
    assert.ok(stderrSection.length <= 200);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('logs carry unique names and full command/cwd/duration/outcome metadata', async () => {
  const dir = await tempDir('piastra-checks-log-');
  try {
    const check = { name: 'hi', command: ['node', '-e', 'console.log("hi")'] };
    const first = await executeCheck(check, { cwd: dir, logDir: dir });
    const second = await executeCheck(check, { cwd: dir, logDir: dir });
    assert.notEqual(first.details.logPath, second.details.logPath);
    const content = readFileSync(first.details.logPath, 'utf8');
    assert.ok(content.includes('check: hi'));
    assert.ok(content.includes('command: '));
    assert.ok(content.includes(`cwd: ${dir}`));
    assert.ok(content.includes('outcome: passed'));
    assert.ok(content.includes('durationMs: '));
    assert.ok(content.includes(`logPath: ${first.details.logPath}`));
    assert.ok(content.includes('--- stdout ---'));
    assert.ok(content.includes('--- stderr ---'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a clean-looking but incomplete TAP stream is not reported as passed', async () => {
  const dir = await tempDir('piastra-checks-partial-tap-');
  try {
    const res = await executeCheck(
      { name: 'partial-tap', command: ['node', '-e', "console.log('TAP version 13'); console.log('ok 1 - fine')"] },
      { cwd: dir, logDir: dir },
    );
    assert.equal(res.details.status, 'failed');
    assert.ok(res.text.includes('FAILED (TAP incomplete or truncated)'));
    assert.ok(!res.text.includes('PASSED'));
    assert.ok(!res.text.includes('All tests passed'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a TAP bailout with exit 0 is reported failed', async () => {
  const dir = await tempDir('piastra-checks-bailout-');
  try {
    const res = await executeCheck(
      { name: 'bailout', command: ['node', '-e', "console.log('TAP version 13'); console.log('ok 1 - fine'); console.log('Bail out! tests aborted')"] },
      { cwd: dir, logDir: dir },
    );
    assert.equal(res.details.status, 'failed');
    assert.ok(res.text.includes('Bail out! tests aborted'));
    assert.ok(!res.text.includes('All tests passed'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-visible result includes command, cwd, elapsed and truncation notices', async () => {
  const dir = await tempDir('piastra-checks-meta-');
  try {
    const res = await executeCheck(
      { name: 'big', command: ['node', '-e', "process.stdout.write('a'.repeat(10000))"] },
      { cwd: dir, logDir: dir, stdoutCap: 200 },
    );
    assert.equal(res.details.status, 'passed');
    assert.ok(res.text.includes('command: '));
    assert.ok(res.text.includes(`cwd: ${dir}`));
    assert.ok(res.text.includes('elapsed: '));
    assert.ok(res.text.includes('[notice] stdout truncated'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('log write failures surface a notice in the model-visible result', async () => {
  const dir = await tempDir('piastra-checks-logerr-');
  try {
    const res = await executeCheck(
      { name: 'ok', command: ['node', '-e', 'console.log("ok")'] },
      { cwd: dir, logDir: dir, writeLog: async () => { throw new Error('disk full'); } },
    );
    assert.equal(res.details.status, 'passed');
    assert.equal(res.details.logError, 'disk full');
    assert.ok(res.text.includes('[notice] could not write log: disk full'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// --- real subprocess-tree termination (timeout/cancellation) ---

function hangingTreeScript(grandchildPidFile) {
  const grandchild = [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid));`,
    "process.stdout.write('grandchild alive\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  return [
    "const { spawn } = require('child_process');",
    `const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'pipe', 'pipe'] });`,
    'g.stdout.pipe(process.stdout);',
    'g.stderr.pipe(process.stderr);',
    'setInterval(() => {}, 1000);',
  ].join('\n');
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

async function waitForFile(file, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function assertEventuallyDead(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.fail(`pid ${pid} still alive after ${timeoutMs}ms`);
}

test('timeout kills a real child+grandchild tree that holds stdout open', async () => {
  const dir = await tempDir('piastra-checks-real-timeout-tree-');
  try {
    const pidFile = path.join(dir, 'grandchild.pid');
    const res = await executeCheck(
      { name: 'hang-tree', command: ['node', '-e', hangingTreeScript(pidFile)] },
      { cwd: dir, logDir: dir, timeoutMs: 3000 },
    );
    assert.equal(res.details.status, 'timeout');
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    await assertEventuallyDead(pid, 8000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancellation kills a real child+grandchild tree that holds stdout open', async () => {
  const dir = await tempDir('piastra-checks-real-cancel-tree-');
  const ac = new AbortController();
  const pidFile = path.join(dir, 'grandchild.pid');
  try {
    const resPromise = executeCheck(
      { name: 'hang-tree', command: ['node', '-e', hangingTreeScript(pidFile)] },
      { cwd: dir, logDir: dir, timeoutMs: 60000, signal: ac.signal },
    );
    await waitForFile(pidFile, 8000);
    ac.abort();
    const res = await resPromise;
    assert.equal(res.details.status, 'cancelled');
    assert.equal(res.details.cancelled, true);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    await assertEventuallyDead(pid, 8000);
  } finally {
    ac.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Windows job-object supervisor (real orphaned descendants) ---

function orphanLeaderScript(grandchildPidFile) {
  // The leader spawns a grandchild that keeps running, then exits normally,
  // orphaning the grandchild. Only the job object can reap it afterward.
  const grandchild = [
    "const fs = require('fs');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  return [
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    `const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(g.pid));`,
    "process.stdout.write('leader done\\n');",
    'process.exit(0);',
  ].join('\n');
}

test('Windows supervisor kills an orphaned grandchild after the leader exits normally', { skip: process.platform !== 'win32' }, async () => {
  const dir = await tempDir('piastra-checks-win-orphan-');
  try {
    const pidFile = path.join(dir, 'grandchild.pid');
    const res = await executeCheck(
      { name: 'orphan', command: ['node', '-e', orphanLeaderScript(pidFile)] },
      { cwd: dir, logDir: dir },
    );
    assert.equal(res.details.status, 'passed');
    assert.equal(res.details.exitCode, 0);
    assert.ok(res.text.includes('leader done'));
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    await assertEventuallyDead(pid, 8000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Windows supervisor kills a hanging tree on timeout', { skip: process.platform !== 'win32' }, async () => {
  const dir = await tempDir('piastra-checks-win-timeout-');
  try {
    const pidFile = path.join(dir, 'grandchild.pid');
    const res = await executeCheck(
      { name: 'hang-tree', command: ['node', '-e', hangingTreeScript(pidFile)] },
      { cwd: dir, logDir: dir, timeoutMs: 3000 },
    );
    assert.equal(res.details.status, 'timeout');
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    await assertEventuallyDead(pid, 8000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Windows supervisor kills a hanging tree on cancellation', { skip: process.platform !== 'win32' }, async () => {
  const dir = await tempDir('piastra-checks-win-cancel-');
  const ac = new AbortController();
  const pidFile = path.join(dir, 'grandchild.pid');
  try {
    const resPromise = executeCheck(
      { name: 'hang-tree', command: ['node', '-e', hangingTreeScript(pidFile)] },
      { cwd: dir, logDir: dir, timeoutMs: 60000, signal: ac.signal },
    );
    await waitForFile(pidFile, 8000);
    ac.abort();
    const res = await resPromise;
    assert.equal(res.details.status, 'cancelled');
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    await assertEventuallyDead(pid, 8000);
  } finally {
    ac.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- runChecks top-level interface ---

test('untrusted workspaces fail closed without reading the catalog or executing', async () => {
  const dir = await tempDir('piastra-checks-untrusted-');
  try {
    const sentinel = path.join(dir, 'sentinel.txt');
    await writeCatalog(dir, [{ name: 'boom', command: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x')`] }]);
    await assert.rejects(
      runChecks({ name: 'boom' }, { cwd: dir, trusted: false, logDir: dir }, undefined),
      /trusted/i,
    );
    assert.ok(!existsSync(sentinel));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('listing the catalog never executes checks', async () => {
  const dir = await tempDir('piastra-checks-list-');
  try {
    const sentinel = path.join(dir, 'sentinel.txt');
    await writeCatalog(dir, [
      { name: 'boom', description: 'Writes a sentinel.', command: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x')`] },
    ]);
    const { text, details } = await runChecks({}, { cwd: dir, trusted: true, logDir: dir }, undefined);
    assert.equal(details.executed, false);
    assert.deepEqual(details.listed, ['boom']);
    assert.ok(text.includes('boom') && text.includes('Writes a sentinel.'));
    assert.ok(!existsSync(sentinel));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unknown names are rejected without option injection', async () => {
  const dir = await tempDir('piastra-checks-unknown-');
  try {
    await writeCatalog(dir, [{ name: 'test', command: ['node', '-e', '0'] }]);
    await assert.rejects(
      runChecks({ name: '--help' }, { cwd: dir, trusted: true, logDir: dir }, undefined),
      /Unknown check: --help\. Available: test/,
    );
    await assert.rejects(
      runChecks({ name: 'test; rm -rf /' }, { cwd: dir, trusted: true, logDir: dir }, undefined),
      /Unknown check/,
    );
    await assert.rejects(
      runChecks({ name: '' }, { cwd: dir, trusted: true, logDir: dir }, undefined),
      /nonempty string/,
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runChecks executes a catalog entry end to end', async () => {
  const dir = await tempDir('piastra-checks-e2e-');
  try {
    await writeCatalog(dir, [{ name: 'hi', command: ['node', '-e', 'console.log("hi from catalog")'] }]);
    const res = await runChecks({ name: 'hi' }, { cwd: dir, trusted: true, logDir: dir }, undefined);
    assert.equal(res.details.status, 'passed');
    assert.ok(res.text.includes('PASSED (exit 0)'));
    assert.ok(res.text.includes('hi from catalog'));
    assert.ok(existsSync(res.details.logPath));
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('nested failures cannot be erased by passing parents or contradictory summary counts', async () => {
  const tap = `TAP version 13
# Subtest: parent
    not ok 1 - broken
    1..1
ok 1 - parent
1..1
# fail 0
`;
  assert.equal(summarizeTap(tap).fail, 1);
  const dir = await tempDir('piastra-checks-nested-');
  try {
    const result = await executeCheck({ name: 'nested', command: ['node', '-e', `process.stdout.write(${JSON.stringify(tap)})`] }, {cwd:dir, logDir:dir});
    assert.equal(result.details.status, 'failed');
    assert.match(result.text, /broken/);
    assert.doesNotMatch(result.text, /All tests passed/);
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test('enclosing TODO or SKIP still suppresses expected nested failures', () => {
  for (const directive of ['TODO', 'SKIP']) {
    const tap = `TAP version 13
# Subtest: parent
    not ok 1 - expected
    1..1
not ok 1 - parent # ${directive} later
1..1
# fail 0
`;
    const result = summarizeTap(tap);
    assert.equal(result.fail, 0);
    assert.equal(result.failures.length, 0);
  }
});

test('indented #fail/#tests summaries never establish whole-run completion', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: parent',
    '    ok 1 - child',
    '    1..2',
    '    # fail 0',
  ].join('\n');
  const summarized = summarizeTap(tap);
  assert.ok(summarized.isTap);
  assert.equal(summarized.complete, false);
  assert.equal(summarized.explicitPass, false);
  assert.ok(!summarized.summary.includes('All tests passed'));
  assert.ok(summarized.summary.includes('partial TAP'));
});

test('a truncated nested plan invalidates an otherwise consistent top-level plan', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: parent',
    '    ok 1 - child',
    '    1..2',
    'ok 1 - parent',
    '1..1',
    '# fail 0',
  ].join('\n');
  const summarized = summarizeTap(tap);
  assert.equal(summarized.complete, false);
  assert.equal(summarized.explicitPass, false);
  assert.ok(!summarized.summary.includes('All tests passed'));
});

test('a valid nested node-style suite with a matching nested plan still passes', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: parent',
    '    ok 1 - child',
    '    1..1',
    'ok 1 - parent',
    '1..1',
    '# tests 2',
    '# pass 2',
    '# fail 0',
  ].join('\n');
  const summarized = summarizeTap(tap);
  assert.equal(summarized.complete, true);
  assert.equal(summarized.explicitPass, true);
  assert.equal(summarized.fail, 0);
  assert.equal(summarized.pass, 2);
  assert.equal(summarized.total, 2);
  assert.ok(summarized.summary.includes('All tests passed'));
});

test('sibling subtests sharing one nested plan stay complete (node suite shape)', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: parent',
    '    # Subtest: c1',
    '    ok 1 - c1',
    '    # Subtest: c2',
    '    ok 2 - c2',
    '    1..2',
    'ok 1 - parent',
    '1..1',
    '# tests 3',
    '# pass 3',
    '# fail 0',
  ].join('\n');
  const summarized = summarizeTap(tap);
  assert.equal(summarized.complete, true);
  assert.equal(summarized.explicitPass, true);
  assert.equal(summarized.fail, 0);
});

test('a missing parent and truncated nested plan is reported failed at execution even with exit 0', async () => {
  const dir = await tempDir('piastra-checks-nested-partial-');
  try {
    const tap = [
      'TAP version 13',
      '# Subtest: parent',
      '    ok 1 - child',
      '    1..2',
      '    # fail 0',
    ].join('\n');
    const res = await executeCheck(
      { name: 'nested-partial', command: ['node', '-e', `process.stdout.write(${JSON.stringify(tap)})`] },
      { cwd: dir, logDir: dir },
    );
    assert.equal(res.details.status, 'failed');
    assert.equal(res.details.exitCode, 0);
    assert.ok(res.text.includes('TAP incomplete or truncated'));
    assert.ok(!res.text.includes('PASSED'));
    assert.ok(!res.text.includes('All tests passed'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('valid nested plan-first TAP does not regress while incomplete scopes fail', () => {
  const tap = `TAP version 13
# Subtest: parent
    1..2
    ok 1 - first
    ok 2 - second
ok 1 - parent
1..1
`;
  assert.equal(summarizeTap(tap).complete, true);
  assert.equal(summarizeTap(tap.replace('    ok 2 - second\n', '')).complete, false);
});

test('headerless sibling TAP scopes close at enclosing results for both plan orders', () => {
  for (const planFirst of [false, true]) {
    const child = name => planFirst ? `    1..1\n    ok 1 - child ${name}\n` : `    ok 1 - child ${name}\n    1..1\n`;
    const tap = `TAP version 13\n${child('A')}ok 1 - parent A\n${child('B')}ok 2 - parent B\n1..2\n`;
    assert.equal(summarizeTap(tap).explicitPass, true);
    assert.equal(summarizeTap(tap.replace('    ok 1 - child A\n', '')).complete, false);
  }
});

test('a valid nested node-style suite passes end to end', async () => {
  const dir = await tempDir('piastra-checks-nested-valid-');
  try {
    const tap = [
      'TAP version 13',
      '# Subtest: parent',
      '    ok 1 - child',
      '    1..1',
      'ok 1 - parent',
      '1..1',
      '# tests 2',
      '# pass 2',
      '# fail 0',
    ].join('\n');
    const res = await executeCheck(
      { name: 'nested-valid', command: ['node', '-e', `process.stdout.write(${JSON.stringify(tap)})`] },
      { cwd: dir, logDir: dir },
    );
    assert.equal(res.details.status, 'passed');
    assert.equal(res.details.exitCode, 0);
    assert.ok(res.text.includes('PASSED (exit 0)'));
    assert.ok(res.text.includes('All tests passed'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
