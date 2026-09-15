import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatHelp, formatTerminalHelp, helpSections, sectionIds } from './help.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- Content contract ---

test('help exposes the required seven sections with string line arrays', () => {
  assert.deepEqual(sectionIds(), ['getting-started', 'agents-models', 'workers-tasks', 'worktrees-sessions', 'shortcuts', 'troubleshooting', 'commands']);
  for (const section of helpSections) {
    assert.ok(section.id && section.title, 'section has id and title');
    assert.ok(Array.isArray(section.lines) && section.lines.length > 0, `${section.id} has lines`);
    for (const line of section.lines) assert.equal(typeof line, 'string', `${section.id} lines are strings`);
  }
});

test('content names real commands, real shortcuts, and when-to-use tips', () => {
  const all = formatHelp('all');
  for (const cmd of ['/dispatch', '/piastra', '/agent', '/workers', '/dispatch-help', '/q ', '/st ', '/pause', '/queue-drain', '/worktree', '/todos', '/atelier', '/new', '/model', '/reload']) {
    assert.ok(all.includes(cmd), `help names ${cmd}`);
  }
  for (const key of ['Shift+Tab', 'Ctrl+T', 'Ctrl+O', 'Ctrl+V', 'Alt+V', 'Ctrl+X', 'Ctrl+Shift+A', 'Ctrl+Shift+W', 'PgUp', 'Home', 'End']) {
    assert.ok(all.includes(key), `help names ${key}`);
  }
  assert.match(all, /When to use what/, 'help gives when-to-use tips');
});

test('content marks boundaries: launcher pending, no sandbox, no fallback, no Luna default', () => {
  const all = formatHelp('all');
  assert.match(all, /Full launcher\/setup is pending/, 'setup/launcher marked pending');
  assert.match(all, /NOT a security sandbox/, 'worker isolation is not a sandbox');
  assert.match(all, /No automatic fallback/, 'no fallback claim');
  assert.ok(!all.includes('LunaMedium'), 'LunaMedium onboarding is not presented as current');
  assert.ok(!/standalone dispatch (runtime|cli|launcher) (is|ships)/i.test(all), 'no implemented-standalone claims');
  assert.match(all, /Pi-provided/, 'Pi-provided commands are labeled');
});

test('queue semantics are factual: /q parks paused idle, /st idle no-backlog starts vs active steer', () => {
  const text = formatHelp('workers-tasks');
  assert.match(text, /\/q <prompt>.*follow-up/s);
  assert.match(text, /Idle parks it paused/);
  assert.match(text, /\/st <prompt>.*steer/s);
  assert.match(text, /Idle with no[\s\S]*backlog starts/);
  assert.match(text, /active run steers it/);
});

test('formatHelp resolves sections and reports unknown ids with the available list', () => {
  assert.match(formatHelp('shortcuts'), /Shift\+Tab/);
  assert.match(formatHelp('nope'), /Unknown help section "nope"/);
  assert.match(formatHelp('nope'), /getting-started/);
  assert.equal(formatHelp(), formatHelp('all'));
});

test('formatTerminalHelp starts with the title, documents dispatch --help, and stays short', () => {
  const text = formatTerminalHelp();
  assert.ok(text.length < formatHelp('all').length, 'terminal overview is shorter than full text');
  assert.ok(text.startsWith('Dispatch — commands and shortcuts'), 'starts with the title');
  assert.match(text, /Usage: dispatch --help \| -h/, 'documents the help-only bin');
  assert.match(text, /Full launcher\/setup is pending/, 'pending state stated once');
  for (const cmd of ['/agent', '/workers', '/dispatch-help', '/q ', '/st ', '/queue-drain']) {
    assert.ok(text.includes(cmd), `overview names ${cmd}`);
  }
  assert.ok(text.includes('Shift+Tab') && text.includes('Ctrl+X'), 'overview names real shortcuts');
});

test('native session commands are accurate: /session /name /hotkeys, never /sessions /skills', () => {
  const all = formatHelp('all');
  for (const cmd of ['/session', '/name', '/hotkeys']) {
    assert.ok(all.includes(cmd), `help names native ${cmd}`);
  }
  assert.ok(!all.includes('/sessions'), 'never lists non-native /sessions');
  assert.ok(!all.includes('/skills'), 'never lists non-native /skills');
});

