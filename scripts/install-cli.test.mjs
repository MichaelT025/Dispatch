import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function runInstaller(agentDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/install-cli.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: 'pipe',
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

test('installer preserves packages and disables only upstream worktree extension', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-installer-'));
  try {
    const settings = {
      customSetting: true,
      packages: ['npm:keep-me', 'npm:@thisux/pi-worktree@1.2.0'],
      extensions: ['/existing/extension.ts'],
    };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    await runInstaller(agentDir);
    const installed = JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(installed.customSetting, true);
    assert.deepEqual(installed.packages, [
      'npm:keep-me',
      { source: 'npm:@thisux/pi-worktree@1.2.0', extensions: [] },
    ]);
    assert.match(installed.extensions.join('\n'), /extensions[\\/]pi-worktree[\\/]git-worktree\.ts/);
    await readFile(path.join(agentDir, 'piastra/package/extensions/pi-worktree/LICENSE'), 'utf8');
    // The worker guard helper is part of the managed copy; index.ts imports it
    // at runtime, so a missing file would break the installed extension.
    const guard = await readFile(path.join(agentDir, 'piastra/package/extensions/piastra/guard.mjs'), 'utf8');
    assert.match(guard, /PIASTRA_WORKER_GUARD_CHANNEL/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
