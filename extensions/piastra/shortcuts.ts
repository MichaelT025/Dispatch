/**
 * Piastra editor-scoped shortcuts.
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
 * Cooperative composition with Pi Atelier uses an explicit VERSIONED factory
 * capability published as plain metadata on the editor factory (the key
 * literals below must stay in sync with the vendored fork in
 * extensions/pi-atelier; there is deliberately no cross-package import so
 * each fork remains separately loadable):
 * - PiastraEditor accepts shared presentation entries (width budget + frame
 *   decorator). render() applies base rendering first, then decorations, and
 *   the leader hint last, so the frame never eats the hint.
 * - When Atelier ran first, installShortcuts reads its capability metadata
 *   and rebuilds a fresh shortcut factory that constructs a SINGLE
 *   PiastraEditor carrying every presentation entry — never nested or
 *   discarded editors — so the Atelier frame is preserved.
 * - When Piastra ran first, Atelier composes onto this capability through
 *   composePresentation(). Entries carry an ownerToken identifying the
 *   owning Atelier session, so PiAstra may later rebuild the factory
 *   (per-presentation ownership identity, not just initial factory equality)
 *   while the Atelier session can still peel its frame back off.
 *   If the Piastra factory was already retired (session replaced/shutdown),
 *   compose/remove still update the retired factory's presentation METADATA
 *   for handoff at the next Piastra session_start, but never construct an
 *   editor or trigger ui.setEditorComponent — a retired factory refuses to
 *   build editors (throws) so no stale reconstruction can happen.
 * - Unknown foreign factories (no capability metadata) are never overwritten
 *   by either installer.
 *
 * Mappings (see docs/shortcuts.md):
 * - Shift+Tab        cycle the primary PiAstra agents
 * - Ctrl+T           native app.thinking.cycle
 * - Ctrl+O           optional toggleTools action; unhandled → native app.tools.expand
 * - Ctrl+V / Alt+V   native clipboard paste, with compact image labels
 * - Ctrl+X           arm a 2s leader with a small visible hint
 *   t                native app.thinking.toggle
 *   y                native app.message.copy
 *   a                PiAstra agent picker
 *   w                worker overlay
 *   m                native app.model.select (model picker)
 *   Esc              cancel the leader without aborting
 *   other key        disarm and fall through normally
 *   Ctrl+X           rearm (timer restarts)
 */
import { CustomEditor, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { expandImageMarkers, insertClipboardImage, renderImagePlaceholders } from './image-paste.ts';

export type EditorFactory = ((tui: any, theme: any, keybindings: any) => any) & Record<string, any>;

/**
 * Shared explicit cooperative editor capability metadata, published as plain
 * properties on editor factories. Mirrored by the vendored pi-atelier fork.
 */
export const EDITOR_CAPABILITY_KEY = 'editorCapability';
export const EDITOR_PRESENTATIONS_KEY = 'editorPresentations';
export const EDITOR_CAPABILITY_VERSION = 1;
export const PIASTRA_EDITOR_CAPABILITY_ID = 'piastra.shortcuts';

export interface EditorPresentationContext {
  borderColor?: (text: string) => string;
  editor?: CustomEditor;
}

/** One width-safe decoration layer applied over base editor rendering. */
export interface EditorPresentationEntry {
  readonly id: string;
  /** Identity of the composing party; per-session/lifecycle token. */
  readonly ownerToken: object;
  /** Columns consumed around the base rendering (frame chrome). */
  readonly chrome: number;
  /** Decorations are skipped below this outer width. */
  readonly minWidth: number;
  decorate(
    inner: readonly string[],
    outerWidth: number,
    context: EditorPresentationContext,
  ): readonly string[];
}

/** Cooperative contract both installers understand via the capability key. */
export interface CooperativeEditorCapability {
  readonly id: string;
  readonly version: number;
  readonly ownerToken?: object;
  /** Presentation entries applied by this factory, innermost first. */
  readonly readPresentations: () => readonly EditorPresentationEntry[];
  /** Overlay an entry, rebuilding so one fresh editor carries all layers. */
  readonly composePresentation?: (entry: EditorPresentationEntry) => EditorFactory | undefined;
  /** Drop entries owned by the given token; returns the rebuilt factory. */
  readonly withoutPresentationsFor?: (ownerToken: object) => EditorFactory | undefined;
}

/** Presentation entries already recorded on a factory, innermost first. */
export function readEditorPresentations(factory: unknown): readonly EditorPresentationEntry[] {
  const entries = (factory as any)?.[EDITOR_PRESENTATIONS_KEY];
  return Array.isArray(entries) ? (entries as EditorPresentationEntry[]) : [];
}

export function readEditorCapability(factory: unknown): CooperativeEditorCapability | undefined {
  const cap = (factory as any)?.[EDITOR_CAPABILITY_KEY];
  return cap && typeof cap === 'object' ? (cap as CooperativeEditorCapability) : undefined;
}

export const LEADER_TIMEOUT_MS = 2000;
export const LEADER_HINT = ' x→ t y a w m ';

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
  /** Presentation layers composed onto the base rendering, innermost first. */
  presentations?: readonly EditorPresentationEntry[];
  /** Expanded draft captured before core replaces the old editor instance. */
  initialExpandedText?: string;
}

