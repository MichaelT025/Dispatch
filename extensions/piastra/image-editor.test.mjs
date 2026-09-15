import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesKey, stripTerminalSequences } from '@earendil-works/pi-tui';
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { PiastraEditor, installShortcuts } from './shortcuts.ts';

const paths = [
  'C:\\Users\\micha\\AppData\\Local\\Temp\\pi-clipboard-a1b2c3d4-e5f6-4789-9abc-def012345678.png',
  'C:\\Users\\micha\\AppData\\Local\\Temp\\pi-clipboard-9f8e7d6c-5b4a-4321-8fed-cba987654321.png',
];
const tui = { terminal: { rows: 40 }, requestRender() {} };
const theme = { borderColor: text => text };
const keys = (clipboard = ['alt+v']) => ({
  matches: (data, action) => action === 'app.clipboard.pasteImage' && clipboard.some(key => matchesKey(data, key)),
});
const makeEditor = (options = {}) => new PiastraEditor(tui, theme, keys(), options);
const rendered = editor => stripTerminalSequences(editor.render(120).join('\n'));

test('Ctrl+V and Alt+V reuse the native clipboard callback and accumulate image placeholders', async () => {
  const editor = makeEditor();
  let pastes = 0;
  // Core copies this callback into CustomEditor after construction. It inserts
  // the temporary image path asynchronously into the active editor.
  editor.onPasteImage = () => {
    const path = paths[pastes++];
    queueMicrotask(() => editor.insertTextAtCursor(path));
  };
  editor.handleInput('\x16');
  await Promise.resolve();
  editor.handleInput('\x1bv');
  await Promise.resolve();
  const text = rendered(editor);
  assert.equal(pastes, 2);
  assert.match(text, /\[Image #1\]/);
  assert.match(text, /\[Image #2\]/);
  assert.doesNotMatch(text, /pi-clipboard|chars|\[paste #/);
  assert.equal(editor.getExpandedText(), paths.join(' '));
  let submitted;
  editor.onSubmit = text => { submitted = text; };
  editor.handleInput('\r');
  assert.equal(submitted, paths.join(' '));
  assert.equal(editor.getText(), '');
  editor.insertTextAtCursor(paths[0]);
  assert.match(rendered(editor), /\[Image #1\]/, 'new draft restarts image numbering');
});

test('kitty Ctrl+V works and native custom clipboard bindings remain active', () => {
  const editor = new PiastraEditor(tui, theme, keys(['ctrl+b']));
  let calls = 0;
  editor.onPasteImage = () => { calls++; };
  editor.handleInput('\x1b[118;5u');
  editor.handleInput('\x02');
  assert.equal(calls, 2);
});

test('clipboard text fallback and normal bracketed multiline placeholders are preserved', () => {
  const editor = makeEditor();
  editor.onPasteImage = () => editor.insertTextAtCursor('ordinary clipboard text');
  editor.handleInput('\x16');
  assert.equal(editor.getText(), 'ordinary clipboard text');
  editor.setText('');
  const text = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n');
  editor.handleInput(`\x1b[200~${text}\x1b[201~`);
  assert.match(rendered(editor), /\[paste #1 \+15 lines\]/);
  editor.insertTextAtCursor(paths[0]);
  assert.match(rendered(editor), /\[Image #1\]/);
  assert.equal(editor.getExpandedText(), `${text} ${paths[0]}`);
});

test('terminal-pasted clipboard paths become image labels, including split paste chunks', () => {
  const editor = makeEditor();
  let clipboardReads = 0;
  editor.onPasteImage = () => { clipboardReads++; };
  editor.handleInput(`\x1b[200~${paths[0]}\x1b[201~`);
  editor.handleInput('\x1b[200~');
  editor.handleInput(paths[1].slice(0, 20));
  editor.handleInput(paths[1].slice(20));
  editor.handleInput('\x1b[201~ after');
  assert.match(rendered(editor), /\[Image #1\]/);
  assert.match(rendered(editor), /\[Image #2\]/);
  assert.equal(editor.getExpandedText(), `${paths.join(' ')} after`);
  assert.equal(clipboardReads, 0, 'terminal paste must not trigger another OS clipboard read');
});

test('split bracketed text paste does not dispatch shortcut-looking payload', () => {
  const editor = makeEditor();
  let clipboardReads = 0;
  editor.onPasteImage = () => { clipboardReads++; };
  editor.handleInput('\x1b[200~');
  editor.handleInput('ordinary text');
  editor.handleInput('\x16'); // literal control byte inside paste, not a keypress
  editor.handleInput('\x1b[201~');
  assert.equal(clipboardReads, 0);
  assert.equal(editor.getText(), 'ordinary text'); // native paste filtering removes control bytes
});

test('image paste cancels an armed leader without running its actions', () => {
  const editor = makeEditor();
  editor.onPasteImage = () => editor.insertTextAtCursor(paths[0]);
  try {
    editor.handleInput('\x18');
    assert.equal(editor.isLeaderArmed, true);
    editor.handleInput('\x16');
    assert.equal(editor.isLeaderArmed, false);
    assert.match(rendered(editor), /\[Image #1\]/);
  } finally { editor.dispose(); }
});

test('image deletion and undo stay atomic through the integrated editor', () => {
  const editor = makeEditor();
  editor.insertTextAtCursor(paths[0]);
  editor.handleInput('\x7f');
  assert.equal(editor.getText(), '');
  editor.handleInput('\x1f');
  assert.equal(editor.getExpandedText(), paths[0]);
  assert.match(rendered(editor), /\[Image #1\]/);
});

test('setText transfers preserve the paths behind image tokens', () => {
  const editor = makeEditor();
  editor.insertTextAtCursor(paths[0]);
  const draft = editor.getLines().join('\n'); // internal collapsed draft
  editor.setText(`queued text\n${draft}`);
  assert.equal(editor.getExpandedText(), `queued text\n${paths[0]}`);
  assert.doesNotMatch(editor.getExpandedText(), /\[paste #|\[Image #/);
});

test('native custom-to-default-to-replacement reload preserves image paths', () => {
  const original = makeEditor();
  original.insertTextAtCursor('Review these: ');
  for (const path of paths) original.insertTextAtCursor(path);
  assert.match(rendered(original), /\[Image #2\]/);
  assert.match(original.getLines().join('\n'), /\[paste #/, 'native state remains atomic');
  const expected = `Review these: ${paths.join(' ')}`;
  assert.equal(original.getText(), expected, 'exported text carries paths, not unresolvable tokens');
  // resetExtensionUI runs BEFORE session_shutdown/factory creation on reload.
  const defaultEditor = new CustomEditor(tui, theme, keys());
  defaultEditor.setText(original.getText());
  original.dispose();
  const replacement = makeEditor({ initialExpandedText: defaultEditor.getExpandedText() });
  replacement.setText(defaultEditor.getText());
  assert.equal(replacement.getExpandedText(), expected);
  let submitted;
  replacement.onSubmit = text => { submitted = text; };
  replacement.handleInput('\r');
  assert.equal(submitted, expected);
});

test('factory captures expanded draft so replacing an editor never strands image tokens', () => {
  const original = makeEditor();
  original.insertTextAtCursor(paths[0]);
  const text = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n');
  original.handleInput(`\x1b[200~\n${text}\x1b[201~`);
  const collapsed = original.getText();
  const expanded = original.getExpandedText();
  const handlers = new Map();
  let factory;
  installShortcuts({ on: (name, callback) => handlers.set(name, callback) }, {
    cycleAgents() {}, openAgentPicker() {}, openWorkers() {},
  });
  handlers.get('session_start')({}, {
    mode: 'tui',
    ui: {
      getEditorComponent: () => undefined,
      getEditorText: () => expanded,
      setEditorComponent: value => { factory = value; },
      notify() {},
    },
  });
  const replacement = factory(tui, theme, keys());
  replacement.setText(collapsed); // mirrors core setCustomEditorComponent
  assert.equal(replacement.getExpandedText(), expanded);
  replacement.setText('new unrelated text');
  assert.equal(replacement.getText(), 'new unrelated text', 'initial draft is used only once');
  handlers.get('session_shutdown')();
});

test('image placeholders render inside Atelier and draft paths survive frame removal', async () => {
  const { installAtelierEditor, clearAtelierEditor } = await import('../pi-atelier/src/editor.ts');
  const handlers = new Map();
  let factory;
  let editor;
  const ctx = { mode: 'tui', ui: {
    getEditorComponent: () => factory,
    getEditorText: () => editor?.getExpandedText() ?? '',
    setEditorComponent(value) {
      const draft = editor?.getText() ?? '';
      factory = value;
      editor = factory(tui, theme, keys());
      editor.setText(draft);
    },
    notify() {},
  } };
  installShortcuts({ on: (name, callback) => handlers.set(name, callback) }, {
    cycleAgents() {}, openAgentPicker() {}, openWorkers() {},
  });
  handlers.get('session_start')({}, ctx);
  const token = {};
  try {
    assert.equal(installAtelierEditor(ctx, token), true);
    editor.insertTextAtCursor(paths[0]);
    assert.match(rendered(editor), /╭/);
    assert.match(rendered(editor), /\[Image #1\]/);
    assert.doesNotMatch(rendered(editor), /pi-clipboard|\[paste #/);
    assert.equal(editor.getExpandedText(), paths[0]);
    clearAtelierEditor(ctx, token);
    assert.doesNotMatch(rendered(editor), /╭/);
    assert.equal(editor.getExpandedText(), paths[0], 'replacement exports real paths, not stranded markers');
  } finally { handlers.get('session_shutdown')(); }
});
