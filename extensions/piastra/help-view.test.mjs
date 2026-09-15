import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { helpSections } from './help.mjs';
import { createHelpView } from './help-view.ts';

const theme = { fg: (_s, t) => t, bg: (_s, t) => t };
const mkTui = (rows) => ({ terminal: { rows }, requestRender() {} });
const text = (view, width) => stripTerminalSequences(view.render(width).join('\n'));
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const ENTER = '\r';
const ESC = '\x1b';

function open(initialId, rows = 24) {
  let closed = false;
  const view = createHelpView(mkTui(rows), theme, () => { closed = true; }, helpSections, initialId);
  return { view, closed: () => closed, dispose: () => view.dispose() };
}

test('picker lists sections; arrows + Enter choose; width-safe single column', () => {
  const { view, dispose } = open(undefined, 24);
  try {
    const first = text(view, 80);
    assert.match(first, /Dispatch help/);
    assert.match(first, /Getting started/);
    view.handleInput(DOWN);
    view.handleInput(DOWN);
    assert.equal(view.state().pickerIndex, 2);
    view.handleInput(ENTER);
    assert.equal(view.state().mode, 'reading');
    assert.equal(view.state().sectionIndex, 2);
    for (const line of view.render(1)) assert.ok(stripTerminalSequences(line).length <= 1, '1-column safe');
    for (const line of view.render(80)) assert.ok(stripTerminalSequences(line).length <= 80, 'fits width');
  } finally { dispose(); }
});

test('reading scrolls with arrows PgUp PgDn Home End j/k; End clamps; arrows scroll lines', () => {
  const { view, dispose } = open('workers-tasks', 8);
  try {
    assert.equal(view.state().mode, 'reading');
    const top = text(view, 80);
    view.handleInput(DOWN); // arrow scrolls one line, not section change
    assert.equal(view.state().sectionIndex, view.state().pickerIndex, 'arrow scroll keeps section');
    assert.ok(view.state().scroll >= 1, 'arrow scrolled');
    view.handleInput('j');
    const afterJ = view.state().scroll;
    view.handleInput('k');
    assert.ok(view.state().scroll < afterJ, 'k scrolls back');
    view.handleInput('\x1b[6~'); // PgDn
    const afterPg = view.state().scroll;
    assert.ok(afterPg > 0, 'PgDn pages');
    view.handleInput('\x1b[5~'); // PgUp
    assert.ok(view.state().scroll <= afterPg, 'PgUp pages back');
    view.handleInput('\x1b[4~'); // End clamps to max
    const endText = text(view, 80);
    assert.notEqual(endText, top, 'End moved');
    view.handleInput('\x1b[H'); // Home
    assert.equal(view.state().scroll, 0);
    assert.equal(text(view, 80), top, 'Home returns to top');
  } finally { dispose(); }
});

test('Left/b returns to sections; Enter cycles next; Esc and Ctrl+C close', () => {
  for (const closer of [ESC, '\x03']) {
    let closed = false;
    const view = createHelpView(mkTui(24), theme, () => { closed = true; }, helpSections);
    try {
      view.handleInput(ENTER);
      assert.equal(view.state().mode, 'reading');
      const first = view.state().sectionIndex;
      view.handleInput(ENTER); // next section
      assert.equal(view.state().sectionIndex, (first + 1) % helpSections.length);
      assert.equal(view.state().scroll, 0, 'section change resets scroll');
      view.handleInput(LEFT);
      assert.equal(view.state().mode, 'sections', 'Left backs to sections');
      view.handleInput(ENTER);
      view.handleInput('b');
      assert.equal(view.state().mode, 'sections', 'b backs to sections');
      view.handleInput(closer);
      assert.equal(closed, true, `${JSON.stringify(closer)} closes`);
    } finally { view.dispose(); }
  }
});

test('initial section id preselects reading; unknown id opens the picker', () => {
  const known = open('shortcuts', 24);
  try {
    assert.equal(known.view.state().mode, 'reading');
    assert.match(text(known.view, 80), /Shift\+Tab/);
  } finally { known.dispose(); }
  const unknown = open('nope', 24);
  try {
    assert.equal(unknown.view.state().mode, 'sections');
  } finally { unknown.dispose(); }
});

test('short heights and one-row terminals render without overflow', () => {
  for (const rows of [1, 3, 5]) {
    const { view, dispose } = open('shortcuts', rows);
    try {
      const lines = view.render(40);
      assert.ok(lines.length <= rows, `rows=${rows} fits`);
      const picker = open(undefined, rows);
      try {
        assert.ok(picker.view.render(40).length <= rows, `picker rows=${rows} fits`);
      } finally { picker.dispose(); }
    } finally { dispose(); }
  }
});

test('state is fresh per open: scroll and picker do not leak between instances', () => {
  const first = open(undefined, 24);
  try {
    first.view.handleInput(DOWN);
    first.view.handleInput(ENTER);
    first.view.handleInput('j');
    first.view.handleInput('j');
    assert.ok(first.view.state().scroll > 0);
  } finally { first.dispose(); }
  const second = open(undefined, 24);
  try {
    assert.deepEqual(second.view.state(), { mode: 'sections', pickerIndex: 0, sectionIndex: 0, scroll: 0, sections: second.view.state().sections });
  } finally { second.dispose(); }
});

