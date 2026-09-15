/** PiAstra allowlisted checks subsystem.
 *
 * Security model
 * --------------
 * Checks are arbitrary trusted code owned by the repository in
 * `cwd/config/checks.json` and are only ever executed when the caller marks
 * the workspace trusted (`trusted: true`). Untrusted workspaces fail closed:
 * the catalog is not read and nothing runs. The model supplies only a check
 * `name`; it can never supply arguments, a cwd, environment variables or a
 * shell. The resolved command is executed with `shell: false` from the
 * workspace cwd, so option injection from the model is impossible.
 *
 * Catalog (`cwd/config/checks.json`)
 * ----------------------------------
 *   { "checks": [ { "name": "...", "description": "...", "command": ["executable", ...args], "timeoutMs": 12345 } ] }
 *
 *   - `name` is a safe identifier (letters/digits/dash/underscore, max 64).
 *   - `command` is a nonempty array of nonempty strings. `command[0]` may be
 *     `node`, `npm` (both resolved below) or any trusted executable token.
 *   - `timeoutMs` is optional, positive, and bounded to [1ms, MAX_TIMEOUT_MS].
 *   - `description` is optional.
 *
 * Defaults: when `config/checks.json` is missing in a trusted workspace, the
 * catalog falls back to `npm test` (name `test`) and `npm run test:cli`
 * (name `test-cli`) so a fresh checkout still has working checks.
 *
 * Executable resolution
 * ---------------------
 * `node` resolves to `process.execPath`. `npm` resolves to a trusted
 * `npm-cli.js` (first `process.env.npm_execpath` when it is a real script
 * file rather than a shell wrapper such as npm.cmd/npm.ps1, otherwise relative
 * to the Node installation) and is executed via `node <npm-cli.js> <args>`.
 * This is cross-platform and never goes through a shell or npm.cmd.
 *
 * Lifecycle
 * ---------
 * Each run is bounded by `timeoutMs` (default DEFAULT_TIMEOUT_MS = 180s).
 * Cancellation (AbortSignal) and timeout terminate the whole subprocess tree.
 * On Windows every check runs under a fixed PowerShell supervisor
 * (`windows-check-job.ps1`) that assigns itself to a Windows Job Object with
 * KILL_ON_JOB_CLOSE before launching the command, so every descendant — even
 * orphans whose launcher has already exited — is killed when the job closes.
 * The supervisor is not a general-purpose shell: the resolved command travels
 * as base64 JSON in environment variables and is never interpolated into a
 * shell command line. On POSIX the detached process group is SIGKILLed.
 * Bounded stdout/stderr are captured, and a full bounded log is written to
 * `logDir` with a unique name so the read tool can inspect evidence. The
 * result `details` include the resolved command, cwd, duration, outcome
 * (status/exit code/signal/timedOut/cancelled) and the log path.
 *
 * Output
 * ------
 * TAP output is summarized to failures only, including indented diagnostic
 * blocks and nested subtest failures; reported top-level summary counts are
 * preferred, and `# TODO`/`# SKIP` points are not failures. A run is reported
 * FAILED whenever the process exits non-zero or is signalled, and a non-zero
 * exit is never overridden by clean-looking TAP. Partial, incomplete or
 * truncated TAP and `Bail out!` are never treated as an all-pass. stderr,
 * bailout lines and bounded non-TAP stdout diagnostics are always retained.
 * The model-visible `text` also carries the resolved command, cwd, elapsed
 * time, and notices for truncation or log-write failures.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TIMEOUT_MS = 180000;
export const MAX_TIMEOUT_MS = 600000;
export const STDOUT_CAP = 4 * 1024 * 1024;
export const STDERR_CAP = 4 * 1024 * 1024;
const GRACE_MS = 5000;
const TEXT_CAP = 20000;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SUPERVISOR_PS1 = fileURLToPath(new URL('./windows-check-job.ps1', import.meta.url));

/** Fallback catalog used when config/checks.json is missing in a trusted
 *  workspace. Documented as part of this module's contract. */
export const DEFAULT_CHECKS = [
  { name: 'test', description: 'Run the default npm test suite.', command: ['npm', 'test'] },
  { name: 'test-cli', description: 'Run the CLI-focused test subset.', command: ['npm', 'run', 'test:cli'] },
];

