// Above-editor subagent panel for the orchestrator: a TODO-style live view of
// the workers delegated during the current agent run. The parent extension
// drives the lifecycle (bind/beginRun/addCall/publish/endRun/reset); this
// module owns no timers — the existing 250ms worker publish tick supplies
// spinner frames and elapsed-time updates, and finalization publishes settle
// the last status before the parent calls endRun on agent_settled.
//
// Run scoping: only workers whose delegate `toolCallId` was registered with
// addCall during the current run are shown, never the full restored session
// history. Retried agent runs emit extra `agent_start` events, so beginRun is
// a no-op while a run is still open; the next beginRun after endRun clears the
// whitelist and history. Completed rows stay visible until that next run or a
// session-boundary reset.

import { truncateToWidth } from '@earendil-works/pi-tui';

export const WIDGET_KEY = 'piastra:subagents';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Heading + worker rows/overflow line; one trailing blank is added
// after these. Rows are never dropped from state, only from the display.
const MAX_CONTENT_LINES = 12;
const ACTIVE_STATUSES = new Set(['starting', 'running']);

// Sanitize external content before applying our own terminal styles.
const clean = (value: unknown) => String(value ?? '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, '');

export type PanelRow = { id?: number; role: string; status: string; started: number; ended?: number };

// Roles reuse existing theme colors: general=warning/yellow, fast=thinkingLow/blue,
// review=success/green. Unknown roles fall back to muted; failures are red.
const ROLE_STYLES: Record<string, string> = { general: 'warning', fast: 'thinkingLow', review: 'success' };

export function spinnerFrame(index: number) {
  const frames = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((index % frames) + frames) % frames];
}

