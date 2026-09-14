import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, cp, mkdir } from 'node:fs/promises';
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

// The preference store needs a plain npm runtime dependency that Pi's loader
// does not alias. Synthetic source trees must contain it so the installer can
// bundle it into the standalone copy, exactly like a real checkout.
async function writeRuntimeDependency(root) {
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await cp(path.join(repoRoot, 'node_modules', 'proper-lockfile'), path.join(root, 'node_modules', 'proper-lockfile'), { recursive: true, force: true });
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
