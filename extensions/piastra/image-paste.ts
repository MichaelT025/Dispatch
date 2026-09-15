/**
 * Native clipboard-image placeholder adapter.
 *
 * Reuses the native pi-tui Editor paste registry (`pastes: Map<number, string>`
 * + `pasteCounter: number`) as the single source of truth for clipboard images.
 * An INTERNAL marker is inserted via the caller-provided native insertion hook,
 * and the original clipboard image path is registered in the native map under
 * the same id. Native rendering, atomic cursor movement, delete/backspace,
 * undo and `getExpandedText()`/Enter-submit expansion keep working because the
 * registry is the native one.
 *
 * INTERNAL marker format: `[paste #N <path.length> chars]` - the same shape
 * the native editor itself emits for long single-line pastes. The suffix is
 * REQUIRED, not cosmetic: native backspace renumbering rewrites later markers
 * with `[paste #${id - 1}${suffixGroup}]`, which corrupts suffix-less markers
 * into `[paste #Nundefined]` and breaks native expansion/submit. Carrying the
 * native suffix keeps delete/backspace/renumber/undo fully native.
 *
 * The display-only rename happens in `renderImagePlaceholders`:
 * `[paste #N ...]` -> `[Image #ordinal]` (trailing spaces preserve the native
 * marker's layout width, keeping cursor and mouse coordinates unchanged).
 * Native word-wrap can split an oversized atomic marker across rendered rows,
 * so the rename is done on an ANSI-aware flattened view of the rendered rows:
 * the full marker literal is matched allowing wrap padding/line transitions
 * and cursor ANSI between its characters, each matched visible character is
 * mapped to the same-length `[Image #ordinal]`+spaces alias, and control
 * sequences plus row padding are emitted untouched. Row widths and cursor
 * columns are therefore unchanged.
 * Ordinals count image markers across the entire draft, not just its visible
 * viewport; identity is always resolved
 * through the current native map, so native backspace renumbering and undo
 * stay correct. Ordinary native multiline paste labels are never renamed
 * (their registry values are text, not clipboard image paths).
 *
 * The `pastes`/`pasteCounter` fields are private in the native Editor and have
 * no public placeholder API; this adapter is deliberately narrow and
 * feature-detected. If the contract is unavailable, every function fails safe
 * (insertion reports false so the caller can insert the raw path; render and
 * expand leave content untouched). No native methods are monkey-patched.
 *
 * Known display limitation: `renderImagePlaceholders` only sees the rows the
 * caller hands it. When the editor viewport cuts a wrapped marker (cursor on
 * a marker fragment at the scroll boundary), the continuation fragment is on
 * a hidden row, so the visible partial fragment cannot be identified without
 * risking renames of ordinary wrapped prose and is therefore left as-is.
 */

/**
 * Native marker shape, suffix optional in matching but always present on
 * markers this adapter inserts. Registry-value validation decides what is an
 * image token, so ordinary native paste labels are never mistaken for images.
 */
const IMAGE_MARKER_PATTERN = /\[paste #(\d+)((?: \+\d+ lines)|(?: \d+ chars))?\]/g;
/** Any native marker prefix, used to keep new ids from aliasing literal text. */
const ANY_MARKER_PATTERN = /\[paste #(\d+)/g;

const IMAGE_EXTENSIONS = "(?:png|jpe?g|webp|gif|bmp)";
/** Absolute-path prefixes: Windows drive, UNC, or POSIX root. */
const ABSOLUTE_PREFIX = "(?:[A-Za-z]:[\\\\/]|\\\\\\\\|//|/)";
const PATH_SEPARATOR_TAIL = "(?:[^\\\\/\\n]*[\\\\/])*";
/** Native clipboard scratch files are named `pi-clipboard-<UUID>.<ext>`. */
const CLIPBOARD_FILENAME = "pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ABSOLUTE_IMAGE_PATH = new RegExp(
  `^${ABSOLUTE_PREFIX}${PATH_SEPARATOR_TAIL}${CLIPBOARD_FILENAME}\\.${IMAGE_EXTENSIONS}$`,
  "i",
);

/**
 * Recognize a payload that is entirely a native clipboard image path.
 * Accepts optional surrounding quotes/whitespace (shell-escaping artifacts),
 * but never collapses prose, source text, relative names, or ordinary text
 * ending in an image extension. Returns the bare path (quotes stripped,
 * payload content itself preserved exactly), or null when not an image path.
 */
function parseClipboardImagePath(text: unknown): string | null {
  if (typeof text !== "string") return null;
  let value = text.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
  }
  if (value.length === 0 || /[\x00-\x1f\x7f]/.test(value)) return null;
  return ABSOLUTE_IMAGE_PATH.test(value) ? value : null;
}

/** Check that a native registry value is a recognized clipboard image path. */
function isClipboardImageEntry(content: unknown): content is string {
  return typeof content === "string" && parseClipboardImagePath(content) !== null;
}

/**
 * Whitespace padding so expanded absolute paths never concatenate with
 * adjacent prose or successive image insertions. Adds a space on each side
 * only when the character at the cursor boundary is non-whitespace.
 */
