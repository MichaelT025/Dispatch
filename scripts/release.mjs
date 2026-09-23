/**
 * Cut a release from a clean, up-to-date `main`:
 *   1. pin config/release.json to DispatchWeb's current `main` commit,
 *   2. bump package.json/package-lock.json to the chosen version,
 *   3. commit, tag `v<version>`, and push both atomically.
 * The pushed tag starts .github/workflows/release.yml, which builds, tests
 * and publishes. Nothing is committed or pushed before you confirm.
 *
 * Usage: npm run release [-- <patch|minor|major|x.y.z>] [--dry-run] [--yes]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG_PATH,
  SHA_PATTERN,
  STABLE_VERSION_PATTERN,
  loadReleaseConfig,
  readLockfileVersion,
  readPackageVersion,
  validateReleaseMetadata,
} from './release-metadata.mjs';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUMPS = ['patch', 'minor', 'major'];

/** Resolve `patch|minor|major` or an explicit stable version above `current`. */
export function resolveNextVersion(current, input) {
  const semver = require('semver');
  const wanted = String(input ?? '').trim().replace(/^v/, '');
  const next = BUMPS.includes(wanted) ? semver.inc(current, wanted) : wanted;
  if (!STABLE_VERSION_PATTERN.test(next ?? '')) {
    throw new Error(`"${input}" is not patch, minor, major or a stable x.y.z version.`);
  }
  if (!semver.gt(next, current)) throw new Error(`Version ${next} must be greater than the current ${current}.`);
  return next;
}

/** Extract the commit SHA from `git ls-remote <url> refs/heads/main` output. */
export function parseLsRemote(output, ref = 'refs/heads/main') {
  const line = String(output).split(/\r?\n/).find((l) => l.trim().endsWith(`\t${ref}`) || l.trim().endsWith(` ${ref}`));
  const sha = line?.trim().split(/\s+/)[0];
  if (!sha || !SHA_PATTERN.test(sha)) throw new Error(`Could not find ${ref} in ls-remote output.`);
  return sha;
}

/** Return config/release.json text with only `web.sha` replaced. */
export function withWebSha(configText, sha) {
  if (!SHA_PATTERN.test(sha)) throw new Error(`Web SHA ${sha} must be a full 40-hex commit SHA.`);
  const config = JSON.parse(configText);
  config.web = { ...config.web, sha };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function run(cmd, args, { capture = true } = {}) {
  const spawn = require('cross-spawn');
  const result = spawn.sync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed${capture ? `:\n${(result.stderr || result.stdout).trim()}` : ''}`);
  }
  return capture ? result.stdout.trim() : '';
}
const git = (...args) => run('git', args);

function preflight(tag) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') throw new Error(`Releases are cut from main (currently on ${branch}).`);
  if (git('status', '--porcelain')) throw new Error('Working tree is not clean. Commit or stash your changes first.');
  git('fetch', '--quiet', 'origin', 'main', '--tags');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
    throw new Error('Local main differs from origin/main. Run git pull (and push any local commits) first.');
  }
  if (tag && git('tag', '--list', tag)) throw new Error(`Tag ${tag} already exists.`);
}

function parseArgs(argv) {
  const options = { version: undefined, dryRun: false, yes: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!options.version) options.version = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: npm run release [-- <patch|minor|major|x.y.z>] [--dry-run] [--yes]\n');
    return;
  }
  preflight();
  const current = readPackageVersion(ROOT);
  const config = loadReleaseConfig({ root: ROOT });
  const webSha = parseLsRemote(git('ls-remote', `https://github.com/${config.webRepository}.git`, 'refs/heads/main'));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let input = options.version;
    if (!input) {
      input = (await rl.question(`Current version ${current}. New version (patch/minor/major or x.y.z) [minor]: `)).trim() || 'minor';
    }
    const version = resolveNextVersion(current, input);
    const tag = `v${version}`;
    preflight(tag);

    const webNote = webSha === config.webSha ? `${webSha} (unchanged)` : `${config.webSha} -> ${webSha}`;
    process.stdout.write(
      `\nRelease plan\n  version  ${current} -> ${version}\n  tag      ${tag}\n  web      ${config.webRepository}@${webNote}\n` +
        `  commit   "release: ${tag}" on main, then push main + ${tag} to origin\n\n`,
    );
    if (options.dryRun) {
      process.stdout.write('Dry run: nothing changed.\n');
      return;
    }
    if (!options.yes) {
      const answer = (await rl.question('Commit, tag and push? This starts the npm publish. [y/N] ')).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        process.stdout.write('Aborted: nothing changed.\n');
        return;
      }
    }

    const configPath = resolve(ROOT, DEFAULT_CONFIG_PATH);
    try {
      writeFileSync(configPath, withWebSha(readFileSync(configPath, 'utf8'), webSha));
      run('npm', ['version', version, '--no-git-tag-version'], { capture: true });
      validateReleaseMetadata({
        tag,
        packageVersion: readPackageVersion(ROOT),
        lockfileVersion: readLockfileVersion(ROOT),
        config: loadReleaseConfig({ root: ROOT }),
      });
      git('add', 'package.json', 'package-lock.json', DEFAULT_CONFIG_PATH);
      git('commit', '--quiet', '-m', `release: ${tag}`);
    } catch (error) {
      git('checkout', '--', 'package.json', 'package-lock.json', DEFAULT_CONFIG_PATH);
      throw new Error(`${error.message}\nRestored package.json, package-lock.json and ${DEFAULT_CONFIG_PATH}; nothing was committed.`);
    }
    git('tag', '-a', tag, '-m', tag);
    try {
      run('git', ['push', '--atomic', 'origin', 'main', tag], { capture: false });
    } catch (error) {
      throw new Error(
        `${error.message}\nThe release commit and tag exist locally only. Retry with: git push --atomic origin main ${tag}\n` +
          `Or undo with: git tag -d ${tag} && git reset --hard HEAD~1`,
      );
    }
    process.stdout.write(`\nPushed ${tag}. The Release workflow is publishing it; follow with: gh run watch\n`);
  } finally {
    rl.close();
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
