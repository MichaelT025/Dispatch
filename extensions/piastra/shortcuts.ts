/**
 * PiAstra editor-scoped shortcuts.
 *
 * Installs a CustomEditor subclass as the main input editor. All interception
 * lives inside the editor's own handleInput, so:
 * - no global keybindings config is written,
 * - no global input listeners are registered,
 * - pi.registerShortcut is not overridden: the existing ctrl+shift+a/w
 *   aliases keep working through pi's default onExtensionShortcut wiring,
 * - overlays such as the worker viewer keep their own Shift+Tab navigation
 *   because they receive input while the main editor is unfocused.
 *
 * pi installs its native action handlers (app.thinking.toggle,
 * app.message.copy, ...) into any editor that duck-types as a CustomEditor
 * (interactive-mode setCustomEditorComponent copies defaultEditor's
 * actionHandlers map), so shortcuts invoke those handlers by action id
 * instead of simulating raw keystrokes.
 *
 * Mappings (see docs/shortcuts.md):
 * - Shift+Tab        cycle the primary PiAstra agents
 * - Ctrl+T           native app.thinking.cycle
 * - Ctrl+O           optional toggleTools action; unhandled → native app.tools.expand
 * - Ctrl+X           arm a 2s leader with a small visible hint
 *   t                native app.thinking.toggle
 *   y                native app.message.copy
 *   a                PiAstra agent picker
 *   w                worker overlay
 *   Esc              cancel the leader without aborting
 *   other key        disarm and fall through normally
 *   Ctrl+X           rearm (timer restarts)
 */
import { CustomEditor, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export const LEADER_TIMEOUT_MS = 2000;
export const LEADER_HINT = ' x→ t y a w ';

/** Property marker on the installed factory so /reload replacements never nest. */
export const EDITOR_FACTORY_BRAND = 'piastraShortcutsFactory';

/** Actions receive the session context captured at session_start. */
export interface PiastraShortcutActions {
  cycleAgents: (ctx: any) => void | Promise<void>;
  openAgentPicker: (ctx: any) => void | Promise<void>;
  openWorkers: (ctx: any) => void | Promise<void>;
  /**
   * Ctrl+O. Must answer synchronously: return true when the toggle was
   * handled (e.g. the compact-transcript plugin claimed the event), false
   * (or throw) to fall back to the native app.tools.expand handler.
   */
  toggleTools?: (ctx: any) => boolean;
}

export interface PiastraEditorOptions {
  /** Session context handed to shortcut actions. */
  ctx?: any;
  actions?: PiastraShortcutActions;
  leaderTimeoutMs?: number;
  hintStyle?: (hint: string) => string;
  onActionError?: (error: unknown) => void;
  embedWorkingStatus?: boolean;
}

const noopActions: PiastraShortcutActions = { cycleAgents() {}, openAgentPicker() {}, openWorkers() {} } as any;

const noopContext = {};

export class PiastraEditor extends CustomEditor {
  private ctx: any;
  private actions: PiastraShortcutActions;
  private leaderTimeoutMs: number;
  private hintStyle: (hint: string) => string;
  private onActionError: (error: unknown) => void;
  private armed = false;
  private leaderTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(tui: any, theme: any, keybindings: any, options: PiastraEditorOptions = {}) {
    super(tui, theme, keybindings, { embedWorkingStatus: options.embedWorkingStatus === true });
    this.ctx = options.ctx ?? noopContext;
    this.actions = options.actions ?? noopActions;
    this.leaderTimeoutMs = options.leaderTimeoutMs ?? LEADER_TIMEOUT_MS;
    this.hintStyle = options.hintStyle ?? ((hint: string) => hint);
    this.onActionError = options.onActionError ?? (() => {});
    // The TUI assigns `focused` on focus changes (dialogs, overlays, custom
    // components). Leaving the editor always disarms the leader so a stale
    // hint or timer never survives into another focus target.
    let focused = false;
    Object.defineProperty(this, 'focused', {
      get: () => focused,
      set: (value: boolean) => {
        focused = value;
        if (!value) this.disarmLeader();
      },
    });
  }

  /** True while the Ctrl+X leader is armed. */
  get isLeaderArmed(): boolean {
    return this.armed;
  }

  handleInput(data: string): void {
    if (this.armed) {
      // Escape cancels the leader without aborting: do not pass it to super,
      // where it would match app.interrupt.
      if (matchesKey(data, 'escape')) return this.disarmLeader();
      // Repeat Ctrl+X rearms with a fresh timeout.
      if (matchesKey(data, 'ctrl+x')) return this.armLeader();
      this.disarmLeader();
      if (matchesKey(data, 't')) return this.invokeNative('app.thinking.toggle', data);
      if (matchesKey(data, 'y')) return this.invokeNative('app.message.copy', data);
      if (matchesKey(data, 'a')) return this.runAction('openAgentPicker');
      if (matchesKey(data, 'w')) return this.runAction('openWorkers');
      // Unmatched key: disarm (done above) and fall through normally.
      return super.handleInput(data);
    }
    if (matchesKey(data, 'shift+tab')) return this.runAction('cycleAgents');
    if (matchesKey(data, 'ctrl+x')) return this.armLeader();
    if (matchesKey(data, 'ctrl+t')) return this.invokeNative('app.thinking.cycle', data);
    if (matchesKey(data, 'ctrl+o')) return this.toggleTools(data);
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!this.armed || lines.length === 0) return lines;
    const hint = this.hintStyle(LEADER_HINT);
    const hintWidth = visibleWidth(hint);
    if (hintWidth === 0 || hintWidth >= width) return lines;
    const last = lines.length - 1;
    lines[last] = truncateToWidth(lines[last]!, width - hintWidth, '') + hint;
    return lines;
  }

  /** Clear the leader timer and hint. Safe to call repeatedly. */
  disarmLeader(): void {
    if (this.leaderTimer) {
      clearTimeout(this.leaderTimer);
      this.leaderTimer = undefined;
    }
    if (!this.armed) return;
    this.armed = false;
    this.invalidate();
    this.tui?.requestRender();
  }

  /** Lifecycle hook for session shutdown and disposal. */
  dispose(): void {
    this.disarmLeader();
  }

  private armLeader(): void {
    if (this.leaderTimer) clearTimeout(this.leaderTimer);
    this.leaderTimer = setTimeout(() => {
      this.leaderTimer = undefined;
      this.disarmLeader();
    }, this.leaderTimeoutMs);
    if (this.armed) return;
    this.armed = true;
    this.invalidate();
    this.tui?.requestRender();
  }

  /**
   * Invoke a native app action by id from the handler map pi copies into
   * CustomEditor instances. Falls back to normal key handling when the map
   * has no entry (for example in unit tests with a reduced handler set).
   */
  private invokeNative(action: string, data: string): void {
    const handler = this.actionHandlers.get(action as never);
    if (handler) handler();
    else super.handleInput(data);
  }

  /**
   * Ctrl+O: ask the optional toggleTools action first (synchronously), then
   * fall back to the native app.tools.expand handler when it does not claim
   * the toggle (absent, false, or thrown).
   */
  private toggleTools(data: string): void {
    const action = this.actions.toggleTools;
    if (action) {
      let handled = false;
      try {
        handled = action(this.ctx) === true;
      } catch (error) {
        try { this.onActionError(error); } catch { /* never reject input handling */ }
      }
      if (handled) return;
    }
    this.invokeNative('app.tools.expand', data);
  }

  private runAction(name: keyof PiastraShortcutActions): void {
    const action = this.actions[name];
    if (!action) return;
    void Promise.resolve().then(() => action(this.ctx)).catch(error => {
      try { this.onActionError(error); } catch { /* never reject input handling */ }
    });
  }
}

