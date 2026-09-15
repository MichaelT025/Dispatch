import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth, TuiMainScreen } from '@earendil-works/pi-tui';
import { plainLines, renderTranscript, toolSummary } from './worker-render.ts';
initTheme('dark');
import { createWorkerView, dropInitialTask, messageText, workerOverlayOptions } from './worker-view.ts';

const baseWorker = (id, task = 'trial', extra = {}) => ({
  id, role: 'general', task, model: 'glm', status: 'running', activity: 'Responding', ...extra
});
const theme = { fg: (_s, t) => t, bg: (_s, t) => t };
const mkTui = (rows) => ({ terminal: { rows }, requestRender() {} });

test('viewer navigates workers and returns to parent without mutating sessions', () => {
  let closed = false;
  const records = new Map([[1, { worker: baseWorker(1, 'test'), getMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'Inspecting a.ts' }] }] }]]);
  const view = createWorkerView({ terminal: { rows: 25 }, requestRender() {} }, theme, () => { closed = true; }, records);
  try {
    assert.match(view.render(100).join('\n'), /Parent › Workers/);
    view.handleInput('\t');
    assert.match(view.render(100).join('\n'), /#1 general/);
    assert.match(view.render(100).join('\n'), /Inspecting a\.ts/);
    records.get(1).worker.status = 'completed';
    assert.match(view.render(100).join('\n'), /completed/);
    view.handleInput('\x1b[B'); assert.match(view.render(100).join('\n'), /Parent › Workers/);
    view.handleInput('\x1b'); assert.equal(closed, true);
  } finally { view.dispose(); }
});
test('Up at the first picker entry wraps to the last worker; inside a worker it returns to parent', () => {
  let closed = false;
  const records = new Map(Array.from({ length: 50 }, (_, i) => {
    const id = i * 2 + 1; // non-contiguous ids: navigation follows picker order
    return [id, { worker: baseWorker(id), getMessages: () => [] }];
  }));
  const view = createWorkerView(mkTui(24), theme, () => { closed = true; }, records);
  try {
    assert.match(view.render(80).join('\n'), /› #1 general/);
    view.handleInput('\x1b[A');
    assert.equal(closed, false);
    assert.match(view.render(80).join('\n'), /› #99 general/);
    view.handleInput('\x1b[A');
    assert.match(view.render(80).join('\n'), /› #97 general/);
    view.handleInput('\x1b[B');
    assert.match(view.render(80).join('\n'), /› #99 general/);
    view.handleInput('\r');
    assert.match(view.render(80).at(-1), /#99 general/);
    view.handleInput('\x1b[A');
    assert.equal(closed, true, 'Up inside a worker still closes to the parent');
  } finally { view.dispose(); }
});

test('Up in empty and single-worker pickers stays in the picker; Esc still closes', () => {
  for (const count of [0, 1]) {
    let closed = false;
    const records = new Map(count ? [[7, { worker: baseWorker(7), getMessages: () => [] }]] : []);
    const view = createWorkerView(mkTui(24), theme, () => { closed = true; }, records);
    try {
      view.render(80);
      view.handleInput('\x1b[A');
      view.handleInput('\x1b[A');
      const text = view.render(80).join('\n');
      assert.equal(closed, false);
      assert.match(text, /Parent › Workers/);
      if (count) assert.match(text, /› #7 general/);
      else assert.match(text, /No delegated workers/);
      view.handleInput('\x1b');
      assert.equal(closed, true);
    } finally { view.dispose(); }
  }
});

test('transcript view includes messages and tools but not hidden reasoning', () => {
  const text = messageText([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } }] }, { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'source code' }] }]);
  assert.match(text, /a.ts/); assert.match(text, /source code/); assert.doesNotMatch(text, /hidden/);
});