/**
 * Run allowlisted checks.
 *
 * @param {{ name?: string }} input  Omit `name` to list the catalog without
 *   executing anything.
 * @param {{ cwd: string, trusted?: boolean, logDir?: string }} opts
 *   `trusted` must be strictly `true` for any execution (fail closed).
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ text: string, details: object }>}
 */
export async function runChecks(input = {}, opts = {}, signal) {
  const { name } = input ?? {};
  const { cwd, trusted, logDir } = opts ?? {};
  if (typeof cwd !== 'string' || !cwd) throw new Error('cwd is required.');
  if (name !== undefined && name !== null && (typeof name !== 'string' || name.length === 0)) {
    throw new Error('name must be a nonempty string.');
  }
  if (trusted !== true) {
    throw new Error('Allowlisted checks only run in trusted workspaces; execution is disabled for untrusted workspaces.');
  }
  const { checks, source } = loadCatalog(cwd);
  if (name === undefined || name === null) {
    const listed = [...checks.keys()];
    const lines = listed.map(n => {
      const check = checks.get(n);
      return `- ${n}${check.description ? `: ${check.description}` : ''}`;
    });
    const text = [
      `Available checks (${source === 'default' ? 'default: no config/checks.json found' : 'config/checks.json'}):`,
      ...(lines.length ? lines : ['(none)']),
    ].join('\n');
    return { text, details: { listed, source, count: listed.length, executed: false } };
  }
  if (!checks.has(name)) {
    const available = [...checks.keys()].join(', ') || '(none)';
    throw new Error(`Unknown check: ${name}. Available: ${available}.`);
  }
  return executeCheck(checks.get(name), { cwd, logDir, signal });
}

/** Load and validate the check catalog. Falls back to DEFAULT_CHECKS when
 *  config/checks.json is missing. Throws on malformed JSON, an invalid
 *  `checks` shape, duplicate names, bad names/commands or bad timeoutMs. */
export function loadCatalog(cwd, { fs: fsImpl = { readFileSync } } = {}) {
  const file = path.join(cwd, 'config', 'checks.json');
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        source: 'default',
        checks: new Map(DEFAULT_CHECKS.map(c => [c.name, { ...c, command: [...c.command], timeoutMs: DEFAULT_TIMEOUT_MS }])),
      };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`config/checks.json is not valid JSON: ${error.message}`);
  }
  if (!parsed || !Array.isArray(parsed.checks)) throw new Error('config/checks.json must define a checks array.');
  const checks = new Map();
  parsed.checks.forEach((entry, index) => {
    validateCheckEntry(entry, index);
    if (checks.has(entry.name)) throw new Error(`Duplicate check name: ${entry.name}.`);
    checks.set(entry.name, normalizeCheck(entry));
  });
  return { source: 'catalog', checks };
}

function validateCheckEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`config/checks.json entry ${index} must be an object.`);
  }
  if (typeof entry.name !== 'string' || !SAFE_NAME_RE.test(entry.name)) {
    throw new Error(`Invalid check name in config/checks.json: ${JSON.stringify(entry.name)}. Use letters, numbers, dash or underscore (max 64).`);
  }
  if (!Array.isArray(entry.command) || entry.command.length === 0) {
    throw new Error(`Check ${entry.name} must define a nonempty command array.`);
  }
  if (entry.command.some(a => typeof a !== 'string' || a.length === 0)) {
    throw new Error(`Check ${entry.name} command must be an array of nonempty strings.`);
  }
  if (entry.description !== undefined && typeof entry.description !== 'string') {
    throw new Error(`Check ${entry.name} description must be a string.`);
  }
  if (entry.timeoutMs !== undefined && (typeof entry.timeoutMs !== 'number' || !Number.isFinite(entry.timeoutMs) || entry.timeoutMs <= 0)) {
    throw new Error(`Check ${entry.name} timeoutMs must be a positive number.`);
  }
}

