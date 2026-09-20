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
  'extensions/piastra/worker-runtime.mjs',
  'extensions/piastra/session-title.mjs',
  'extensions/piastra/worker-view.ts',
  'extensions/piastra/help.mjs',
  'extensions/piastra/help-view.ts',
  'extensions/piastra/worker-panel.ts',
  'extensions/piastra/worker-render.ts',
  'extensions/piastra/shortcuts.ts',
  'extensions/piastra/image-paste.ts',
  'extensions/piastra/web.mjs',
  'extensions/piastra/checks.mjs',
  'extensions/piastra/windows-check-job.ps1',
  'extensions/pi-ui/index.ts',
  'extensions/pi-worktree/git-worktree.ts',
  'extensions/pi-worktree/resume.mjs',
  'extensions/pi-worktree/empty-sessions.mjs',
  'extensions/pi-worktree/LICENSE',
  'extensions/pi-compact-transcript/index.ts',
  'extensions/pi-compact-transcript/extensions/compact-transcript.ts',
  'extensions/pi-compact-transcript/package.json',
  'extensions/pi-compact-transcript/LICENSE',
  'extensions/pi-compact-transcript/README.md',
];

function runInstaller(sourceRoot, agentDir, { atelier = false, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['scripts/install-cli.mjs', ...(atelier ? ['--atelier'] : [])];
    const child = spawn(process.execPath, args, {
      cwd: sourceRoot,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...env },
      stdio: 'pipe',
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

// Tool runtime modules shipped by the managed copy (custom-tools factory,
// notes module) are copied for real from the checkout; they live on the
// merged parent branch and are required files now.
async function writeToolRuntime(root) {
  for (const file of ['extensions/piastra/custom-tools.ts', 'extensions/piastra/notes.mjs']) {
    assert.ok(existsSync(path.join(repoRoot, file)), `missing merged tool runtime file: ${file}`);
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(repoRoot, file), target);
  }
}

// Synthetic pi-usage source tree: the installer must copy runtime files and
// license but omit colocated tests.
async function writeFixtureUsage(root, { includeTests = true } = {}) {
  const base = path.join(root, 'extensions', 'pi-usage');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'index.ts'), 'import { usageRuntime } from "./runtime.mjs";\nexport default usageRuntime;\n');
  await writeFile(path.join(base, 'runtime.mjs'), 'export const usageRuntime = "pi-usage-runtime";\n');
  await cp(path.join(repoRoot, 'extensions', 'pi-usage', 'LICENSE'), path.join(base, 'LICENSE'));
  if (includeTests) {
    await writeFile(path.join(base, 'runtime.test.mjs'), 'test("noop");\n');
    await mkdir(path.join(base, '__tests__'), { recursive: true });
    await writeFile(path.join(base, '__tests__', 'helper.mjs'), 'export const helper = 1;\n');
  }
}

// Synthetic vendored fork: runtime files, dependencies, LICENSE/README, tests.
// Used for tests that exercise filters/forms independent of the real
// extensions/pi-queue tree; the copy semantics under test are identical.
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
  // The installer itself imports minimatch (Pi pattern semantics for the
  // rpiv-todo migration), so the fixture closure must include it too.
  const seen = new Map();
  for (const dep of ['proper-lockfile', 'html-to-text', 'ipaddr.js', 'minimatch']) {
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

// Synthetic managed Atelier fork with the pristine npm 0.10.1 layout. Used
// for tests that exercise copy filters and settings forms independent of the
// real extensions/pi-atelier tree.
async function writeFixtureAtelier(root, { includeTests = true } = {}) {
  const base = path.join(root, 'extensions', 'pi-atelier');
  await mkdir(path.join(base, 'extensions'), { recursive: true });
  await mkdir(path.join(base, 'src'), { recursive: true });
  await mkdir(path.join(base, 'assets'), { recursive: true });
  await writeFile(path.join(base, 'extensions', 'index.ts'), 'import { footer } from "../src/footer.mjs";\nexport default footer;\n');
  await writeFile(path.join(base, 'src', 'footer.mjs'), 'export const footer = () => "atelier";\n');
  await writeFile(path.join(base, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  await writeFile(path.join(base, 'LICENSE'), 'MIT\n');
  await writeFile(path.join(base, 'README.md'), '# pi-atelier fork\n');
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'pi-atelier', version: '0.10.1', private: true }) + '\n');
  if (includeTests) {
    await writeFile(path.join(base, 'src', 'footer.test.mjs'), 'test("noop");\n');
    await mkdir(path.join(base, '__tests__'), { recursive: true });
    await writeFile(path.join(base, '__tests__', 'helper.mjs'), 'export const helper = 1;\n');
  }
}

