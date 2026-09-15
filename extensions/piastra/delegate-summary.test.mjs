import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { createDelegateFallbackSummary, createWorkerProgress, renderTranscript } from './worker-render.ts';

initTheme('dark');

const theme = { fg: (_style, text) => text };
const render = (workers, expanded, width = 80) =>
  createWorkerProgress(workers, expanded, theme).render(width);
const stripped = (workers, expanded, width = 80) =>
  stripTerminalSequences(render(workers, expanded, width).join('\n'));

const worker = (overrides = {}) => ({
  id: 1,
  role: 'general',
  model: 'secret-model-xyz',
  status: 'running',
  activity: 'super secret activity',
  task: 'super secret task payload',
  recent: ['✓ read secret-file.ts'],
  text: 'super secret response body',
  transcript: '/tmp/secret-transcript-path',
  started: Date.now() - 5000,
  ...overrides,
});

test('expanded and collapsed delegation render identically as one summary line', () => {
  const workers = [worker({ id: 1, status: 'completed' }), worker({ id: 2, status: 'running' })];
  assert.deepEqual(render(workers, true), render(workers, false));
  const lines = render(workers, true);
  assert.equal(lines.length, 1);
  assert.match(stripped(workers, true), /Workers/);
  assert.match(stripped(workers, true), /1 completed/);
  assert.match(stripped(workers, true), /1 running/);
  assert.match(stripped(workers, true), /\/workers for details/);
});

test('failure, cancellation, and interruption counts stay visible', () => {
  const workers = [
    worker({ id: 1, status: 'completed' }),
    worker({ id: 2, status: 'failed' }),
    worker({ id: 3, status: 'cancelled' }),
    worker({ id: 4, status: 'interrupted' }),
  ];
  const text = stripped(workers, false);
  assert.match(text, /1 failed/);
  assert.match(text, /1 cancelled/);
  assert.match(text, /1 interrupted/);
  assert.match(text, /1 completed/);
  const errorTheme = { fg: (style, value) => `<${style}>${value}` };
  const styled = createWorkerProgress(workers, false, errorTheme).render(120).join('\n');
  assert.match(styled, /<error>/);
});

test('starting status and unknown fallbacks are counted, zero workers is meaningful', () => {
  assert.match(stripped([worker({ status: 'starting' })], false), /1 starting/);
  assert.match(stripped([worker({ status: 'weird-status' })], false), /1 weird-status/);
  assert.match(stripped([worker({ status: undefined })], false), /1 unknown/);
  assert.match(stripped([], false), /Workers · none · \/workers for details/);
  assert.match(stripped(null, false), /Workers · none/);
});

test('many workers stay bounded to one width-limited line without payload leaks', () => {
  const workers = Array.from({ length: 500 }, (_, i) =>
    worker({ id: i, status: i % 3 === 0 ? 'failed' : i % 3 === 1 ? 'running' : 'completed' }));
  for (const width of [40, 80, 120]) {
    const lines = render(workers, true, width);
    assert.equal(lines.length, 1);
    assert.ok(lines.every(line => visibleWidth(stripTerminalSequences(line)) <= width));
  }
  const text = stripped(workers, false, 200);
  assert.match(text, /failed/);
  for (const secret of ['secret-model-xyz', 'super secret task', 'super secret activity', 'secret-file', 'secret response', 'secret-transcript']) {
    assert.doesNotMatch(text, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('main-chat summary leaks no per-worker fields', () => {
  const workers = [worker({ id: 7, status: 'running' })];
  const text = stripped(workers, true);
  assert.doesNotMatch(text, /#7/);
  assert.doesNotMatch(text, /secret-model-xyz/);
  assert.doesNotMatch(text, /super secret/);
  assert.doesNotMatch(text, /secret-file/);
  assert.doesNotMatch(text, /secret-transcript/);
});

test('workers input is not mutated', () => {
  const workers = [worker({ id: 1, status: 'running' }), worker({ id: 2, status: 'failed' })];
  const before = structuredClone(workers);
  render(workers, true);
  render(workers, false);
  assert.deepEqual(workers, before);
});

test('full overlay transcript rendering still works', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'r', name: 'read', arguments: { path: 'a.ts' } }] },
    { role: 'toolResult', toolCallId: 'r', toolName: 'read', content: [{ type: 'text', text: 'const answer = 42;' }] },
    { role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'critical failure' }] },
  ];
  const expanded = stripTerminalSequences(renderTranscript(messages, theme, 80).join('\n'));
  assert.match(expanded, /const answer = 42/);
  assert.match(expanded, /critical failure/);
  const collapsed = stripTerminalSequences(renderTranscript(messages, theme, 80, false).join('\n'));
  assert.match(collapsed, /Ctrl\+O to expand/);
  assert.match(collapsed, /critical failure/);
});