function normalizeCheck(entry) {
  const rawTimeout = entry.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : entry.timeoutMs;
  return {
    name: entry.name,
    description: entry.description || '',
    command: entry.command.map(String),
    timeoutMs: Math.max(1, Math.min(Math.floor(rawTimeout), MAX_TIMEOUT_MS)),
  };
}

/** Locate a trusted npm-cli.js. Prefers a script-like npm_execpath, then the
 *  npm bundled with the Node installation. Never returns a shell wrapper. */
export function findNpmCli({ env = process.env, execPath = process.execPath, fs: fsImpl = { statSync } } = {}) {
  const fromEnv = env?.npm_execpath;
  if (isAbsoluteNpmCli(fromEnv) && isFile(fsImpl, fromEnv)) return fromEnv;
  const nodeDir = path.dirname(execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/share/nodejs/npm/bin/npm-cli.js',
  ];
  for (const candidate of candidates) {
    if (isFile(fsImpl, candidate)) return candidate;
  }
  throw new Error('Cannot locate a trusted npm-cli.js. Set npm_execpath to the absolute npm-cli.js file (not npm.cmd) or reinstall Node/npm.');
}

function isAbsoluteNpmCli(p) {
  return typeof p === 'string' && path.isAbsolute(p) && path.basename(p) === 'npm-cli.js';
}