const noopActions: PiastraShortcutActions = { cycleAgents() {}, openAgentPicker() {}, openWorkers() {} } as any;

const noopContext = {};

export class PiastraEditor extends CustomEditor {
  private ctx: any;
  private actions: PiastraShortcutActions;
  private leaderTimeoutMs: number;
  private hintStyle: (hint: string) => string;
  private onActionError: (error: unknown) => void;
  private presentations: EditorPresentationEntry[];
  private disposed = false;
  private armed = false;
  private leaderTimer: ReturnType<typeof setTimeout> | undefined;
  private initialExpandedText: string | undefined;
  private bracketedPaste: string | undefined;

  constructor(tui: any, theme: any, keybindings: any, options: PiastraEditorOptions = {}) {
    super(tui, theme, keybindings, { embedWorkingStatus: options.embedWorkingStatus === true });
    this.initialExpandedText = options.initialExpandedText;
    this.ctx = options.ctx ?? noopContext;
    this.actions = options.actions ?? noopActions;
    this.leaderTimeoutMs = options.leaderTimeoutMs ?? LEADER_TIMEOUT_MS;
    this.hintStyle = options.hintStyle ?? ((hint: string) => hint);
    this.onActionError = options.onActionError ?? (() => {});
    this.presentations = [...(options.presentations ?? [])];
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

  /** Presentation layers currently composed over the base rendering. */
  getPresentations(): readonly EditorPresentationEntry[] {
    return this.presentations;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    // A terminal-owned paste may deliver the clipboard path as bracketed text
    // instead of a keypress. Buffer it before shortcut dispatch (including
    // split input chunks), and leave all non-image pastes to Pi unchanged.
    const pasteStart = '\x1b[200~', pasteEnd = '\x1b[201~';
    if (this.bracketedPaste !== undefined || data.startsWith(pasteStart)) {
      this.bracketedPaste = (this.bracketedPaste ?? '') + (data.startsWith(pasteStart) ? data.slice(pasteStart.length) : data);
      const end = this.bracketedPaste.indexOf(pasteEnd);
      if (end < 0) return;
      const text = this.bracketedPaste.slice(0, end);
      const remaining = this.bracketedPaste.slice(end + pasteEnd.length);
      this.bracketedPaste = undefined;
      this.disarmLeader();
      if (!insertClipboardImage(this, text, value => super.insertTextAtCursor(value))) {
        super.handleInput(pasteStart + text + pasteEnd);
      }
      if (remaining) this.handleInput(remaining);
      return;
    }
    // Clipboard paste is a dedicated native callback, not an actionHandlers
    // entry. Reusing it preserves Pi's OS support and ordinary text fallback.
    if ((matchesKey(data, 'ctrl+v') || matchesKey(data, 'alt+v')) && this.onPasteImage) {
      this.disarmLeader();
      this.onPasteImage();
      return;
    }
    if (this.armed) {
      // Escape cancels the leader without aborting: do not pass it to super,
      // where it would match app.interrupt.
      if (matchesKey(data, 'escape')) return this.disarmLeader();
      // Repeat Ctrl+X rearms with a fresh timeout.
      if (matchesKey(data, 'ctrl+x')) return this.armLeader();
      this.disarmLeader();
      if (matchesKey(data, 't')) return this.invokeNative('app.thinking.toggle', data);
      if (matchesKey(data, 'y')) return this.invokeNative('app.message.copy', data);
      if (matchesKey(data, 'm')) return this.invokeNative('app.model.select', data);
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

  insertTextAtCursor(text: string): void {
    if (!insertClipboardImage(this, text, value => super.insertTextAtCursor(value))) {
      super.insertTextAtCursor(text);
    }
  }

  getText(): string {
    // Core transfers getText(), not getExpandedText(), when resetting custom
    // UI before /reload. Never export image markers without their registry.
    // Native layout/cursor/submit use state.lines directly, so the editor can
    // keep atomic markers internally while its text API returns image paths.
    return expandImageMarkers(this, super.getText());
  }

  setText(text: string): void {
    // Preserve all expanded pastes during direct editor replacement as well.
    const expanded = this.initialExpandedText ?? expandImageMarkers(this, text);
    this.initialExpandedText = undefined;
    this.bracketedPaste = undefined;
    super.setText(expanded);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.trunc(width));
    const renderLayer = (index: number, outerWidth: number): string[] => {
      if (index < 0) return renderImagePlaceholders(this, super.render(outerWidth));
      const presentation = this.presentations[index]!;
      if (outerWidth < presentation.minWidth || outerWidth <= presentation.chrome) {
        return renderLayer(index - 1, outerWidth);
      }
      const inner = renderLayer(index - 1, outerWidth - presentation.chrome);
      try {
        return [...presentation.decorate(inner, outerWidth, {
          borderColor: (text: string) => this.borderColor?.(text) ?? text,
          editor: this,
        })].map(line => truncateToWidth(line, outerWidth, ''));
      } catch {
        return renderLayer(index - 1, outerWidth);
      }
    };
    const lines = renderLayer(this.presentations.length - 1, safeWidth);

    // The hint is applied LAST so a frame presentation can never eat it.
    if (!this.armed || lines.length === 0) return lines;
    const hint = this.hintStyle(LEADER_HINT);
    const hintWidth = visibleWidth(hint);
    if (hintWidth === 0 || hintWidth >= safeWidth) return lines;
    const last = lines.length - 1;
    lines[last] = truncateToWidth(lines[last]!, safeWidth - hintWidth, '') + hint;
    return lines;
  }

  /** Replace presentations, disarming the leader so no stale hint survives. */
  setPresentations(entries: readonly EditorPresentationEntry[]): void {
    this.presentations = [...entries];
    this.disarmLeader();
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
    this.disposed = true;
    this.bracketedPaste = undefined;
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
    void Promise.resolve().then(() => this.disposed ? undefined : action(this.ctx)).catch(error => {
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
  let generation = 0;
  const disarmActive = () => { try { activeEditor?.dispose(); } catch { /* ignore */ } };

  pi.on('session_start', (_event, ctx) => {
    const currentGeneration = ++generation;
    disarmActive();
    if (ctx.mode !== 'tui' || !ctx.ui?.setEditorComponent) return;
    const notifyError = (error: unknown) => {
      try { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); } catch { /* ignore */ }
    };
    const guarded = (action: (ctx: any) => void | Promise<void>) => async (context: any) => {
      try { await action(context); } catch (error) { notifyError(error); }
    };

    /**
     * Build a branded Piastra factory. The factory records the shared
     * cooperative capability metadata (and its presentation layers) so the
     * other installer can compose or peel frames without importing this
     * module. Each rebuild constructs ONE editor instance owning the leader
     * state; active editor tracking follows factory invocations.
     */
    const buildFactory = (incoming: readonly EditorPresentationEntry[]): EditorFactory => {
      const presentationEntries = [...incoming];
      // Active generation: rebuild a fresh factory carrying `next`. Retired
      // generation: NEVER construct an editor or run an action, but still
      // record the updated presentation metadata on the (still UI-installed)
      // retired factory so the next session_start hands off exactly these
      // entries. Returning undefined means the caller must not call
      // ui.setEditorComponent, so no stale reconstruction ever happens.
      const compose = (next: readonly EditorPresentationEntry[]): EditorFactory | undefined => {
        if (generation === currentGeneration) return buildFactory(next);
        presentationEntries.splice(0, presentationEntries.length, ...next);
        return undefined;
      };
      const factory = ((tui: any, theme: any, keybindings: any) => {
        if (generation !== currentGeneration) throw new Error('PiAstra editor factory belongs to a retired session');
        disarmActive();
        const editor = new PiastraEditor(tui, theme, keybindings, {
          ctx,
          initialExpandedText: ctx.ui.getEditorText?.(),
          actions: {
            cycleAgents: guarded(actions.cycleAgents),
            openAgentPicker: guarded(actions.openAgentPicker),
            openWorkers: guarded(actions.openWorkers),
            // Ctrl+O must answer synchronously (the editor needs the handled
            // flag before deciding on the native fallback), so this action is
            // not routed through the async `guarded` wrapper. Emission errors
            // are swallowed and treated as "not handled" → native fallback.
            toggleTools: (context: any) => {
              try {
                const envelope = { handled: false, ctx: context };
                pi.events.emit('piastra:compact-transcript:toggle', envelope);
                return envelope.handled === true;
              } catch {
                return false;
              }
            },
          },
          hintStyle: hint => styleHint(ctx, hint),
          onActionError: notifyError,
          presentations: presentationEntries,
        });
        activeEditor = editor;
        return editor;
      }) as EditorFactory;
      Object.defineProperty(factory, EDITOR_FACTORY_BRAND, { value: true });
      // Legacy snapshot property stays consistent with the live metadata:
      // read through the mutable entries array (retired compose updates it).
      Object.defineProperty(factory, EDITOR_PRESENTATIONS_KEY, { get: () => [...presentationEntries] });
      Object.defineProperty(factory, EDITOR_CAPABILITY_KEY, {
        value: {
          id: PIASTRA_EDITOR_CAPABILITY_ID,
          version: EDITOR_CAPABILITY_VERSION,
          ownerToken: factory,
          readPresentations: () => [...presentationEntries],
          // Compose an extra presentation on top: rebuild so exactly ONE
          // fresh PiastraEditor carries base rendering plus every entry.
          composePresentation: (entry: EditorPresentationEntry) =>
            compose([...presentationEntries.filter(existing => existing.id !== entry.id), entry]),
          // Drop entries owned by a token (per-session ownership identity);
          // also disarms the current leader so no stale hint survives.
          withoutPresentationsFor: (ownerToken: object) =>
            compose(presentationEntries.filter(existing => existing.ownerToken !== ownerToken)),
        } satisfies CooperativeEditorCapability,
      });
      return factory;
    };
    const previous = ctx.ui.getEditorComponent() as any;
    let presentations: readonly EditorPresentationEntry[] = [];
    if (previous) {
      const isOwn = previous[EDITOR_FACTORY_BRAND] === true;
      // Preserve every presentation the previous factory already applies if
      // it publishes cooperative capability metadata (e.g. the Atelier
      // frame); our own legacy brand without metadata is also replaced
      // cleanly with an empty presentation stack.
      const capability = readEditorCapability(previous);
      const recognized = capability?.version === EDITOR_CAPABILITY_VERSION
        && (capability.id === PIASTRA_EDITOR_CAPABILITY_ID || capability.id === 'piastra.atelier-frame')
        && typeof capability.readPresentations === 'function';
      const canCompose = isOwn || recognized;
      if (!canCompose) {
        try {
          ctx.ui.notify('PiAstra editor shortcuts not installed: another extension already provides a custom editor.', 'warning');
        } catch { /* ignore */ }
        return;
      }
      // Preserve every presentation the previous factory already applies
      // if it publishes cooperative capability metadata (e.g. the Atelier
      // frame); our own legacy brand without metadata is also replaced
      // cleanly with an empty presentation stack.
      if (recognized) presentations = capability!.readPresentations();
      else presentations = [];
    }
    ctx.ui.setEditorComponent(buildFactory(presentations));
  });
  // Tree navigation keeps this editor mounted; only cancel the leader, not
  // the editor itself (unlike session replacement/shutdown).
  pi.on('session_tree', () => activeEditor?.disarmLeader());
  pi.on('session_shutdown', () => { generation++; disarmActive(); activeEditor = undefined; });
}
