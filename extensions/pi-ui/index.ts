import { createEditTool, getLanguageFromPath, highlightCode } from '@earendil-works/pi-coding-agent';
import { Text, stripTerminalSequences } from '@earendil-works/pi-tui';

const clean = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

export function highlightedDiff(diff: string, file: string, theme: any, expanded: boolean) {
  const raw = clean(diff).split('\n');
  const selected = raw.slice(0, expanded ? 500 : 14);
  const language = getLanguageFromPath(file);
  const parsed = selected.map(line => /^([+\- ])(\s*\d*) (.*)$/.exec(line));
  // Highlight each side as a block so multiline comments and strings retain context.
  const sides = ['-', '+'].map(side => {
    const lines = parsed.filter(row => row && row[1] !== (side === '-' ? '+' : '-'));
    const code = lines.map(row => row![3]).join('\n').slice(0, 30000);
    const colored = language ? highlightCode(code, language) : code.split('\n');
    return new Map(lines.map((row, index) => [row, colored[index] ?? '…']));
  });
  const output = selected.map((line, index) => {
    const row = parsed[index];
    if (!row) return theme.fg('toolDiffContext', line);
    const color = row[1] === '+' ? 'toolDiffAdded' : row[1] === '-' ? 'toolDiffRemoved' : 'toolDiffContext';
    return theme.fg(color, row[1] + row[2] + ' ') + (sides[row[1] === '-' ? 0 : 1].get(row) ?? row[3]);
  });
  if (raw.length > selected.length) output.push(theme.fg('muted', `… ${raw.length - selected.length} more lines${expanded ? ' (preview limit)' : ' · Ctrl+O to expand'}`));
  return output.join('\n');
}

// Independent of PiAstra: usable in any Pi session, without an LSP or extra dependencies.
export default function (pi: any) {
  const edit = createEditTool(process.cwd());
  pi.registerTool({
    ...edit,
    execute(id: string, args: any, signal: any, update: any, ctx: any) {
      return createEditTool(ctx.cwd).execute(id, args, signal, update);
    },
    renderCall(args: any, theme: any) {
      return new Text(theme.fg('toolTitle', 'edit ') + theme.fg('accent', clean(String(args.path ?? args.file_path ?? '…'))), 0, 0);
    },
    renderResult(result: any, options: any, theme: any, ctx: any) {
      const summary = clean(result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n'));
      const diff = result.details?.diff;
      const output = ctx.isError ? theme.fg('error', summary) : typeof diff === 'string'
        ? `${theme.fg('muted', summary)}\n\n${highlightedDiff(diff, ctx.args.path ?? ctx.args.file_path ?? '', theme, options.expanded)}`
        : summary;
      const component = ctx.lastComponent ?? new Text('', 0, 0);
      component.setText(output);
      return component;
    },
  });
}