test('worktree subcommands and fresh-vs-resume guidance are present', () => {
  const text = formatHelp('worktrees-sessions');
  for (const sub of ['ls', 'add', 'open', 'resume', 'rm', 'pr']) {
    assert.ok(text.includes(sub), `names /wt subcommand ${sub}`);
  }
  assert.match(text, /\/new.*fresh/s, 'fresh sessions start with /new');
  assert.match(text, /\/resume.*resume a different session/s, '/resume resumes');
});

test('worker keys are precise: siblings Left/Right/Tab/Shift+Tab, Up parent, Down picker', () => {
  const text = formatHelp('workers-tasks');
  assert.match(text, /Left\/Right\/Tab\/Shift\+Tab cycle sibling/, 'siblings cycle');
  assert.match(text, /Up returns to the parent/, 'Up goes to parent');
  assert.match(text, /Down returns to the[\s\S]*picker/, 'Down goes to picker');
  assert.ok(!/Up\/Down[^\n]*sibling/i.test(text), 'Up/Down never both cycle siblings');
});

test('starter steps never show a fake delegate tool invocation or tool schema', () => {
  const text = formatHelp('getting-started');
  assert.ok(!text.includes('delegate <tasks>'), 'no fake delegate invocation');
  assert.ok(!text.includes('tasks: [{'), 'no tool JSON schema in first-use text');
  assert.match(text, /ask.*orchestrator/i, 'user asks the orchestrator instead');
  assert.match(text, /dispatch --help/, 'points at the help-only bin, not formatTerminalHelp');
  assert.ok(!text.includes('formatTerminalHelp'), 'no code-identifier references');
});

test('Dispatch shortcuts are scoped to editor focus, never universal', () => {
  const all = formatHelp('all');
  assert.ok(!/keep working everywhere/i.test(all), 'no universal-shortcut claim');
  assert.match(all, /editor is focused/, 'shortcuts scoped to editor focus');
});

test('optional addons and login troubleshooting are factual', () => {
  const all = formatHelp('all');
  assert.match(all, /\/todos \(pi-todo\)/, '/todos labeled optional pi-todo');
  assert.match(all, /\/atelier/, '/atelier named');
  assert.match(all, /Alt\+A/, 'Alt+A default named');
  assert.match(all, /Ctrl\+Shift\+R/, 'resize shortcut named');
  assert.match(all, /\/login.*configure the provider/s, '/login troubleshooting present');
  assert.match(all, /Nothing falls back or onboards automatically/, 'no fallback/onboarding claims');
});

test('listed Pi-provided names exist in the actual native catalog', async () => {
  const { readFile } = await import('node:fs/promises');
  const catalogPath = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'slash-commands.js');
  const catalog = await readFile(catalogPath, 'utf8');
  const native = [...catalog.matchAll(/name: "([^"]+)"/g)].map(m => m[1]);
  assert.ok(native.includes('session'), 'catalog has /session');
  assert.ok(native.includes('name'), 'catalog has /name');
  assert.ok(native.includes('hotkeys'), 'catalog has /hotkeys');
  assert.ok(!native.includes('sessions'), 'catalog has no /sessions');
  assert.ok(!native.includes('skills'), 'catalog has no /skills');
  for (const claimed of ['/session', '/name', '/hotkeys', '/model', '/login', '/new', '/resume', '/tree', '/compact', '/fork', '/reload', '/thinking']) {
    assert.ok(native.includes(claimed.slice(1)), `claimed native ${claimed} is in the catalog`);
  }
  const all = formatHelp('all');
  assert.ok(!all.includes('/sessions'), 'invalid /sessions absent from help');
  assert.ok(!all.includes('/skills'), 'invalid /skills absent from help');
});

// --- Registration / RPC / guard ---

function makePi() {
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
    events: { on() { return () => {}; }, emit() {} },
    registerTool() {},
    registerCommand(name, def) { commands.set(name, def); },
    registerShortcut() {},
    registerEntryRenderer() {},
    appendEntry() {},
    getThinkingLevel: () => 'low',
    getAllTools: () => [],
    setModel: async () => true,
    setThinkingLevel() {},
    setActiveTools() {},
  };
  return { pi, commands, handlers };
}