test('task prompt is pinned readable at top while output streams below', () => {
  const task = 'Write tests for the worker view overlay and verify the prompt stays visible';
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: 'assistant', content: `Message ${i}` }));
  const records = new Map([[1, { worker: baseWorker(1, task), getMessages: () => messages }]]);
  const view = createWorkerView(mkTui(24), theme, () => {}, records);
  try {
    view.handleInput('\r'); // open worker 1
    // Follow mode with streaming output: prompt stays pinned at top.
    view.render(80);
    view.handleInput('\x1b[F'); // End -> follow latest output
    let rendered = view.render(80).map(line => stripTerminalSequences(line));
    assert.match(rendered.join('\n'), new RegExp(task.split(' ')[0]));
    assert.match(rendered.find(line => line.trim()), /Task: Write tests/); // first content is the prompt, not identity
    assert.ok(rendered.slice(1).some(line => /Message 39/.test(line)), 'latest output visible while following');
    // Identity moved to the bottom.
    assert.equal(rendered.indexOf(rendered.find(l => /#1 general/.test(l))), rendered.length - 1);
    messages.push({ role: 'assistant', content: 'New streaming output' });
    rendered = view.render(80).map(line => stripTerminalSequences(line));
    assert.match(rendered.find(line => line.trim()), /Task: Write tests/, 'prompt still pinned while output streams');
    assert.ok(rendered.slice(1).some(line => /New streaming output/.test(line)));
  } finally { view.dispose(); }
});

test('prompt panel has themed full-width background, padding, and a transcript gap', () => {
  const painted = [];
  let color = 236;
  const panelTheme = {
    fg: (token, text) => {
      if (token === 'userMessageText') assert.equal(visibleWidth(text), 60);
      return text;
    },
    bg: (token, text) => {
      painted.push(token);
      return `\x1b[48;5;${color}m${text}\x1b[49m`;
    }
  };
  const view = createWorkerView(mkTui(24), panelTheme, () => {}, new Map([
    [1, { worker: baseWorker(1, 'A spaced prompt'), getMessages: () => [{ role: 'assistant', content: 'Worker output' }] }]
  ]));
  try {
    view.handleInput('\r');
    const lines = view.render(60);
    const plain = lines.map(stripTerminalSequences);
    assert.deepEqual(painted, ['userMessageBg', 'userMessageBg', 'userMessageBg']);
    assert.equal(plain[0], ' '.repeat(60), 'top padding inside background');
    assert.equal(plain[1], '  Task: A spaced prompt'.padEnd(60));
    assert.equal(plain[2], ' '.repeat(60), 'bottom padding inside background');
    assert.equal(plain[3], '', 'unpainted gap separates prompt and transcript');
    assert.match(plain[4], /Transcript:/);
    assert.match(plain.join('\n'), /Worker output/);
    assert.ok(lines.slice(0, 3).every(line => line.startsWith('\x1b[48;5;236m') && line.endsWith('\x1b[49m')));
    assert.ok(lines.slice(3).every(line => !line.includes('\x1b[48;5;236m')), 'background does not leak into output/footer');
    assert.equal(lines.length, 24);
    assert.ok(lines.every(line => visibleWidth(line) <= 60));
    color = 250; // changing theme is reflected, not cached into the panel
    view.invalidate();
    assert.match(view.render(60)[1], /\x1b\[48;5;250m/);
  } finally { view.dispose(); }
});

test('prompt padding wraps all text inside the panel without clipping', () => {
  const task = 'The prompt should wrap inside its horizontal padding and retain every word.';
  const view = createWorkerView(mkTui(30), theme, () => {}, new Map([
    [1, { worker: baseWorker(1, task), getMessages: () => [] }]
  ]));
  try {
    view.handleInput('\r');
    const lines = view.render(40);
    const expected = plainLines(`Task: ${task}`, 36);
    assert.deepEqual(lines.slice(1, 1 + expected.length), expected.map(line => (`  ${line}`).padEnd(40)));
    assert.ok(lines.every(line => visibleWidth(line) <= 40));
  } finally { view.dispose(); }
});

test('background and spacing stay bounded on tiny and resized screens', () => {
  const terminal = { rows: 24 };
  const colored = { ...theme, bg: (_token, text) => `\x1b[48;5;236m${text}\x1b[49m` };
  const view = createWorkerView({ terminal, requestRender() {} }, colored, () => {}, new Map([
    [1, { worker: baseWorker(1, Array.from({ length: 50 }, (_, i) => `Instruction ${i}`).join('\n')), getMessages: () => [] }]
  ]));
  try {
    view.handleInput('\r');
    for (const rows of [24, 8, 4, 2, 1, 30]) {
      terminal.rows = rows;
      for (const width of [1, 2, 8, 20, 80]) {
        const lines = view.render(width);
        assert.equal(lines.length, rows);
        assert.ok(lines.every(line => visibleWidth(line) <= width), `bounds at ${width}x${rows}`);
        if (width >= 20) assert.match(stripTerminalSequences(lines.at(-1)), /#1 general/);
      }
    }
  } finally { view.dispose(); }
});

test('paused streaming viewport and sibling reading positions remain stable', () => {
  const messages = Array.from({ length: 45 }, (_, i) => ({ role: 'assistant', content: `Message ${i}` }));
  const records = new Map([1, 2].map(id => [id, { worker: baseWorker(id), getMessages: () => messages }]));
  const tui = mkTui(24);
  const view = createWorkerView(tui, theme, () => {}, records);
  try {
    view.handleInput('\r');
    view.render(80);
    view.handleInput('\x1b[5~');
    const before = view.render(80).slice(0, -4); // exclude controls, range, and identity
    messages.push({ role: 'assistant', content: 'New streaming output' });
    assert.deepEqual(view.render(80).slice(0, -4), before);
    view.handleInput('\x1b[C'); view.render(80);
    view.handleInput('\x1b[D');
    assert.deepEqual(view.render(80).slice(0, -4), before);
    records.get(1).worker.status = 'completed';
    assert.deepEqual(view.render(80).slice(0, -4), before);
    view.handleInput('\x1b[F');
    assert.match(view.render(80).join('\n'), /New streaming output/);
    for (const width of [30, 80, 160]) {
      const lines = view.render(width);
      assert.equal(lines.length, 24);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
    }
  } finally { view.dispose(); }
});

test('sibling cycling preserves transcript position but resets prompt to beginning', () => {
  const messages = Array.from({ length: 60 }, (_, i) => ({ role: 'assistant', content: `Sibling message ${i}` }));
  const records = new Map([1, 2].map(id => [id, { worker: baseWorker(id, 'cycle task'), getMessages: () => messages }]));
  const view = createWorkerView(mkTui(24), theme, () => {}, records);
  try {
    view.handleInput('\r'); // open #1
    view.handleInput('\x1b[F'); // follow end
    assert.match(view.render(80).join('\n'), /Sibling message 59/);
    view.handleInput('\x1b[5~'); // pause, scroll output up
    const snapped = view.render(80).join('\n');
    view.handleInput('\t'); // cycle to #2
    assert.match(view.render(80).join('\n'), /Task: cycle task/, 'prompt start visible after cycling');
    view.handleInput('\x1b[5~');
    view.render(80);
    // Transcript position is preserved per worker: cycling back restores it.
    view.handleInput('\x1b[D'); // back to #1
    assert.equal(stripTerminalSequences(view.render(80).join('\n')), stripTerminalSequences(snapped));
  } finally { view.dispose(); }
});

test('long prompt is fully reachable via independently scrollable prompt pane', () => {
  const task = Array.from({ length: 60 }, (_, i) => `Prompt line number ${i} with some words`).join(' ');
  const records = new Map([[1, { worker: baseWorker(1, task), getMessages: () => [{ role: 'assistant', content: 'Output here' }] }]]);
  const view = createWorkerView(mkTui(24), theme, () => {}, records);
  try {
    view.handleInput('\r');
    view.render(80);
    view.handleInput('p'); // focus prompt pane
    view.handleInput('\x1b[6~'); // PgDn in prompt
    let lines = view.render(80).map(line => stripTerminalSequences(line));
    const promptRows = lines.filter(l => /Prompt line number/.test(l));
    assert.ok(promptRows.length > 0, 'prompt pane shows scrolled content');
    assert.match(lines.find(line => line.trim()), /Task \d+–\d+\/\d+/, 'prompt range indicator shown');
    view.handleInput('\x1b[F'); // End of prompt
    lines = view.render(80).map(line => stripTerminalSequences(line));
    assert.match(lines.join('\n'), /some words/, 'last prompt words reachable');
    const total = plainLines(`Task: ${task}`, 76).length;
    assert.ok(lines.find(line => line.trim()).includes(`–${total}/${total}`), 'prompt range shows end');
    view.handleInput('\x1b[H'); // Home of prompt
    lines = view.render(80).map(line => stripTerminalSequences(line));
    assert.match(lines.join('\n'), /Prompt line number 0/, 'first prompt line reachable again');
    // Output pane remained independent: switch focus back and follow output.
    view.handleInput('p');
    view.handleInput('\x1b[F');
    lines = view.render(80).map(line => stripTerminalSequences(line));
    assert.ok(lines.some(l => /Output here/.test(l)), 'output still visible');
    assert.ok(lines.filter(l => /Prompt line number/.test(l)).length > 0, 'prompt still pinned above');
  } finally { view.dispose(); }
});

test('prompt pane never truncates text horizontally', () => {
  const longWord = 'Supercalifragilisticexpialidocious'.repeat(4);
  const records = new Map([[1, { worker: baseWorker(1, longWord), getMessages: () => [] }]]);
  const view = createWorkerView(mkTui(24), theme, () => {}, records);
  try {
    view.handleInput('\r');
    const lines = view.render(40);
    assert.ok(lines.length <= 24);
    assert.ok(lines.every(line => visibleWidth(line) <= 40));
    const joined = stripTerminalSequences(lines.join('\n'));
    assert.ok(/Supercalifragilisticexpialidocious/.test(joined), 'long word wrapped, not truncated');
  } finally { view.dispose(); }
});

test('duplicate initial task is dropped but other user messages retained', () => {
  const task = 'Do the thing';
  const messages = [
    { role: 'user', content: task },
    { role: 'assistant', content: 'Working on it' },
    { role: 'user', content: 'Follow-up question' }
  ];
  assert.equal(dropInitialTask(messages, task).length, 2);
  assert.equal(dropInitialTask(messages, 'different')[0].content, 'Do the thing');
  assert.equal(dropInitialTask(undefined, task).length, 0);
  assert.equal(dropInitialTask([{ role: 'user', content: [{ type: 'text', text: task }] }], task).length, 0);
  const records = new Map([[1, { worker: baseWorker(1, task), getMessages: () => messages }]]);
  const view = createWorkerView(mkTui(24), theme, () => {}, records);
  try {
    view.handleInput('\r');
    const rendered = stripTerminalSequences(view.render(80).join('\n'));
    assert.match(rendered, /Task: Do the thing/, 'pinned prompt present');
    assert.match(rendered, /Follow-up question/, 'later user message kept');
    assert.doesNotMatch(rendered, /^Do the thing$/m, 'duplicate initial task removed from transcript');
  } finally { view.dispose(); }
});

test('identity is rendered at the bottom with role, model, and status', () => {
  const records = new Map([[1, { worker: baseWorker(1, 'task'), getMessages: () => [{ role: 'assistant', content: 'hello' }] }]]);
  const view = createWorkerView(mkTui(20), theme, () => {}, records);
  try {
    view.handleInput('\r');
    const lines = view.render(80).map(l => stripTerminalSequences(l));
    assert.match(lines[lines.length - 1], /#1 general · glm · running/);
    // Role/model/status must not appear at the top.
    assert.doesNotMatch(lines[0], /glm/);
  } finally { view.dispose(); }
});

test('transcript file path stays visible in output pane', () => {
  const records = new Map([[1, { worker: baseWorker(1, 'task', { transcript: '/tmp/worker-1.jsonl' }), getMessages: () => [{ role: 'assistant', content: 'text' }] }]]);
  const view = createWorkerView(mkTui(24), theme, () => {}, records);
  try {
    view.handleInput('\r');
    assert.match(stripTerminalSequences(view.render(80).join('\n')), /\/tmp\/worker-1\.jsonl/);
  } finally { view.dispose(); }
});

test('single-line worker labels cannot inject physical rows or terminal tabs', () => {
  const records = new Map([[1, {
    worker: baseWorker(1, 'A multiline\ntask\twith tabs', {
      transcript: '/tmp/directory\nwith\ttabs/worker.jsonl',
      role: 'general\nagent', model: 'provider/\tmodel',
    }),
    getMessages: () => [{ role: 'assistant', content: 'Output stays within its pane' }],
  }]]);
  const view = createWorkerView(mkTui(24), theme, () => {}, records);
  try {
    // Picker task/identity labels are single-line too.
    for (const line of view.render(80)) assert.doesNotMatch(line, /[\r\n\t]/);
    view.handleInput('\r');
    const lines = view.render(80);
    assert.equal(lines.length, 24);
    for (const line of lines) {
      assert.doesNotMatch(line, /[\r\n\t]/);
      assert.ok(visibleWidth(line) <= 80);
    }
    assert.match(lines.join('\n'), /Transcript: \/tmp\/directory with tabs\/worker\.jsonl/);
    assert.match(lines.at(-1), /#1 general agent · provider\/ model · running/);
  } finally { view.dispose(); }
});

test('tiny and narrow terminals keep bounds, prompt and identity', () => {
  const task = Array.from({ length: 10 }, (_, i) => `Tiny prompt line ${i}`).join(' ');
  const records = new Map([[1, { worker: baseWorker(1, task), getMessages: () => [{ role: 'assistant', content: 'out' }] }]]);
  for (const rows of [1, 2, 3, 4, 5, 6, 8]) {
    for (const width of [10, 20, 40]) {
      const view = createWorkerView(mkTui(rows), theme, () => {}, records);
      try {
        view.handleInput('\r');
        const lines = view.render(width);
        assert.ok(lines.length <= rows, `rows ${rows} width ${width}: ${lines.length}`);
        assert.ok(lines.every(l => visibleWidth(l) <= width), `width ${rows}x${width}`);
        const flat = stripTerminalSequences(lines.join('\n'));
        if (rows >= 4) assert.match(flat, /#1/, `identity visible at ${rows} rows`);
        if (rows >= 5) assert.match(flat, /Tiny/, `prompt visible at ${rows} rows`);
        if (rows >= 5 && width >= 40) assert.match(flat, /Tiny prompt line/, `full prompt words at ${rows}x${width}`);
      } finally { view.dispose(); }
    }
  }
});

test('resize to a smaller terminal stays within bounds and re-shows prompt', () => {
  const task = Array.from({ length: 20 }, (_, i) => `Resize prompt line ${i}`).join(' ');
  const records = new Map([[1, { worker: baseWorker(1, task), getMessages: () => [{ role: 'assistant', content: 'out' }] }]]);
  const terminal = { rows: 30 };
  const view = createWorkerView({ terminal, requestRender() {} }, theme, () => {}, records);
  try {
    view.handleInput('\r');
    view.render(80);
    terminal.rows = 8;
    const lines = view.render(50);
    assert.ok(lines.length <= 8);
    assert.ok(lines.every(l => visibleWidth(l) <= 50));
    const flat = stripTerminalSequences(lines.join('\n'));
    assert.match(flat, /Resize prompt/);
    assert.match(flat, /#1 general/);
  } finally { view.dispose(); }
});

test('Ctrl+O expands and collapses tools while the prompt is focused', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'echo test' } }] },
    { role: 'toolResult', toolCallId: 'call', toolName: 'bash', content: 'first line\nsecond line' }
  ];
  const view = createWorkerView(mkTui(24), theme, () => {}, new Map([
    [1, { worker: baseWorker(1, 'Review output'), getMessages: () => messages }]
  ]));
  try {
    view.handleInput('\r');
    view.render(80);
    view.handleInput('p');
    const collapsed = stripTerminalSequences(view.render(80).join('\n'));
    assert.match(collapsed, /Ctrl\+O to expand/);
    view.handleInput('\x0f');
    const expanded = stripTerminalSequences(view.render(80).join('\n'));
    assert.match(expanded, /"command"/);
    assert.doesNotMatch(expanded, /Ctrl\+O to expand/);
    assert.match(expanded, /p: prompt/);
    view.handleInput('\x0f');
    assert.equal(stripTerminalSequences(view.render(80).join('\n')), collapsed);
  } finally { view.dispose(); }
});

test('scrolling and navigation controls stay discoverable in either pane', () => {
  const task = Array.from({ length: 60 }, (_, i) => `Instruction ${i}`).join('\n');
  const messages = Array.from({ length: 50 }, (_, i) => ({ role: 'assistant', content: `Output ${i}` }));
  for (const width of [40, 80, 120]) {
    const view = createWorkerView(mkTui(24), theme, () => {}, new Map([
      [1, { worker: baseWorker(1, task), getMessages: () => messages }]
    ]));
    try {
      view.handleInput('\r');
      view.render(width);
      view.handleInput('\x1b[5~'); // paused output adds a longer range label
      for (const focus of ['output', 'prompt']) {
        if (focus === 'prompt') view.handleInput('p');
        const lines = view.render(width);
        const text = stripTerminalSequences(lines.join('\n'));
        assert.match(text, new RegExp(`p: ${focus}`));
        for (const key of ['PgUp/PgDn', 'j/k', 'Home/End', '←/→/Tab', '↑/Esc', '↓ picker', 'Ctrl+O']) {
          assert.ok(text.replace(/\s+/g, ' ').includes(key), `${key} visible at width ${width} (${focus})`);
        }
        assert.equal(lines.length, 24);
        assert.ok(lines.every(line => visibleWidth(line) <= width));
      }
    } finally { view.dispose(); }
  }
});

test('every long prompt line is reachable and cycling resets the prompt independently', () => {
  const taskLines = Array.from({ length: 55 }, (_, i) => `Unique instruction ${i}`);
  const messages = Array.from({ length: 45 }, (_, i) => ({ role: 'assistant', content: `Output ${i}` }));
  const view = createWorkerView(mkTui(24), theme, () => {}, new Map([
    [1, { worker: baseWorker(1, taskLines.join('\n')), getMessages: () => messages }],
    [2, { worker: baseWorker(2, 'Different worker prompt'), getMessages: () => messages }]
  ]));
  try {
    view.handleInput('\r');
    view.render(80);
    view.handleInput('p');
    const seen = new Set();
    for (let i = 0; i < taskLines.length; i++) {
      for (const line of view.render(80)) {
        const match = stripTerminalSequences(line).match(/Unique instruction (\d+)/);
        if (match) seen.add(Number(match[1]));
      }
      view.handleInput('j');
    }
    assert.equal(seen.size, taskLines.length, 'no prompt lines omitted');
    messages.push({ role: 'assistant', content: 'Still following output' });
    assert.match(view.render(80).join('\n'), /Still following output/);
    view.handleInput('\t');
    assert.match(view.render(80).find(line => line.trim()), /Task: Different worker prompt/);
    view.handleInput('\x1b[Z'); // Shift+Tab
    assert.match(view.render(80).join('\n'), /Task: Unique instruction 0/);
  } finally { view.dispose(); }
});

test('empty picker fits narrow terminal widths', () => {
  const view = createWorkerView(mkTui(24), theme, () => {}, new Map());
  try {
    for (const width of [1, 10, 30]) {
      const lines = view.render(width);
      assert.equal(lines.length, 24);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
    }
  } finally { view.dispose(); }
});

test('tool summaries keep queries, scopes, and unknown names safe', () => {
  assert.equal(toolSummary('grep', { pattern: 'needle', path: 'src' }), 'Search needle in src');
  assert.equal(toolSummary('find', { pattern: '*.ts', path: 'src' }), 'Find *.ts in src');
  assert.equal(toolSummary('mystery\n\\x1b[31m', { path: 'a.ts' }), 'mystery \\x1b[31m a.ts');
});

test('transcripts highlight source, collapse tools, and retain errors', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private thought' }, { type: 'toolCall', id: 'r', name: 'read', arguments: { path: 'a.ts' } }] },
    { role: 'toolResult', toolCallId: 'r', toolName: 'read', content: [{ type: 'text', text: 'const answer = 42;\nconsole.log(answer);' }] },
    { role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'failed first line\ncritical second line' }] }
  ];
  const expanded = renderTranscript(messages, theme, 80).join('\n');
  assert.match(expanded, /\x1b\[/);
  assert.match(stripTerminalSequences(expanded), /const answer = 42/);
  assert.doesNotMatch(expanded, /private thought/);
  const collapsed = renderTranscript(messages, theme, 80, false).join('\n');
  assert.match(collapsed, /Ctrl\+O to expand/);
  assert.match(collapsed, /const answer = 42/);
  assert.match(collapsed, /critical second line/);
});

