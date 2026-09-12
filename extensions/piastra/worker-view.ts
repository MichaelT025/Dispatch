import { readFileSync } from 'node:fs';
import { truncateToWidth, matchesKey } from '@earendil-works/pi-tui';
import { plainLines, renderTranscript, safe, statusStyle } from './worker-render.ts';

export const workerOverlayOptions = { overlay: true, overlayOptions: { width: '100%' as const, maxHeight: '100%' as const, anchor: 'top-left' as const, margin: 0 } };

// Plain export for callers that need text rather than terminal styling.
export function messageText(messages: any[]) {
  return messages.map(message => {
    const content = typeof message.content === 'string' ? message.content : (message.content || []).map((part: any) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'toolCall') return `→ ${part.name}\n${JSON.stringify(part.arguments, null, 2)}`;
      return '';
    }).filter(Boolean).join('\n');
    return content ? `${message.role === 'toolResult' ? `TOOL ${message.toolName}${message.isError ? ' · FAILED' : ''}` : message.role.toUpperCase()}\n${safe(content).slice(0, 30000)}` : '';
  }).filter(Boolean).join('\n\n');
}

export function createWorkerView(tui: any, theme: any, done: () => void, records: Map<number, any>) {
  let selected: number | undefined;
  let pickerIndex = 0;
  let pageSize = 15;
  let expandedTools = false;
  const positions = new Map<number, { scroll: number; follow: boolean; max: number }>();
  const savedMessages = new Map<string, any[]>();
  const position = () => {
    if (!positions.has(selected!)) positions.set(selected!, { scroll: 0, follow: true, max: 0 });
    return positions.get(selected!)!;
  };
  const timer = setInterval(() => tui.requestRender(), 250);
  return {
    handleInput(data: string) {
      const ids = [...records.keys()];
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) return done();
      if (selected === undefined) {
        if (matchesKey(data, 'up')) {
          if (pickerIndex === 0) return done();
          pickerIndex--;
        } else if (matchesKey(data, 'down')) pickerIndex = Math.min(ids.length - 1, pickerIndex + 1);
        else if (matchesKey(data, 'enter') || matchesKey(data, 'right') || matchesKey(data, 'tab')) selected = ids[Math.max(0, pickerIndex)];
        else if (matchesKey(data, 'left')) return done();
      } else if (matchesKey(data, 'up')) return done();
      else if (matchesKey(data, 'down')) { pickerIndex = Math.max(0, ids.indexOf(selected)); selected = undefined; }
      else if (matchesKey(data, 'right') || matchesKey(data, 'tab') || matchesKey(data, 'left') || matchesKey(data, 'shift+tab')) {
        const step = matchesKey(data, 'left') || matchesKey(data, 'shift+tab') ? -1 : 1;
        selected = ids[(ids.indexOf(selected) + step + ids.length) % ids.length];
      } else {
        const state = position();
        if (matchesKey(data, 'pageUp') || data === 'k') { state.follow = false; state.scroll = Math.max(0, state.scroll - (data === 'k' ? 1 : pageSize)); }
        else if (matchesKey(data, 'pageDown') || data === 'j') { state.scroll = Math.min(state.max, state.scroll + (data === 'j' ? 1 : pageSize)); state.follow = state.scroll === state.max; }
        else if (matchesKey(data, 'home')) { state.follow = false; state.scroll = 0; }
        else if (matchesKey(data, 'end')) state.follow = true;
        else if (matchesKey(data, 'ctrl+o')) { expandedTools = !expandedTools; state.scroll = 0; }
      }
      tui.requestRender();
    },
    render(width: number) {
      width = Math.max(1, width);
      const rows = Math.max(1, tui.terminal.rows || 24);
      const all = [...records.values()];
      const record = selected === undefined ? undefined : records.get(selected);
      const worker = record?.worker;
      const fit = (text: string) => truncateToWidth(text, width);
      const header = worker ? `Parent › #${worker.id} ${worker.role} · ${worker.model} · ${worker.status}` : 'Parent › Workers';
      const hints = worker ? '←/→ siblings · ↑ parent · ↓ picker · PgUp/PgDn scroll · End follow · Esc parent'
        : '↑/↓ select · Enter/→ open · Esc parent';
      const top = [fit(theme.fg('accent', safe(header))), fit(theme.fg('dim', hints)),
        fit(theme.fg('dim', worker ? `Ctrl+O: ${expandedTools ? 'collapse' : 'expand'} tools · j/k: scroll line · Home: start` : ''))];
      const height = Math.max(0, rows - top.length - 1);
      pageSize = Math.max(1, height - 1);
      let lines: string[];
      let footer: string;
      if (!worker) {
        pickerIndex = Math.max(0, Math.min(pickerIndex, all.length - 1));
        const start = Math.max(0, pickerIndex - Math.max(1, Math.floor(height / 3)) + 1);
        lines = all.length ? all.slice(start).flatMap(({ worker: w }, index) => [
          fit(theme.fg(statusStyle(w.status), safe(`${start + index === pickerIndex ? '›' : ' '} #${w.id} ${w.role} · ${w.status}`))),
          fit(theme.fg('muted', safe(`  ${w.task}`))), ''
        ]) : ['No delegated workers in this session yet.'];
        footer = `${all.length} workers · Enter opens selected session`;
      } else {
        let messages = record.getMessages?.();
        if (!messages && worker.transcript) {
          try {
            if (!savedMessages.has(worker.transcript)) {
              savedMessages.set(worker.transcript, readFileSync(worker.transcript, 'utf8').split('\n').flatMap(line => {
                try { const entry = JSON.parse(line); return entry.type === 'message' ? [entry.message] : []; } catch { return []; }
              }));
            }
            messages = savedMessages.get(worker.transcript);
          } catch { messages = []; }
        }
        const body = [
          ...plainLines(`Task: ${worker.task}`, width),
          ...plainLines(`Transcript: ${worker.transcript || '(starting)'}`, width).map(line => theme.fg('dim', line)), '',
          ...renderTranscript(messages || [], theme, width, expandedTools),
          ...plainLines(worker.activity, width).map(line => theme.fg(statusStyle(worker.status), line))
        ];
        const state = position();
        state.max = Math.max(0, body.length - height);
        state.scroll = state.follow ? state.max : Math.min(state.scroll, state.max);
        lines = body.slice(state.scroll, state.scroll + height);
        footer = `${state.scroll + 1}–${Math.min(state.scroll + height, body.length)} / ${body.length} · ${state.follow ? 'following' : 'paused · End to follow'}`;
      }
      // A fixed-height overlay shields the viewer from parent transcript growth.
      const visible = lines.slice(0, height);
      while (visible.length < height) visible.push('');
      return [...top, ...visible, fit(theme.fg('dim', footer))].slice(-rows);
    },
    invalidate() {},
    dispose() { clearInterval(timer); }
  };
}