test('no-workers fallback is one sanitized width-bounded line with the error text', () => {
  const output = {
    content: [
      { type: 'text', text: 'fixture: runtime \x1b[31minitialization\x1b[0m hung\nand failed\n\nsecond line' },
      { type: 'text', text: 'raw\x00content\twith extra   spacing' },
    ],
  };
  const before = structuredClone(output);
  for (const width of [40, 80, 120]) {
    for (const isError of [true, false]) {
      const lines = createDelegateFallbackSummary(output, theme, isError).render(width);
      assert.equal(lines.length, 1);
      const plain = stripTerminalSequences(lines[0]);
      assert.ok(visibleWidth(plain) <= width, `fallback wider than ${width}: ${JSON.stringify(plain)}`);
      assert.ok(!plain.includes('\n'), 'fallback must be a single line');
      assert.ok(!plain.includes('\x1b'), 'fallback must strip ANSI escapes');
    }
  }
  const text = stripTerminalSequences(createDelegateFallbackSummary(output, theme, true).render(200).join('\n'));
  assert.match(text, /Delegate/);
  assert.match(text, /initialization hung/);
  assert.match(text, /second line/);
  assert.doesNotMatch(text, /\x1b/);
  assert.deepEqual(output, before, 'fallback must not mutate its input');
});

test('fallback error color follows isError and expanded stays single-line via the registered delegate', async () => {
  const errorTheme = { fg: (style, value) => `<${style}>${value}` };
  const failing = stripTerminalSequences(createDelegateFallbackSummary({ content: [{ type: 'text', text: 'boom' }] }, errorTheme, true).render(120).join('\n'));
  assert.match(failing, /<error>/);
  const ok = stripTerminalSequences(createDelegateFallbackSummary({ content: [{ type: 'text', text: 'boom' }] }, errorTheme, false).render(120).join('\n'));
  assert.doesNotMatch(ok, /<error>/);

  const { readFileSync } = await import('node:fs');
  const { dirname, join, resolve } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = readFileSync(join(root, 'extensions', 'piastra', 'index.ts'), 'utf8');
  assert.match(source, /createDelegateFallbackSummary/);
  assert.match(source, /isError/);

  const extension = await import(pathToFileURL(join(root, 'extensions', 'piastra', 'index.ts')).href);
  const tools = [];
  const fakePi = {
    events: { on: () => () => {}, emit: () => {} },
    on: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    registerTool: (tool) => { tools.push(tool); },
    getThinkingLevel: () => 'low',
    appendEntry: () => {},
    getAllTools: () => [],
    setModel: async () => true,
    setThinkingLevel: () => {},
    setActiveTools: () => {},
  };
  extension.default(fakePi);
  const delegate = tools.find((tool) => tool.name === 'delegate');
  assert.ok(delegate, 'real extension must register the delegate tool');
  const failingOutput = { content: [{ type: 'text', text: 'fixture: runtime \x1b[31mboom\x1b[0m\nline two' }], details: {} };
  const before = structuredClone(failingOutput);
  for (const expanded of [true, false]) {
    const component = delegate.renderResult(failingOutput, { expanded }, theme, { isError: true });
    const lines = component.render(80);
    assert.equal(lines.length, 1, `fallback must stay one line when expanded=${expanded}`);
    const plain = stripTerminalSequences(lines.join('\n'));
    assert.ok(visibleWidth(plain) <= 80);
    assert.match(plain, /boom/);
    assert.match(plain, /line two/);
  }
  assert.deepEqual(failingOutput, before);
});
