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

// Fallback for delegate results without worker details (for example an early
// runtime throw from execute). Collapses raw/model-facing content to one
// sanitized, width-bounded line so a multiline error can never spill into the
// transcript. `expanded` is intentionally ignored; `isError` only selects the
// error color. Never mutates `output`.
export function createDelegateFallbackSummary(output: any, theme: any, isError?: boolean) {
  const blocks = Array.isArray(output?.content) ? output.content : [];
  const raw = blocks.filter((block: any) => block?.type === 'text').map((block: any) => String(block.text ?? '')).join('\n');
  const collapsed = safe(raw).replace(/\s+/g, ' ').trim();
  const concise = collapsed.slice(0, 260) + (collapsed.length > 260 ? '…' : '');
  const summary = concise || (isError ? 'failed' : 'no result');
  const style = isError ? 'error' : 'accent';
  return {
    invalidate() {},
    render(width: number) {
      return [truncateToWidth(theme.fg(style, `Delegate · ${summary}`), width)];
    }
  };
}

// Main-chat delegation stays compact: a single aggregate line. Expanded
// per-worker detail lives in /workers (worker-view.ts), not here. The
// `expanded` argument is kept for the renderResult call-site but ignored.
export function createWorkerProgress(workers: any[], _expanded: boolean, theme: any) {
  const list = Array.isArray(workers) ? workers : [];
  const snapshot = list.map(worker => safe(worker?.status || 'unknown').replace(/\s+/g, ' ').toLowerCase().trim().slice(0, 32) || 'unknown');
  return {
    invalidate() {},
    render(width: number) {
      const counts = new Map<string, number>();
      for (const status of snapshot) counts.set(status, (counts.get(status) ?? 0) + 1);
      const order = ['completed', 'running', 'starting', 'failed', 'cancelled', 'interrupted'];
      const parts: string[] = [];
      for (const status of order) {
        const count = counts.get(status);
        if (count) { parts.push(`${count} ${status}`); counts.delete(status); }
      }
      for (const [status, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        parts.push(`${count} ${status}`);
      }
      const summary = parts.length ? parts.join(' · ') : 'none';
      const hasFailure = snapshot.some(status => ['failed', 'cancelled', 'interrupted'].includes(status));
      const hasActive = snapshot.some(status => ['starting', 'running'].includes(status));
      const style = hasFailure ? 'error' : list.length > 0 && !hasActive ? 'success' : 'accent';
      return [truncateToWidth(theme.fg(style, `Workers · ${summary} · /workers for details`), width)];
    }
  };
}