const styleHint = (ctx: any, hint: string) => {
  try { return ctx.ui.theme.fg('accent', hint) as string; } catch { return hint; }
};

/**
 * Install the editor-scoped shortcuts on an ExtensionAPI.
 *
 * `actions` receive the session context captured at session_start, so they
 * are always bound to the current session. Errors are surfaced through
 * ctx.ui.notify instead of escaping input handling; the busy guard in
 * agents.select ("Wait for the current turn to finish...") therefore shows
 * as a notification when Shift+Tab is pressed while the agent is running.
 */
export function installShortcuts(pi: ExtensionAPI, actions: PiastraShortcutActions): void {
  let activeEditor: PiastraEditor | undefined;
  const disarm = () => { try { activeEditor?.dispose(); } catch { /* ignore */ } };

  pi.on('session_start', (_event, ctx) => {
    disarm();
    if (ctx.mode !== 'tui' || !ctx.ui?.setEditorComponent) return;
    const notifyError = (error: unknown) => {
      try { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); } catch { /* ignore */ }
    };
    const guarded = (action: (ctx: any) => void | Promise<void>) => async (ctx: any) => {
      try { await action(ctx); } catch (error) { notifyError(error); }
    };
    const previous = ctx.ui.getEditorComponent() as any;
    // After /reload or a session switch our own earlier factory is still
    // installed; replace it outright so repeated reloads cannot nest editors
    // and stale contexts are dropped.
    if (previous && previous[EDITOR_FACTORY_BRAND] !== true) {
      // A foreign extension owns the editor. Composing would mean constructing
      // and discarding that editor (leaking its state) or clobbering its
      // behavior, so skip installation gracefully instead.
      try {
        ctx.ui.notify('PiAstra editor shortcuts not installed: another extension already provides a custom editor.', 'warning');
      } catch { /* ignore */ }
      return;
    }
    const factory = (tui: any, theme: any, keybindings: any) => {
      const editor = new PiastraEditor(tui, theme, keybindings, {
        ctx,
        actions: {
          cycleAgents: guarded(actions.cycleAgents),
          openAgentPicker: guarded(actions.openAgentPicker),
          openWorkers: guarded(actions.openWorkers),
          // Ctrl+O must answer synchronously (the editor needs the handled
          // flag before deciding on the native fallback), so this action is
          // not routed through the async `guarded` wrapper. Emission errors
          // are swallowed and treated as "not handled" → native fallback.
          toggleTools: (ctx: any) => {
            try {
              const envelope = { handled: false, ctx };
              pi.events.emit('piastra:compact-transcript:toggle', envelope);
              return envelope.handled === true;
            } catch {
              return false;
            }
          },
        },
        hintStyle: hint => styleHint(ctx, hint),
        onActionError: notifyError,
      });
      activeEditor = editor;
      return editor;
    };
    Object.defineProperty(factory, EDITOR_FACTORY_BRAND, { value: true });
    ctx.ui.setEditorComponent(factory);
  });
  pi.on('session_tree', disarm);
  pi.on('session_shutdown', () => { disarm(); activeEditor = undefined; });
}
