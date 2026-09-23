import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_WEB_REPOSITORY,
  STABLE_VERSION_PATTERN,
  loadReleaseConfig,
  readLockfileVersion,
  readPackageVersion,
  validateReleaseMetadata,
} from './release-metadata.mjs';

const VALID_SHA = '35030893d78386b578364ce72d8f5e7c1054c9e4';

function makeRoot({ version = '0.1.0', lockVersion = '0.1.0', sha = VALID_SHA } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-release-meta-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version }));
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ packages: { '': { version: lockVersion } } }),
  );
  writeFileSync(
    join(root, 'config', 'release.json'),
    JSON.stringify({ web: { repository: EXPECTED_WEB_REPOSITORY, sha } }),
  );
  return root;
}

describe('release-metadata', () => {
  it('loads the repo config and validates a stable release', () => {
    const root = makeRoot();
    try {
      const config = loadReleaseConfig({ root });
      assert.equal(config.webRepository, EXPECTED_WEB_REPOSITORY);
      assert.equal(config.webSha, VALID_SHA);
      assert.equal(readPackageVersion(root), '0.1.0');
      assert.equal(readLockfileVersion(root), '0.1.0');
      const result = validateReleaseMetadata({
        tag: 'v0.1.0',
        packageVersion: '0.1.0',
        lockfileVersion: '0.1.0',
        config,
      });
      assert.equal(result.tarballName, 'michaelt025-dispatch-0.1.0.tgz');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects tag, lockfile, and prerelease mismatches', () => {
    const root = makeRoot();
    try {
      const config = loadReleaseConfig({ root });
      assert.throws(
        () => validateReleaseMetadata({ tag: 'v0.2.0', packageVersion: '0.1.0', lockfileVersion: '0.1.0', config }),
        /exactly v \+ root package version/,
      );
      assert.throws(
        () => validateReleaseMetadata({ tag: 'v0.1.0', packageVersion: '0.1.0', lockfileVersion: '0.1.1', config }),
        /must match root package version/,
      );
      assert.throws(
        () => validateReleaseMetadata({
          tag: 'v1.0.0-beta.1',
          packageVersion: '1.0.0-beta.1',
          lockfileVersion: '1.0.0-beta.1',
          config,
        }),
        /prerelease/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects short or non-hex web SHAs and wrong repositories', () => {
    const short = makeRoot({ sha: '3503089' });
    try {
      assert.throws(() => loadReleaseConfig({ root: short }), /40-hex/);
    } finally {
      rmSync(short, { recursive: true, force: true });
    }
    const root = makeRoot();
    try {
      const config = loadReleaseConfig({ root });
      assert.throws(
        () => validateReleaseMetadata({
          tag: 'v0.1.0',
          packageVersion: '0.1.0',
          lockfileVersion: '0.1.0',
          config: { ...config, webSha: 'not-a-sha' },
        }),
        /40-hex/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const wrong = mkdtempSync(join(tmpdir(), 'dispatch-release-wrong-'));
    try {
      mkdirSync(join(wrong, 'config'), { recursive: true });
      writeFileSync(
        join(wrong, 'config', 'release.json'),
        JSON.stringify({ web: { repository: 'SomeoneElse/DispatchWeb', sha: VALID_SHA } }),
      );
      assert.throws(() => loadReleaseConfig({ root: wrong }), /web\.repository/);
    } finally {
      rmSync(wrong, { recursive: true, force: true });
    }
  });

  it('enforces strict canonical stable semver without dependencies', () => {
    const root = makeRoot();
    try {
      const config = loadReleaseConfig({ root });
      // Canonical stable versions pass the pattern directly.
      assert.match('0.1.0', STABLE_VERSION_PATTERN);
      assert.match('10.20.30', STABLE_VERSION_PATTERN);
      const badVersions = [
        '01.0.0',
        '0.01.0',
        '0.0.01',
        '1.0',
        '1',
        'v1.0.0',
        '1.0.0-beta.1',
        '1.0.0-rc.1',
        '1.0.0+build.1',
        '1.0.0-beta.1+build',
        '1.0.0 ', // trailing space
      ];
      for (const packageVersion of badVersions) {
        assert.equal(STABLE_VERSION_PATTERN.test(packageVersion), false, packageVersion);
        assert.throws(
          () =>
            validateReleaseMetadata({
              tag: `v${packageVersion}`,
              packageVersion,
              lockfileVersion: packageVersion,
              config,
            }),
          /prerelease\/build|stable semver/,
          packageVersion,
        );
      }
      // Prerelease/build variants keep an actionable prerelease message.
      assert.throws(
        () =>
          validateReleaseMetadata({
            tag: 'v1.0.0+build.1',
            packageVersion: '1.0.0+build.1',
            lockfileVersion: '1.0.0+build.1',
            config,
          }),
        /prerelease\/build/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('helper source is dependency-free (no semver/createRequire)', () => {
    const helperPath = fileURLToPath(new URL('./release-metadata.mjs', import.meta.url));
    const source = readFileSync(helperPath, 'utf8');
    assert.doesNotMatch(source, /createRequire/);
    assert.doesNotMatch(source, /require\(['"]semver['"]\)/);
    assert.doesNotMatch(source, /from ['"]semver['"]/);
  });

  it('CLI works from a clean copy without node_modules', () => {
    const helperPath = fileURLToPath(new URL('./release-metadata.mjs', import.meta.url));
    const isolated = mkdtempSync(join(tmpdir(), 'dispatch-release-clean-'));
    try {
      mkdirSync(join(isolated, 'scripts'), { recursive: true });
      mkdirSync(join(isolated, 'config'), { recursive: true });
      copyFileSync(helperPath, join(isolated, 'scripts', 'release-metadata.mjs'));
      writeFileSync(join(isolated, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }));
      writeFileSync(
        join(isolated, 'package-lock.json'),
        JSON.stringify({ packages: { '': { version: '0.1.0' } } }),
      );
      writeFileSync(
        join(isolated, 'config', 'release.json'),
        JSON.stringify({ web: { repository: EXPECTED_WEB_REPOSITORY, sha: VALID_SHA } }),
      );
      // Simulate a clean runner: no node_modules and no other repo files.
      assert.equal(readFileSync(join(isolated, 'package.json'), 'utf8').includes('semver'), false);
      const output = execFileSync(
        process.execPath,
        [join(isolated, 'scripts', 'release-metadata.mjs'), '--validate', '--tag', 'v0.1.0', '--root', isolated],
        { encoding: 'utf8' },
      );
      assert.match(output, /Release metadata OK/);
      // Missing --root value is a clean usage error, not a resolve() TypeError.
      let rootError = null;
      try {
        execFileSync(
          process.execPath,
          [join(isolated, 'scripts', 'release-metadata.mjs'), '--validate', '--tag', 'v0.1.0', '--root'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (error) {
        rootError = error;
      }
      assert.ok(rootError, 'expected CLI to fail on missing --root value');
      const rootStderr = String(rootError.stderr ?? rootError.message ?? '');
      assert.match(rootStderr, /Missing value for --root/);
      assert.doesNotMatch(rootStderr, /ERR_INVALID_ARG_TYPE|TypeError/);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe('release workflow artifact upload', () => {
  it('includes hidden files when uploading from a dot-directory', () => {
    const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    const upload = workflow.split(/\n\s*- name: /).find((step) => step.startsWith('Upload tested tarball'));
    assert.ok(upload, 'release.yml must have the "Upload tested tarball" step');
    // upload-artifact >= 4.4 silently skips dot-directories unless opted in.
    if (/path:\s*\.[^/\s]*\//.test(upload)) assert.match(upload, /include-hidden-files:\s*true/);
  });
});