test('collapsed results keep output visible beside long targets and pair calls', () => {
  const path = 'a/'.repeat(150) + 'result.txt';
  const rendered = stripTerminalSequences(renderTranscript([
    { role: 'assistant', content: [{ type: 'toolCall', id: 'r', name: 'read', arguments: { path } }] },
    { role: 'toolResult', toolCallId: 'r', toolName: 'read', content: [{ type: 'text', text: 'IMPORTANT RESULT' }] },
  ], theme, 50, false).join('\n'));
  assert.match(rendered, /IMPORTANT RESULT/);
  assert.match(rendered, /Read/);
});

test('collapsed failures retain their output and status', () => {
  const rendered = stripTerminalSequences(renderTranscript([
    { role: 'toolResult', toolName: 'mystery', isError: true, content: [{ type: 'text', text: 'critical failure' }] }
  ], theme, 50, false).join('\n'));
  assert.match(rendered, /✗ mystery/);
  assert.match(rendered, /critical failure/);
});

test('sanitized worker content keeps ANSI and control characters out of the view', () => {
  const evil = '\x1b]0;pwned\x07\x1b[31mred\x1b[0m text\x07more';
  const records = new Map([[1, { worker: baseWorker(1, evil), getMessages: () => [{ role: 'assistant', content: evil }] }]]);
  const view = createWorkerView(mkTui(24), theme, () => {}, records);
  try {
    view.handleInput('\r');
    const rendered = view.render(80);
    assert.ok(rendered.every(line => visibleWidth(line) <= 80));
    assert.doesNotMatch(rendered.join('\n'), /\x1b\]0;pwned/);
    assert.doesNotMatch(rendered.join('\n'), /\x07/);
    assert.match(stripTerminalSequences(rendered.join('\n')), /red text/);
  } finally { view.dispose(); }
});

