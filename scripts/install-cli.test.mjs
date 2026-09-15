import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Resolve a dependency's package.json from an importer dir, tolerating
// exports-map packages that block `<dep>/package.json` (same fallback as
// the installer under test).
function resolveFixturePackageJson(dep, fromDir) {
  const requireFrom = createRequire(path.join(fromDir, 'package.json'));
  try {
    return requireFrom.resolve(`${dep}/package.json`);
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && error?.code !== 'ERR_PACKAGE_SUBPATH_NOT_EXPORTED') throw error;
    const entry = requireFrom.resolve(dep);
    let dir = path.dirname(entry);
    while (true) {
      const candidate = path.join(dir, 'package.json');
      if (existsSync(candidate)) {
        try {
          if (JSON.parse(readFileSync(candidate, 'utf8')).name === dep) return candidate;
        } catch {}
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw error;
  }
}

function collectFixtureClosure(dep, fromDir, seen) {
  const packageJsonPath = resolveFixturePackageJson(dep, fromDir);
  const dir = path.dirname(packageJsonPath);
  if (seen.has(dir)) return;
  seen.set(dir, packageJsonPath);
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const runtimeDeps = { ...(manifest.dependencies || {}) };
  for (const [name, range] of Object.entries(manifest.optionalDependencies || {})) {
    if (!(name in runtimeDeps)) runtimeDeps[name] = range;
  }
  for (const child of Object.keys(runtimeDeps)) {
    try {
      collectFixtureClosure(child, dir, seen);
    } catch (error) {
      if (manifest.optionalDependencies?.[child]) continue;
      throw error;
    }
  }
}

// Files the installer requires beyond the pi-queue fork under test. The tool
// runtime modules that already exist in the checkout (web/checks/policy and
// the check catalog) are copied for real so the installer copy semantics and
// the runtime proof below exercise the actual code, not stubs.
const supportFiles = [
  'scripts/install-cli.mjs',
  'config/agents.json',
  'config/checks.json',
  ...['orchestrator', 'general', 'fast', 'review'].map((role) => `roles/${role}.md`),
  'extensions/piastra/index.ts',
  'extensions/piastra/policy.mjs',
  'extensions/piastra/agents.mjs',
  'extensions/piastra/prefs.mjs',
  'extensions/piastra/guard.mjs',
  'extensions/piastra/progress.mjs',
  'extensions/piastra/sidebar.mjs',
  'extensions/piastra/worker-bridge.mjs',
  'extensions/piastra/worker-view.ts',
  'extensions/piastra/worker-render.ts',
  'extensions/piastra/shortcuts.ts',
  'extensions/piastra/image-paste.ts',
  'extensions/piastra/web.mjs',
  'extensions/piastra/checks.mjs',
  'extensions/piastra/windows-check-job.ps1',
  'extensions/pi-ui/index.ts',
  'extensions/pi-worktree/git-worktree.ts',
  'extensions/pi-worktree/LICENSE',
  'extensions/pi-compact-transcript/index.ts',
  'extensions/pi-compact-transcript/extensions/compact-transcript.ts',
  'extensions/pi-compact-transcript/package.json',
  'extensions/pi-compact-transcript/LICENSE',
  'extensions/pi-compact-transcript/README.md',
];

function runInstaller(sourceRoot, agentDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/install-cli.mjs'], {
      cwd: sourceRoot,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: 'pipe',
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

// Tool runtime files still being integrated on the parent branch
// (custom-tools factory, notes module) are copied for real when they exist;
// otherwise synthetic fixtures cover the installer copy semantics so this
// test does not block on the parent branch.
async function writeToolRuntime(root) {
  const pending = {
    'extensions/piastra/custom-tools.ts': 'export const PIASTRA_CUSTOM_TOOLS_FIXTURE = 1;\n',
    'extensions/piastra/notes.mjs': 'export const PIASTRA_NOTES_FIXTURE = 1;\n',
  };
  for (const [file, fixture] of Object.entries(pending)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    if (existsSync(path.join(repoRoot, file))) {
      await cp(path.join(repoRoot, file), target);
    } else {
      await writeFile(target, fixture);
    }
  }
}

// Synthetic vendored fork: runtime files, dependencies, LICENSE/README, tests.
// Used because the real fork (extensions/pi-queue) is vendored by another
// worker and may not exist yet; the copy semantics under test are identical.
async function writeFixtureFork(root, { includeTests = true } = {}) {
  const base = path.join(root, 'extensions', 'pi-queue');
  await mkdir(path.join(base, 'lib'), { recursive: true });
  await writeFile(path.join(base, 'index.ts'), 'import { steer } from "./lib/state.mjs";\nexport { steer };\n');
  await writeFile(path.join(base, 'lib/state.mjs'), 'export const steer = () => "queued";\n');
  await writeFile(path.join(base, 'LICENSE'), 'MIT\n');
  await writeFile(path.join(base, 'README.md'), '# pi-queue fork\n');
  if (includeTests) {
    await writeFile(path.join(base, 'index.test.ts'), 'test("noop");\n');
    await writeFile(path.join(base, 'lib/state.test.mjs'), 'test("noop");\n');
    await mkdir(path.join(base, '__tests__'), { recursive: true });
    await writeFile(path.join(base, '__tests__/helper.mjs'), 'export const helper = 1;\n');
  }
  // Same shape for the compact-transcript fork: runtime files come from
  // supportFiles; a test file here verifies test exclusion during the copy.
  const compact = path.join(root, 'extensions', 'pi-compact-transcript');
  await mkdir(path.join(compact, 'extensions'), { recursive: true });
  if (includeTests) {
    await writeFile(path.join(compact, 'compact-transcript.test.mjs'), 'test("noop");\n');
  }
}

// The installed copy vendors a recursive runtime dependency closure. The
// source tree needs the hoisted closure sources so resolution matches a real
// checkout; copy only the closure packages (not the whole repo
// node_modules) into the synthetic source, preserving their hoisted layout.
async function writeRuntimeDependency(root) {
  const seen = new Map();
  for (const dep of ['proper-lockfile', 'html-to-text', 'ipaddr.js']) {
    collectFixtureClosure(dep, repoRoot, seen);
  }
  const hoisted = path.join(repoRoot, 'node_modules') + path.sep;
  for (const dir of seen.keys()) {
    let relative;
    if (dir.startsWith(hoisted)) {
      relative = dir.slice(hoisted.length);
    } else {
      relative = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
    }
    await mkdir(path.join(root, 'node_modules', path.dirname(relative)), { recursive: true });
    await cp(dir, path.join(root, 'node_modules', relative), { recursive: true, force: true });
  }
}

function count(list, value) {
  return list.filter((item) => item === value).length;
}

// Recursively locate an installed package dir under the standalone
// node_modules (flat hoisted or nested per-package copy).
async function findInstalledPackage(agentDir, name) {
  const start = path.join(agentDir, 'piastra/package/node_modules');
  const parts = name.split('/');
  async function walk(dir, depth) {
    const candidate = path.join(dir, ...parts, 'package.json');
    if (existsSync(candidate)) return path.dirname(candidate);
    if (depth <= 0) return null;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EPERM') return null;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (entry.name === '.bin') continue;
      const found = await walk(path.join(dir, entry.name), depth - 1);
      if (found) return found;
    }
    return null;
  }
  return walk(start, 4);
}

// Self-contained runtime proof: in a fresh unrelated directory (no checkout
// parent, no NODE_PATH), import the *installed* web.mjs/checks.mjs/policy
// and prefs modules in a child Node process and exercise real behavior:
// HTML extraction, public-IP validation, check-catalog exports and the
// lockfile-backed preference store import. File presence alone proves
// nothing; this fails when transitive deps are missing from the closure.
function runInstalledRuntime(agentDir, workDir) {
  const installedWeb = pathToFileURL(path.join(agentDir, 'piastra/package/extensions/piastra/web.mjs')).href;
  const installedChecks = pathToFileURL(path.join(agentDir, 'piastra/package/extensions/piastra/checks.mjs')).href;
  const installedPolicy = pathToFileURL(path.join(agentDir, 'piastra/package/extensions/piastra/policy.mjs')).href;
  const installedPrefs = pathToFileURL(path.join(agentDir, 'piastra/package/extensions/piastra/prefs.mjs')).href;
  const script = `
    const web = await import(${JSON.stringify(installedWeb)});
    const checks = await import(${JSON.stringify(installedChecks)});
    const policy = await import(${JSON.stringify(installedPolicy)});
    const prefs = await import(${JSON.stringify(installedPrefs)});
    if (typeof web.htmlToText !== 'function') throw new Error('web.mjs htmlToText missing');
    if (typeof web.isPublicIp !== 'function') throw new Error('web.mjs isPublicIp missing');
    const text = web.htmlToText('<html><body><h1>Hello</h1><p>world</p><script>var x = 1;</script></body></html>');
    if (!text.includes('Hello') || !text.includes('world')) throw new Error('extraction wrong: ' + JSON.stringify(text));
    if (/var x/.test(text)) throw new Error('script not stripped: ' + JSON.stringify(text));
    if (web.isPublicIp('8.8.8.8') !== true) throw new Error('public IP rejected');
    if (web.isPublicIp('10.0.0.1') !== false) throw new Error('private IP accepted');
    if (typeof checks.runChecks !== 'function' && typeof checks.loadCatalog !== 'function') throw new Error('checks.mjs exports missing');
    if (typeof policy.gitArguments !== 'function' && typeof policy.validateTasks !== 'function') throw new Error('policy.mjs exports missing');
    if (typeof prefs.loadPrefs !== 'function') throw new Error('prefs.mjs loadPrefs missing');
    const check = await checks.executeCheck({name:'installed-probe',command:['node','-e',"console.log('installed check verified')"],timeoutMs:15000}, {cwd:process.cwd(),logDir:process.cwd()});
    if (check.details.status !== 'passed' || !check.text.includes('installed check verified')) throw new Error(check.text);

    // Resolve the transitive web closure from the installed tree itself.
    const { createRequire } = await import('node:module');
    const requireWeb = createRequire(${JSON.stringify(installedWeb)});
    for (const dep of ['html-to-text', 'ipaddr.js']) requireWeb.resolve(dep);
    const requireHtml = createRequire(requireWeb.resolve('html-to-text'));
    for (const dep of ['htmlparser2', 'selderee', 'dom-serializer', 'deepmerge-ts']) requireHtml.resolve(dep);
    const requireLock = createRequire(${JSON.stringify(installedPrefs)});
    requireLock.resolve('proper-lockfile');
    console.log(JSON.stringify({ text, ok: true }));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: workDir,
      env: { ...process.env, NODE_PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`installed runtime probe failed (exit ${code}): ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop()));
      } catch (error) {
        reject(new Error(`installed runtime probe unparseable: ${stdout} ${stderr}`));
      }
    });
  });
}

