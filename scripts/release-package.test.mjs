import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  buildRelease,
  EXCLUDED_DEPS,
  MANAGED_ENTRIES,
  RELEASE_MARKER_FILE,
  RUNTIME_DEPS,
} from './build-release.mjs';

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-root-'));
  const write = (rel, content = '') => {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };
  write('package.json', JSON.stringify({
    name: '@michaelt025/dispatch', version: '0.1.0', private: true, type: 'module',
    description: 'Dispatch test fixture',
    dependencies: { '@earendil-works/pi-coding-agent': '0.85.1' },
    overrides: { express: { qs: '6.16.0' }, '@agegr/pi-web': { next: '16.3.3' } },
  }));
  write('bin/dispatch.mjs', '#!/usr/bin/env node\n');
  write('lib/install-notice.mjs', "console.log('Run dispatch setup');\n");
  write('lib/state.mjs', 'export {};\n');
  write('lib/state.test.mjs', '// excluded\n');
  write('extensions/piastra/help.mjs', 'export {};\n');
  write('extensions/piastra/help-view.ts', 'export {};\n');
  write('config/agents.json', '{"orchestrator":{}}');
  write('config/checks.json', '{}');
  for (const r of ['orchestrator', 'general', 'fast', 'review']) write(`roles/${r}.md`, `# ${r}\n`);
  write('README.md', '# Dispatch\n');
  write('LICENSE', 'MIT License\n');
  write('docs/RELEASE_README.md', '# Packaged Dispatch\n');
  write('THIRD_PARTY_NOTICES.md', '# notices\n');
  write('assets/dispatch.svg', '<svg></svg>');
  for (const entry of MANAGED_ENTRIES) write(entry, '// entry\n');
  for (const lic of [
    'extensions/pi-worktree/LICENSE',
    'extensions/pi-queue/LICENSE',
    'extensions/pi-compact-transcript/LICENSE',
    'extensions/pi-atelier/LICENSE',
    'extensions/pi-todo/LICENSE',
  ]) write(lic, 'MIT fork\n');
  write('extensions/pi-usage/LICENSE', 'Apache License 2.0\n');
  write('extensions/pi-usage/adapter.mjs', 'export {};\n');
  write('extensions/pi-usage/adapter.test.mjs', '// excluded\n');
  // Fixtures that must be excluded from the artifact.
  write('extensions/pi-queue/queue.test.mjs', '// test\n');
  write('extensions/pi-queue/__tests__/x.mjs', '// test\n');
  write('extensions/pi-atelier/tests/y.test.mjs', '// test\n');
  write('extensions/pi-todo/node_modules/leftovers/index.js', '// tooling\n');
  write('extensions/pi-todo/vendor/rpiv-config/index.ts', '// vendor\n');
  write('extensions/pi-todo/vendor/rpiv-config/package.json', '{"name":"x"}');
  write('extensions/piastra/auth.json', '{"token":"secret"}\n');
  write('extensions/piastra/.env', 'SECRET=1\n');
  write('extensions/piastra/.env.local', 'SECRET=1\n');
  return root;
}

