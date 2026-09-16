import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { workerGuardMessage } from './guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const shortcuts = new Map();
  const listeners = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
    events: {
      on(name, handler) {
        listeners.set(name, [...(listeners.get(name) || []), handler]);
        return () => listeners.set(name, listeners.get(name).filter(h => h !== handler));
      },
      emit(name, value) { for (const handler of listeners.get(name) || []) handler(value); },
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, def) { commands.set(name, def); },
    registerShortcut(name, def) { shortcuts.set(name, def); },
    registerEntryRenderer() {},
    appendEntry() {},
    getThinkingLevel: () => 'low',
    getAllTools: () => [],
    setModel: async () => true,
    setThinkingLevel() {},
    setActiveTools() {},
  };
  return { pi, handlers, commands, tools, shortcuts };
}

async function loadExtension() {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-rebrand-'));
  process.env.PI_CODING_AGENT_DIR = dir;
  const { pi, handlers, commands, tools, shortcuts } = makePi();
  const extension = await import(pathToFileURL(path.join(root, 'extensions', 'piastra', 'index.ts')).href);
  extension.default(pi);
  return {
    dir,
    restore: async () => {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      await rm(dir, { recursive: true, force: true });
    },
    pi, handlers, commands, tools, shortcuts,
  };
}

const notifyCtx = (dir, notices = []) => ({
  cwd: dir,
  ui: { notify: (message, level) => notices.push({ message, level }) },
});

test('canonical /dispatch and legacy /piastra share one handler with Dispatch branding', async () => {
  const ext = await loadExtension();
  try {
    const dispatch = ext.commands.get('dispatch');
    const legacy = ext.commands.get('piastra');
    assert.ok(dispatch, 'canonical /dispatch must be registered');
    assert.ok(legacy, 'legacy /piastra alias must be retained');
    assert.equal(legacy.handler, dispatch.handler, 'alias must share the canonical handler, not diverge');
    assert.match(dispatch.description, /Dispatch/, 'command description uses the Dispatch brand');
    assert.match(legacy.description, /Dispatch/, 'alias description uses the Dispatch brand');
    const first = [];
    const second = [];
    await dispatch.handler('', notifyCtx(ext.dir, first));
    await legacy.handler('', notifyCtx(ext.dir, second));
    assert.equal(first.length, 1);
    assert.deepEqual(second, first, '/piastra output is identical to /dispatch output');
    assert.match(first[0].message, /Active: orchestrator/, 'role summary handler still reports roles');
  } finally { await ext.restore(); }
});

test('user-visible tool labels, command descriptions and prompt headings use Dispatch', async () => {
  initTheme('dark');
  const ext = await loadExtension();
  try {
    const delegate = ext.tools.get('delegate');
    assert.ok(delegate, 'delegate tool is registered');
    assert.equal(delegate.label, 'Dispatch workers');
    const theme = { fg: (_style, text) => text };
    const call = delegate.renderCall({ tasks: [{}, {}] }, theme, {});
    assert.match(call.render(120).join('\n'), /Dispatch · 2 workers in parallel/);

    const agent = ext.commands.get('agent');
    assert.match(agent.description, /Dispatch/);
    assert.match(ext.shortcuts.get('ctrl+shift+a').description, /Dispatch/);

    const beforeAgent = ext.handlers.get('before_agent_start');
    assert.ok(beforeAgent?.length, 'before_agent_start prompt injection is registered');
    const injected = await beforeAgent[0]({ systemPrompt: 'base' });
    assert.match(injected.systemPrompt, /Active Dispatch agent: orchestrator/);
    assert.doesNotMatch(injected.systemPrompt, /PiAstra/);

    const toolCall = ext.handlers.get('tool_call');
    const blocked = await toolCall[0]({ toolName: 'delegate_task' });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /Dispatch single delegation policy/);
  } finally { await ext.restore(); }
});

test('legacy session, preferences, status, channel and protocol identifiers are preserved', async () => {
  const agentsSource = readFileSync(path.join(root, 'extensions', 'piastra', 'agents.mjs'), 'utf8');
  assert.match(agentsSource, /appendEntry\('piastra-agent'/, 'session custom entry type stays piastra-agent');
  assert.match(agentsSource, /setStatus\('piastra-agent'/, 'status key stays piastra-agent');
  const indexSource = readFileSync(path.join(root, 'extensions', 'piastra', 'index.ts'), 'utf8');
  assert.match(indexSource, /piastraDelegateHasResult/, 'delegate render state key is unchanged');
  const guardSource = readFileSync(path.join(root, 'extensions', 'piastra', 'guard.mjs'), 'utf8');
  assert.match(guardSource, /piastra:worker-guard/, 'worker guard event channel is unchanged');
  const bridgeSource = readFileSync(path.join(root, 'extensions', 'piastra', 'worker-bridge.mjs'), 'utf8');
  assert.match(bridgeSource, /piastra:workers/, 'worker protocol channel is unchanged');
  const shortcutsSource = readFileSync(path.join(root, 'extensions', 'piastra', 'shortcuts.ts'), 'utf8');
  assert.match(shortcutsSource, /piastra\.shortcuts/, 'editor capability ID is unchanged');
  assert.match(shortcutsSource, /piastra:compact-transcript:toggle/, 'compact toggle channel is unchanged');
  const worktreeSource = readFileSync(path.join(root, 'extensions', 'pi-worktree', 'git-worktree.ts'), 'utf8');
  assert.match(worktreeSource, /piastra\/pr\//, 'PR ref prefix piastra/pr is unchanged');
  assert.match(worktreeSource, /piastra:worker-guard/, 'worktree guard channel is unchanged');
  const prefsSource = readFileSync(path.join(root, 'extensions', 'piastra', 'prefs.mjs'), 'utf8');
  assert.match(prefsSource, /Invalid persisted Dispatch preference/, 'user-facing prefs error uses Dispatch');
  assert.match(indexSource, /'piastra', 'agents\.json'/, 'cross-session prefs path stays <agentDir>/piastra/agents.json');
  // Changed labels still read as Dispatch where users see them.
  assert.match(workerGuardMessage(2), /^2 Dispatch workers are still running/);
  const rolePrompt = readFileSync(path.join(root, 'roles', 'orchestrator.md'), 'utf8');
  assert.match(rolePrompt, /Dispatch's orchestrator/);
});