test('installed fork is self-contained: runtime files copied, tests excluded, single index entry; upstream package entries removed and other settings preserved', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
  const workDir = await mkdtemp(path.join(tmpdir(), 'piastra-work-'));
  try {
    for (const file of supportFiles) {
      await mkdir(path.join(sourceRoot, path.dirname(file)), { recursive: true });
      await cp(path.join(repoRoot, file), path.join(sourceRoot, file));
    }
    await writeFixtureFork(sourceRoot);
    await writeRuntimeDependency(sourceRoot);
    await writeToolRuntime(sourceRoot);
    const settings = {
      customSetting: true,
      unrelated: { nested: [1, 2, 3] },
      packages: [
        'npm:keep-me',
        'npm:pi-queue-steer-factory',
        'npm:pi-queue-steer-factory@2.1.0',
        'git:github.com/user/pi-queue-steer-factory@main',
        'https://github.com/user/pi-queue-steer-factory',
        'npm:pi-compact-transcript',
        {
          source: 'npm:pi-compact-transcript@0.10.1',
          commands: [],
        },
        {
          source: 'pi-queue-other-entry',
          skills: [],
        },
        { source: 'npm:@thisux/pi-worktree@1.2.0' },
      ],
      extensions: ['/existing/extension.ts'],
    };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    await runInstaller(sourceRoot, agentDir);
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));

    // Unrelated settings survive untouched.
    assert.equal(installed.customSetting, true);
    assert.deepEqual(installed.unrelated, { nested: [1, 2, 3] });
    assert.deepEqual(installed.packages.filter((p) => typeof p === 'object' && p.skills), [
      { source: 'pi-queue-other-entry', skills: [] },
    ]);
    assert.equal(installed.packages.some((p) => (typeof p === 'string' ? p : p?.source) === 'npm:keep-me'), true);

    // Every known upstream form is gone; worktree still disabled, not removed.
    const sources = installed.packages.map((p) => (typeof p === 'string' ? p : p?.source));
    for (const source of sources) {
      assert.doesNotMatch(source, /^npm:pi-queue-steer-factory/);
      assert.doesNotMatch(source, /pi-queue-steer-factory/);
    }
    assert.deepEqual(
      installed.packages.find((p) => typeof p === 'object' && p?.source === 'npm:@thisux/pi-worktree@1.2.0'),
      { source: 'npm:@thisux/pi-worktree@1.2.0', extensions: [] },
    );

    // The vendored compact-transcript fork replaces the upstream plugin: both
    // the bare string and the versioned object are disabled via extensions: [],
    // and the versioned object keeps its other fields.
    assert.deepEqual(
      installed.packages.find((p) => typeof p === 'object' && p?.source === 'npm:pi-compact-transcript'),
      { source: 'npm:pi-compact-transcript', extensions: [] },
    );
    assert.deepEqual(
      installed.packages.find((p) => typeof p === 'object' && p?.source === 'npm:pi-compact-transcript@0.10.1'),
      { source: 'npm:pi-compact-transcript@0.10.1', commands: [], extensions: [] },
    );
    assert.equal(installed.packages.some((p) => typeof p === 'string' && /^npm:pi-compact-transcript/.test(p)), false);

    // Fork installed recursively: index, dependency, LICENSE, README present;
    // tests of any shape excluded; index registered exactly once.
    const installedPkg = path.join(agentDir, 'piastra/package/extensions/pi-queue');
    const indexSource = await readFile(path.join(installedPkg, 'index.ts'), 'utf8');
    assert.match(indexSource, /state\.mjs/);
    await readFile(path.join(installedPkg, 'lib/state.mjs'), 'utf8');
    await readFile(path.join(installedPkg, 'LICENSE'), 'utf8');
    await readFile(path.join(installedPkg, 'README.md'), 'utf8');
    assert.equal(existsSync(path.join(installedPkg, 'index.test.ts')), false);
    assert.equal(existsSync(path.join(installedPkg, 'lib/state.test.mjs')), false);
    assert.equal(existsSync(path.join(installedPkg, '__tests__')), false);
    assert.equal(count(installed.extensions, path.join(agentDir, 'piastra/package/extensions/pi-queue/index.ts')), 1);

    // Compact-transcript fork installed recursively: index, extension module,
    // package.json, LICENSE, README present; tests excluded; index registered
    // exactly once.
    const installedCompact = path.join(agentDir, 'piastra/package/extensions/pi-compact-transcript');
    const compactIndexSource = await readFile(path.join(installedCompact, 'index.ts'), 'utf8');
    assert.match(compactIndexSource, /compact-transcript\.ts/);
    await readFile(path.join(installedCompact, 'extensions/compact-transcript.ts'), 'utf8');
    await readFile(path.join(installedCompact, 'package.json'), 'utf8');
    await readFile(path.join(installedCompact, 'LICENSE'), 'utf8');
    await readFile(path.join(installedCompact, 'README.md'), 'utf8');
    assert.equal(existsSync(path.join(installedCompact, 'compact-transcript.test.mjs')), false);
    assert.equal(count(installed.extensions, path.join(agentDir, 'piastra/package/extensions/pi-compact-transcript/index.ts')), 1);

    // The piastra shortcuts module ships with the managed copy.
    const shortcuts = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/shortcuts.ts'), 'utf8');
    assert.match(shortcuts, /piastra:compact-transcript:toggle/);
    const imagePaste = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/image-paste.ts'), 'utf8');
    assert.match(imagePaste, /insertClipboardImage/);
    const workerBridge = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/worker-bridge.mjs'), 'utf8');
    assert.match(workerBridge, /WORKER_CHANNEL/);

    // The per-role preference store ships with the managed copy together with
    // its runtime dependency, so the installed extension resolves it without
    // a checkout.
    const prefs = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/prefs.mjs'), 'utf8');
    assert.match(prefs, /proper-lockfile/);
    await readFile(path.join(agentDir, 'piastra/package/node_modules/proper-lockfile/package.json'), 'utf8');

    // The agent tool runtime ships with the managed copy: factory plus
    // notes/web/checks modules plus the check catalog. Real modules are used
    // wherever they exist in the checkout; pending parent-branch files fall
    // back to fixture markers (see writeToolRuntime).
    for (const file of [
      'extensions/piastra/custom-tools.ts',
      'extensions/piastra/notes.mjs',
      'extensions/piastra/web.mjs',
      'extensions/piastra/checks.mjs',
      'extensions/piastra/windows-check-job.ps1',
    ]) {
      const content = await readFile(path.join(agentDir, 'piastra/package', file), 'utf8');
      assert.match(content, file.endsWith('.ps1') ? /PiAstraJob/ : /export/);
    }
    const webSource = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/web.mjs'), 'utf8');
    assert.match(webSource, /htmlToText|html-to-text/);
    const checksSource = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/checks.mjs'), 'utf8');
    assert.match(checksSource, /runChecks|loadCatalog/);
    const checksCatalog = JSON.parse(await readFile(path.join(agentDir, 'piastra/package/config/checks.json'), 'utf8'));
    assert.equal(Array.isArray(checksCatalog.checks), true);
    assert.ok(checksCatalog.checks.length > 0);

    // The standalone copy declares and vendors every non-aliased runtime
    // dependency: the preference store lock plus the tool runtime web deps.
    const standalone = JSON.parse(await readFile(path.join(agentDir, 'piastra/package/package.json'), 'utf8'));
    assert.equal(standalone.dependencies['proper-lockfile'], '^4.1.2');
    assert.equal(standalone.dependencies['html-to-text'], '10.0.1');
    assert.equal(standalone.dependencies['ipaddr.js'], '2.5.0');
    await readFile(path.join(agentDir, 'piastra/package/node_modules/html-to-text/package.json'), 'utf8');
    await readFile(path.join(agentDir, 'piastra/package/node_modules/ipaddr.js/package.json'), 'utf8');

    // The recursive closure is vendored: hoisted transitive deps of
    // html-to-text (htmlparser2, selderee, dom-serializer, deepmerge-ts) and
    // of proper-lockfile (graceful-fs, retry, signal-exit) resolve somewhere
    // under the standalone node_modules (flat or nested per-package copy).
    for (const dep of ['htmlparser2', 'selderee', 'dom-serializer', 'deepmerge-ts', 'graceful-fs', 'retry', 'signal-exit']) {
      assert.ok(await findInstalledPackage(agentDir, dep), `transitive dep missing from closure: ${dep}`);
    }

    // Runtime proof in an unrelated directory: the installed web.mjs really
    // imports and extracts HTML, policy/checks/prefs load, and the whole
    // transitive closure resolves from the installed tree.
    const runtime = await runInstalledRuntime(agentDir, workDir);
    assert.equal(runtime.ok, true);
    assert.match(runtime.text, /Hello/);
    assert.match(runtime.text, /world/);

    // Stale development entries are gone.
    for (const entry of installed.extensions) {
      assert.doesNotMatch(entry, /\.\.[\\/]/);
      assert.notEqual(entry, path.join(sourceRoot, 'extensions/pi-queue/index.ts'));
      assert.notEqual(entry, path.join(sourceRoot, 'extensions/piastra/index.ts'));
      assert.notEqual(entry, path.join(sourceRoot, 'extensions/pi-compact-transcript/index.ts'));
    }

    // Idempotence: rerunning keeps the same extension set (single queue index)
    // and does not resurrect removed upstream packages.
    await runInstaller(sourceRoot, agentDir);
    const rerun = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    assert.deepEqual(rerun.extensions, installed.extensions);
    assert.equal(count(rerun.extensions, path.join(agentDir, 'piastra/package/extensions/pi-queue/index.ts')), 1);
    assert.equal(count(rerun.extensions, path.join(agentDir, 'piastra/package/extensions/pi-compact-transcript/index.ts')), 1);
    assert.deepEqual(rerun.packages, installed.packages);
    const rerunRuntime = await runInstalledRuntime(agentDir, workDir);
    assert.equal(rerunRuntime.ok, true);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test('installer fails before saving settings when vendored fork is missing, leaving upstream settings unchanged', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
  try {
    for (const file of supportFiles) {
      await mkdir(path.join(sourceRoot, path.dirname(file)), { recursive: true });
      await cp(path.join(repoRoot, file), path.join(sourceRoot, file));
    }
    await writeRuntimeDependency(sourceRoot);
    await writeToolRuntime(sourceRoot);
    // No fork in the source tree for this fixture.
    const settings = {
      customSetting: true,
      packages: ['npm:keep-me', 'npm:pi-queue-steer-factory'],
      extensions: ['/existing/extension.ts'],
    };
    const serialized = JSON.stringify(settings);
    await writeFile(path.join(agentDir, 'settings.json'), serialized);
    await assert.rejects(runInstaller(sourceRoot, agentDir), /pi-queue/);
    const installed = await readFile(path.join(agentDir, 'settings.json'), 'utf8');
    // Upstream settings file is byte-for-byte untouched: the original queue
    // plugin entry is still present because nothing was saved.
    assert.equal(installed, serialized);
    assert.equal(existsSync(path.join(agentDir, 'piastra/package/extensions/pi-queue')), false);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test('installer preserves packages and disables only upstream worktree extension', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-installer-'));
  const workDir = await mkdtemp(path.join(tmpdir(), 'piastra-work-'));
  try {
    for (const file of supportFiles) {
      await mkdir(path.join(sourceRoot, path.dirname(file)), { recursive: true });
      await cp(path.join(repoRoot, file), path.join(sourceRoot, file));
    }
    await writeFixtureFork(sourceRoot, { includeTests: false });
    await writeRuntimeDependency(sourceRoot);
    await writeToolRuntime(sourceRoot);
    const settings = {
      customSetting: true,
      packages: ['npm:keep-me', 'npm:@thisux/pi-worktree@1.2.0'],
      extensions: ['/existing/extension.ts'],
    };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    await runInstaller(sourceRoot, agentDir);
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(installed.customSetting, true);
    assert.deepEqual(installed.packages, [
      'npm:keep-me',
      { source: 'npm:@thisux/pi-worktree@1.2.0', extensions: [] },
    ]);
    assert.match(installed.extensions.join('\n'), /extensions[\\/]pi-worktree[\\/]git-worktree\.ts/);
    // The vendored compact-transcript fork is registered from the installed copy.
    assert.match(installed.extensions.join('\n'), /extensions[\\/]pi-compact-transcript[\\/]index\.ts/);
    await readFile(path.join(agentDir, 'piastra/package/extensions/pi-worktree/LICENSE'), 'utf8');
    // The piastra shortcuts module ships with the managed copy.
    const shortcuts = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/shortcuts.ts'), 'utf8');
    assert.match(shortcuts, /piastra:compact-transcript:toggle/);
    const imagePaste = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/image-paste.ts'), 'utf8');
    assert.match(imagePaste, /insertClipboardImage/);
    // The worker guard helper is part of the managed copy; index.ts imports it
    // at runtime, so a missing file would break the installed extension.
    const guard = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/guard.mjs'), 'utf8');
    assert.match(guard, /PIASTRA_WORKER_GUARD_CHANNEL/);
    // The per-role preference store and its bundled dependency ship too.
    const prefs = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/prefs.mjs'), 'utf8');
    assert.match(prefs, /proper-lockfile/);
    await readFile(path.join(agentDir, 'piastra/package/node_modules/proper-lockfile/package.json'), 'utf8');
    // The agent tool runtime ships too (real modules where they exist).
    for (const file of [
      'extensions/piastra/custom-tools.ts',
      'extensions/piastra/notes.mjs',
      'extensions/piastra/web.mjs',
      'extensions/piastra/checks.mjs',
      'extensions/piastra/windows-check-job.ps1',
    ]) {
      const content = await readFile(path.join(agentDir, 'piastra/package', file), 'utf8');
      assert.match(content, file.endsWith('.ps1') ? /PiAstraJob/ : /export/);
    }
    const checksCatalog = JSON.parse(await readFile(path.join(agentDir, 'piastra/package/config/checks.json'), 'utf8'));
    assert.equal(Array.isArray(checksCatalog.checks), true);
    const standalone = JSON.parse(await readFile(path.join(agentDir, 'piastra/package/package.json'), 'utf8'));
    assert.equal(standalone.dependencies['html-to-text'], '10.0.1');
    assert.equal(standalone.dependencies['ipaddr.js'], '2.5.0');
    await readFile(path.join(agentDir, 'piastra/package/node_modules/html-to-text/package.json'), 'utf8');
    await readFile(path.join(agentDir, 'piastra/package/node_modules/ipaddr.js/package.json'), 'utf8');
    // Runtime proof: installed web.mjs extracts HTML in an unrelated dir.
    const runtime = await runInstalledRuntime(agentDir, workDir);
    assert.equal(runtime.ok, true);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});

test('real repo install is self-contained: installed web.mjs extracts HTML in an unrelated directory', async (t) => {
  // The parent branch owns the remaining tool runtime files; skip until they
  // land rather than blocking this packaging proof on their integration.
  for (const file of ['extensions/piastra/custom-tools.ts', 'extensions/piastra/notes.mjs']) {
    if (!existsSync(path.join(repoRoot, file))) {
      t.skip(`pending parent branch file: ${file}`);
      return;
    }
  }
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-real-agent-'));
  const workDir = await mkdtemp(path.join(tmpdir(), 'piastra-real-work-'));
  try {
    await runInstaller(repoRoot, agentDir);
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    assert.ok(Array.isArray(installed.extensions));
    assert.match(installed.extensions.join('\n'), /piastra[\\/]package[\\/]extensions[\\/]piastra[\\/]index\.ts/);
    const runtime = await runInstalledRuntime(agentDir, workDir);
    assert.equal(runtime.ok, true);
    assert.match(runtime.text, /Hello/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
});
