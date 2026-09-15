import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createCustomTools } from './custom-tools.ts';
import { workerTools, agentTools } from './agents.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piastra-tools-'));
  const agentDir = path.join(dir, 'agent');
  await mkdir(agentDir);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { cwd: dir, agentDir, sessionId: 'parent-session', trusted: true, writable: true };
}
const call = (tools, name, params = {}) => tools.find(t => t.name === name).execute('call', params);

test('factory permissions and session notes are shared across worker instances', async t => {
  const scope = await fixture(t);
  const writer = createCustomTools(() => scope);
  const reader = createCustomTools(() => ({ ...scope, writable: false }));
  await call(writer, 'write_note', { name: 'api-audit.md', text: 'Source: README, baseline 123' });
  assert.match((await call(reader, 'read_note', { name: 'api-audit.md' })).content[0].text, /baseline 123/);
  await assert.rejects(call(reader, 'write_note', { name: 'x', text: 'x' }), /Read-only/);
  scope.sessionId = 'new-parent';
  assert.match((await call(reader, 'list_notes')).content[0].text, /no shared notes/);
  for (const access of ['read', 'write']) {
    const names = workerTools(access);
    assert.equal(names.includes('write_note'), access === 'write');
    assert.ok(names.includes('run_checks'));
    assert.ok(!names.includes('delegate'));
    assert.deepEqual(names, agentTools(access === 'read' ? 'review' : 'fast'));
  }
});

test('run_checks uses workspace catalog, exposes evidence and denies arbitrary input/untrusted execution', async t => {
  const scope = await fixture(t);
  await mkdir(path.join(scope.cwd, 'config'));
  await writeFile(path.join(scope.cwd, 'config', 'checks.json'), JSON.stringify({ checks: [
    { name: 'probe', command: ['node', '-e', 'console.log("verified workspace")'] },
    { name: 'fail', command: ['node', '-e', 'console.error("actual failure");process.exit(2)'] },
  ] }));
  const tools = createCustomTools(() => scope);
  assert.match((await call(tools, 'run_checks')).content[0].text, /probe/);
  const good = await call(tools, 'run_checks', { name: 'probe' });
  assert.equal(good.details.status, 'passed');
  assert.match(good.content[0].text, /verified workspace/);
  assert.match(await readFile(good.details.logPath, 'utf8'), /outcome: passed/);
  const failed = await call(tools, 'run_checks', { name: 'fail' });
  assert.equal(failed.details.status, 'failed');
  assert.equal(failed.details.exitCode, 2);
  assert.match(failed.content[0].text, /actual failure/);
  await assert.rejects(call(tools, 'run_checks', { name: 'node -e evil' }), /Unknown check/);
  scope.trusted = false;
  await assert.rejects(call(tools, 'run_checks', { name: 'probe' }), /trusted/);
});

test('live offline SDK exposes custom tools to read-only workers without extension discovery', async t => {
  const scope = await fixture(t);
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: scope.cwd, agentDir: scope.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  const model = { id: 'offline', name: 'Offline', provider: 'test', api: 'openai-completions', baseUrl: 'http://unused.invalid',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
  const { session } = await createAgentSession({ cwd: scope.cwd, agentDir: scope.agentDir, model,
    settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(scope.cwd),
    tools: workerTools('read'), customTools: createCustomTools(() => ({ ...scope, writable: false })).filter(t => workerTools('read').includes(t.name)) });
  try {
    const names = session.agent.state.tools.map(t => t.name);
    for (const name of ['read_note', 'list_notes', 'fetch_url', 'web_search', 'run_checks', 'inspect_git']) assert.ok(names.includes(name), name);
    for (const name of ['write_note', 'bash', 'edit', 'write', 'delegate']) assert.ok(!names.includes(name), name);
  } finally { session.dispose(); }
});
