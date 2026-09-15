import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { insertClipboardImage, renderImagePlaceholders, expandImageMarkers } from './image-paste.ts';

const UNIX_PATH = '/tmp/pi-clipboard-9f8e7d6c-5b4a-4321-8fed-cba987654321.jpg';
const WIN_PATH = 'C:\\Users\\micha\\AppData\\Local\\Temp\\pi-clipboard-a1b2c3d4-e5f6-4789-9abc-def012345678.png';
/** Internal marker shape this adapter inserts: native `[paste #N <len> chars]`. */
const imageMarker = (id, len) => `[paste #${id} ${len} chars]`;
const unixMarker = (id) => imageMarker(id, UNIX_PATH.length);
const winMarker = (id) => imageMarker(id, WIN_PATH.length);
/** Display label: `[Image #N]` padded with trailing spaces to the native marker width. */
const imageLabel = (ordinal, len, id = ordinal) => `[Image #${ordinal}]`.padEnd(imageMarker(id, len).length);

const NON_IMAGE_TEXTS = [
  'check out my photo.png',
  'see /tmp/pi-clipboard-9f8e7d6c-5b4a-4321-8fed-cba987654321.jpg for details',
  'pi-clipboard-9f8e7d6c-5b4a-4321-8fed-cba987654321.png',
  'const file = "/tmp/pi-clipboard-9f8e7d6c-5b4a-4321-8fed-cba987654321.png";',
  '/tmp/pi-clipboard-9f8e7d6c-5b4a-4321-8fed-cba987654321.txt',
  '/tmp/screenshot.png',
  'hello world',
  '',
  'C:\\rel\\path.png',
];

const tuiStub = { terminal: { rows: 40, columns: 120 }, requestRender() {} };
const selectListTheme = {
  selectedPrefix: (s) => s,
  selectedText: (s) => s,
  description: (s) => s,
  scrollInfo: (s) => s,
  noMatch: (s) => s,
};
const editorThemeStub = { borderColor: (s) => s, selectList: selectListTheme };
const keybindingsStub = { matches: () => false, getKeys: () => [] };

function createEditor(kind = 'editor') {
  if (kind === 'custom') {
    return new CustomEditor(tuiStub, editorThemeStub, keybindingsStub);
  }
  return new Editor(tuiStub, editorThemeStub);
}

/** Insert an image the way the parent integration does: native hook bound to the editor. */
function insertNativeFor(editor) {
  return (text) => editor.insertTextAtCursor(text);
}

test('inserts a native marker and registers the clipboard image path', () => {
  const editor = createEditor();
  const changes = [];
  editor.onChange = (t) => changes.push(t);
  const ok = insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor));
  assert.equal(ok, true);
  assert.equal(editor.getText(), unixMarker(1));
  assert.equal(editor.pastes.get(1), UNIX_PATH);
  assert.equal(editor.pasteCounter, 1);
  assert.deepEqual(editor.getCursor(), { line: 0, col: unixMarker(1).length });
  // single notify, after registration, with final text
  assert.equal(changes.length, 1);
  assert.equal(changes[0], unixMarker(1));
  // expanded text and Enter submit return the real path, no tokens
  assert.equal(editor.getExpandedText(), UNIX_PATH);
  let submitted;
  editor.onSubmit = (t) => { submitted = t; };
  editor.handleInput('\r');
  assert.equal(submitted, UNIX_PATH);
  assert.equal(editor.getText(), '');
});

test('rejects prose, relative names and ordinary text ending in an image extension', () => {
  const editor = createEditor();
  for (const text of NON_IMAGE_TEXTS) {
    assert.equal(insertClipboardImage(editor, text, insertNativeFor(editor)), false, JSON.stringify(text));
  }
  assert.equal(editor.getText(), '');
  assert.equal(editor.pastes.size, 0);
});