// Synthetic vendored rpiv-todo fork: entry point, vendored rpiv-config runtime
// with its LICENSE, package metadata, tests of any shape. Mirrors the shape of
// the real extensions/pi-todo tree; the real tree is exercised by the loader
// smoke test below.
async function writeFixtureTodo(root, { includeTests = true } = {}) {
  const base = path.join(root, 'extensions', 'pi-todo');
  await mkdir(path.join(base, 'vendor', 'rpiv-config'), { recursive: true });
  await writeFile(path.join(base, 'index.ts'), 'import { config } from "./vendor/rpiv-config/index.js";\nexport const todoTool = config;\n');
  await writeFile(path.join(base, 'config.ts'), 'export { config };\n');
  await writeFile(path.join(base, 'vendor', 'rpiv-config', 'index.ts'), 'export const config = { tool: "todo" };\n');
  await writeFile(path.join(base, 'vendor', 'rpiv-config', 'LICENSE'), 'MIT\n');
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: '@juicesharp/rpiv-todo', version: '2.9.0' }) + '\n');
  await writeFile(path.join(base, 'LICENSE'), 'MIT\n');
  await writeFile(path.join(base, 'README.md'), '# rpiv-todo fork\n');
  if (includeTests) {
    await mkdir(path.join(base, 'tests'), { recursive: true });
    await writeFile(path.join(base, 'tests', 'fork.test.mjs'), 'test("noop");\n');
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
    await writeFixtureUsage(sourceRoot);
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
      extensions: ['/existing/extension.ts', path.join(sourceRoot, 'extensions/pi-usage/index.ts')],
    };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    const credentials = '{"token":"fixture-secret"}\n';
    const usageConfig = '{"enabled":true}\n';
    await writeFile(path.join(agentDir, 'credentials.json'), credentials);
    await mkdir(path.join(agentDir, 'config'), { recursive: true });
    await writeFile(path.join(agentDir, 'config', 'pi-usage.json'), usageConfig);
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

    // pi-usage is copied as a complete runtime tree, but tests are not
    // shipped. Its installed index is the only registration and the checkout
    // development entry is removed.
    const installedUsage = path.join(agentDir, 'piastra/package/extensions/pi-usage');
    const usageDevelopment = path.join(sourceRoot, 'extensions/pi-usage/index.ts');
    assert.match(await readFile(path.join(installedUsage, 'index.ts'), 'utf8'), /runtime\.mjs/);
    assert.match(await readFile(path.join(installedUsage, 'runtime.mjs'), 'utf8'), /pi-usage-runtime/);
    await readFile(path.join(installedUsage, 'LICENSE'), 'utf8');
    assert.equal(existsSync(path.join(installedUsage, 'runtime.test.mjs')), false);
    assert.equal(existsSync(path.join(installedUsage, '__tests__')), false);
    assert.equal(count(installed.extensions, path.join(installedUsage, 'index.ts')), 1);
    assert.equal(installed.extensions.includes(usageDevelopment), false);
    assert.equal(await readFile(path.join(agentDir, 'credentials.json'), 'utf8'), credentials);
    assert.equal(await readFile(path.join(agentDir, 'config', 'pi-usage.json'), 'utf8'), usageConfig);

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
    assert.equal(count(rerun.extensions, path.join(agentDir, 'piastra/package/extensions/pi-usage/index.ts')), 1);
    assert.deepEqual(rerun.packages, installed.packages);
    assert.equal(await readFile(path.join(agentDir, 'credentials.json'), 'utf8'), credentials);
    assert.equal(await readFile(path.join(agentDir, 'config', 'pi-usage.json'), 'utf8'), usageConfig);
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
    await writeFixtureUsage(sourceRoot);
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
    await writeFixtureUsage(sourceRoot);
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