export function formatElapsed(millis: number) {
  const seconds = Math.max(0, Math.floor(millis / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

// Spinner frames for starting/running, ✓ completed, ✗ failed, and distinct
// indicators for cancelled (⊘) and interrupted (⏹).
function statusGlyph(status: string, frame: string): [string, string] {
  if (ACTIVE_STATUSES.has(status)) return [frame, 'accent'];
  if (status === 'completed') return ['✓', 'success'];
  if (status === 'failed') return ['✗', 'error'];
  if (status === 'cancelled') return ['⊘', 'error'];
  if (status === 'interrupted') return ['⏹', 'error'];
  return ['·', 'dim'];
}

const roleStyle = (role: unknown) => ROLE_STYLES[String(role)] ?? 'muted';

// Pure renderer: rows are worker snapshots, theme is whatever the caller wants
// (the panel passes ctx.ui.theme each render so theme switches apply).
export function renderSubagentPanel(
  rows: PanelRow[],
  theme: any,
  width: number,
  options: { spinnerFrame?: number; now?: number; frozenAt?: number; runOpen?: boolean } = {},
) {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0 || rows.length === 0) return [];
  const fg = (style: string, text: string) => (theme && typeof theme.fg === 'function' ? theme.fg(style, text) : text);
  const fit = (line: string) => truncateToWidth(line, safeWidth);
  const frame = spinnerFrame(options.spinnerFrame ?? 0);
  const runActive = options.runOpen === true && rows.some(row => ACTIVE_STATUSES.has(String(row.status)));
  const finished = rows.filter(row => !ACTIVE_STATUSES.has(row.status)).length;
  const lines = [fit(fg(runActive ? 'accent' : 'muted', `${runActive ? '●' : '○'} Subagents (${finished}/${rows.length})`))];
  // Active rows first so bounded overflow can never silently hide a live worker.
  const ordered = [...rows].sort((a, b) => Number(ACTIVE_STATUSES.has(String(b.status))) - Number(ACTIVE_STATUSES.has(String(a.status))));
  const budget = MAX_CONTENT_LINES - 1;
  const overflowing = ordered.length > budget;
  const shown = overflowing ? ordered.slice(0, budget - 1) : ordered;
  // Ended timers freeze: settled rows keep their end time, and rows still
  // active when the run ended keep the frozen timestamp.
  const endedAt = typeof options.frozenAt === 'number' ? options.frozenAt : (options.now ?? Date.now());
  const rowLines = shown.map((row, index) => {
    const [glyph, glyphStyle] = statusGlyph(String(row.status || ''), frame);
    const branch = !overflowing && index === shown.length - 1 ? '└─' : '├─';
    const elapsed = formatElapsed((row.ended ?? endedAt) - (row.started ?? endedAt));
    return fit(`${branch} ${fg(glyphStyle, glyph)} ${fg(roleStyle(row.role), clean(row.role))} ${fg('dim', elapsed)}`);
  });
  if (overflowing) rowLines.push(fit(`└─ ${fg('dim', `+${ordered.length - shown.length} more · /workers`)}`));
  return [...lines, ...rowLines, ''];
}

export function createWorkerPanel(workerViews: Map<number, any>) {
  let ctx: any;
  let tui: any;
  let factoryTheme: any;
  let mounted = false;
  let disposed = false;
  let runOpen = false;
  let runEnabled = false;
  let frozenAt: number | undefined;
  let spinnerIndex = 0;
  let whitelist = new Set<string>();
  let tracked: PanelRow[] = [];
  let signature = '';
  let mountGeneration = 0;

  const snapshot = (): PanelRow[] => {
    const rows: PanelRow[] = [];
    for (const record of workerViews.values()) {
      const worker = record?.worker;
      if (!worker || !whitelist.has(worker.toolCallId)) continue;
      rows.push({ id: worker.id, role: String(worker.role ?? ''), status: String(worker.status ?? ''), started: worker.started ?? Date.now(), ended: worker.ended });
    }
    return rows;
  };

  const visible = () => !disposed && !!ctx && ctx.mode === 'tui' && runEnabled && tracked.length > 0;

  const render = (width: number) => {
    if (!visible()) return [];
    const theme = ctx?.ui?.theme ?? factoryTheme;
    return renderSubagentPanel(tracked, theme, width, {
      spinnerFrame: spinnerIndex,
      now: Date.now(),
      frozenAt,
      runOpen,
    });
  };

  const mount = () => {
    if (mounted || disposed || !ctx || ctx.mode !== 'tui' || typeof ctx.ui?.setWidget !== 'function') return;
    const generation = ++mountGeneration;
    mounted = true;
    try {
      ctx.ui.setWidget(WIDGET_KEY, (tuiInstance: any, theme: any) => {
        if (generation !== mountGeneration || disposed) return { render: () => [], invalidate() {} };
        tui = tuiInstance;
        factoryTheme = theme;
        return { render: (width: number) => generation === mountGeneration ? render(width) : [], invalidate() {} };
      }, { placement: 'aboveEditor' });
    } catch {
      // Widget publication must never fail a delegation. Retry next publish.
      mountGeneration++;
      mounted = false;
      tui = undefined;
      factoryTheme = undefined;
    }
  };

  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    mountGeneration++;
    try { ctx?.ui?.setWidget?.(WIDGET_KEY, undefined); } catch { /* teardown must not throw */ }
    tui = undefined;
    factoryTheme = undefined;
  };

  // Recompute visibility and only ask for a repaint when the rendered content
  // actually changed (publish ticks are frequent; settled panels are static).
  const refresh = () => {
    if (disposed) return;
    if (!visible()) { signature = ''; unmount(); return; }
    mount();
    const next = JSON.stringify({
      frame: tracked.some(row => ACTIVE_STATUSES.has(row.status)) ? spinnerIndex : -1,
      rows: tracked.map(row => `${row.id}:${row.role}:${row.status}:${formatElapsed((row.ended ?? frozenAt ?? Date.now()) - (row.started ?? Date.now()))}`),
    });
    if (next !== signature) {
      signature = next;
      try { tui?.requestRender?.(); } catch { /* view refresh must not throw */ }
    }
  };

  return {
    bind(context: any) {
      if (disposed) return;
      if (ctx && (ctx.ui !== context?.ui || ctx.mode !== context?.mode)) {
        unmount();
        runOpen = false;
        runEnabled = false;
        whitelist.clear();
        tracked = [];
        signature = '';
      }
      ctx = context;
      refresh();
    },
    beginRun(enabled = true) {
      if (disposed || runOpen) return;
      runOpen = true;
      runEnabled = !!enabled;
      whitelist = new Set();
      tracked = [];
      frozenAt = undefined;
      spinnerIndex = 0;
      signature = '';
      refresh();
    },
    addCall(toolCallId: unknown) {
      if (disposed || !runOpen || toolCallId === undefined || toolCallId === null) return;
      whitelist.add(String(toolCallId));
    },
    publish() {
      if (disposed || !ctx || ctx.mode !== 'tui') return;
      if (runOpen && runEnabled) {
        const rows = snapshot();
        if (rows.some(row => ACTIVE_STATUSES.has(row.status))) spinnerIndex += 1;
        tracked = rows;
      }
      refresh();
    },
    endRun() {
      if (disposed || !runOpen) return;
      runOpen = false;
      frozenAt = Date.now();
      if (runEnabled) tracked = snapshot().map(row => ACTIVE_STATUSES.has(row.status)
        ? { ...row, status: 'interrupted', ended: row.ended ?? frozenAt }
        : row);
      refresh();
    },
    reset() {
      if (disposed) return;
      runOpen = false;
      runEnabled = false;
      frozenAt = undefined;
      spinnerIndex = 0;
      whitelist = new Set();
      tracked = [];
      signature = '';
      unmount();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unmount();
      ctx = undefined;
      tui = undefined;
      factoryTheme = undefined;
      whitelist = new Set();
      tracked = [];
      signature = '';
    },
  };
}
