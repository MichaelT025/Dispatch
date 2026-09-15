import { readFileSync } from 'node:fs';
import { truncateToWidth, matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { plainLines, renderTranscript, safe, statusStyle, toolSummary } from './worker-render.ts';

export const workerOverlayOptions = { overlay: true, overlayOptions: { width: '100%' as const, maxHeight: '100%' as const, anchor: 'top-left' as const, margin: 0 } };

// Plain export for callers that need text rather than terminal styling.
export function messageText(messages: any[]) {
  return messages.map(message => {
    const content = typeof message.content === 'string' ? message.content : (message.content || []).map((part: any) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'toolCall') return `→ ${toolSummary(part.name, part.arguments)}`;
      return '';
    }).filter(Boolean).join('\n');
    if (!content) return '';
    return message.role === 'toolResult'
      ? `${message.isError ? '✗' : '✓'} ${toolSummary(message.toolName)}\n${safe(content).slice(0, 30000)}`
      : safe(content).slice(0, 30000);
  }).filter(Boolean).join('\n\n');
}

// The pinned prompt already shows the full initial task, so drop the transcript's
// own leading copy when it exactly matches. Any other user message is retained.
export function dropInitialTask(messages: any[] | undefined, task: unknown) {
  const list = messages ?? [];
  if (!list.length || list[0]?.role !== 'user') return list;
  const first = list[0];
  const text = typeof first.content === 'string' ? first.content
    : (first.content || []).map((part: any) => part?.type === 'text' ? String(part.text ?? '') : '').join('');
  return text === task ? list.slice(1) : list;
}