test('real repo install is self-contained: installed web.mjs extracts HTML in an unrelated directory', async () => {
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


async function writeAtelierSources(sourceRoot) {
  for (const file of supportFiles) {
    await mkdir(path.join(sourceRoot, path.dirname(file)), { recursive: true });
    await cp(path.join(repoRoot, file), path.join(sourceRoot, file));
  }
  await writeFixtureUsage(sourceRoot);
  await writeFixtureFork(sourceRoot);
  await writeFixtureAtelier(sourceRoot);
  await writeRuntimeDependency(sourceRoot);
  await writeToolRuntime(sourceRoot);
}

test('--atelier opts in: managed fork installed self-contained, upstream package disabled but kept, dev entry removed, config untouched', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
  try {
    await writeAtelierSources(sourceRoot);
    const managedIndex = path.join(agentDir, 'piastra', 'package', 'extensions', 'pi-atelier', 'extensions', 'index.ts');
    const developmentEntry = path.join(sourceRoot, 'extensions', 'pi-atelier', 'extensions', 'index.ts');
    const settings = {
      customSetting: true,
      unrelated: { nested: [1, 2, 3] },
      packages: [
        'npm:keep-me',
        'npm:pi-atelier',
        'npm:pi-atelier@*',
        { source: 'npm:pi-atelier@>=0.10.0 <0.11.0', prompts: [] },
        'npm:pi-atelier-other',
        {
          source: 'npm:pi-atelier@0.10.1',
          commands: [],
          skills: ['planning'],
        },
        { source: 'pi-atelier-other-entry', skills: [] },
      ],
      extensions: ['/existing/extension.ts', developmentEntry],
    };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    // Per-install config lives at agentDir/pi-atelier.json (not under a
    // subdirectory); the installer must never touch it.
    const atelierConfigContents = '{"agent":"atelier","showSidebar":true}\n';
    await writeFile(path.join(agentDir, 'pi-atelier.json'), atelierConfigContents);
    await runInstaller(sourceRoot, agentDir, { atelier: true });
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));

    // Unrelated settings survive untouched.
    assert.equal(installed.customSetting, true);
    assert.deepEqual(installed.unrelated, { nested: [1, 2, 3] });

    // Upstream npm:pi-atelier entries are disabled via extensions: [] but kept
    // as packages; extra fields on object entries are preserved.
    assert.deepEqual(
      installed.packages.find((p) => typeof p === 'object' && p?.source === 'npm:pi-atelier'),
      { source: 'npm:pi-atelier', extensions: [] },
    );
    assert.deepEqual(
      installed.packages.find((p) => typeof p === 'object' && p?.source === 'npm:pi-atelier@0.10.1'),
      { source: 'npm:pi-atelier@0.10.1', commands: [], skills: ['planning'], extensions: [] },
    );
    assert.deepEqual(
      installed.packages.find((p) => p?.source === 'npm:pi-atelier@*'),
      { source: 'npm:pi-atelier@*', extensions: [] },
    );
    assert.deepEqual(
      installed.packages.find((p) => p?.source === 'npm:pi-atelier@>=0.10.0 <0.11.0'),
      { source: 'npm:pi-atelier@>=0.10.0 <0.11.0', prompts: [], extensions: [] },
    );
    assert.equal(installed.packages.includes('npm:pi-atelier-other'), true);
    assert.equal(installed.packages.some((p) => typeof p === 'string' && /^npm:pi-atelier(?:@|$)/.test(p)), false);
    assert.equal(installed.packages.some((p) => (typeof p === 'string' ? p : p?.source) === 'npm:keep-me'), true);
    assert.deepEqual(
      installed.packages.filter((p) => typeof p === 'object' && p.skills && p.source !== 'npm:pi-atelier@0.10.1'),
      [{ source: 'pi-atelier-other-entry', skills: [] }],
    );

    // The fork is installed recursively as a self-contained copy: index,
    // dependency, src, assets, LICENSE, README, package.json; tests excluded.
    const installedPkg = path.join(agentDir, 'piastra/package/extensions/pi-atelier');
    const indexSource = await readFile(path.join(installedPkg, 'extensions', 'index.ts'), 'utf8');
    assert.match(indexSource, /footer\.mjs/);
    await readFile(path.join(installedPkg, 'src', 'footer.mjs'), 'utf8');
    await readFile(path.join(installedPkg, 'assets', 'logo.svg'), 'utf8');
    await readFile(path.join(installedPkg, 'LICENSE'), 'utf8');
    await readFile(path.join(installedPkg, 'README.md'), 'utf8');
    await readFile(path.join(installedPkg, 'package.json'), 'utf8');
    assert.equal(existsSync(path.join(installedPkg, 'src', 'footer.test.mjs')), false);
    assert.equal(existsSync(path.join(installedPkg, '__tests__')), false);

    // The managed index is registered exactly once; the current checkout's
    // development entry for this fork is gone.
    assert.equal(count(installed.extensions, managedIndex), 1);
    assert.equal(installed.extensions.includes(developmentEntry), false);
    for (const entry of installed.extensions) {
      assert.notEqual(entry, developmentEntry);
      assert.doesNotMatch(entry, /\.\.[\\/]/);
    }

    // Per-install config (agentDir/pi-atelier.json) is byte-for-byte untouched.
    assert.equal(await readFile(path.join(agentDir, 'pi-atelier.json'), 'utf8'), atelierConfigContents);
    assert.equal(existsSync(path.join(agentDir, 'config/pi-atelier.json')), false);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

// Real-fork smoke test. Opt-in via --atelier against the actual repo so the
// installer copies the actual extensions/pi-atelier tree (npm layout), then the
// installed entry point is loaded through Pi's own jiti extension loader and
// must register the /atelier command with zero load errors.
test('real atelier fork smoke: installer ships the real tree and Pi loader registers /atelier from the installed copy', async () => {
  const realSourceIndex = path.join(repoRoot, 'extensions', 'pi-atelier', 'extensions', 'index.ts');
  assert.ok(existsSync(realSourceIndex), 'vendored Atelier entry must exist');
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-real-'));
  const emptyCwd = await mkdtemp(path.join(tmpdir(), 'piastra-cwd-'));
  const piSaved = process.env.PI_CODING_AGENT_DIR;
  try {
    const devEntry = path.join(repoRoot, 'extensions', 'pi-atelier', 'extensions', 'index.ts');
    const settings = {
      packages: ['npm:keep-me', 'npm:pi-atelier@0.10.1', { source: 'npm:pi-atelier', skills: [] }],
      extensions: ['/existing/extension.ts', devEntry],
    };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    await runInstaller(repoRoot, agentDir, { atelier: true });
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));

    // Real tree shipped recursively: index + src modules + assets + LICENSE +
    // README + package.json present; tests of any shape excluded.
    const installedPkg = path.join(agentDir, 'piastra/package/extensions/pi-atelier');
    const indexSource = await readFile(path.join(installedPkg, 'extensions', 'index.ts'), 'utf8');
    assert.match(indexSource, /registerCommand\("atelier"/);
    for (const src of ['src/state.ts', 'src/sidebar.ts', 'src/config.ts', 'src/footer.ts', 'src/types.ts']) {
      await readFile(path.join(installedPkg, ...src.split('/')), 'utf8');
    }
    await readFile(path.join(installedPkg, 'LICENSE'), 'utf8');
    await readFile(path.join(installedPkg, 'README.md'), 'utf8');
    await readFile(path.join(installedPkg, 'package.json'), 'utf8');
    await readFile(path.join(installedPkg, 'assets', 'preview.png'));
    // No test files ship, whatever directory they lived in upstream.
    assert.equal(existsSync(path.join(installedPkg, 'tests', 'baseline.test.mjs')), false);
    assert.deepEqual(
      (await readdir(installedPkg, { recursive: true })).filter((f) => f.includes('.test.') || f.includes('__tests__')),
      [],
    );

    // Registration: managed index exactly once, development checkout entry gone,
    // upstream package disabled but kept as a package.
    const managedIndex = path.join(agentDir, 'piastra', 'package', 'extensions', 'pi-atelier', 'extensions', 'index.ts');
    assert.equal(count(installed.extensions, managedIndex), 1);
    assert.equal(installed.extensions.includes(devEntry), false);
    assert.deepEqual(
      installed.packages.find((p) => typeof p === 'object' && p?.source === 'npm:pi-atelier'),
      { source: 'npm:pi-atelier', skills: [], extensions: [] },
    );
    // The versioned upstream entry (string form) is converted to an object and disabled.
    assert.deepEqual(
      installed.packages.find((p) => typeof p === 'object' && p?.source === 'npm:pi-atelier@0.10.1'),
      { source: 'npm:pi-atelier@0.10.1', extensions: [] },
    );

    // Load the installed entry through Pi's own extension loader (jiti, with
    // the same aliases pi uses for @earendil-works packages and TS .js->.ts
    // relative imports), not via a direct import of the TS source.
    process.env.PI_CODING_AGENT_DIR = agentDir; // getAgentDir() reads this per call
    const piEntryUrl = new URL(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const loaderUrl = new URL('./core/extensions/loader.js', piEntryUrl); // dist/index.js -> dist/core/extensions/loader.js
    const { loadExtensions } = await import(loaderUrl.href);
    const result = await loadExtensions([managedIndex], emptyCwd);
    assert.deepEqual(result.errors, []);
    const loaded = result.extensions.find((e) => e.path === managedIndex);
    assert.ok(loaded, 'installed atelier entry should load');
    assert.ok(loaded.commands.has('atelier'), 'installed copy registers the /atelier command');
    assert.ok(Array.from(loaded.handlers.keys()).includes('session_start'));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await rm(emptyCwd, { recursive: true, force: true });
    if (piSaved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = piSaved;
  }
});

test('without --atelier and without a managed entry, Atelier packages and settings are left untouched', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
  try {
    await writeAtelierSources(sourceRoot);
    const atelierPackage = { source: 'npm:pi-atelier@0.10.1', commands: [] };
    const settings = {
      customSetting: true,
      packages: ['npm:keep-me', 'npm:pi-atelier@0.10.1', atelierPackage],
      extensions: ['/existing/extension.ts'],
    };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    await runInstaller(sourceRoot, agentDir);
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));

    // The bare/versioned upstream Atelier entries are neither disabled nor
    // removed, and the managed fork is neither copied nor registered.
    assert.deepEqual(installed.packages, ['npm:keep-me', 'npm:pi-atelier@0.10.1', atelierPackage]);
    assert.equal(existsSync(path.join(agentDir, 'piastra/package/extensions/pi-atelier')), false);
    assert.equal(
      installed.extensions.some((entry) => entry.includes('pi-atelier')),
      false,
    );
    assert.equal(installed.customSetting, true);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test('repeat install without --atelier keeps updating the managed fork once it is registered', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
  try {
    await writeAtelierSources(sourceRoot);
    const managedIndex = path.join(agentDir, 'piastra', 'package', 'extensions', 'pi-atelier', 'extensions', 'index.ts');
    const settings = { packages: ['npm:pi-atelier@0.10.1'], extensions: [] };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    await runInstaller(sourceRoot, agentDir, { atelier: true });
    const first = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    assert.deepEqual(first.packages, [{ source: 'npm:pi-atelier@0.10.1', extensions: [] }]);
    assert.equal(count(first.extensions, managedIndex), 1);

    // Change the vendored fork and rerun WITHOUT the flag: the managed copy
    // must be updated, not skipped.
    await writeFile(path.join(sourceRoot, 'extensions', 'pi-atelier', 'src', 'footer.mjs'), 'export const footer = () => "updated";\n');
    await runInstaller(sourceRoot, agentDir);
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(count(installed.extensions, managedIndex), 1);
    assert.deepEqual(installed.extensions, first.extensions);
    const footer = await readFile(path.join(agentDir, 'piastra/package/extensions/pi-atelier/src/footer.mjs'), 'utf8');
    assert.match(footer, /"updated"/);
    // The upstream package stays present and disabled.
    assert.deepEqual(installed.packages, [{ source: 'npm:pi-atelier@0.10.1', extensions: [] }]);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test('--atelier with a missing fork fails without saving settings or disabling upstream', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
  try {
    await writeAtelierSources(sourceRoot);
    await rm(path.join(sourceRoot, 'extensions', 'pi-atelier'), { recursive: true, force: true });
    const settings = {
      customSetting: true,
      packages: ['npm:keep-me', 'npm:pi-atelier@0.10.1'],
      extensions: ['/existing/extension.ts'],
    };
    const serialized = JSON.stringify(settings);
    await writeFile(path.join(agentDir, 'settings.json'), serialized);
    await assert.rejects(runInstaller(sourceRoot, agentDir, { atelier: true }), /pi-atelier/);
    // Settings are byte-for-byte untouched: the upstream entry is neither
    // disabled nor removed and no managed directory was created.
    const installed = await readFile(path.join(agentDir, 'settings.json'), 'utf8');
    assert.equal(installed, serialized);
    assert.equal(existsSync(path.join(agentDir, 'piastra/package/extensions/pi-atelier')), false);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// pi-todo fork (@juicesharp/rpiv-todo) migration
// ---------------------------------------------------------------------------

async function writeTodoSources(sourceRoot) {
  for (const file of supportFiles) {
    await mkdir(path.join(sourceRoot, path.dirname(file)), { recursive: true });
    await cp(path.join(repoRoot, file), path.join(sourceRoot, file));
  }
  await writeFixtureUsage(sourceRoot);
  await writeFixtureFork(sourceRoot);
  await writeFixtureTodo(sourceRoot);
  await writeRuntimeDependency(sourceRoot);
  await writeToolRuntime(sourceRoot);
}

// Isolated XDG config layer: proves the installer (and the loaded fork) never
// write user rpiv-todo config or history (the vendored copy resolves config
// exactly like upstream, from this temp layer).
function makeXdgDir() {
  return mkdtemp(path.join(tmpdir(), 'piastra-xdg-'));
}

test('enabled upstream rpiv-todo entries migrate: bare, versioned, ranged, and object forms disabled with fields preserved', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
  const xdgDir = await makeXdgDir();
  try {
    await writeTodoSources(sourceRoot);
    const managedIndex = path.join(agentDir, 'piastra', 'package', 'extensions', 'pi-todo', 'index.ts');
    const developmentEntry = path.join(sourceRoot, 'extensions', 'pi-todo', 'index.ts');
    const settings = {
      customSetting: true,
      unrelated: { nested: [1, 2, 3] },
      packages: [
        'npm:keep-me',
        'npm:@juicesharp/rpiv-todo',
        'npm:@juicesharp/rpiv-todo@2.9.0',
        'npm:@juicesharp/rpiv-todo@>=2.0.0 <3.0.0',
        { source: 'npm:@juicesharp/rpiv-todo@2.8.1', commands: [], skills: ['plan'] },
        { source: 'npm:@juicesharp/rpiv-todo@2.7.0', extensions: [] },
        { source: 'npm:@juicesharp/rpiv-todo@2.6.0', autoload: false },
        { source: 'npm:@juicesharp/other-package', skills: [] },
      ],
      extensions: ['/existing/extension.ts', developmentEntry],
    };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    await runInstaller(sourceRoot, agentDir, { env: { XDG_CONFIG_HOME: xdgDir } });
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));

    // Unrelated settings and packages survive untouched.
    assert.equal(installed.customSetting, true);
    assert.deepEqual(installed.unrelated, { nested: [1, 2, 3] });
    assert.equal(installed.packages.includes('npm:keep-me'), true);
    assert.deepEqual(
      installed.packages.filter((p) => typeof p === 'object' && p?.source === 'npm:@juicesharp/other-package'),
      [{ source: 'npm:@juicesharp/other-package', skills: [] }],
    );

    // Every upstream form (bare, versioned, ranged; string or object) is
    // disabled via extensions: [] while the package entry and its other fields
    // are preserved. An entry already disabled via autoload: false keeps that
    // marker and gains extensions: [] as well.
    assert.deepEqual(
      installed.packages.find((p) => p?.source === 'npm:@juicesharp/rpiv-todo'),
      { source: 'npm:@juicesharp/rpiv-todo', extensions: [] },
    );
    assert.deepEqual(
      installed.packages.find((p) => p?.source === 'npm:@juicesharp/rpiv-todo@2.9.0'),
      { source: 'npm:@juicesharp/rpiv-todo@2.9.0', extensions: [] },
    );
    assert.deepEqual(
      installed.packages.find((p) => p?.source === 'npm:@juicesharp/rpiv-todo@>=2.0.0 <3.0.0'),
      { source: 'npm:@juicesharp/rpiv-todo@>=2.0.0 <3.0.0', extensions: [] },
    );
    assert.deepEqual(
      installed.packages.find((p) => p?.source === 'npm:@juicesharp/rpiv-todo@2.8.1'),
      { source: 'npm:@juicesharp/rpiv-todo@2.8.1', commands: [], skills: ['plan'], extensions: [] },
    );
    assert.deepEqual(
      installed.packages.find((p) => p?.source === 'npm:@juicesharp/rpiv-todo@2.7.0'),
      { source: 'npm:@juicesharp/rpiv-todo@2.7.0', extensions: [] },
    );
    assert.deepEqual(
      installed.packages.find((p) => p?.source === 'npm:@juicesharp/rpiv-todo@2.6.0'),
      { source: 'npm:@juicesharp/rpiv-todo@2.6.0', autoload: false, extensions: [] },
    );
    assert.equal(installed.packages.some((p) => typeof p === 'string' && /^npm:@juicesharp\/rpiv-todo/.test(p)), false);

    // The fork is copied recursively and self-contained: index, config module,
    // vendored dependency with its LICENSE, package metadata, LICENSE, README;
    // tests of any shape excluded; the managed index registered exactly once
    // and the current checkout's development entry removed.
    const installedPkg = path.join(agentDir, 'piastra/package/extensions/pi-todo');
    const indexSource = await readFile(path.join(installedPkg, 'index.ts'), 'utf8');
    assert.match(indexSource, /vendor\/rpiv-config\/index\.js/);
    await readFile(path.join(installedPkg, 'config.ts'), 'utf8');
    await readFile(path.join(installedPkg, 'vendor', 'rpiv-config', 'index.ts'), 'utf8');
    await readFile(path.join(installedPkg, 'vendor', 'rpiv-config', 'LICENSE'), 'utf8');
    await readFile(path.join(installedPkg, 'package.json'), 'utf8');
    await readFile(path.join(installedPkg, 'LICENSE'), 'utf8');
    await readFile(path.join(installedPkg, 'README.md'), 'utf8');
    assert.equal(existsSync(path.join(installedPkg, 'tests')), false);
    assert.equal(count(installed.extensions, managedIndex), 1);
    assert.equal(installed.extensions.includes(developmentEntry), false);
    for (const entry of installed.extensions) {
      assert.notEqual(entry, developmentEntry);
      assert.doesNotMatch(entry, /\.\.[\\/]/);
    }

    // No user XDG writes: the isolated config layer stays empty.
    assert.deepEqual(await readdir(xdgDir).catch(() => []), []);

    // Idempotence: rerunning keeps a single managed registration and the
    // disabled upstream forms stable.
    await runInstaller(sourceRoot, agentDir, { env: { XDG_CONFIG_HOME: xdgDir } });
    const rerun = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    assert.deepEqual(rerun.extensions, installed.extensions);
    assert.equal(count(rerun.extensions, managedIndex), 1);
    assert.deepEqual(rerun.packages, installed.packages);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await rm(xdgDir, { recursive: true, force: true });
  }
});

test('without an enabled upstream rpiv-todo entry and without a managed registration, todo packages and settings are left untouched', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
  try {
    await writeTodoSources(sourceRoot);
    const disabledExtensions = { source: 'npm:@juicesharp/rpiv-todo', extensions: [] };
    const disabledAutoload = { source: 'npm:@juicesharp/rpiv-todo@2.9.0', autoload: false };
    const settings = {
      customSetting: true,
      packages: ['npm:keep-me', disabledExtensions, disabledAutoload],
      extensions: ['/existing/extension.ts'],
    };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    await runInstaller(sourceRoot, agentDir);
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));

    // Nothing changes: the disabled upstream entries are neither touched nor
    // re-disabled, and the managed fork is neither copied nor registered.
    assert.deepEqual(installed.packages, ['npm:keep-me', disabledExtensions, disabledAutoload]);
    assert.equal(existsSync(path.join(agentDir, 'piastra/package/extensions/pi-todo')), false);
    assert.equal(
      installed.extensions.some((entry) => entry.includes('pi-todo')),
      false,
    );
    assert.equal(installed.customSetting, true);

    // Same with no todo package configured at all: no implicit enable.
    const bareAgentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
    try {
      const bareSettings = { customSetting: true, packages: ['npm:keep-me'], extensions: ['/existing/extension.ts'] };
      await writeFile(path.join(bareAgentDir, 'settings.json'), JSON.stringify(bareSettings));
      await runInstaller(sourceRoot, bareAgentDir);
      const bareInstalled = JSON.parse(await readFile(path.join(bareAgentDir, 'settings.json'), 'utf8'));
      assert.deepEqual(bareInstalled.packages, ['npm:keep-me']);
      assert.equal(existsSync(path.join(bareAgentDir, 'piastra/package/extensions/pi-todo')), false);
      assert.equal(
        bareInstalled.extensions.some((entry) => entry.includes('pi-todo')),
        false,
      );
    } finally {
      await rm(bareAgentDir, { recursive: true, force: true });
    }
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

// Pi's own package filter semantics (dist/core/package-manager.js
// applyPatterns) decide whether a settings entry enables the upstream
// package's sole extension file: plain glob patterns include (no plain
// pattern means all), `!glob` excludes, `+path` exact restores it after an
// exclusion, `-path` exact finally removes it. Entries whose filters disable
// index.ts must NOT trigger the migration and are left byte-for-byte
// untouched; entries whose filters still enable it (including restored ones)
// migrate exactly like unfiltered enabled entries. Nothing is enabled
// implicitly.
test('rpiv-todo filter semantics: Pi applyPatterns decides migration, disabled filters leave settings untouched, enabled filters still migrate', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  try {
    await writeTodoSources(sourceRoot);
    // Every case gets a fresh agent dir so cases are independent.
    const disabledCases = [
      ['!index.ts'], // glob exclusion of the sole file
      ['-index.ts'], // exact final exclusion
      ['other.ts'], // plain include that does not match the sole file
      ['-.\\index.ts'], // exact overrides normalize Windows dot-prefixes
      ['!*.ts'], // glob exclusion covering the sole file
      ['!*.ts', '+other.ts'], // +override restores another file only
      ['index.*', '!index.ts', '+index.ts', '-index.ts'], // -precedence beats +restore
    ];
    const enabledCases = [
      ['*.ts'], // plain glob include matching the sole file
      ['index.ts'], // exact-looking plain include (still glob semantics)
      ['!other.ts'], // no plain includes: all enabled, exclusion misses
      ['!*.ts', '+.\\index.ts'], // exact Windows path restores the entry
      ['!*.ts', '+index.ts'], // +override restores the excluded sole file
    ];
    for (const patterns of disabledCases) {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
      try {
        const entry = { source: 'npm:@juicesharp/rpiv-todo@2.9.0', extensions: patterns };
        const settings = { customSetting: true, packages: [entry], extensions: ['/existing/extension.ts'] };
        await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
        await runInstaller(sourceRoot, agentDir);
        const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
        assert.deepEqual(installed.packages, [entry], `disabled case left untouched: ${JSON.stringify(patterns)}`);
        assert.equal(existsSync(path.join(agentDir, 'piastra/package/extensions/pi-todo')), false);
        assert.equal(installed.extensions.some((e) => e.includes('pi-todo')), false);
        assert.equal(installed.customSetting, true);
      } finally {
        await rm(agentDir, { recursive: true, force: true });
      }
    }
    for (const patterns of enabledCases) {
      const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
      try {
        const settings = {
          packages: ['npm:keep-me', { source: 'npm:@juicesharp/rpiv-todo@2.9.0', extensions: patterns }],
          extensions: ['/existing/extension.ts'],
        };
        await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
        await runInstaller(sourceRoot, agentDir);
        const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
        assert.deepEqual(
          installed.packages.find((p) => p?.source === 'npm:@juicesharp/rpiv-todo@2.9.0'),
          { source: 'npm:@juicesharp/rpiv-todo@2.9.0', extensions: [] },
          `enabled filter must migrate: ${JSON.stringify(patterns)}`,
        );
        assert.equal(count(installed.extensions, path.join(agentDir, 'piastra', 'package', 'extensions', 'pi-todo', 'index.ts')), 1);
        await readFile(path.join(agentDir, 'piastra/package/extensions/pi-todo/index.ts'), 'utf8');
        assert.equal(installed.packages.includes('npm:keep-me'), true);
      } finally {
        await rm(agentDir, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test('repeat install without flags keeps updating the managed todo fork once it is registered', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
  try {
    await writeTodoSources(sourceRoot);
    const managedIndex = path.join(agentDir, 'piastra', 'package', 'extensions', 'pi-todo', 'index.ts');
    const settings = { packages: ['npm:@juicesharp/rpiv-todo@2.9.0'], extensions: [] };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    await runInstaller(sourceRoot, agentDir);
    const first = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    assert.deepEqual(first.packages, [{ source: 'npm:@juicesharp/rpiv-todo@2.9.0', extensions: [] }]);
    assert.equal(count(first.extensions, managedIndex), 1);

    // Change the vendored fork and rerun WITHOUT any flags: the managed copy
    // must be updated (the managed registration itself counts as active), and
    // the upstream package stays present and disabled.
    await writeFile(path.join(sourceRoot, 'extensions', 'pi-todo', 'config.ts'), 'export { config }; // updated\n');
    await runInstaller(sourceRoot, agentDir);
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(count(installed.extensions, managedIndex), 1);
    assert.deepEqual(installed.extensions, first.extensions);
    const configSource = await readFile(path.join(agentDir, 'piastra/package/extensions/pi-todo/config.ts'), 'utf8');
    assert.match(configSource, /updated/);
    assert.deepEqual(installed.packages, [{ source: 'npm:@juicesharp/rpiv-todo@2.9.0', extensions: [] }]);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test('missing active pi-todo fork fails before saving settings, leaving upstream settings unchanged', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
  try {
    await writeTodoSources(sourceRoot);
    // Case 1: the whole fork is absent from the source tree.
    await rm(path.join(sourceRoot, 'extensions', 'pi-todo'), { recursive: true, force: true });
    const settings = {
      customSetting: true,
      packages: ['npm:keep-me', 'npm:@juicesharp/rpiv-todo'],
      extensions: ['/existing/extension.ts'],
    };
    const serialized = JSON.stringify(settings);
    await writeFile(path.join(agentDir, 'settings.json'), serialized);
    await assert.rejects(runInstaller(sourceRoot, agentDir), /pi-todo/);
    // Settings are byte-for-byte untouched: the upstream entry is neither
    // disabled nor removed and no managed directory was created.
    assert.equal(await readFile(path.join(agentDir, 'settings.json'), 'utf8'), serialized);
    assert.equal(existsSync(path.join(agentDir, 'piastra/package/extensions/pi-todo')), false);

    // Case 2: the fork exists but its essential vendored dependency is missing.
    await writeFixtureTodo(sourceRoot);
    await rm(path.join(sourceRoot, 'extensions', 'pi-todo', 'vendor', 'rpiv-config', 'index.ts'));
    await assert.rejects(runInstaller(sourceRoot, agentDir), /rpiv-config/);
    assert.equal(await readFile(path.join(agentDir, 'settings.json'), 'utf8'), serialized);
    assert.equal(existsSync(path.join(agentDir, 'piastra/package/extensions/pi-todo')), false);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

// Real-fork smoke test. --atelier against the actual repo ships the real
// Atelier tree; the enabled upstream rpiv-todo entry migrates the real
// extensions/pi-todo tree. All managed extensions are then loaded through Pi's
// own jiti extension loader: the combined set must register exactly one todo
// tool with no overlay collapse shortcut, and the worker panel module must
// ship with the managed piastra copy.
test('real todo + atelier + piastra loader smoke: single todo tool, no overlay shortcut, worker panel shipped', async () => {
  const realTodoIndex = path.join(repoRoot, 'extensions', 'pi-todo', 'index.ts');
  const realTodoVendorIndex = path.join(repoRoot, 'extensions', 'pi-todo', 'vendor', 'rpiv-config', 'index.ts');
  assert.ok(existsSync(realTodoIndex), 'vendored rpiv-todo entry must exist');
  assert.ok(existsSync(realTodoVendorIndex), 'vendored rpiv-config dependency must exist');
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-real-'));
  const emptyCwd = await mkdtemp(path.join(tmpdir(), 'piastra-cwd-'));
  const xdgDir = await makeXdgDir();
  try {
    const devTodoEntry = realTodoIndex;
    const settings = {
      packages: ['npm:keep-me', 'npm:@juicesharp/rpiv-todo@2.9.0', 'npm:pi-atelier@0.10.1'],
      extensions: ['/existing/extension.ts', devTodoEntry],
    };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    await runInstaller(repoRoot, agentDir, { atelier: true, env: { XDG_CONFIG_HOME: xdgDir } });
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));

    // Registration: managed indexes exactly once, the development checkout
    // entry is gone, and both upstream packages are disabled but kept.
    const managedTodoIndex = path.join(agentDir, 'piastra', 'package', 'extensions', 'pi-todo', 'index.ts');
    const managedAtelierIndex = path.join(agentDir, 'piastra', 'package', 'extensions', 'pi-atelier', 'extensions', 'index.ts');
    assert.equal(count(installed.extensions, managedTodoIndex), 1);
    assert.equal(installed.extensions.includes(devTodoEntry), false);
    assert.equal(count(installed.extensions, managedAtelierIndex), 1);
    assert.deepEqual(
      installed.packages.find((p) => p?.source === 'npm:@juicesharp/rpiv-todo@2.9.0'),
      { source: 'npm:@juicesharp/rpiv-todo@2.9.0', extensions: [] },
    );
    assert.deepEqual(
      installed.packages.find((p) => p?.source === 'npm:pi-atelier@0.10.1'),
      { source: 'npm:pi-atelier@0.10.1', extensions: [] },
    );

    // Real tree shipped recursively, self-contained: index + config + vendored
    // dependency (with its LICENSE) + runtime modules + LICENSE/README/
    // package.json; tests of any shape excluded.
    const installedTodo = path.join(agentDir, 'piastra', 'package', 'extensions', 'pi-todo');
    const indexSource = await readFile(path.join(installedTodo, 'index.ts'), 'utf8');
    assert.match(indexSource, /registerTodoTool/);
    await readFile(path.join(installedTodo, 'config.ts'), 'utf8');
    await readFile(path.join(installedTodo, 'vendor', 'rpiv-config', 'index.ts'), 'utf8');
    await readFile(path.join(installedTodo, 'vendor', 'rpiv-config', 'LICENSE'), 'utf8');
    await readFile(path.join(installedTodo, 'LICENSE'), 'utf8');
    await readFile(path.join(installedTodo, 'README.md'), 'utf8');
    await readFile(path.join(installedTodo, 'package.json'), 'utf8');
    await readFile(path.join(installedTodo, 'locales', 'en.json'), 'utf8');
    await readFile(path.join(installedTodo, 'state', 'store.ts'), 'utf8');
    await readFile(path.join(installedTodo, 'tool', 'sanitize.ts'), 'utf8');
    await readFile(path.join(installedTodo, 'view', 'format.ts'), 'utf8');
    assert.equal(existsSync(path.join(installedTodo, 'tests', 'fork.test.mjs')), false);
    assert.deepEqual(
      (await readdir(installedTodo, { recursive: true })).filter((f) => f.includes('.test.') || f.includes('__tests__')),
      [],
    );

    // The completed worker panel module ships with the managed piastra copy.
    const installedPiastra = path.join(agentDir, 'piastra', 'package', 'extensions', 'piastra');
    await readFile(path.join(installedPiastra, 'worker-panel.ts'), 'utf8');
    for (const file of ['help.mjs', 'help-view.ts']) {
      assert.equal(await readFile(path.join(installedPiastra, file), 'utf8'),
        await readFile(path.join(repoRoot, 'extensions/piastra', file), 'utf8'));
    }

    // Load ALL managed extensions through Pi's own extension loader (jiti,
    // with the same aliases pi uses for @earendil-works packages, typebox, and
    // TS .js->.ts relative imports).
    const xdgSaved = process.env.XDG_CONFIG_HOME;
    const piSaved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir; // getAgentDir() reads this per call
    process.env.XDG_CONFIG_HOME = xdgDir; // rpiv-config must see the temp layer
    try {
      const piEntryUrl = new URL(import.meta.resolve('@earendil-works/pi-coding-agent'));
      const loaderUrl = new URL('./core/extensions/loader.js', piEntryUrl); // dist/index.js -> dist/core/extensions/loader.js
      const { loadExtensions } = await import(loaderUrl.href);
      const result = await loadExtensions(
        installed.extensions.filter((p) => p.startsWith(path.join(agentDir, 'piastra', 'package'))),
        emptyCwd,
      );
      assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
      const loaded = result.extensions.filter((e) => e.path.startsWith(path.join(agentDir, 'piastra', 'package')));
      assert.equal(loaded.length, installed.extensions.length - 1, 'every managed extension entry must load (the fake /existing entry is not loaded)');

      const usageExtensions = loaded.filter((e) => e.commands.has('usage'));
      assert.equal(usageExtensions.length, 1, 'exactly one installed subscription usage command');
      assert.equal(usageExtensions[0].path, path.join(agentDir, 'piastra/package/extensions/pi-usage/index.ts'));
      assert.ok(usageExtensions[0].handlers.has('session_start'));
      assert.ok(usageExtensions[0].handlers.has('session_shutdown'));

      // Help must work from the installed copy, not just the checkout.
      const helpExtensions = loaded.filter((e) => e.commands.has('dispatch-help'));
      assert.equal(helpExtensions.length, 1);
      const notices = [];
      await helpExtensions[0].commands.get('dispatch-help').handler('shortcuts', {
        mode: 'rpc', hasUI: true, ui: { notify: (text) => notices.push(text) },
      });
      assert.equal(notices.length, 1);
      assert.match(notices[0], /Shift\+Tab/);

      // Exactly one extension registers the todo tool across the whole set.
      const todoExtensions = loaded.filter((e) => e.tools.has('todo'));
      assert.equal(todoExtensions.length, 1, 'exactly one managed extension may register the todo tool');
      const todoExtension = todoExtensions[0];
      assert.equal(todoExtension.path, managedTodoIndex);
      assert.ok(todoExtension.commands.has('todos'), '/todos command registered');
      // The PiAstra fork disables the persistent overlay: its collapse/expand
      // shortcut must not be registered.
      assert.equal(todoExtension.shortcuts.size, 0, 'overlay collapse shortcut must not be registered');
      assert.ok(Array.from(todoExtension.handlers.keys()).includes('session_start'));
    } finally {
      if (xdgSaved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = xdgSaved;
      if (piSaved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = piSaved;
    }

    // No user XDG writes happened during install or load.
    assert.deepEqual(await readdir(xdgDir).catch(() => []), []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await rm(emptyCwd, { recursive: true, force: true });
    await rm(xdgDir, { recursive: true, force: true });
  }
});

test('checkout nested under tests/__tests__ ancestors still vendors forks (root-relative runtime filter)', async () => {
  const outer = await mkdtemp(path.join(tmpdir(), 'piastra-outer-'));
  const sourceRoot = path.join(outer, '__tests__', 'tests', 'src');
  await mkdir(sourceRoot, { recursive: true });
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
  try {
    for (const file of supportFiles) {
      await mkdir(path.join(sourceRoot, path.dirname(file)), { recursive: true });
      await cp(path.join(repoRoot, file), path.join(sourceRoot, file));
    }
    await writeFixtureUsage(sourceRoot);
    await writeFixtureFork(sourceRoot);
    await writeFixtureAtelier(sourceRoot);
    await writeFixtureTodo(sourceRoot);
    await writeRuntimeDependency(sourceRoot);
    await writeToolRuntime(sourceRoot);
    const managedQueueIndex = path.join(agentDir, 'piastra', 'package', 'extensions', 'pi-queue', 'index.ts');
    const managedAtelierIndex = path.join(agentDir, 'piastra', 'package', 'extensions', 'pi-atelier', 'extensions', 'index.ts');
    const managedTodoIndex = path.join(agentDir, 'piastra', 'package', 'extensions', 'pi-todo', 'index.ts');
    const settings = {
      customSetting: true,
      packages: ['npm:keep-me', 'npm:@juicesharp/rpiv-todo@2.9.0', 'npm:pi-atelier@0.10.1'],
      extensions: ['/existing/extension.ts'],
    };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    await runInstaller(sourceRoot, agentDir, { atelier: true });
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));

    // The fork roots themselves are not filtered even though the absolute
    // checkout path contains exact `__tests__` and `tests` ancestors.
    const installedQueue = path.join(agentDir, 'piastra/package/extensions/pi-queue');
    await readFile(path.join(installedQueue, 'index.ts'), 'utf8');
    await readFile(path.join(installedQueue, 'lib/state.mjs'), 'utf8');
    assert.equal(existsSync(path.join(installedQueue, 'index.test.ts')), false);
    assert.equal(existsSync(path.join(installedQueue, '__tests__')), false);
    assert.equal(count(installed.extensions, managedQueueIndex), 1);

    const installedAtelier = path.join(agentDir, 'piastra/package/extensions/pi-atelier');
    await readFile(path.join(installedAtelier, 'extensions', 'index.ts'), 'utf8');
    await readFile(path.join(installedAtelier, 'src', 'footer.mjs'), 'utf8');
    assert.equal(existsSync(path.join(installedAtelier, 'src', 'footer.test.mjs')), false);
    assert.equal(existsSync(path.join(installedAtelier, '__tests__')), false);
    assert.equal(count(installed.extensions, managedAtelierIndex), 1);

    const installedTodo = path.join(agentDir, 'piastra/package/extensions/pi-todo');
    await readFile(path.join(installedTodo, 'index.ts'), 'utf8');
    await readFile(path.join(installedTodo, 'vendor', 'rpiv-config', 'index.ts'), 'utf8');
    assert.equal(existsSync(path.join(installedTodo, 'tests')), false);
    assert.equal(count(installed.extensions, managedTodoIndex), 1);

    // Upstream entries are still migrated/disabled with fields preserved.
    assert.deepEqual(
      installed.packages.find((p) => p?.source === 'npm:@juicesharp/rpiv-todo@2.9.0'),
      { source: 'npm:@juicesharp/rpiv-todo@2.9.0', extensions: [] },
    );
    assert.deepEqual(
      installed.packages.find((p) => p?.source === 'npm:pi-atelier@0.10.1'),
      { source: 'npm:pi-atelier@0.10.1', extensions: [] },
    );
    assert.equal(installed.customSetting, true);
  } finally {
    await rm(outer, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});