test('restored transcript from disk renders with pinned prompt and no duplicate task', async () => {
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'worker-view-'));
  try {
    const transcriptPath = join(dir, 'worker.jsonl');
    const task = 'Disk transcript task';
    const entries = [
      { type: 'message', message: { role: 'user', content: task } },
      { type: 'message', message: { role: 'assistant', content: 'from disk' } },
      { type: 'other', message: { role: 'assistant', content: 'ignored' } }
    ];
    await writeFile(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n'));
    const records = new Map([[1, { worker: baseWorker(1, task, { transcript: transcriptPath }) }]]);
    const view = createWorkerView(mkTui(24), theme, () => {}, records);
    try {
      view.handleInput('\r');
      const flat = stripTerminalSequences(view.render(80).join('\n'));
      assert.match(flat, /Task: Disk transcript task/);
      assert.match(flat, /from disk/);
      assert.doesNotMatch(flat, /Disk transcript task\nDisk transcript task/);
      assert.doesNotMatch(flat, /ignored/);
    } finally { view.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real TUI overlay composition stays fixed when the parent grows', () => {
  const tui = new TuiMainScreen({ rows: 24, columns: 80, hideCursor() {} });
  tui.requestRender = () => {}; // Exercise the real compositor without terminal I/O.
  const view = createWorkerView(tui, theme, () => {}, new Map());
  let handle;
  try {
    handle = tui.showOverlay(view, workerOverlayOptions.overlayOptions);
    const before = tui.compositeOverlays(['Parent line'], 80, 24).slice(-24);
    const after = tui.compositeOverlays(Array.from({ length: 100 }, (_, i) => `Parent update ${i}`), 80, 24).slice(-24);
    assert.deepEqual(after, before);
    assert.match(stripTerminalSequences(after.join('\n')), /Parent › Workers/);
    assert.doesNotMatch(stripTerminalSequences(after.join('\n')), /Parent update/);
  } finally { handle?.hide(); view.dispose(); }
});
