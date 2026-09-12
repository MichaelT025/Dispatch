import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { forkArtifactErrors, parseForkPort, resolveForkRoot, seedForkAgentDir, seedForkDataDir } from './start-fork.mjs';
import { FORK_DISABLED_AGENT_TOOLS } from '../extensions/piastra/policy.mjs';

const base = join(tmpdir(), 'fork-launcher-tests');

function makeFakeRoots({ withArtifacts = true } = {}) {
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  const root = join(base, 'project');
  mkdirSync(join(root, 'extensions', 'piastra'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'extensions', 'piastra', 'index.ts'), 'export default () => {};');
  writeFileSync(join(root, 'config', 'agents.json'), JSON.stringify({
    orchestrator: { model: 'p/m', thinking: 'low' },
    general: { model: 'p/g', thinking: null },
    fast: { model: 'p/f', thinking: null },
    review: { model: 'p/r', thinking: 'medium' },
  }));
  const fork = join(base, 'fork');
  if (withArtifacts) {
    mkdirSync(join(fork, 'dist', 'server'), { recursive: true });
    mkdirSync(join(fork, 'web', 'dist'), { recursive: true });
    writeFileSync(join(fork, 'package.json'), '{"version":"0.80.0"}');
    writeFileSync(join(fork, 'dist', 'server', 'index.js'), 'export {};');
    writeFileSync(join(fork, 'web', 'dist', 'index.html'), '<html></html>');
  }
  return { root, fork };
}

test('missing fork artifacts are reported with a build hint', () => {
  const { root, fork } = makeFakeRoots({ withArtifacts: false });
  assert.deepEqual(forkArtifactErrors(fork).length, 3);
  assert.throws(() => resolveForkRoot(root, { PIASTRA_FORK_DIR: fork }), /npm run build/);
});

test('fork root override and artifact validation', () => {
  const { root, fork } = makeFakeRoots();
  assert.equal(resolveForkRoot(root, { PIASTRA_FORK_DIR: fork }), fork);
  rmSync(join(fork, 'web', 'dist', 'index.html'));
  assert.throws(() => resolveForkRoot(root, { PIASTRA_FORK_DIR: fork }), /index.html/);
});

test('port validation', () => {
  assert.equal(parseForkPort({}), 8790);
  assert.equal(parseForkPort({ PIASTRA_FORK_PORT: '1234' }), 1234);
  for (const bad of ['0', '70000', 'abc']) assert.throws(() => parseForkPort({ PIASTRA_FORK_PORT: bad }), /PIASTRA_FORK_PORT/);
});

test('agent dir seed references the extension by absolute path and copies credentials once', async () => {
  const { root } = makeFakeRoots();
  mkdirSync(join(root, '.local', 'agent'), { recursive: true });
  writeFileSync(join(root, '.local', 'agent', 'auth.json'), '{"secret":"bytes"}');
  writeFileSync(join(root, '.local', 'agent', 'models-store.json'), '{"cached":true}');
  const originalCwd = process.cwd();
  process.chdir(root); // resolve() of the seeded paths must land inside the fake root
  try {
    const agentDir = join(root, '.local', 'fork-agent');
    const first = seedForkAgentDir(root, agentDir);
    assert.ok(first.settingsSeeded);
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(settings.defaultProvider, 'p');
    assert.equal(settings.defaultModel, 'm');
    assert.equal(settings.defaultThinkingLevel, 'low');
    assert.deepEqual(settings.extensions, [resolve(join(root, 'extensions', 'piastra', 'index.ts'))]);
    assert.equal(readFileSync(join(agentDir, 'auth.json'), 'utf8'), '{"secret":"bytes"}');
    assert.equal(readFileSync(join(agentDir, 'models-store.json'), 'utf8'), '{"cached":true}');
    // Second run must change nothing (no gratuitous rewrites; auth untouched).
    writeFileSync(join(root, '.local', 'agent', 'auth.json'), '{"rotated":true}');
    const second = seedForkAgentDir(root, agentDir);
    assert.ok(!second.settingsSeeded);
    assert.equal(readFileSync(join(agentDir, 'auth.json'), 'utf8'), '{"secret":"bytes"}');
  } finally {
    process.chdir(originalCwd);
  }
});

test('fork UI state seeds foreign delegation tools disabled and templates staged off', async () => {
  const { root, fork } = makeFakeRoots();
  mkdirSync(join(root, 'roles'), { recursive: true });
  for (const role of ['general', 'fast', 'review']) writeFileSync(join(root, 'roles', role + '.md'), 'role ' + role);
  const dataDir = join(root, '.local', 'fork-web');
  mkdirSync(join(root, 'roles'), { recursive: true });
  for (const role of ['general','fast','review']) writeFileSync(join(root, 'roles', role + '.md'), 'role ' + role);
  mkdirSync(join(fork, 'dist', 'server'), { recursive: true });
  writeFileSync(join(fork, 'dist', 'server', 'subagent-templates.js'), 'export const DEFAULT_TEMPLATES = [{ name: "review" }, { name: "implement" }];');
  const first = await seedForkDataDir(root, dataDir, fork);
  assert.ok(first.clientSeeded && first.seededNames && first.templatesSeeded);
  const client = JSON.parse(readFileSync(join(dataDir, 'client-state.json'), 'utf8'));
  const disabled = client.__settings__.settings.disabledAgentTools;
  for (const tool of FORK_DISABLED_AGENT_TOOLS) assert.ok(disabled.includes(tool), tool);
  assert.ok(!disabled.includes('bash'));
  const seeded = JSON.parse(readFileSync(join(dataDir, 'subagent-templates.seeded.json'), 'utf8'));
  assert.ok(seeded.includes('review') && seeded.includes('implement'));
  const templates = JSON.parse(readFileSync(join(dataDir, 'subagent-templates.json'), 'utf8'));
  assert.equal(templates.length, 3);
  assert.ok(templates.every(t => t.enabled === false));
  // Templates directory content is preserved on rerun (no rewrite).
  const again = await seedForkDataDir(root, dataDir, fork);
  assert.ok(!again.clientSeeded && !again.templatesSeeded);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'subagent-templates.json'), 'utf8')).length, 3);
});