export function createWorkerView(tui: any, theme: any, done: () => void, records: Map<number, any>) {
  let selected: number | undefined;
  let pickerIndex = 0;
  let outputPage = 15;
  let promptPage = 10;
  let expandedTools = false;
  let focus: 'prompt' | 'output' = 'output';
  let promptScroll = 0;
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
          pickerIndex = pickerIndex > 0 ? pickerIndex - 1 : Math.max(0, ids.length - 1);
        } else if (matchesKey(data, 'down')) pickerIndex = Math.min(ids.length - 1, pickerIndex + 1);
        else if (matchesKey(data, 'enter') || matchesKey(data, 'right') || matchesKey(data, 'tab')) {
          selected = ids[Math.max(0, pickerIndex)];
          promptScroll = 0; // every worker opens with the prompt beginning
          focus = 'output';
        }
        else if (matchesKey(data, 'left')) return done();
      } else if (matchesKey(data, 'up')) return done();
      else if (matchesKey(data, 'down')) { pickerIndex = Math.max(0, ids.indexOf(selected)); selected = undefined; }
      else if (matchesKey(data, 'right') || matchesKey(data, 'tab') || matchesKey(data, 'left') || matchesKey(data, 'shift+tab')) {
        const step = matchesKey(data, 'left') || matchesKey(data, 'shift+tab') ? -1 : 1;
        selected = ids[(ids.indexOf(selected) + step + ids.length) % ids.length];
        promptScroll = 0; // cycling shows the prompt beginning; transcript positions stay per-worker
      } else if (data === 'p') focus = focus === 'prompt' ? 'output' : 'prompt';
      else {
        const state = position();
        if (matchesKey(data, 'ctrl+o')) { expandedTools = !expandedTools; state.scroll = 0; }
        else if (focus === 'prompt') {
          if (matchesKey(data, 'pageUp') || data === 'k') promptScroll -= data === 'k' ? 1 : promptPage;
          else if (matchesKey(data, 'pageDown') || data === 'j') promptScroll += data === 'j' ? 1 : promptPage;
          else if (matchesKey(data, 'home')) promptScroll = 0;
          else if (matchesKey(data, 'end')) promptScroll = Number.MAX_SAFE_INTEGER;
        } else {
          if (matchesKey(data, 'pageUp') || data === 'k') { state.follow = false; state.scroll = Math.max(0, state.scroll - (data === 'k' ? 1 : outputPage)); }
          else if (matchesKey(data, 'pageDown') || data === 'j') { state.scroll = Math.min(state.max, state.scroll + (data === 'j' ? 1 : outputPage)); state.follow = state.scroll === state.max; }
          else if (matchesKey(data, 'home')) { state.follow = false; state.scroll = 0; }
          else if (matchesKey(data, 'end')) state.follow = true;
        }
      }
      tui.requestRender();
    },
    render(width: number) {
      width = Math.max(1, width);
      const rows = Math.max(1, tui.terminal.rows || 24);
      const all = [...records.values()];
      const record = selected === undefined ? undefined : records.get(selected);
      const worker = record?.worker;
      // Labels occupy one physical terminal row, even when a path or worker
      // field contains valid filesystem whitespace such as a newline or tab.
      const fit = (text: string) => truncateToWidth(text.replace(/[\r\n\t]/g, ' '), width);
      if (!worker) {
        const hints = '↑/↓ select · ↑ at first: last · Enter/→ open · Esc parent';
        const top = [fit(theme.fg('accent', 'Parent › Workers')), fit(theme.fg('dim', hints))];
        const height = Math.max(1, rows - top.length - 1);
        pickerIndex = Math.max(0, Math.min(pickerIndex, all.length - 1));
        const start = Math.max(0, pickerIndex - Math.max(1, Math.floor(height / 3)) + 1);
        const lines = all.length ? all.slice(start).flatMap(({ worker: w }, index) => [
          fit(theme.fg(statusStyle(w.status), safe(`${start + index === pickerIndex ? '›' : ' '} #${w.id} ${w.role} · ${w.status}`))),
          fit(theme.fg('muted', safe(`  ${w.task}`))), ''
        ]) : plainLines('No delegated workers in this session yet.', width);
        const visible = lines.slice(0, height);
        while (visible.length < height) visible.push('');
        return [...top, ...visible, fit(theme.fg('dim', `${all.length} workers · Enter opens selected session`))].slice(-rows);
      }
      const state = position();
      // Bottom identity line is always present; on rows <= 1 it is the only line.
      const identity = fit(theme.fg('accent', safe(`#${worker.id} ${worker.role} · ${worker.model} · ${worker.status}`)));
      if (rows <= 1) return [identity];
      const avail = rows - 1;
      // Use the theme's user-message colors for the orchestrator's prompt.
      // Wrap inside the padding so no prompt text is lost at the right edge.
      const paddingX = width >= 20 ? 2 : width >= 12 ? 1 : 0;
      const promptWidth = Math.max(1, width - paddingX * 2);
      const promptAll = plainLines(`Task: ${worker.task}`, promptWidth);
      const promptTotal = promptAll.length;
      // Wrap controls rather than hiding the essential keys behind scroll counters.
      const controls = plainLines(
        `p: ${focus} ↔ ${focus === 'prompt' ? 'output' : 'prompt'} · PgUp/PgDn j/k scroll · Home/End ${focus === 'output' ? 'start/follow' : 'start/end'}\n` +
        '←/→/Tab siblings · ↑/Esc parent · ↓ picker · Ctrl+O tools', width);
      let infoRows = avail >= 8 ? Math.min(controls.length + 1, avail - 7) : 0;
      const minOut = avail - infoRows >= 9 ? 4 : avail - infoRows >= 4 ? 2 : 1;
      // Decoration yields to content on short terminals; keep live output usable.
      const room = avail - infoRows - minOut;
      const paddingY = room >= 7 ? 1 : 0;
      const gap = room >= 4 ? 1 : 0;
      const decorationRows = paddingY * 2 + gap;
      let promptH = Math.min(promptTotal, Math.max(0, room - decorationRows));
      if (promptTotal > 0 && promptH === 0) { promptH = 1; infoRows = 0; } // tiny screens keep a prompt row
      const outH = Math.max(0, avail - infoRows - promptH - decorationRows);
      const overflow = promptTotal > promptH;
      const promptContentH = overflow ? Math.max(1, promptH - 1) : promptH;
      const promptMax = Math.max(0, promptTotal - promptContentH);
      promptScroll = overflow ? Math.max(0, Math.min(promptScroll, promptMax)) : 0;
      promptPage = Math.max(1, promptContentH);
      const promptFrom = promptScroll + 1;
      const promptTo = Math.min(promptTotal, promptScroll + promptContentH);
      const promptLines = promptTotal === 0 ? []
        : overflow && promptH >= 2 ? [
            truncateToWidth(theme.fg('accent', `Task ${promptFrom}–${promptTo}/${promptTotal}${focus === 'prompt' ? ' ◆' : ' · p: focus prompt'}`), promptWidth),
            ...promptAll.slice(promptScroll, promptScroll + promptContentH)
          ]
        : promptAll.slice(promptScroll, promptScroll + promptContentH);
      const panelLine = (line: string) => {
        const padded = ' '.repeat(paddingX) + line;
        return theme.bg('userMessageBg', theme.fg('userMessageText', padded + ' '.repeat(Math.max(0, width - visibleWidth(padded)))));
      };
      const promptPanel = [
        ...Array(paddingY).fill(''), ...promptLines, ...Array(paddingY).fill('')
      ].map(panelLine);
      // Live transcript pane below the pinned prompt; transcript file info stays pinned to it.
      let outLines: string[] = [];
      let outRange = '';
      if (outH > 0) {
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
          ...renderTranscript(dropInitialTask(messages, worker.task), theme, width, expandedTools),
          ...plainLines(worker.activity, width).map(line => theme.fg(statusStyle(worker.status), line))
        ];
        if (outH >= 2) {
          const contentH = outH - 1;
          outputPage = Math.max(1, contentH);
          state.max = Math.max(0, body.length - contentH);
          state.scroll = state.follow ? state.max : Math.min(state.scroll, state.max);
          outRange = `out ${state.scroll + 1}–${Math.min(state.scroll + contentH, body.length)}/${body.length}${state.follow ? ' following' : ' paused · End follows'}`;
          outLines = [fit(theme.fg('dim', safe(`Transcript: ${worker.transcript || '(starting)'}`))),
            ...body.slice(state.scroll, state.scroll + contentH)];
        } else {
          outputPage = 1;
          state.max = Math.max(0, body.length - 1);
          state.scroll = state.follow ? state.max : Math.min(state.scroll, state.max);
          outLines = body.slice(state.scroll, state.scroll + 1);
        }
      }
      const info = [...controls, outRange].slice(0, infoRows).map(line => fit(theme.fg('dim', line)));
      const bodyRows = Math.max(0, avail - infoRows);
      const visible = [...promptPanel, ...Array(gap).fill(''), ...outLines].slice(0, bodyRows);
      while (visible.length < bodyRows) visible.push('');
      const bottom = [...info, identity];
      // A fixed-height overlay shields the viewer from parent transcript growth.
      return [...visible, ...bottom].slice(-rows);
    },
    invalidate() {},
    dispose() { clearInterval(timer); }
  };
}