function insertionPadding(editor: any): { prefix: string; suffix: string } {
  try {
    if (typeof editor?.getCursor !== "function" || typeof editor?.getLines !== "function") {
      return { prefix: "", suffix: "" };
    }
    const cursor = editor.getCursor();
    const lines = editor.getLines();
    if (!cursor || !Array.isArray(lines)) return { prefix: "", suffix: "" };
    const line = lines[cursor.line] ?? "";
    const before = line.slice(0, cursor.col);
    const after = line.slice(cursor.col);
    return {
      prefix: /\S$/.test(before) ? " " : "",
      suffix: /^\S/.test(after) ? " " : "",
    };
  } catch {
    return { prefix: "", suffix: "" };
  }
}

/**
 * Allocate a paste id that is greater than the native counter, every id in the
 * native registry, and every `[paste #N` reference (including literal,
 * registry-less tokens) currently present in the editor text. This prevents a
 * newly allocated image id from aliasing an ordinary large paste, a stale
 * counter, or a literal marker the user typed earlier.
 */
function allocatePasteId(editor: any): number {
  let next = 1;
  const bump = (value: unknown) => {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id >= next) next = id + 1;
  };
  bump(editor?.pasteCounter);
  const pastes = editor?.pastes;
  if (pastes instanceof Map) {
    for (const key of pastes.keys()) bump(key);
  }
  const currentText = typeof editor?.getText === "function" ? editor.getText() : "";
  if (typeof currentText === "string") {
    for (const match of currentText.matchAll(ANY_MARKER_PATTERN)) bump(match[1]);
  }
  return next;
}

/**
 * Insert a clipboard image as a native paste marker.
 *
 * `text` must be a full native clipboard image path (optionally quoted);
 * otherwise the function returns false and the caller falls back to inserting
 * the raw text itself. On success the internal marker
 * `[paste #N <path.length> chars]` (native suffix format; see module docs) is
 * inserted first through `insertNative` (which must create the native undo
 * snapshot, as `Editor.insertTextAtCursor` does), then the path is registered
 * in the native map, `editor.onChange` (suppressed during insertion) is
 * restored, and the caller's change callback fires exactly once with the
 * final text.
 *
 * Returns true when the marker was inserted and registered.
 */
export function insertClipboardImage(
  editor: any,
  text: string,
  insertNative: (text: string) => void,
): boolean {
  const pastes = editor?.pastes;
  if (!(pastes instanceof Map) || typeof editor?.pasteCounter !== "number") return false;
  if (typeof insertNative !== "function") return false;
  const path = parseClipboardImagePath(text);
  if (!path) return false;

  const id = allocatePasteId(editor);
  const { prefix, suffix } = insertionPadding(editor);
  const previousOnChange = editor.onChange;
  let inserted = false;
  try {
    // Suppress change notifications so the marker insertion and the registry
    // mutation surface as a single onChange after registration.
    editor.onChange = undefined;
    insertNative(`${prefix}[paste #${id} ${path.length} chars]${suffix}`);
    inserted = true;
  } finally {
    editor.onChange = previousOnChange;
  }
  if (!inserted) return false;

  // Registered after the native undo snapshot captured the pre-insert text.
  pastes.set(id, path);
  editor.pasteCounter = id;
  if (typeof previousOnChange === "function") {
    previousOnChange(editor.getText());
  }
  return true;
}

/**
 * Display-only rename of valid image markers. Returns the lines with image
 * markers (`[paste #N ...]` whose id resolves in the current native map to a
 * recognized clipboard image path) replaced by `[Image #ordinal]`, padded
 * with spaces so the rendered width is always exact. The marker may have been
 * split by native word-wrap across the rendered rows (with wrap padding and
 * cursor ANSI between the fragments); such split markers are renamed across
 * rows in place, character for character, so every row keeps its visible
 * width and cursor column. Native multiline paste labels (registry values are
 * text), literal tokens without a valid registry entry, and non-image
 * registry values are left untouched. ANSI sequences around or inside the
 * marker do not affect the replacement.
 */
