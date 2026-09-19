/**
 * Release metadata helper for tag-driven npm publishing.
 *
 * Single source of truth for the immutable Web checkout pin in
 * `config/release.json`. The release workflow (`push` of `v*` tags) and its
 * tests use this module so local validation matches CI validation.
 *
 * Testable entry points:
 * - `loadReleaseConfig({ root })` reads and validates config/release.json.
 * - `readPackageVersion(root)` / `readLockfileVersion(root)`.
 * - `validateReleaseMetadata({ tag, packageVersion, lockfileVersion, config })`
 *   enforces: tag is exactly `v` + root package version, lockfile root
 *   version matches, no prerelease (npm `latest` must never be a prerelease
 *   by accident), and the web SHA is a full 40-hex commit.
 *
 * CLI: `node scripts/release-metadata.mjs --validate --tag v0.1.0 [--root <path>]`
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');
export const DEFAULT_CONFIG_PATH = 'config/release.json';
export const EXPECTED_WEB_REPOSITORY = 'MichaelT025/DispatchWeb';
export const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`Cannot read JSON ${path}: ${error.message}`);
  }
}

export function loadReleaseConfig({ root = DEFAULT_ROOT } = {}) {
  const path = resolve(root, DEFAULT_CONFIG_PATH);
  const raw = readJson(path);
  const web = raw?.web;
  if (!web || typeof web !== 'object') fail(`Release config ${path} must define a "web" object.`);
  if (web.repository !== EXPECTED_WEB_REPOSITORY) {
    fail(`Release config web.repository must be ${EXPECTED_WEB_REPOSITORY} (found ${web.repository}).`);
  }
  if (typeof web.sha !== 'string' || !SHA_PATTERN.test(web.sha)) {
    fail(`Release config web.sha must be a full 40-hex commit SHA (found ${web.sha}).`);
  }
  return { path, webRepository: web.repository, webSha: web.sha };
}

export function readPackageVersion(root = DEFAULT_ROOT) {
  const manifest = readJson(resolve(root, 'package.json'));
  if (typeof manifest.version !== 'string' || !manifest.version) {
    fail('Root package.json must define a version string.');
  }
  return manifest.version;
}

export function readLockfileVersion(root = DEFAULT_ROOT) {
  const lock = readJson(resolve(root, 'package-lock.json'));
  const version = lock?.packages?.['']?.version;
  if (typeof version !== 'string' || !version) {
    fail('package-lock.json packages[""].version must define the root version.');
  }
  return version;
}

/**
 * Validate tag/version/lockfile/config consistency.
 * @returns {{ version: string, webRepository: string, webSha: string, tarballName: string }}
 */
export function validateReleaseMetadata({ tag, packageVersion, lockfileVersion, config } = {}) {
  if (typeof tag !== 'string' || !tag) fail('A tag (e.g. v0.1.0) is required.');
  if (typeof packageVersion !== 'string' || !packageVersion) fail('A root package version is required.');
  if (typeof lockfileVersion !== 'string' || !lockfileVersion) fail('A lockfile root version is required.');
  if (!config || typeof config.webSha !== 'string') fail('A validated release config is required.');

  const expectedTag = `v${packageVersion}`;
  if (tag !== expectedTag) {
    fail(`Tag ${tag} must be exactly v + root package version (${expectedTag}).`);
  }
  if (lockfileVersion !== packageVersion) {
    fail(`package-lock.json version ${lockfileVersion} must match root package version ${packageVersion}.`);
  }
  if (!STABLE_VERSION_PATTERN.test(packageVersion)) {
    if (packageVersion.includes('-') || packageVersion.includes('+')) {
      fail(`Refusing prerelease/build version ${packageVersion}: publish stable versions only for now.`);
    }
    fail(`Root version ${packageVersion} must be stable semver major.minor.patch (e.g. 0.1.0).`);
  }
  if (!SHA_PATTERN.test(config.webSha)) {
    fail(`Web SHA ${config.webSha} must be a full 40-hex commit SHA.`);
  }
  return {
    version: packageVersion,
    webRepository: config.webRepository,
    webSha: config.webSha,
    tarballName: `michaelt025-dispatch-${packageVersion}.tgz`,
  };
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--validate') {
      options.validate = true;
    } else if (arg === '--tag') {
      options.tag = argv[++i];
      if (!options.tag) fail('Missing value for --tag.');
    } else if (arg === '--root') {
      const value = argv[++i];
      if (!value) fail('Missing value for --root.');
      options.root = resolve(value);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

const invoked = resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || !options.validate) {
      process.stdout.write(
        'Usage: node scripts/release-metadata.mjs --validate --tag v<version> [--root <path>]\n',
      );
      process.exit(options.help ? 0 : 1);
    }
    if (!options.tag) fail('Missing required --tag (e.g. --tag v0.1.0).');
    const config = loadReleaseConfig({ root: options.root });
    const packageVersion = readPackageVersion(options.root);
    const lockfileVersion = readLockfileVersion(options.root);
    const result = validateReleaseMetadata({
      tag: options.tag,
      packageVersion,
      lockfileVersion,
      config,
    });
    process.stdout.write(
      `Release metadata OK: tag ${options.tag}, version ${result.version}, web ${result.webRepository}@${result.webSha}, tarball ${result.tarballName}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