test('accepts quoted windows paths and registers the unquoted payload unchanged', () => {
  const editor = createEditor();
  const quoted = `"${WIN_PATH}"`;
  const ok = insertClipboardImage(editor, quoted, insertNativeFor(editor));
  assert.equal(ok, true);
  assert.equal(editor.pastes.get(1), WIN_PATH);
  assert.equal(editor.getExpandedText(), WIN_PATH);
  assert.equal(editor.getText(), winMarker(1));
});

test('accepts leading/trailing whitespace and single quotes around the path', () => {
  const editor = createEditor();
  assert.equal(insertClipboardImage(editor, `  '${UNIX_PATH}' \n`, insertNativeFor(editor)), true);
  assert.equal(editor.pastes.get(1), UNIX_PATH);
});

test('successive images get distinct ids and whitespace separation', () => {
  const editor = createEditor();
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  assert.equal(insertClipboardImage(editor, WIN_PATH, insertNativeFor(editor)), true);
  assert.equal(editor.getText(), `${unixMarker(1)} ${winMarker(2)}`);
  assert.equal(editor.pastes.get(2), WIN_PATH);
  // expanded paths must not concatenate
  assert.equal(editor.getExpandedText(), `${UNIX_PATH} ${WIN_PATH}`);
  // display: image-only ordinals, width preserved
  const rendered = renderImagePlaceholders(editor, editor.getLines());
  assert.equal(
    stripTerminalSequences(rendered.join('\n')),
    `${imageLabel(1, UNIX_PATH.length)} ${imageLabel(2, WIN_PATH.length)}`,
  );
  for (const line of rendered) {
    assert.equal(stripTerminalSequences(line).length, editor.getLines()[0].length);
  }
});

test('pads display labels when the native id is wider than the image ordinal', () => {
  const editor = createEditor();
  // literal wide token that will not be renamed keeps a multi-digit registry id
  editor.setText('before [paste #9] after');
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  assert.equal(editor.getText(), `before [paste #9] after ${unixMarker(10)}`);
  const rendered = renderImagePlaceholders(editor, editor.getLines());
  // id "10" vs ordinal "1": trailing spaces pad `[Image #1]` to the native width
  assert.equal(
    stripTerminalSequences(rendered.join('\n')),
    `before [paste #9] after ${imageLabel(1, UNIX_PATH.length, 10)}`,
  );
  assert.equal(renderImagePlaceholders(editor, [unixMarker(10)])[0].length, unixMarker(10).length);
  assert.equal(renderImagePlaceholders(editor, [unixMarker(1)])[0].length, unixMarker(1).length);
});