function makeWeb(extraDeps = {}, extra = null) {
  const web = mkdtempSync(join(tmpdir(), 'dispatch-web-'));
  const write = (rel, content = '') => {
    const path = join(web, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };
  write('package.json', JSON.stringify({
    name: 'web-fixture', version: '0.0.0', private: true,
    dependencies: {
      '@earendil-works/pi-coding-agent': '^0.85.1',
      express: '4.21.0',
      '@agegr/pi-web': '0.9.1',
      'pi-web-ui': '0.80.0',
      'tau-mirror': '1.0.9',
      ...extraDeps,
    },
  }));
  write('dist/server/index.js', '// server\n');
  write('web/dist/index.html', '<html></html>');
  write('web/public/favicon.ico', 'icon');
  write('LICENSE', 'web license');
  write('README.md', '# web\n');
  if (extra) extra(write);
  return { web, write };
}

describe('buildRelease staging', () => {
  it('stages manifest, file paths, and excludes trials/tests', () => {
    const root = makeRoot();
    const { web } = makeWeb();
    try {
      const outDir = join(root, '.release', 'package');
      const calls = [];
      const result = buildRelease({
        root, webRoot: web, outDir, buildWeb: false,
        run: () => { calls.push(true); return { status: 0 }; },
      });
      assert.equal(calls.length, 0);
      assert.match(readFileSync(join(outDir, 'extensions/pi-usage/LICENSE'), 'utf8'), /Apache/);
      assert.ok(existsSync(join(outDir, 'extensions/pi-usage/adapter.mjs')));
      assert.ok(!existsSync(join(outDir, 'extensions/pi-usage/adapter.test.mjs')));
      const manifest = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
      assert.equal(manifest.name, '@michaelt025/dispatch');
      assert.equal(manifest.version, '0.1.0');
      assert.ok(!('private' in manifest), 'staged manifest must be publishable');
      assert.equal(manifest.license, 'MIT');
      assert.deepEqual(manifest.publishConfig, { access: 'public' });
      assert.equal(manifest.repository.url, 'git+https://github.com/MichaelT025/Dispatch.git');
      assert.deepEqual(manifest.bin, { dispatch: 'bin/dispatch.mjs' });
      assert.deepEqual(manifest.scripts, { postinstall: 'node lib/install-notice.mjs' });
      assert.equal(manifest.type, 'module');
      assert.deepEqual(manifest.engines, { node: '>=22.19.0' });
      for (const [name, range] of Object.entries(RUNTIME_DEPS)) {
        assert.equal(manifest.dependencies[name], range, name);
      }
      assert.equal(manifest.dependencies['@earendil-works/pi-coding-agent'], '0.85.1');
      assert.equal(manifest.dependencies.express, '4.21.0');
      for (const name of EXCLUDED_DEPS) assert.ok(!(name in manifest.dependencies), name);
      assert.ok(!('dependispatchweb' in manifest.dependencies));
      // Security overrides merged, trial override excluded.
      assert.deepEqual(manifest.overrides, { express: { qs: '6.16.0' } });
      for (const entry of MANAGED_ENTRIES) assert.ok(existsSync(join(outDir, entry)), entry);
      assert.ok(existsSync(join(outDir, 'vendor', 'web-ui', 'dist', 'server', 'index.js')));
      assert.ok(existsSync(join(outDir, 'vendor', 'web-ui', 'web', 'dist', 'index.html')));
      assert.ok(existsSync(join(outDir, 'vendor', 'web-ui', 'web', 'public', 'favicon.ico')));
      assert.ok(existsSync(join(outDir, 'vendor', 'web-ui', 'LICENSE')));
      assert.ok(existsSync(join(outDir, 'lib', 'install-notice.mjs')));
      assert.ok(existsSync(join(outDir, 'lib', 'state.mjs')));
      assert.ok(!existsSync(join(outDir, 'lib', 'state.test.mjs')));
      assert.ok(existsSync(join(outDir, 'assets', 'dispatch.svg')));
      assert.match(readFileSync(join(outDir, 'README.md'), 'utf8'), /Packaged Dispatch/);
      assert.ok(existsSync(join(outDir, 'extensions', 'pi-todo', 'vendor', 'rpiv-config', 'index.ts')));
      // Fork licenses retained.
      for (const lic of [
        'extensions/pi-worktree/LICENSE',
        'extensions/pi-queue/LICENSE',
        'extensions/pi-compact-transcript/LICENSE',
        'extensions/pi-atelier/LICENSE',
        'extensions/pi-todo/LICENSE',
      ]) assert.ok(existsSync(join(outDir, lic)), lic);
      // Compact entry is the state-helper index, not a nested extensions entry.
      assert.ok(MANAGED_ENTRIES.includes('extensions/pi-compact-transcript/index.ts'));
      assert.ok(!MANAGED_ENTRIES.includes('extensions/pi-compact-transcript/extensions/compact-transcript.ts'));
      // Production exclusions.
      assert.ok(!existsSync(join(outDir, 'extensions', 'pi-queue', 'queue.test.mjs')));
      assert.ok(!existsSync(join(outDir, 'extensions', 'pi-queue', '__tests__')));
      assert.ok(!existsSync(join(outDir, 'extensions', 'pi-atelier', 'tests')));
      assert.ok(!existsSync(join(outDir, 'extensions', 'pi-todo', 'node_modules')));
      assert.ok(!existsSync(join(outDir, '.git')));
      // Secrets excluded.
      assert.ok(!existsSync(join(outDir, 'extensions', 'piastra', 'auth.json')));
      assert.ok(!existsSync(join(outDir, 'extensions', 'piastra', '.env')));
      assert.ok(!existsSync(join(outDir, 'extensions', 'piastra', '.env.local')));
      // Ownership marker present.
      const marker = JSON.parse(readFileSync(join(outDir, RELEASE_MARKER_FILE), 'utf8'));
      assert.equal(marker.marker, 'dispatch-release');
      assert.equal(marker.version, 1);
      assert.deepEqual(result.manifest, manifest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('copies all lib runtime files and drops symlinked content', () => {
    const root = makeRoot();
    const { web } = makeWeb();
    try {
      mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(join(root, 'lib', 'launcher.mjs'), 'export {};\n');
      const outside = mkdtempSync(join(tmpdir(), 'dispatch-outside-'));
      writeFileSync(join(outside, 'evil.txt'), 'evil');
      try {
        symlinkSync(join(outside, 'evil.txt'), join(root, 'lib', 'linked.txt'));
      } catch {
        // Symlinks unavailable; skip symlink assertion but keep lib copy check.
      }
      const outDir = join(root, '.release', 'package');
      buildRelease({ root, webRoot: web, outDir, buildWeb: false });
      assert.ok(existsSync(join(outDir, 'lib', 'launcher.mjs')));
      assert.ok(!existsSync(join(outDir, 'lib', 'linked.txt'))
        || !readFileSync(join(outDir, 'lib', 'linked.txt'), 'utf8').includes('evil')
        || !existsSync(join(outDir, 'lib', 'linked.txt')));
      rmSync(outside, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects misbuilt web checkouts and missing source artifacts', () => {
    const root = makeRoot();
    const { web } = makeWeb();
    try {
      rmSync(join(web, 'web', 'dist', 'index.html'));
      assert.throws(() => buildRelease({ root, webRoot: web, outDir: join(root, '.release', 'package'), buildWeb: false }), /misbuilt/);
    } finally {
      rmSync(web, { recursive: true, force: true });
    }
    const { web: web2 } = makeWeb();
    try {
      rmSync(join(web2, 'LICENSE'));
      assert.throws(() => buildRelease({ root, webRoot: web2, outDir: join(root, '.release', 'package'), buildWeb: false }), /misbuilt/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(web, { recursive: true, force: true });
      rmSync(web2, { recursive: true, force: true });
    }
    const root2 = makeRoot();
    const { web: web3 } = makeWeb();
    try {
      rmSync(join(root2, 'extensions', 'pi-queue', 'index.ts'));
      assert.throws(() => buildRelease({ root: root2, webRoot: web3, outDir: join(root2, '.release', 'package'), buildWeb: false }), /Source checkout missing/);
      rmSync(join(root2, 'lib', 'state.mjs'));
      assert.throws(() => buildRelease({ root: root2, webRoot: web3, outDir: join(root2, '.release', 'package'), buildWeb: false }), /Source checkout missing/);
      rmSync(join(root2, 'extensions', 'piastra', 'help-view.ts'));
      assert.throws(() => buildRelease({ root: root2, webRoot: web3, outDir: join(root2, '.release', 'package'), buildWeb: false }), /Source checkout missing/);
    } finally {
      rmSync(root2, { recursive: true, force: true });
      rmSync(web3, { recursive: true, force: true });
    }
  });

  it('fails when the web SDK range is incompatible with the pin', () => {
    const root = makeRoot();
    const { web } = makeWeb({ '@earendil-works/pi-coding-agent': '^0.80.0' });
    try {
      assert.throws(() => buildRelease({ root, webRoot: web, outDir: join(root, '.release', 'package'), buildWeb: false }), /does not accept/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(web, { recursive: true, force: true });
    }
  });

  it('refuses source-child, unmanaged, and symlinked outDirs', () => {
    const root = makeRoot();
    const { web } = makeWeb();
    try {
      assert.throws(() => buildRelease({ root, webRoot: web, outDir: root, buildWeb: false }), /overwrite/);
      assert.throws(
        () => buildRelease({ root, webRoot: web, outDir: join(root, '..'), buildWeb: false }),
        /ancestor|overwrite/i,
      );
      assert.throws(
        () => buildRelease({ root, webRoot: web, outDir: join(root, 'extensions', 'staged'), buildWeb: false }),
        /outside \.release/,
      );
      assert.throws(
        () => buildRelease({ root, webRoot: web, outDir: join(root, 'lib', 'staged'), buildWeb: false }),
        /outside \.release/,
      );
      // Foreign non-empty unmanaged dir refused.
      const foreign = mkdtempSync(join(tmpdir(), 'dispatch-foreign-'));
      writeFileSync(join(foreign, 'keep.txt'), 'keep');
      assert.throws(() => buildRelease({ root, webRoot: web, outDir: foreign, buildWeb: false }), /unmanaged/);
      rmSync(foreign, { recursive: true, force: true });
      // Symlinked out target refused.
      const linkBase = mkdtempSync(join(tmpdir(), 'dispatch-link-'));
      const linkTarget = join(linkBase, 'real');
      mkdirSync(linkTarget, { recursive: true });
      const link = join(linkBase, 'link');
      try {
        symlinkSync(linkTarget, link);
        assert.throws(() => buildRelease({ root, webRoot: web, outDir: link, buildWeb: false }), /symlink/i);
      } catch (e) {
        if (!/symlink/i.test(e.message)) throw e;
      } finally {
        rmSync(linkBase, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(web, { recursive: true, force: true });
    }
  });

  it('treats spawn errors, signals, and null status as build failure', () => {
    const root = makeRoot();
    const { web } = makeWeb();
    try {
      assert.throws(
        () => buildRelease({ root, webRoot: web, outDir: join(root, '.release', 'package'), buildWeb: true, run: () => ({ error: new Error('spawn ENOENT'), status: 0 }) }),
        /Web build failed/,
      );
      assert.throws(
        () => buildRelease({ root, webRoot: web, outDir: join(root, '.release', 'package'), buildWeb: true, run: () => ({ status: null, signal: 'SIGKILL' }) }),
        /Web build failed/,
      );
      assert.throws(
        () => buildRelease({ root, webRoot: web, outDir: join(root, '.release', 'package'), buildWeb: true, run: () => ({ status: null }) }),
        /Web build failed/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(web, { recursive: true, force: true });
    }
  });

  it('preserves the old stage when the replacement build fails', () => {
    const root = makeRoot();
    const { web } = makeWeb();
    try {
      const outDir = join(root, '.release', 'package');
      buildRelease({ root, webRoot: web, outDir, buildWeb: false });
      writeFileSync(join(outDir, 'sentinel.txt'), 'old');
      writeFileSync(join(outDir, RELEASE_MARKER_FILE), JSON.stringify({ marker: 'dispatch-release', version: 1 }));
      rmSync(join(root, 'lib', 'state.mjs'));
      assert.throws(() => buildRelease({ root, webRoot: web, outDir, buildWeb: false }), /Source checkout missing/);
      assert.ok(existsSync(join(outDir, 'sentinel.txt')));
      assert.equal(readFileSync(join(outDir, 'sentinel.txt'), 'utf8'), 'old');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(web, { recursive: true, force: true });
    }
  });

  it('never deletes a pre-existing predictable backup directory on rebuild', () => {
    const root = makeRoot();
    const { web } = makeWeb();
    try {
      const outDir = join(root, '.release', 'package');
      buildRelease({ root, webRoot: web, outDir, buildWeb: false });
      const legacyBackup = `${outDir}.backup-${process.pid}`;
      mkdirSync(legacyBackup, { recursive: true });
      writeFileSync(join(legacyBackup, 'sentinel.txt'), 'unowned');
      const second = buildRelease({ root, webRoot: web, outDir, buildWeb: false });
      assert.ok(existsSync(legacyBackup), 'pre-existing predictable backup must remain');
      assert.equal(readFileSync(join(legacyBackup, 'sentinel.txt'), 'utf8'), 'unowned');
      assert.ok(existsSync(join(outDir, RELEASE_MARKER_FILE)));
      assert.equal(second.outDir, outDir);
      const manifest = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
      assert.equal(manifest.name, '@michaelt025/dispatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(web, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite the source repo or an ancestor, and runs injected builds', () => {
    const root = makeRoot();
    const { web } = makeWeb();
    try {
      assert.throws(() => buildRelease({ root, webRoot: web, outDir: root, buildWeb: false }), /overwrite/);
      assert.throws(
        () => buildRelease({ root, webRoot: web, outDir: join(root, '..'), buildWeb: false }),
        /ancestor|overwrite/i,
      );
      const calls = [];
      buildRelease({
        root, webRoot: web, outDir: join(root, '.release', 'package'), buildWeb: true,
        run: (cmd, args, opts) => {
          calls.push([cmd, args, opts?.cwd]);
          return { status: 0 };
        },
      });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0][0], 'npm');
      assert.deepEqual(calls[0][1], ['run', 'build']);
      assert.throws(
        () => buildRelease({ root, webRoot: web, outDir: join(root, '.release', 'package'), buildWeb: true, run: () => ({ status: 1 }) }),
        /Web build failed/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(web, { recursive: true, force: true });
    }
  });
});
