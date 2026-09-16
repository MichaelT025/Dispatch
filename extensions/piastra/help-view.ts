import { truncateToWidth, wrapTextWithAnsi, matchesKey } from '@earendil-works/pi-tui';
import { helpSections } from './help.mjs';

export const helpOverlayOptions = { overlay: true, overlayOptions: { width: '100%' as const, maxHeight: '100%' as const, anchor: 'top-left' as const, margin: 0 } };

/**
 * Section picker + scrollable read-only help overlay.
 * Fresh closure state per open; no timers, polling, or provider calls.
 * Body text wraps with wrapTextWithAnsi so long lines stay reachable on
 * narrow terminals; scrolling is measured in wrapped rows and re-clamped
 * on every render (resize reflow). dispose() is a no-op kept for the
 * viewer protocol (nothing to clean up, so no guard can leak after close
 * or error).
 */
export function createHelpView(tui: any, theme: any, done: () => void, sections: any[] = helpSections, initialId?: string) {
  let mode: 'sections' | 'reading' = 'sections';
  let pickerIndex = 0;
  let sectionIndex = 0;
  let scroll = 0;
  let page = 10;

  if (initialId) {
    const found = sections.findIndex(s => s.id === initialId);
    if (found >= 0) { mode = 'reading'; sectionIndex = found; pickerIndex = found; scroll = 0; }
  }

  const ids = () => sections.map(s => s.id);
  const clean = (text: string) => text.replace(/[\r\n\t]/g, ' ');
  // Wrap one logical line into physical rows; always yields >= 1 row so
  // blank lines remain scrollable positions.
  const wrap = (text: string, width: number): string[] => {
    const rows = wrapTextWithAnsi(clean(text), Math.max(1, width));
    return rows.length ? rows : [''];
  };
  const wrapAll = (lines: string[], width: number): string[] =>
    lines.flatMap(line => wrap(line, width));

  return {
    handleInput(data: string) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { done(); return; }
      if (mode === 'sections') {
        if (matchesKey(data, 'up') || data === 'k') pickerIndex = Math.max(0, pickerIndex - 1);
        else if (matchesKey(data, 'down') || data === 'j') pickerIndex = Math.min(sections.length - 1, pickerIndex + 1);
        else if (matchesKey(data, 'home')) pickerIndex = 0;
        else if (matchesKey(data, 'end')) pickerIndex = sections.length - 1;
        else if (matchesKey(data, 'enter') || matchesKey(data, 'right')) {
          sectionIndex = pickerIndex; scroll = 0; mode = 'reading';
        } else if (matchesKey(data, 'left')) done();
      } else {
        if (matchesKey(data, 'left') || data === 'b') { mode = 'sections'; pickerIndex = sectionIndex; }
        else if (matchesKey(data, 'up') || data === 'k') scroll = Math.max(0, scroll - 1);
        else if (matchesKey(data, 'down') || data === 'j') scroll = scroll + 1;
        else if (matchesKey(data, 'pageUp')) scroll = Math.max(0, scroll - page);
        else if (matchesKey(data, 'pageDown')) scroll = scroll + page;
        else if (matchesKey(data, 'home')) scroll = 0;
        else if (matchesKey(data, 'end')) scroll = Number.MAX_SAFE_INTEGER;
        else if (matchesKey(data, 'enter') || matchesKey(data, 'right') || matchesKey(data, 'tab')) {
          sectionIndex = (sectionIndex + 1) % sections.length; pickerIndex = sectionIndex; scroll = 0;
        } else if (matchesKey(data, 'shift+tab')) {
          sectionIndex = (sectionIndex - 1 + sections.length) % sections.length; pickerIndex = sectionIndex; scroll = 0;
        }
      }
      tui.requestRender();
    },
    render(width: number) {
      width = Math.max(1, width);
      const rows = Math.max(1, tui.terminal.rows || 24);
      const fit = (text: string) => truncateToWidth(clean(text), width);
      if (mode === 'sections') {
        const items = sections.map((s, i) =>
          theme.fg(i === pickerIndex ? 'accent' : 'muted', `${i === pickerIndex ? '›' : ' '} ${s.title}`));
        const wrappedItems = items.flatMap(line => wrap(line, width));
        // Map the selected section to its first wrapped row so the
        // viewport can follow it on short terminals.
        const itemStartRow: number[] = [];
        {
          let at = 0;
          for (const line of items) {
            itemStartRow.push(at);
            at += Math.max(1, wrap(line, width).length);
          }
        }
        if (rows <= 2) {
          // Tiny terminals prioritize the selected row over chrome.
          const sel = itemStartRow[pickerIndex] ?? 0;
          const start = Math.max(0, Math.min(sel, wrappedItems.length - rows));
          const visible = wrappedItems.slice(start, start + rows);
          while (visible.length < rows) visible.push('');
          return visible.slice(-rows);
        }
        const top = [fit(theme.fg('accent', 'Dispatch help')), fit(theme.fg('dim', 'Up/Down select · Enter open · Esc close'))];
        const footer = fit(theme.fg('dim', `${sections.length} sections · Enter opens selected section`));
        const height = Math.max(1, rows - top.length - 1);
        const sel = itemStartRow[pickerIndex] ?? 0;
        const start = Math.max(0, Math.min(sel, Math.max(0, wrappedItems.length - height)));
        const visible = wrappedItems.slice(start, start + height);
        while (visible.length < height) visible.push('');
        return [...top, ...visible, footer].slice(-rows);
      }
      const section = sections[sectionIndex];
      const body = wrapAll([`# ${section.title}`, ...section.lines], width);
      if (rows <= 1) {
        // Single-row terminal: the content row itself, not just chrome.
        const max = Math.max(0, body.length - 1);
        scroll = Math.max(0, Math.min(scroll, max));
        page = 1;
        return [body[scroll] ?? ''].slice(-rows);
      }
      if (rows <= 2) {
        // Two rows: header plus the current content row; footer yields.
        const header = fit(theme.fg('accent', `Help › ${section.title}`));
        const max = Math.max(0, body.length - 1);
        scroll = Math.max(0, Math.min(scroll, max));
        page = 1;
        return [header, body[scroll] ?? ''].slice(-rows);
      }
      const header = fit(theme.fg('accent', `Help › ${section.title}`));
      const footer = fit(theme.fg('dim', 'Up/Down/j/k scroll · PgUp/PgDn · Home/End · Enter next · Left/b sections · Esc close'));
      const contentH = Math.max(1, rows - 2);
      page = Math.max(1, contentH);
      const max = Math.max(0, body.length - contentH);
      scroll = Math.max(0, Math.min(scroll, max));
      const slice = body.slice(scroll, scroll + contentH);
      while (slice.length < contentH) slice.push('');
      return [header, ...slice, footer].slice(-rows);
    },
    invalidate() {},
    dispose() {},
    // Test-visible state snapshot.
    state() { return { mode, pickerIndex, sectionIndex, scroll, sections: ids() }; },
  };
}