test('long body lines wrap instead of truncating: every marker reachable at widths 20 and 40', () => {
  const longSections = [
    { id: 'a', title: 'Alpha section', lines: ['short line', `word `.repeat(30) + 'MARKER-ALPHA-END'] },
    { id: 'b', title: 'Beta section', lines: [`x`.repeat(120) + 'MARKER-BETA-END'] },
  ];
  for (const width of [20, 40]) {
    for (const id of ['a', 'b']) {
      let closed = false;
      const view = createHelpView(mkTui(24), theme, () => { closed = true; }, longSections, id);
      try {
        const marker = id === 'a' ? 'MARKER-ALPHA-END' : 'MARKER-BETA-END';
        const seen = new Set();
        // Walk the full scroll range; every render must fit the width.
        for (let step = 0; step < 60; step++) {
          const lines = view.render(width);
          assert.ok(lines.length <= 24, 'no overflow');
          for (const line of lines) {
            assert.ok(stripTerminalSequences(line).length <= width, `fits width ${width}`);
            seen.add(stripTerminalSequences(line));
          }
          if ([...seen].join('\n').includes(marker)) break;
          view.handleInput(DOWN);
        }
        assert.ok([...seen].join('\n').includes(marker), `${marker} reachable at width ${width}`);
        assert.equal(closed, false);
      } finally { view.dispose(); }
    }
  }
});

test('selected last section stays visible in short terminals at rows 3-5 and narrow widths', () => {
  for (const rows of [3, 4, 5]) {
    for (const width of [1, 10, 20, 40, 80]) {
      let closed = false;
      const view = createHelpView(mkTui(rows), theme, () => { closed = true; }, helpSections);
      try {
        for (let i = 0; i < helpSections.length - 1; i++) view.handleInput(DOWN);
        assert.equal(view.state().pickerIndex, helpSections.length - 1);
        const lines = view.render(width);
        assert.ok(lines.length <= rows, `picker rows=${rows} width=${width} fits`);
        for (const line of lines) assert.ok(stripTerminalSequences(line).length <= width, 'no overflow');
        const last = helpSections[helpSections.length - 1].title;
        if (width >= 10) {
          // Wrapped rows may split the title, so look for its first word
          // on the visible selected row rather than the full string.
          assert.ok(text(view, width).includes(last.split(' ')[0]), `last section visible at rows=${rows} width=${width}`);
        } else {
          // At a handful of columns the selected-row marker is the
          // selection signal: titles cannot fit but › must remain visible.
          assert.ok(text(view, width).includes('›'), `selection marker visible at rows=${rows} width=${width}`);
        }
        assert.equal(closed, false);
      } finally { view.dispose(); }
    }
  }
});

test('resize reflows after End: content reachable at the new width with no overflow', () => {
  const longSections = [
    { id: 'only', title: 'Only', lines: [`Lorem ipsum dolor sit amet `.repeat(12) + 'MARKER-REFLOW-END'] },
  ];
  const tui = mkTui(24);
  let closed = false;
  const view = createHelpView(tui, theme, () => { closed = true; }, longSections, 'only');
  try {
    view.handleInput('\x1b[F'); // End at width 80
    let out = text(view, 80);
    assert.ok(out.includes('MARKER-REFLOW-END'), 'End reaches the tail');
    tui.terminal.rows = 6; // resize: fewer rows, narrower width
    view.handleInput('\x1b[F'); // End again re-anchors to the reflowed tail
    const seen = new Set();
    for (let step = 0; step < 80; step++) {
      const lines = view.render(20);
      assert.ok(lines.length <= 6, 'no overflow after resize');
      for (const line of lines) assert.ok(stripTerminalSequences(line).length <= 20, 'fits new width');
      for (const line of lines) seen.add(stripTerminalSequences(line));
      if ([...seen].join('\n').includes('MARKER-REFLOW-END')) break;
      view.handleInput(UP); // walk back up in the reflowed rows
    }
    assert.ok([...seen].join('\n').includes('MARKER-REFLOW-END'), 'marker still reachable after resize reflow');
    assert.equal(closed, false);
  } finally { view.dispose(); }
});

test('one- and two-row terminals prioritize the selected/content row', () => {
  const picker = open(undefined, 1);
  try {
    picker.view.handleInput(DOWN);
    picker.view.handleInput(DOWN);
    const out = text(picker.view, 40);
    assert.ok(out.includes(helpSections[2].title), '1-row picker shows the selected section, not only chrome');
  } finally { picker.dispose(); }
  const reading = open('shortcuts', 1);
  try {
    const lines = reading.view.render(40);
    assert.equal(lines.length, 1);
    assert.ok(!stripTerminalSequences(lines[0]).includes('Esc close'), '1-row reading shows content, not only the footer');
  } finally { reading.dispose(); }
  const two = open('shortcuts', 2);
  try {
    const lines = two.view.render(40);
    assert.equal(lines.length, 2);
    assert.ok(!stripTerminalSequences(lines.join('\n')).includes('Esc close'), '2-row reading yields the footer for content');
  } finally { two.dispose(); }
});

test('picker arrows move selection (Up from top stays); reading Up scrolls', () => {
  const { view, closed, dispose } = open(undefined, 24);
  try {
    view.handleInput(UP);
    assert.equal(view.state().pickerIndex, 0, 'Up at top stays');
    assert.equal(closed(), false, 'picker Up does not close');
    view.handleInput(RIGHT);
    assert.equal(view.state().mode, 'reading', 'Right opens section');
  } finally { dispose(); }
});
