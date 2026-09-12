import { readFileSync } from 'node:fs';
import { Text, matchesKey } from '@earendil-works/pi-tui';

function safe(text: unknown) {
  return String(text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export function messageText(messages: any[]) {
  return messages.map(message => {
    const content = typeof message.content === 'string' ? message.content : (message.content || []).map((part: any) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'toolCall') return `→ ${part.name}\n${JSON.stringify(part.arguments, null, 2)}`;
      return ''; // Do not expose hidden reasoning or binary payloads.
    }).filter(Boolean).join('\n');
    return content ? `${message.role === 'toolResult' ? `TOOL ${message.toolName}${message.isError ? ' · FAILED' : ''}` : message.role.toUpperCase()}\n${safe(content).slice(0, 30000)}` : '';
  }).filter(Boolean).join('\n\n');
}

export function createWorkerView(tui: any, theme: any, done: () => void, records: Map<number, any>) {
  let selected = -1, scroll = 0, follow = true;
  let cachedId: number | undefined, cachedMessages: any[] | undefined;
  const timer = setInterval(() => tui.requestRender(), 250);
  return {
    handleInput(data: string) {
      const count = records.size;
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) return done();
      if (matchesKey(data, 'right') || matchesKey(data, 'tab') || matchesKey(data, 'left') || matchesKey(data, 'shift+tab')) {
        const step = matchesKey(data, 'left') || matchesKey(data, 'shift+tab') ? -1 : 1;
        selected = ((selected + 1 + step + count + 1) % (count + 1)) - 1;
        scroll = 0; follow = true;
      } else if (matchesKey(data, 'up') || matchesKey(data, 'pageUp')) { follow = false; scroll = Math.max(0, scroll - (matchesKey(data, 'pageUp') ? 15 : 1)); }
      else if (matchesKey(data, 'down') || matchesKey(data, 'pageDown')) { follow = false; scroll += matchesKey(data, 'pageDown') ? 15 : 1; }
      else if (matchesKey(data, 'home')) { follow = false; scroll = 0; }
      else if (matchesKey(data, 'end')) follow = true;
      tui.requestRender();
    },
    render(width: number) {
      const all = [...records.values()];
      const record = all[selected];
      const worker = record?.worker;
      const header = worker ? `Parent › #${worker.id} ${worker.role} · ${worker.model} · ${worker.status}` : 'Parent › Workers';
      const hints = '←/→ or Tab: cycle · ↑/↓ PgUp/PgDn: scroll · End: follow · Esc: parent';
      let body: string;
      if (!record) body = all.length ? all.map(({ worker: w }) => `#${w.id} ${w.role} · ${w.status}\n${w.task}\n${w.activity}`).join('\n\n') : 'No delegated workers in this session yet.';
      else {
        let messages = record.getMessages?.();
        if (!messages && worker.transcript) {
          try {
            if (cachedId !== worker.id) {
              cachedMessages = readFileSync(worker.transcript, 'utf8').split('\n').flatMap(line => { try { const entry = JSON.parse(line); return entry.type === 'message' ? [entry.message] : []; } catch { return []; } });
              cachedId = worker.id;
            }
            messages = cachedMessages;
          }
          catch { messages = []; }
        }
        body = `Task: ${worker.task}\nTranscript: ${worker.transcript || '(starting)'}\n\n${messageText(messages || [])}\n\n${worker.activity}${worker.status === 'running' && worker.text ? `\nLatest response: ${worker.text}` : ''}`;
      }
      const top = new Text(theme.fg('accent', safe(header)) + '\n' + theme.fg('dim', hints), 0, 0).render(width);
      const lines = new Text(safe(body), 0, 0).render(width);
      const height = Math.max(3, (tui.terminal.rows || 24) - top.length - 2);
      const max = Math.max(0, lines.length - height);
      scroll = follow ? max : Math.min(scroll, max);
      return [...top, '', ...lines.slice(scroll, scroll + height), theme.fg('dim', `${scroll + 1}–${Math.min(scroll + height, lines.length)} / ${lines.length}${follow ? ' · following' : ''}`)];
    },
    invalidate() {},
    dispose() { clearInterval(timer); }
  };
}