function isFile(fsImpl, p) {
  try {
    return !!p && fsImpl.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve a catalog command to a concrete executable + argv. `node` maps to
 *  process.execPath; `npm` maps to `node <npm-cli.js>`. Never a shell. */
export function resolveExecutable(command, { execPath = process.execPath, env = process.env, findNpm = findNpmCli } = {}) {
  const [head, ...rest] = command;
  if (head === 'node') return { executable: execPath, args: [...rest] };
  if (head === 'npm') {
    const cli = findNpm({ env, execPath });
    return { executable: execPath, args: [cli, ...rest] };
  }
  return { executable: head, args: [...rest] };
}

/** Build the PowerShell supervisor spawn for a Windows check. The resolved
 *  command is transported as base64 JSON in environment variables (never as
 *  interpolated shell text); the fixed `windows-check-job.ps1` assigns a waiting
 *  Node command runner to a Job Object before allowing it to spawn the
 *  target from that JSON. */
export function buildWindowsSupervisorSpawn({ executable, args, cwd, env, timeoutMs, powershell = 'powershell.exe', ps1Path = SUPERVISOR_PS1, execPath = process.execPath }) {
  const payload = Buffer.from(JSON.stringify({ executable, args, cwd, timeoutMs }), 'utf8').toString('base64');
  return {
    executable: powershell,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
    env: {
      ...env,
      PIASTRA_CHECK_JOB: payload,
      PIASTRA_CHECK_JOB_NODE: execPath,
    },
  };
}

/** Whole-run completion is decided from top-level signals only. Nested
 *  `# tests`/`# fail` summaries are fallback display counts, never proof that
 *  the run finished; a nested plan that does not match its observed points also
 *  means the run is incomplete. */
function isTapComplete({ planTotal, topLevelPoints, topSummaryTests, topSummaryFail, nestedPlanMismatch }) {
  if (nestedPlanMismatch) return false;
  if (planTotal !== null) return topLevelPoints === planTotal;
  return topSummaryTests !== null || topSummaryFail !== null;
}

/** Summarize TAP output to failures only, keeping indented diagnostic blocks
 *  and nested subtest failures. Reported top-level summary counts are preferred
 *  over raw point counting; `# TODO`/`# SKIP` points are never failures, and a
 *  partial/truncated TAP stream or a bailout is never reported as an all-pass. */
export function summarizeTap(output, { maxFailures = 20, maxSummaryChars = 12000 } = {}) {
  const text = String(output ?? '');
  const lines = text.split(/\r?\n/);
  const testPointRe = /^(\s*)(ok|not ok)\s+(\d+)\s*(?:-\s*((?:(?!#\s*(?:SKIP|TODO)\b).)*))?\s*(?:#\s*(SKIP|TODO)\b.*)?$/i;
  const planRe = /^(\s*)1\.\.(\d+)\s*$/;
  const countRe = /^(\s*)#\s*(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/i;
  const failedOfRe = /^(\s*)#\s*failed\s+(\d+)\s+of\s+(\d+)\s*$/i;
  const bailoutRe = /^\s*Bail out!\s*(.*)$/i;
  const subtestRe = /^(\s*)#\s*Subtest:\s*(.*)$/i;
  const versionRe = /^TAP version \d+/i;
  const yamlMarkerRe = /^\s*(---|\.\.\.)\s*$/;

  let sawTap = false;
  let bailout = false;
  let bailoutReason = null;
  let rawPass = 0;
  let topLevelPoints = 0;
  let topLevelFail = 0;
  let planTotal = null;
  let summaryFail = null;
  let summaryPass = null;
  let summaryTests = null;
  let topSummaryFail = null;
  let topSummaryTests = null;
  let nestedPlanMismatch = false;
  const nestedPoints = new Map(); // indent -> observed points at that nested level
  const nestedPlans = new Map(); // validate at scope close, supporting plan-first TAP too
  const finishNestedScope = indent => {
    if (nestedPlans.has(indent) && (nestedPoints.get(indent) ?? 0) !== nestedPlans.get(indent)) nestedPlanMismatch = true;
    nestedPlans.delete(indent);
    nestedPoints.delete(indent);
  };
  const points = [];
  const subtestAt = new Map(); // indent -> subtest name
  const unstructured = [];
  const seenUnstructured = new Set();

  const noteUnstructured = (line) => {
    if (!seenUnstructured.has(line)) {
      seenUnstructured.add(line);
      unstructured.push(line);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (versionRe.test(line)) { sawTap = true; continue; }

    const bail = line.match(bailoutRe);
    if (bail) {
      sawTap = true;
      bailout = true;
      bailoutReason = bail[1]?.trim() || null;
      continue;
    }

    const tp = line.match(testPointRe);
    if (tp) {
      sawTap = true;
      const [, indent, status, num, description, directive] = tp;
      const ok = status === 'ok';
      const dir = (directive || '').toUpperCase();
      const isSkip = dir === 'SKIP';
      const isTodo = dir === 'TODO';
      const ind = indent.length;
      // The enclosing result closes deeper TAP scopes even when optional
      // '# Subtest:' headers are absent between sibling subtests.
      for (const k of new Set([...nestedPoints.keys(), ...nestedPlans.keys()])) if (k > ind) finishNestedScope(k);
      const pathPrefix = ind > 0
        ? [...subtestAt.entries()].filter(([k]) => k < ind).sort((a, b) => a[0] - b[0]).map(([, n]) => n)
        : [];
      points.push({ ind, ok, num, text: (description ?? '').trim(), index: i, line, pathPrefix, skip: isSkip, todo: isTodo });
      if (!isSkip && !isTodo && ok) rawPass++;
      if (ind === 0) {
        topLevelPoints++;
        if (!ok && !isSkip && !isTodo) topLevelFail++;
      } else {
        nestedPoints.set(ind, (nestedPoints.get(ind) ?? 0) + 1);
      }
      continue;
    }

    const plan = line.match(planRe);
    if (plan) {
      sawTap = true;
      const [, indent, n] = plan;
      const total = Number(n);
      if (indent.length === 0) {
        if (planTotal === null) planTotal = total;
      } else {
        if (nestedPlans.has(indent.length) && nestedPlans.get(indent.length) !== total) nestedPlanMismatch = true;
        nestedPlans.set(indent.length, total);
      }
      continue;
    }

    const sub = line.match(subtestRe);
    if (sub) {
      sawTap = true;
      const ind = sub[1].length;
      subtestAt.set(ind, sub[2].trim());
      for (const k of [...subtestAt.keys()]) if (k > ind) subtestAt.delete(k);
      // A new subtest header starts a fresh scope for every deeper level, but
      // sibling subtests at the same indent share one plan (e.g. node emits a
      // single `1..N` for all children of a parent), so the current level keeps
      // accumulating.
      for (const k of new Set([...nestedPoints.keys(), ...nestedPlans.keys()])) if (k > ind) finishNestedScope(k);
      continue;
    }

    const failedOf = line.match(failedOfRe);
    if (failedOf) {
      sawTap = true;
      const [, indent, n] = failedOf;
      const value = Number(n);
      if (indent.length === 0) topSummaryFail = value;
      if (summaryFail === null) summaryFail = value;
      continue;
    }

    const count = line.match(countRe);
    if (count) {
      sawTap = true;
      const [, indent, key, n] = count;
      const value = Number(n);
      const top = indent.length === 0;
      if (top) {
        if (key === 'fail') topSummaryFail = value;
        else if (key === 'tests') topSummaryTests = value;
      }
      if (key === 'fail' && (top || summaryFail === null)) summaryFail = value;
      else if (key === 'pass' && (top || summaryPass === null)) summaryPass = value;
      else if (key === 'tests' && (top || summaryTests === null)) summaryTests = value;
      continue;
    }

    // Preserve non-TAP stdout diagnostics even inside a TAP stream. Indented
    // lines belong to YAML/point diagnostics (already captured on failures);
    // blank lines, `#` comments and YAML markers are ignored.
    if (line.trim() === '' || /^\s+#/.test(line) || yamlMarkerRe.test(line)) continue;
    if (line.trimStart() === line) noteUnstructured(line.trim());
  }

  for (const k of [...nestedPlans.keys()]) finishNestedScope(k);

  if (!sawTap) {
    return {
      isTap: false, summary: text.slice(-6000), header: '', body: text.slice(-6000),
      failuresBody: null, pass: 0, fail: 0, total: null, failures: [], explicitPass: false,
      complete: false, bailout: false, bailoutReason: null, unstructured: [],
    };
  }

  // TAP writes a parent's result after its children. Walk backwards so an
  // enclosing TODO/SKIP suppresses expected nested failures, but a supposedly
  // passing parent cannot hide a genuine child failure.
  const ancestors = new Map();
  for (const p of [...points].reverse()) {
    for (const indent of ancestors.keys()) if (indent >= p.ind) ancestors.delete(indent);
    p.ignored = p.skip || p.todo || [...ancestors.values()].some(parent => parent.ignored);
    ancestors.set(p.ind, p);
  }
  const observedFailure = points.some(p => !p.ok && !p.ignored);
  const failures = [];
  for (const p of points) {
    if (p.ok || p.ignored) continue;
    if (failures.length >= maxFailures) break;
    const diagnostics = [];
    for (let j = p.index + 1; j < lines.length && diagnostics.length < 400; j++) {
      const dl = lines[j];
      const ind = (dl.match(/^(\s*)/) || ['', ''])[1].length;
      if (ind <= p.ind) break;
      const nested = dl.match(testPointRe);
      if (nested && nested[1].length <= p.ind) break;
      diagnostics.push(dl);
    }
    const desc = p.text.trim();
    const label = p.pathPrefix.length
      ? (desc ? `${p.pathPrefix.join(' > ')} > ${desc}` : p.pathPrefix.join(' > '))
      : p.line.trim();
    failures.push({
      line: p.line.trim(),
      label,
      num: p.num,
      text: p.text,
      ind: p.ind,
      diagnostics: diagnostics.map(d => d.trim()).filter(Boolean),
    });
  }

  // Prefer summary counts without counting both a failed child and its parent
  // twice, but never let contradictory totals erase observed nested failures.
  const fail = Math.max(summaryFail ?? topLevelFail, topLevelFail, observedFailure ? 1 : 0);
  const pass = summaryPass ?? rawPass;
  const total = summaryTests ?? planTotal ?? (pass + fail);

  // An explicit top-level plan is authoritative: the run is only complete when
  // every planned top-level point was observed, regardless of any summary
  // counts. Without a plan, only a top-level summary (`# tests` or `# fail`)
  // signals completion; nested summaries never do, and a nested plan that does
  // not match its observed points also makes the run incomplete.
  const complete = !bailout && isTapComplete({
    planTotal,
    topLevelPoints,
    topSummaryTests,
    topSummaryFail,
    nestedPlanMismatch,
  });

  const explicitPass = !bailout && fail === 0 && complete && (planTotal === null || planTotal > 0);

  const failuresBody = failures.length
    ? `Failures:\n${failures.map(f => {
        const diag = f.diagnostics.slice(0, 60).join('\n');
        return diag ? `${f.label}\n${diag}` : f.label;
      }).join('\n')}`
    : null;

  const header = `TAP summary: ${fail} failed, ${pass} passed${total !== null ? `, ${total} total` : ''}.`;
  let body;
  if (bailout) {
    body = `Bail out!${bailoutReason ? ` ${bailoutReason}` : ''}`;
    if (failuresBody) body += `\n${failuresBody}`;
  } else if (failuresBody) {
    body = failuresBody;
  } else if (explicitPass) {
    body = 'All tests passed.';
  } else {
    body = 'No failures found in captured output (partial TAP; see log for the full run).';
  }

  let summary = `${header}\n${body}`;
  if (summary.length > maxSummaryChars) summary = `${summary.slice(0, maxSummaryChars)}\n[Truncated; see log.]`;
  return {
    isTap: true, summary, header, body, failuresBody, pass, fail, total, failures,
    explicitPass, complete, bailout, bailoutReason, unstructured,
  };
}

/** Execute a single (already validated/normalized) check. Injectable
 *  spawn/kill/fs/timers are test seams; production callers use the defaults. */
export async function executeCheck(check, opts = {}) {
  const {
    cwd = process.cwd(),
    logDir = path.join(os.tmpdir(), 'piastra-check-logs'),
    signal,
    spawn = nodeSpawn,
    execPath = process.execPath,
    env = process.env,
    platform = process.platform,
    kill,
    powershell = 'powershell.exe',
    supervisorPs1 = SUPERVISOR_PS1,
    findNpm = findNpmCli,
    now = () => Date.now(),
    random = Math.random,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    writeLog = defaultWriteLog,
    stdoutCap = STDOUT_CAP,
    stderrCap = STDERR_CAP,
  } = opts;

  const resolved = resolveExecutable(check.command, { execPath, env, findNpm });
  const timeoutMs = opts.timeoutMs ?? check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = [resolved.executable, ...resolved.args];
  const started = now();

  let spawnExecutable = resolved.executable;
  let spawnArgs = resolved.args;
  let spawnEnv = env;
  let killFn = kill ?? ((child) => killTree(child, { platform, processRef: process }));
  if (platform === 'win32') {
    // Run Windows checks inside the fixed job-object supervisor so every
    // descendant is contained and killed on completion/timeout/cancel. The
    // logical command is unchanged; only the transport is wrapped.
    const supervisor = buildWindowsSupervisorSpawn({
      executable: resolved.executable,
      args: resolved.args,
      cwd,
      env,
      timeoutMs,
      powershell,
      ps1Path: supervisorPs1,
      execPath,
    });
    spawnExecutable = supervisor.executable;
    spawnArgs = supervisor.args;
    spawnEnv = supervisor.env;
    // Terminating the supervisor closes its Job Object, which kills the whole
    // tree including orphans whose launcher already exited.
    killFn = (child) => { try { child.kill?.(); } catch { /* best effort */ } };
  }

  if (signal?.aborted) {
    return {
      text: `Check ${check.name} CANCELLED before it started.`,
      details: {
        name: check.name, command, cwd, status: 'cancelled', exitCode: null, signal: null,
        timedOut: false, cancelled: true, durationMs: 0, logPath: undefined,
      },
    };
  }

  const outcome = await collectProcess({
    executable: spawnExecutable,
    args: spawnArgs,
    cwd,
    env: spawnEnv,
    timeoutMs,
    signal,
    spawn,
    platform,
    kill: killFn,
    setTimeoutFn,
    clearTimeoutFn,
    stdoutCap,
    stderrCap,
  });

  const durationMs = now() - started;
  const tap = summarizeTap(outcome.stdout);
  const status = outcomeStatus(outcome, tap);

  const details = {
    name: check.name,
    command,
    cwd,
    status,
    exitCode: outcome.code,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    cancelled: outcome.cancelled,
    error: outcome.error?.message,
    durationMs,
    stdoutTruncated: outcome.stdoutTruncated,
    stderrTruncated: outcome.stderrTruncated,
    ...(tap.isTap ? { tap: { pass: tap.pass, fail: tap.fail, total: tap.total } } : {}),
  };

  const logPathCandidate = makeLogPath(logDir, check.name, now, random);
  const content = buildLogContent({ check, command, cwd, durationMs, status, outcome, logPath: logPathCandidate });
  let logPath;
  let logError;
  try {
    logPath = await writeLog(logPathCandidate, content);
  } catch (error) {
    logError = error.message;
  }
  details.logPath = logPath;
  if (logError) details.logError = logError;

  const text = composeText(check, status, outcome, tap, timeoutMs, logPath, {
    command,
    cwd,
    durationMs,
    logError,
  });
  return { text, details };
}

function collectProcess({ executable, args, cwd, env, timeoutMs, signal, spawn, platform, kill, setTimeoutFn, clearTimeoutFn, stdoutCap, stderrCap }) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutLen = 0;
    let stderrLen = 0;
    let spawnError;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer;
    let graceTimer;

    const finish = (overrides = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeoutFn(timer);
      if (graceTimer) clearTimeoutFn(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        code: null,
        signal: null,
        error: spawnError,
        stdout,
        stderr,
        stdoutTruncated: stdoutLen > stdoutCap,
        stderrTruncated: stderrLen > stderrCap,
        timedOut,
        cancelled,
        ...overrides,
      });
    };

    const requestKill = () => {
      try { kill(child); } catch { /* best effort */ }
    };

    const onAbort = () => {
      cancelled = true;
      requestKill();
      if (!graceTimer) graceTimer = setTimeoutFn(() => finish(), GRACE_MS);
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeoutFn(() => {
      timedOut = true;
      requestKill();
      if (!graceTimer) graceTimer = setTimeoutFn(() => finish(), GRACE_MS);
    }, timeoutMs);

    const onStdout = (buf) => {
      const chunk = buf.toString('utf8');
      stdoutLen += chunk.length;
      if (stdout.length < stdoutCap) stdout += chunk.slice(0, stdoutCap - stdout.length);
    };
    const onStderr = (buf) => {
      const chunk = buf.toString('utf8');
      stderrLen += chunk.length;
      if (stderr.length < stderrCap) stderr += chunk.slice(0, stderrCap - stderr.length);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);

    child.on('error', (err) => {
      spawnError = err;
      finish({ code: null, signal: null });
    });
    child.on('close', (code, signalName) => finish({ code, signal: signalName }));
  });
}

/** Terminate the whole subprocess tree. POSIX: SIGKILL the detached process
 *  group (even when the leader has already exited while descendants still hold
 *  the pipes), falling back to the direct child. On Windows this is only a
 *  last-resort fallback that terminates the direct child; real Windows checks
 *  run inside the job-object supervisor (`windows-check-job.ps1`), which kills
 *  the entire tree (including orphans) when its job is closed. */
export function killTree(child, { platform, processRef = process }) {
  if (child.pid == null) return;
  if (platform === 'win32') {
    try { child.kill?.(); } catch { /* best effort */ }
    return;
  }
  try {
    processRef.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill?.('SIGKILL'); } catch { /* best effort */ }
  }
}

function outcomeStatus(outcome, tap) {
  if (outcome.error) return 'error';
  if (outcome.timedOut) return 'timeout';
  if (outcome.cancelled) return 'cancelled';
  if (outcome.signal) return 'failed';
  if (outcome.code !== 0) return 'failed';
  if (tap.isTap) {
    if (tap.bailout) return 'failed';
    if (tap.fail > 0) return 'failed';
    if (outcome.stdoutTruncated) return 'failed';
    if (!tap.complete) return 'failed';
    return 'passed';
  }
  return 'passed';
}

function composeText(check, status, outcome, tap, timeoutMs, logPath, meta) {
  const parts = [`Check ${check.name} ${verdictLine(status, outcome, timeoutMs, tap)}.`];
  if (tap.isTap) {
    parts.push(tap.header);
    let body;
    if (tap.bailout) {
      body = `Bail out!${tap.bailoutReason ? ` ${tap.bailoutReason}` : ''}`;
      if (tap.failuresBody) body += `\n${tap.failuresBody}`;
    } else if (tap.failuresBody) {
      body = tap.failuresBody;
    } else if (status === 'passed') {
      body = tap.explicitPass ? 'All tests passed.' : 'No failures found in captured output.';
    } else if (status === 'failed' && tap.explicitPass && !outcome.timedOut && !outcome.cancelled && !outcome.error) {
      body = `TAP reported no failures, but the process exited non-zero (${outcome.signal ? `signal ${outcome.signal}` : `exit ${outcome.code}`}); see log.`;
    } else if (outcome.timedOut || outcome.cancelled || outcome.error) {
      body = 'No failures were reported before the run was interrupted; see log for the full run.';
    } else {
      body = 'TAP is incomplete or truncated; the run is reported failed; see log for the full run.';
    }
    parts.push(body);
    if (tap.unstructured.length) {
      parts.push(`[output]\n${tap.unstructured.slice(0, 100).join('\n')}`);
    }
    if (outcome.stderr) parts.push(`[stderr]\n${outcome.stderr.slice(-4000)}`);
  } else {
    parts.push(nonTapSummary(outcome));
  }

  parts.push(`command: ${meta.command.map(quoteArg).join(' ')}`);
  parts.push(`cwd: ${meta.cwd}`);
  parts.push(`elapsed: ${meta.durationMs}ms`);
  if (outcome.stdoutTruncated) parts.push('[notice] stdout truncated at the capture cap; bounded output is in the log.');
  if (outcome.stderrTruncated) parts.push('[notice] stderr truncated at the capture cap; bounded output is in the log.');
  if (meta.logError) parts.push(`[notice] could not write log: ${meta.logError}`);
  if (logPath) parts.push(`Full log: ${logPath}`);

  const text = parts.filter(Boolean).join('\n');
  return text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}\n[Truncated; see log.]` : text;
}

function verdictLine(status, outcome, timeoutMs, tap) {
  switch (status) {
    case 'passed': return 'PASSED (exit 0)';
    case 'timeout': return `TIMED OUT after ${timeoutMs}ms`;
    case 'cancelled': return 'CANCELLED';
    case 'error': return `FAILED (could not start: ${outcome.error?.message || 'unknown error'})`;
    case 'failed':
      if (outcome.signal) return `FAILED (signal ${outcome.signal})`;
      if (outcome.code !== 0) return `FAILED (exit ${outcome.code ?? '?'})`;
      if (tap?.bailout) return 'FAILED (TAP bailout)';
      return 'FAILED (TAP incomplete or truncated)';
    default: return String(status).toUpperCase();
  }
}

function nonTapSummary(outcome) {
  const parts = [];
  if (outcome.stdout) parts.push(outcome.stdout.slice(-6000));
  if (outcome.stderr) parts.push(`[stderr]\n${outcome.stderr.slice(-4000)}`);
  return parts.join('\n') || '(no output)';
}

function buildLogContent({ check, command, cwd, durationMs, status, outcome, logPath }) {
  return [
    `check: ${check.name}`,
    `command: ${command.map(quoteArg).join(' ')}`,
    `cwd: ${cwd}`,
    `durationMs: ${durationMs}`,
    `outcome: ${status}`,
    `exitCode: ${outcome.code ?? ''}`,
    `signal: ${outcome.signal ?? ''}`,
    `timedOut: ${outcome.timedOut}`,
    `cancelled: ${outcome.cancelled}`,
    `stdoutTruncated: ${outcome.stdoutTruncated}`,
    `stderrTruncated: ${outcome.stderrTruncated}`,
    `logPath: ${logPath}`,
    '',
    '--- stdout ---',
    outcome.stdout || '(none)',
    '--- stderr ---',
    outcome.stderr || '(none)',
    '',
  ].join('\n');
}

function quoteArg(a) {
  return /[\s"'\\]/.test(a) ? JSON.stringify(a) : a;
}

function makeLogPath(logDir, name, now, random) {
  const safe = name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64) || 'check';
  return path.join(logDir, `check-${safe}-${now()}-${String(process.pid)}-${random().toString(36).slice(2, 10)}.log`);
}

async function defaultWriteLog(logPath, content) {
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, content, 'utf8');
  return logPath;
}