export function renderImagePlaceholders(editor: any, lines: string[]): string[] {
  const input = Array.isArray(lines) ? lines : [];
  const pastes = editor?.pastes instanceof Map ? editor.pastes : null;
  if (!pastes) return input.slice();

  // Ordinals and marker literals derive from the entire draft, never just the
  // rendered viewport, so a scrolled view cannot renumber images.
  const ordinals = new Map<number, number>();
  const markerTexts = new Map<number, string>();
  const draft = typeof editor.getLines === 'function' ? editor.getLines().join('\n') : input.join('\n');
  for (const match of draft.matchAll(IMAGE_MARKER_PATTERN)) {
    const id = Number(match[1]);
    if (!isClipboardImageEntry(pastes.get(id))) continue;
    if (!ordinals.has(id)) {
      ordinals.set(id, ordinals.size + 1);
      markerTexts.set(id, match[0]);
    }
  }
  // No image marker can start without a '[' somewhere in the rendered rows.
  if (ordinals.size === 0 || !input.some((line) => typeof line === 'string' && line.includes('['))) {
    return input.slice();
  }

  // Flatten the rendered rows: visible characters get one global index across
  // rows, terminal control sequences are kept aside (zero visible width).
  const { items, flat } = flattenRenderedLines(input);

  // flat char index -> replacement character. Every replacement char is a
  // 1-column ASCII char, so each row's visible width is preserved exactly.
  const aliasByFlat = new Map<number, string>();
  for (const [id, ordinal] of ordinals) {
    const marker = markerTexts.get(id)!;
    const alias = `[Image #${ordinal}]`;
    if (alias.length > marker.length) continue; // fail safe: never widen rows
    const replacement = alias.padEnd(marker.length, ' ');
    for (const positions of findFlatMatches(flat, marker)) {
      if (positions.some((p) => aliasByFlat.has(p))) continue; // no double takeover
      positions.forEach((p, k) => aliasByFlat.set(p, replacement[k]!));
    }
  }
  if (aliasByFlat.size === 0) return input.slice();

  return items.map((row, index) => {
    if (typeof input[index] !== 'string') return input[index];
    let out = '';
    for (const item of row) {
      out += item.ansi ? item.text : (aliasByFlat.get(item.flat) ?? item.text);
    }
    return out;
  });
}

/** One parsed element of a rendered row: a control sequence or one visible char. */
interface RenderedItem {
  ansi: boolean;
  text: string;
  /** Global flat index across rows for visible chars; unused for ANSI. */
  flat: number;
}

/** CSI / OSC / APC sequences, mirroring the native stripTerminalSequences shapes. */
const ANSI_SEQUENCE_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b_.*?(?:\x07|\x1b\\)/g;

/**
 * Split rendered rows into control sequences and single visible characters.
 * Visible characters are indexed continuously across rows so a marker split by
 * word-wrap is contiguous in the flattened view (row padding between its
 * fragments is whitespace, skipped during matching).
 */
function flattenRenderedLines(input: string[]): { items: RenderedItem[][]; flat: string } {
  const items: RenderedItem[][] = [];
  const flatChars: string[] = [];
  const pushChar = (row: RenderedItem[], ch: string) => {
    row.push({ ansi: false, text: ch, flat: flatChars.length });
    flatChars.push(ch);
  };
  for (const line of input) {
    const row: RenderedItem[] = [];
    if (typeof line === 'string') {
      ANSI_SEQUENCE_PATTERN.lastIndex = 0;
      let cursor = 0;
      for (let m = ANSI_SEQUENCE_PATTERN.exec(line); m !== null; m = ANSI_SEQUENCE_PATTERN.exec(line)) {
        for (let i = cursor; i < m.index; i++) pushChar(row, line[i]!);
        row.push({ ansi: true, text: m[0], flat: -1 });
        cursor = m.index + m[0].length;
      }
      for (let i = cursor; i < line.length; i++) pushChar(row, line[i]!);
    }
    items.push(row);
  }
  return { items, flat: flatChars.join('') };
}

/** Escape one literal character for use inside a RegExp. */
function escapeRegexChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find occurrences of the exact marker literal in the flattened visible text,
 * allowing runs of whitespace (wrap padding, line transitions) between its
 * characters — the shape native word-wrap produces for an oversized atomic
 * marker. Returns, per occurrence, the flat index of each marker character.
 * Because only whitespace may separate the characters, a match always spells
 * the full literal in order and never bridges non-whitespace content.
 */
function findFlatMatches(flat: string, marker: string): number[][] {
  const matches: number[][] = [];
  if (!marker || !flat.includes('[')) return matches;
  let regex: RegExp;
  try {
    regex = new RegExp([...marker].map(escapeRegexChar).join('\\s*'), 'g');
  } catch {
    return matches;
  }
  for (const match of flat.matchAll(regex)) {
    const positions: number[] = [];
    let pointer = match.index;
    let ok = true;
    for (const ch of marker) {
      // Whitespace may only pad the gaps BETWEEN marker characters; a marker
      // character that is itself a space must be matched exactly (otherwise
      // the skip would swallow it and fail on the following character).
      if (!/\s/.test(ch)) {
        while (pointer < flat.length && /\s/.test(flat[pointer]!)) pointer++;
      }
      if (pointer >= flat.length || flat[pointer] !== ch) {
        ok = false;
        break;
      }
      positions.push(pointer);
      pointer++;
    }
    if (ok) matches.push(positions);
  }
  return matches;
}

/**
 * Expand only valid image markers (whose id maps to a recognized clipboard
 * image path in the current native registry). Ordinary native paste markers
 * and invalid/literal tokens are untouched. Use this to carry editor state
 * across `setText` transfers before the native registry is cleared.
 */
export function expandImageMarkers(editor: any, text: string): string {
  const pastes = editor?.pastes instanceof Map ? editor.pastes : null;
  if (!pastes || typeof text !== "string" || !text.includes("[paste #")) return text;
  return text.replace(IMAGE_MARKER_PATTERN, (marker, idText) => {
    const entry = pastes.get(Number(idText));
    return isClipboardImageEntry(entry) ? entry : marker;
  });
}