async function loadExtension() {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-help-'));
  process.env.PI_CODING_AGENT_DIR = dir;
  const { pi, commands, handlers } = makePi();
  const extension = await import(pathToFileURL(path.join(root, 'extensions', 'piastra', 'index.ts')).href);
  extension.default(pi);
  return {
    dir, pi, commands, handlers,
    restore: async () => {
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('/dispatch-help is registered and existing /dispatch + /piastra handlers are unchanged', async () => {
  const ext = await loadExtension();
  try {
    const help = ext.commands.get('dispatch-help');
    assert.ok(help, '/dispatch-help registered');
    assert.match(help.description, /Dispatch help/);
    const dispatch = ext.commands.get('dispatch');
    const legacy = ext.commands.get('piastra');
    assert.equal(legacy.handler, dispatch.handler, '/piastra still shares the /dispatch handler');
    const notices = [];
    await dispatch.handler('', { cwd: ext.dir, ui: { notify: (m, l) => notices.push({ m, l }) } });
    assert.match(notices[0].m, /Active: orchestrator/, '/dispatch output unchanged');
  } finally { await ext.restore(); }
});

test('non-TUI /dispatch-help notifies plain text with no custom UI and no model prompt', async () => {
  const ext = await loadExtension();
  try {
    const help = ext.commands.get('dispatch-help');
    for (const mode of ['rpc', 'print', 'json']) {
      let customCalled = false;
      const notices = [];
      const ctx = {
        mode, hasUI: mode === 'rpc', cwd: ext.dir,
        ui: { notify: (m, l) => notices.push({ m, l }), custom: async () => { customCalled = true; } },
      };
      await help.handler('', ctx);
      assert.equal(customCalled, false, `no custom UI in ${mode} mode`);
      assert.equal(notices.length, 1, `one notify in ${mode} mode`);
      assert.match(notices[0].m, /Dispatch/, 'plain help content delivered');
    }
    // Section arg resolves to that section's text.
    const notices = [];
    await help.handler('shortcuts', {
      mode: 'rpc', cwd: ext.dir,
      ui: { notify: (m, l) => notices.push({ m, l }), custom: async () => { throw new Error('must not open UI'); } },
    });
    assert.match(notices[0].m, /Shift\+Tab/);
    // Unknown section reports the available list instead of throwing.
    const unknown = [];
    await help.handler('nope', {
      mode: 'rpc', cwd: ext.dir,
      ui: { notify: (m, l) => unknown.push({ m, l }), custom: async () => { throw new Error('must not open UI'); } },
    });
    assert.match(unknown[0].m, /Unknown help section/);
  } finally { await ext.restore(); }
});

test('TUI open failure notifies and releases the guard so a retry can reopen', async () => {
  const ext = await loadExtension();
  try {
    const help = ext.commands.get('dispatch-help');
    const notices = [];
    let calls = 0;
    const ctx = {
      mode: 'tui', hasUI: true, cwd: ext.dir,
      ui: {
        notify: (m, l) => notices.push({ m, l }),
        custom: async () => { calls += 1; throw new Error('boom'); },
      },
    };
    await help.handler('', ctx);
    assert.equal(calls, 1);
    assert.match(notices[0].m, /unavailable/, 'failure surfaces via notify');
    // Guard was reset: a second open reaches custom() again.
    ctx.ui.custom = async (factory) => {
      calls += 1;
      let doneCalled = false;
      const view = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_s, t) => t }, {}, () => { doneCalled = true; });
      assert.ok(view && typeof view.render === 'function', 'fresh overlay state per open');
      assert.equal(doneCalled, false);
    };
    await help.handler('', ctx);
    assert.equal(calls, 2, 'guard released after error; reopen works');
  } finally { await ext.restore(); }
});

test('concurrent opens collapse to one overlay and the guard resets after close', async () => {
  const ext = await loadExtension();
  try {
    const help = ext.commands.get('dispatch-help');
    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const ctx = {
      mode: 'tui', hasUI: true, cwd: ext.dir,
      ui: { notify: () => {}, custom: async () => { calls += 1; await gate; } },
    };
    const first = help.handler('', ctx);
    await new Promise(resolve => setTimeout(resolve, 10));
    await help.handler('', ctx); // second open while busy: no-op
    release();
    await first;
    assert.equal(calls, 1, 're-entrant open ignored while viewer is up');
    await help.handler('', ctx); // guard reset after close: opens again
    assert.equal(calls, 2, 'guard reset after close');
    release();
  } finally { await ext.restore(); }
});
