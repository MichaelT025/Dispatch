import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Files the installer requires beyond the pi-queue fork under test.
const supportFiles = [
  'scripts/install-cli.mjs',
  'config/agents.json',
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
  'extensions/pi-ui/index.ts',
  'extensions/pi-worktree/git-worktree.ts',
  'extensions/pi-worktree/LICENSE',
  'extensions/pi-compact-transcript/index.ts',
  'extensions/pi-compact-transcript/extensions/compact-transcript.ts',
  'extensions/pi-compact-transcript/package.json',
  'extensions/pi-compact-transcript/LICENSE',
  'extensions/pi-compact-transcript/README.md',
];

function runInstaller(sourceRoot, agentDir, { atelier = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['scripts/install-cli.mjs', ...(atelier ? ['--atelier'] : [])];
    const child = spawn(process.execPath, args, {
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

// The preference store needs a plain npm runtime dependency that Pi's loader
// does not alias. Synthetic source trees must contain it so the installer can
// bundle it into the standalone copy, exactly like a real checkout.
async function writeRuntimeDependency(root) {
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await cp(path.join(repoRoot, 'node_modules', 'proper-lockfile'), path.join(root, 'node_modules', 'proper-lockfile'), { recursive: true, force: true });
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

function count(list, value) {
  return list.filter((item) => item === value).length;
}

test('installed fork is self-contained: runtime files copied, tests excluded, single index entry; upstream package entries removed and other settings preserved', async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'piastra-src-'));
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-agent-'));
  try {
    for (const file of supportFiles) {
      await mkdir(path.join(sourceRoot, path.dirname(file)), { recursive: true });
      await cp(path.join(repoRoot, file), path.join(sourceRoot, file));
    }
    await writeFixtureFork(sourceRoot);
    await writeRuntimeDependency(sourceRoot);
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
    const workerBridge = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/worker-bridge.mjs'), 'utf8');
    assert.match(workerBridge, /WORKER_CHANNEL/);

    // The per-role preference store ships with the managed copy together with
    // its non-aliased runtime dependency, so the installed extension resolves
    // it without a checkout.
    const prefs = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/prefs.mjs'), 'utf8');
    assert.match(prefs, /proper-lockfile/);
    await readFile(path.join(agentDir, 'piastra/package/node_modules/proper-lockfile/index.js'), 'utf8');

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
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
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
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-installer-'));
  try {
    const settings = {
      customSetting: true,
      packages: ['npm:keep-me', 'npm:@thisux/pi-worktree@1.2.0'],
      extensions: ['/existing/extension.ts'],
    };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    await runInstaller(repoRoot, agentDir);
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
    // The worker guard helper is part of the managed copy; index.ts imports it
    // at runtime, so a missing file would break the installed extension.
    const guard = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/guard.mjs'), 'utf8');
    assert.match(guard, /PIASTRA_WORKER_GUARD_CHANNEL/);
    // The per-role preference store and its bundled dependency ship too.
    const prefs = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/prefs.mjs'), 'utf8');
    assert.match(prefs, /proper-lockfile/);
    await readFile(path.join(agentDir, 'piastra/package/node_modules/proper-lockfile/index.js'), 'utf8');
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});


async function writeAtelierSources(sourceRoot) {
  for (const file of supportFiles) {
    await mkdir(path.join(sourceRoot, path.dirname(file)), { recursive: true });
    await cp(path.join(repoRoot, file), path.join(sourceRoot, file));
  }
  await writeFixtureFork(sourceRoot);
  await writeFixtureAtelier(sourceRoot);
  await writeRuntimeDependency(sourceRoot);
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
    delete process.env.PI_CODING_AGENT_DIR;
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
