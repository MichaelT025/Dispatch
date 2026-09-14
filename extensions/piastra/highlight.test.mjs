import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import register, { highlightedDiff } from '../pi-ui/index.ts';
import { renderTranscript } from './worker-render.ts';
initTheme('dark');
const { theme } = await import('../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js');

test('highlighted edits preserve native execution, patch details, replay and worker rendering', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-highlight-'));
  try {
    await writeFile(path.join(cwd, 'sample.ts'), 'const count = 1;\n');
    let tool;
    register({ registerTool(value) { tool = value; } });
    const args = { path: 'sample.ts', edits: [{ oldText: 'const count = 1;', newText: 'const count = 2;' }] };
    const result = await tool.execute('test', args, undefined, undefined, { cwd });
    assert.equal(await readFile(path.join(cwd, 'sample.ts'), 'utf8'), 'const count = 2;\n');
    assert.ok(result.details.patch.includes('+const count = 2;'));
    const component = tool.renderResult(result, { expanded: false }, theme, { args, argsComplete: false, isError: false });
    const rendered = component.render(100).join('\n');
    assert.match(stripTerminalSequences(rendered), /const count = 2/);
    // Headless Linux uses 256-color output; desktop terminals may use truecolor.
    // Require distinct syntax colors in either encoding, not a specific terminal.
    const foregroundColors = rendered.match(/\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g) ?? [];
    assert.ok(new Set(foregroundColors).size > 2, 'expected multiple syntax foreground colors');
    const messages = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'test', name: 'edit', arguments: args }] },
      { role: 'toolResult', toolCallId: 'test', toolName: 'edit', ...result },
    ];
    assert.match(stripTerminalSequences(renderTranscript(messages, theme, 100).join('\n')), /const count = 2/);
    const error = tool.renderResult({ content: [{ type: 'text', text: 'Edit failed' }] }, {}, theme, { args, isError: true });
    assert.match(stripTerminalSequences(error.render(100).join('\n')), /Edit failed/);
    await assert.rejects(tool.execute('bad', { path: 'sample.ts', edits: [{ oldText: 'missing', newText: 'oops' }] }, undefined, undefined, { cwd }));
    assert.equal(await readFile(path.join(cwd, 'sample.ts'), 'utf8'), 'const count = 2;\n');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('diff previews retain gutters, strip terminal controls and bound expanded output', () => {
  const text = highlightedDiff('-1 const x = 1;\n+1 const x = 2;\x1b]0;untrusted\x07', 'x.ts', theme, true);
  assert.equal(stripTerminalSequences(text), '-1 const x = 1;\n+1 const x = 2;');
  const large = Array.from({ length: 600 }, (_, i) => `+${i + 1} const x = ${i};`).join('\n');
  assert.match(stripTerminalSequences(highlightedDiff(large, 'x.ts', theme, false)), /586 more lines/);
  assert.match(stripTerminalSequences(highlightedDiff(large, 'x.ts', theme, true)), /100 more lines/);
});