test('mixed native large paste and image: only the image marker is renamed', () => {
  const editor = createEditor();
  const bigText = Array.from({ length: 15 }, (_, i) => `line ${i} of a long native paste`).join('\n');
  editor.handleInput(`\x1b[200~${bigText}\x1b[201~`);
  assert.match(editor.getText(), /\[paste #1 \+15 lines\]/);
  assert.equal(editor.pastes.get(1), bigText);
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  assert.equal(editor.pasteCounter, 2);
  assert.equal(editor.getText().endsWith(unixMarker(2)), true);
  const lines = editor.getLines();
  const rendered = renderImagePlaceholders(editor, lines);
  assert.match(stripTerminalSequences(rendered.join('\n')), /\[paste #1 \+15 lines\]/);
  assert.ok(stripTerminalSequences(rendered.join('\n')).includes(imageLabel(1, UNIX_PATH.length, 2)));
  assert.doesNotMatch(stripTerminalSequences(rendered.join('\n')), /\[paste #2/);
  // native expansion still covers the large paste, image expansion covers the path
  const expanded = editor.getExpandedText();
  assert.match(expanded, /^line 0 of a long native paste/);
  assert.ok(expanded.includes(UNIX_PATH));
  assert.doesNotMatch(expanded, /\[paste #2/);
});

test('expandImageMarkers expands only valid image tokens', () => {
  const editor = createEditor();
  editor.setText('keep [paste #7 +9 lines] here');
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  const text = editor.getText();
  assert.equal(text, `keep [paste #7 +9 lines] here ${unixMarker(8)}`);
  assert.equal(expandImageMarkers(editor, text), `keep [paste #7 +9 lines] here ${UNIX_PATH}`);
  // registry-less tokens stay untouched
  assert.equal(expandImageMarkers(createEditor(), '[paste #1]'), '[paste #1]');
  assert.equal(expandImageMarkers(createEditor(), '[paste #1 9 chars]'), '[paste #1 9 chars]');
});

test('backspace over a marker deletes it atomically, undo restores text and registry', () => {
  const editor = createEditor();
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  assert.equal(editor.getCursor().col, unixMarker(1).length);
  editor.handleInput('\x7f'); // backspace deletes the whole atomic marker
  assert.equal(editor.getText(), '');
  assert.equal(editor.pastes.has(1), false);
  assert.equal(editor.pasteCounter, 0);
  editor.handleInput('\x1f'); // ctrl+- undo
  assert.equal(editor.getText(), unixMarker(1));
  assert.equal(editor.pastes.get(1), UNIX_PATH);
  assert.equal(editor.getExpandedText(), UNIX_PATH);
});

test('deleting an earlier image renumbers later markers natively; display follows the live map', () => {
  const editor = createEditor();
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  editor.handleInput('\n'); // newline puts the next image on its own line
  assert.equal(insertClipboardImage(editor, WIN_PATH, insertNativeFor(editor)), true);
  assert.equal(editor.getText(), `${unixMarker(1)}\n${winMarker(2)}`);
  assert.equal(editor.pastes.get(1), UNIX_PATH);
  assert.equal(editor.pastes.get(2), WIN_PATH);
  // move up to the end of the first marker and backspace the atomic segment
  editor.handleInput('\x1b[A'); // up arrow
  editor.handleInput('\x7f');
  assert.equal(editor.getText(), `\n${winMarker(1)}`, 'native renumbered the later marker');
  assert.equal(editor.pastes.get(1), WIN_PATH, 'registry shifted the second image down');
  assert.equal(editor.pastes.has(2), false);
  const rendered = renderImagePlaceholders(editor, editor.getLines());
  assert.equal(stripTerminalSequences(rendered.join('\n')), `\n${imageLabel(1, WIN_PATH.length)}`);
  assert.equal(editor.getExpandedText(), `\n${WIN_PATH}`);
});

test('renderImagePlaceholders tolerates inverse cursor ANSI around the marker', () => {
  const editor = createEditor();
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  const ansiLine = `\x1b[7m${unixMarker(1)}\x1b[27m`;
  const rendered = renderImagePlaceholders(editor, [ansiLine]);
  assert.equal(rendered[0], `\x1b[7m${imageLabel(1, UNIX_PATH.length)}\x1b[27m`);
  // native render output keeps the same visible width after rename
  const nativeRender = editor.render(80);
  const renamed = renderImagePlaceholders(editor, nativeRender);
  assert.equal(
    stripTerminalSequences(renamed.join('\n')).length,
    stripTerminalSequences(nativeRender.join('\n')).length,
  );
  assert.ok(stripTerminalSequences(renamed.join('\n')).includes(imageLabel(1, UNIX_PATH.length)));
});

test('literal preexisting markers are never renamed, expanded or aliased by new ids', () => {
  const editor = createEditor();
  editor.setText('user typed [paste #3] literally and [paste #4 +2 lines] big');
  // allocation skips every id referenced in text: next id is 5
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  assert.equal(editor.getText(), `user typed [paste #3] literally and [paste #4 +2 lines] big ${unixMarker(5)}`);

  const rendered = renderImagePlaceholders(editor, editor.getLines());
  assert.match(stripTerminalSequences(rendered.join('\n')), /user typed \[paste #3\]/);
  assert.ok(stripTerminalSequences(rendered.join('\n')).includes(`big ${imageLabel(1, UNIX_PATH.length, 5)}`));
  assert.equal(expandImageMarkers(editor, editor.getText()).includes('[paste #3]'), true);
  assert.equal(editor.getExpandedText().includes('[paste #3]'), true);
});

test('custom editor contract works end to end', () => {
  const editor = createEditor('custom');
  assert.equal(insertClipboardImage(editor, WIN_PATH, insertNativeFor(editor)), true);
  assert.equal(editor.getText(), winMarker(1));
  const rendered = renderImagePlaceholders(editor, editor.getLines());
  assert.equal(stripTerminalSequences(rendered.join('\n')), imageLabel(1, WIN_PATH.length));
  assert.equal(editor.getExpandedText(), WIN_PATH);
});

test('image inserted next to prose keeps separation after expansion', () => {
  const editor = createEditor();
  editor.setText('lookatthis');
  // cursor sits at end of "lookatthis" -> prefix space expected
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  assert.equal(editor.getText(), `lookatthis ${unixMarker(1)}`);
  assert.equal(editor.getExpandedText(), `lookatthis ${UNIX_PATH}`);

  // cursor mid-word inserts padding on both sides
  const other = createEditor();
  other.setText('ab');
  other.handleInput('\x1bOD'); // left arrow
  assert.equal(insertClipboardImage(other, UNIX_PATH, insertNativeFor(other)), true);
  assert.equal(other.getText(), `a ${unixMarker(1)} b`);
  assert.equal(other.getExpandedText(), `a ${UNIX_PATH} b`);
});

test('fails safe when the native registry contract is unavailable', () => {
  const bare = {};
  assert.equal(insertClipboardImage(bare, UNIX_PATH, () => {}), false);
  const lines = ['text [paste #1 9 chars] more'];
  const unchanged = renderImagePlaceholders({}, lines);
  assert.deepEqual(unchanged, lines);
  assert.equal(expandImageMarkers({}, 'x [paste #1 9 chars] y'), 'x [paste #1 9 chars] y');
  assert.equal(insertClipboardImage(createEditor(), UNIX_PATH, undefined), false);
  assert.equal(insertClipboardImage(createEditor(), UNIX_PATH, 'not-a-function'), false);
});

test('onChange is restored after insertion and subsequent typing notifies normally', () => {
  const editor = createEditor();
  const changes = [];
  editor.onChange = (t) => changes.push(t);
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  const afterInsert = changes.length;
  editor.handleInput('x');
  assert.equal(changes.length, afterInsert + 1);
  assert.equal(changes[changes.length - 1], `${unixMarker(1)}x`);
  // insertion is a single undo step (typing 'x' adds its own step on top)
  editor.handleInput('\x1f');
  assert.equal(editor.getText(), unixMarker(1));
  assert.equal(editor.pastes.get(1), UNIX_PATH);
  editor.handleInput('\x1f');
  assert.equal(editor.getText(), '');
  assert.equal(editor.pastes.size, 0, 'undo snapshot restores the pre-insert registry');
});

test('ordinals derive from the full draft, so a scrolled viewport does not renumber', () => {
  const editor = createEditor();
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  editor.handleInput('\n'); // second image on its own line
  assert.equal(insertClipboardImage(editor, WIN_PATH, insertNativeFor(editor)), true);
  const lines = editor.getLines();
  assert.equal(lines.length, 2);
  // rendering only the second (visible) line keeps ordinal #2
  const secondOnly = renderImagePlaceholders(editor, [lines[1]]);
  assert.equal(stripTerminalSequences(secondOnly[0]), imageLabel(2, WIN_PATH.length));
  // rendering only the first line keeps ordinal #1
  const firstOnly = renderImagePlaceholders(editor, [lines[0]]);
  assert.equal(stripTerminalSequences(firstOnly[0]), imageLabel(1, UNIX_PATH.length));
  // full draft agrees with the viewport slices
  const full = renderImagePlaceholders(editor, lines);
  assert.equal(
    stripTerminalSequences(full.join('\n')),
    `${imageLabel(1, UNIX_PATH.length)}\n${imageLabel(2, WIN_PATH.length)}`,
  );
  for (let i = 0; i < lines.length; i++) {
    assert.equal(stripTerminalSequences(full[i]).length, lines[i].length);
  }
});

test('the same image token repeated keeps a single ordinal', () => {
  const editor = createEditor();
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  // duplicate the same native token literally: both share registry id 1
  editor.insertTextAtCursor(` ${unixMarker(1)}`);
  assert.equal(editor.getText(), `${unixMarker(1)} ${unixMarker(1)}`);
  const rendered = renderImagePlaceholders(editor, editor.getLines());
  const expected = `${imageLabel(1, UNIX_PATH.length)} ${imageLabel(1, UNIX_PATH.length)}`;
  assert.equal(stripTerminalSequences(rendered.join('\n')), expected);
  assert.equal(stripTerminalSequences(rendered[0]).length, editor.getLines()[0].length);
});

test('narrow native renders keep exact width after the display rename', () => {
  const editor = createEditor();
  assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
  for (const width of [80, 40, 30, 25]) {
    const nativeRender = editor.render(width);
    const renamed = renderImagePlaceholders(editor, nativeRender);
    assert.equal(
      stripTerminalSequences(renamed.join('\n')).length,
      stripTerminalSequences(nativeRender.join('\n')).length,
      `width preserved at ${width} columns`,
    );
    assert.ok(
      stripTerminalSequences(renamed.join('\n')).includes(imageLabel(1, UNIX_PATH.length)),
      `image label visible at ${width} columns`,
    );
  }
});

test('wrapped split markers rename leak-free across widths, padding and cursor placement', () => {
  const label = '[Image #1]';
  for (const padding of [0, 1, 2]) {
    for (const width of [10, 12, 15, 20, 24]) {
      const contentWidth = width - padding * 2;
      // Only combinations where '[Image #1]' fits the content area.
      if (contentWidth < label.length) continue;
      for (const cursorAt of ['start', 'end']) {
        const editor = createEditor();
        editor.setText('pre ');
        assert.equal(insertClipboardImage(editor, UNIX_PATH, insertNativeFor(editor)), true);
        editor.handleInput(' post');
        assert.equal(editor.getText(), `pre ${unixMarker(1)} post`);
        editor.setPaddingX(padding);
        editor.handleInput(cursorAt === 'start' ? '\x1b[H' : '\x1b[F');
        assert.equal(editor.getCursor().col, cursorAt === 'start' ? 0 : editor.getLines()[0].length);

        const native = editor.render(width);
        const renamed = renderImagePlaceholders(editor, native);
        assert.equal(renamed.length, native.length, `row count at width=${width} padding=${padding}`);
        for (let i = 0; i < native.length; i++) {
          assert.equal(
            visibleWidth(renamed[i]),
            visibleWidth(native[i]),
            `row ${i} visibleWidth unchanged at width=${width} padding=${padding} cursor=${cursorAt}`,
          );
        }
        const stripped = stripTerminalSequences(renamed.join('\n'));
        assert.doesNotMatch(
          stripped,
          /paste #|chars/,
          `no internal fragment leaked at width=${width} padding=${padding} cursor=${cursorAt}`,
        );
        // Wherever the native marker sits unsplit on one row, the alias is exact.
        if (stripTerminalSequences(native.join('\n')).includes(unixMarker(1))) {
          assert.ok(
            stripped.includes(label),
            `contiguous label at width=${width} padding=${padding} cursor=${cursorAt}`,
          );
        }
        // The inverse-video cursor survives the rename.
        assert.ok(renamed.join('\n').includes('\x1b[7m'), `cursor rendered at width=${width} padding=${padding}`);
      }
    }
  }
});
