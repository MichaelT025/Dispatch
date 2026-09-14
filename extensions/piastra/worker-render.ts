import { Markdown, Text, truncateToWidth } from '@earendil-works/pi-tui';
import { getLanguageFromPath, getMarkdownTheme, highlightCode } from '@earendil-works/pi-coding-agent';
import { highlightedDiff } from '../pi-ui/index.ts';

// Sanitize external content before applying our own terminal styles.
export function safe(text: unknown) {
  return String(text ?? '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export const statusStyle = (status: string) => status === 'completed' ? 'success'
  : ['failed', 'cancelled', 'interrupted'].includes(status) ? 'error' : 'accent';
export const plainLines = (text: unknown, width: number) => new Text(safe(text), 0, 0).render(width);
export const markdownLines = (text: unknown, width: number) => new Markdown(safe(text), 0, 0, getMarkdownTheme()).render(width);
const codeLines = (text: unknown, language: string | undefined, width: number) =>
  new Text(highlightCode(safe(text), language).join('\n'), 0, 0).render(width);
const preview = (text: unknown) => {
  const value = safe(text);
  return value.length > 30000 ? `${value.slice(0, 30000)}\n[Preview truncated; see transcript.]` : value;
};

// Keep the normal transcript useful at a glance. Details remain available via Ctrl+O.
export function toolSummary(name: unknown, args: any = {}) {
  const tool = String(name || 'tool');
  args = args || {};
  const label = ({ read: 'Read', grep: 'Search', find: 'Find', ls: 'List', bash: 'Run',
    edit: 'Edit', write: 'Write', inspect_git: 'Git', fetch_url: 'Fetch' } as any)[tool] || safe(tool).replace(/\s+/g, ' ');
  const clean = (value: unknown) => safe(value).replace(/\s+/g, ' ').trim();
  let value = '';
  if (tool === 'grep' || tool === 'find') {
    const pattern = clean(args.pattern);
    const scope = clean(args.path || args.file_path || args.glob);
    value = [pattern, scope && `in ${scope}`].filter(Boolean).join(' ');
  } else {
    value = clean(args.path || args.file_path || args.pattern || args.command || args.url ||
      [args.operation, args.revision].filter(Boolean).join(' '));
  }
  return `${label}${value ? ` ${value.slice(0, 220)}` : ''}`;
}

export function renderTranscript(messages: any[], theme: any, width: number, expandedTools = true) {
  const lines: string[] = [];
  const calls = new Map<string, any>();
  for (const message of messages) {
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
    for (const part of parts) if (part.type === 'toolCall') calls.set(part.id, part);
  }
  for (const message of messages) {
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
    const visible = parts.filter((part: any) => part.type === 'text' || part.type === 'toolCall');
    if (!visible.length) continue;
    const tool = message.role === 'toolResult';
    for (const part of visible) {
      if (part.type === 'toolCall') {
        const summary = toolSummary(part.name, part.arguments);
        lines.push(...new Text(theme.fg('accent', `→ ${summary}`), 0, 0).render(width));
        if (expandedTools) lines.push(...codeLines(preview(JSON.stringify(part.arguments, null, 2)), 'json', width));
      } else if (tool) {
        const call = calls.get(message.toolCallId);
        const file = call?.arguments?.path || call?.arguments?.file_path;
        const language = message.toolName === 'read' && file ? getLanguageFromPath(file) : undefined;
        const output = preview(part.text);
        if (!expandedTools && !message.isError) {
          // Keep a long target from consuming the line needed to show the result.
          const summaryWidth = Math.min(width, 64);
          lines.push(truncateToWidth(theme.fg('dim', `✓ ${toolSummary(message.toolName, call?.arguments)} · Ctrl+O to expand`), summaryWidth));
          const first = output.replace(/\s+/g, ' ').slice(0, 260);
          if (first) lines.push(truncateToWidth(theme.fg('toolOutput', `  ${first}${output.length > first.length ? '…' : ''}`), width));
        } else {
          lines.push(truncateToWidth(theme.fg(message.isError ? 'error' : 'toolTitle', `${message.isError ? '✗' : '✓'} ${toolSummary(message.toolName, call?.arguments)}`), width));
          lines.push(...(language ? codeLines(output, language, width)
            : new Text(theme.fg(message.isError ? 'error' : 'toolOutput', output), 0, 0).render(width)));
        }
      } else lines.push(...markdownLines(preview(part.text), width));
    }
    if (tool && expandedTools && !message.isError && message.toolName === 'edit' && typeof message.details?.diff === 'string') {
      const args = calls.get(message.toolCallId)?.arguments;
      lines.push(...new Text(highlightedDiff(message.details.diff, args?.path ?? args?.file_path ?? '', theme, true), 0, 0).render(width));
    }
    lines.push('');
  }
  return lines;
}

// The parent card is a bounded preview; /workers contains the complete conversation.
export function createWorkerProgress(workers: any[], expanded: boolean, theme: any) {
  return {
    invalidate() {},
    render(width: number) {
      const lines: string[] = [];
      for (const worker of workers) {
        const seconds = Math.floor(((worker.ended || Date.now()) - worker.started) / 1000);
        lines.push(truncateToWidth(theme.fg(statusStyle(worker.status), safe(`#${worker.id} ${worker.role} · ${worker.model} · ${worker.status} · ${seconds}s`)), width));
        lines.push(truncateToWidth(theme.fg('muted', safe(worker.activity)), width));
        if (expanded) {
          lines.push(...plainLines(`Task: ${worker.task}`, width).slice(0, 2).map(line => theme.fg('dim', line)));
          for (const recent of (worker.recent || []).slice(-4)) {
            lines.push(truncateToWidth(theme.fg(recent.startsWith('✗') ? 'error' : 'toolOutput', safe(recent)), width));
          }
          if (worker.text) lines.push(...markdownLines(worker.text, width).slice(0, 6));
        }
        lines.push('');
      }
      lines.push(truncateToWidth(theme.fg('dim', 'Ctrl+Shift+W: worker sessions · Ctrl+O: activity preview'), width));
      return lines;
    }
  };
}
