/**
 * Bounded regression tests for Piastra <-> Atelier editor cooperation.
 *
 * Imports the real production modules directly (.ts via node
 * --experimental-strip-types; editor.ts has no .js local imports):
 * - extensions/piastra/shortcuts.ts  (installShortcuts, PiastraEditor)
 * - extensions/pi-atelier/src/editor.ts (installAtelierEditor, clearAtelierEditor)
 *
 * The fake ctx.ui below mimics pi's interactive-mode setCustomEditorComponent:
 * save text, focus=false on the old editor, construct the new editor via the
 * factory, copy native actionHandlers + default onExtensionShortcut, focus the
 * new editor. No real TUI terminal is created.
 *
 * Run: node --experimental-strip-types --test extensions/pi-atelier/tests/editor-cooperation.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, matchesKey, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	LEADER_HINT,
	PiastraEditor,
	installShortcuts,
} from "../../piastra/shortcuts.ts";
import {
	AtelierEditor,
	clearAtelierEditor,
	installAtelierEditor,
} from "../src/editor.ts";

const SHIFT_TAB = "\x1b[Z";
const CTRL_X = "\x18";
const CTRL_T = "\x14";
const CTRL_O = "\x0f";
const ESCAPE = "\x1b";

const DEFAULT_BINDINGS = {
	"app.interrupt": ["escape"],
	"app.clear": ["ctrl+c"],
	"app.exit": ["ctrl+d"],
	"app.thinking.cycle": ["shift+tab"],
	"app.thinking.toggle": ["ctrl+t"],
	"app.message.copy": ["ctrl+x"],
	"app.tools.expand": ["ctrl+o"],
};
const keybindingsStub = (bindings = DEFAULT_BINDINGS) => ({
	matches: (data, action) => (bindings[action] ?? []).some((key) => matchesKey(data, key)),
});
const tuiStub = () => {
	let renders = 0;
	return { terminal: { rows: 24 }, requestRender() { renders++; }, get renders() { return renders; } };
};
const themeStub = { borderColor: (text) => text };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function countingActions(overrides = {}) {
	const calls = { cycleAgents: 0, openAgentPicker: 0, openWorkers: 0 };
	return {
		calls,
		actions: {
			cycleAgents: () => { calls.cycleAgents++; },
			openAgentPicker: () => { calls.openAgentPicker++; },
			openWorkers: () => { calls.openWorkers++; },
			...overrides,
		},
	};
}

function fakePi() {
	const handlers = new Map();
	const pi = {
		on(name, fn) { handlers.set(name, fn); },
		async emit(name, event, ctx) { const fn = handlers.get(name); if (fn) await fn(event, ctx); },
		events: { emitted: [], claim: false, emit(channel, envelope) { this.emitted.push([channel, envelope]); if (this.claim) envelope.handled = true; } },
	};
	return pi;
}

/**
 * Mimics pi interactive-mode setCustomEditorComponent semantics (see
 * node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js):
 * save text, blur the old editor (PiastraEditor disarms its leader on
 * focus=false), construct the new editor via the factory, copy native
 * actionHandlers + default onExtensionShortcut alias wiring, focus the new one.
 */
function makeHarness() {
	const tui = tuiStub();
	const theme = themeStub;
	const keybindings = keybindingsStub();
	const native = { thinkCycle: 0, thinkToggle: 0, copy: 0, expand: 0, interrupt: 0 };
	const alias = { extensionShortcut: 0 };
	const notified = [];
	const defaultEditor = new CustomEditor(tui, theme, keybindings);
	defaultEditor.actionHandlers.set("app.thinking.cycle", () => { native.thinkCycle++; });
	defaultEditor.actionHandlers.set("app.thinking.toggle", () => { native.thinkToggle++; });
	defaultEditor.actionHandlers.set("app.message.copy", () => { native.copy++; });
	defaultEditor.actionHandlers.set("app.tools.expand", () => { native.expand++; });
	defaultEditor.actionHandlers.set("app.interrupt", () => { native.interrupt++; });
	defaultEditor.onExtensionShortcut = (data) => {
		if (matchesKey(data, "ctrl+shift+a") || matchesKey(data, "ctrl+shift+w")) {
			alias.extensionShortcut++;
			return true;
		}
		return false;
	};
	const harness = {
		tui, theme, keybindings, native, alias, notified,
		factories: [],
		editor: defaultEditor,
		defaultEditor,
		ctx: null,
	};
	const ui = {
		notified,
		theme: { fg: (_style, text) => text },
		getEditorComponent: () => (harness.factories.length ? harness.factories[harness.factories.length - 1] : undefined),
		setEditorComponent: (factory) => {
			const currentText = harness.editor.getText?.() ?? "";
			try { harness.editor.focused = false; } catch { /* ignore */ }
			harness.factories.push(factory);
			if (!factory) {
				defaultEditor.setText(currentText);
				harness.editor = defaultEditor;
				try { defaultEditor.focused = true; } catch { /* ignore */ }
				return;
			}
			const next = factory(tui, theme, keybindings);
			next.setText?.(currentText);
			if (next.actionHandlers instanceof Map) {
				if (!next.onExtensionShortcut) {
					next.onExtensionShortcut = (data) => defaultEditor.onExtensionShortcut?.(data);
				}
				for (const [action, handler] of defaultEditor.actionHandlers) {
					next.actionHandlers.set(action, handler);
				}
			}
			try { next.focused = true; } catch { /* ignore */ }
			harness.editor = next;
		},
		notify: (message, kind) => { notified.push([message, kind]); },
	};
	harness.ctx = { mode: "tui", ui };
	harness.ui = ui;
	return harness;
}

const plainRender = (editor, width) => stripTerminalSequences(editor.render(width).join("\n"));
const frameCount = (editor, width) =>
	plainRender(editor, width).split("\n").filter((line) => line.includes("╭")).length;

describe("piastra/atelier editor cooperation", () => {
	it("piastra-first then atelier composes: one PiastraEditor keeps every mapping + native fallback", async () => {
		const h = makeHarness();
		const pi = fakePi();
		const { calls, actions } = countingActions();
		installShortcuts(pi, actions);
		await pi.emit("session_start", { reason: "startup" }, h.ctx);
		assert.ok(h.editor instanceof PiastraEditor);

		const token = {};
		assert.equal(installAtelierEditor(h.ctx, token), true);
		assert.ok(h.editor instanceof PiastraEditor);
		assert.equal(h.editor.getPresentations().length, 1);
		assert.equal(frameCount(h.editor, 80), 1);

		h.editor.handleInput(SHIFT_TAB);
		await settle();
		assert.equal(calls.cycleAgents, 1);
		assert.equal(h.native.thinkCycle, 0);

		h.editor.handleInput(CTRL_T);
		assert.equal(h.native.thinkCycle, 1);

		// Ctrl+O unclaimed -> native expand (no event-bus claim).
		h.editor.handleInput(CTRL_O);
		assert.equal(h.native.expand, 1);
		pi.events.claim = true;
		h.editor.handleInput(CTRL_O);
		assert.equal(h.native.expand, 1, 'compact transcript claims toggle without native expansion');
		assert.equal(h.editor.getText(), "");

		// Leader keys: t/y native, a/w actions, Esc cancels without abort.
		h.editor.handleInput(CTRL_X);
		h.editor.handleInput("t");
		assert.equal(h.native.thinkToggle, 1);
		h.editor.handleInput(CTRL_X);
		h.editor.handleInput("y");
		assert.equal(h.native.copy, 1);
		h.editor.handleInput(CTRL_X);
		h.editor.handleInput("a");
		await settle();
		h.editor.handleInput(CTRL_X);
		h.editor.handleInput("w");
		await settle();
		assert.equal(calls.openAgentPicker, 1);
		assert.equal(calls.openWorkers, 1);
		h.editor.handleInput(CTRL_X);
		h.editor.handleInput(ESCAPE);
		assert.ok(!h.editor.isLeaderArmed);
		assert.equal(h.native.interrupt, 0);
	});

	it("atelier-first then piastra preserves the frame without nesting editors", async () => {
		const h = makeHarness();
		const token = {};
		assert.equal(installAtelierEditor(h.ctx, token), true);
		assert.ok(h.editor instanceof AtelierEditor);
		assert.equal(frameCount(h.editor, 80), 1);

		const pi = fakePi();
		const { calls, actions } = countingActions();
		installShortcuts(pi, actions);
		await pi.emit("session_start", { reason: "startup" }, h.ctx);
		assert.ok(h.editor instanceof PiastraEditor);
		assert.ok(!(h.editor instanceof AtelierEditor));
		assert.equal(h.editor.getPresentations().length, 1);
		assert.equal(frameCount(h.editor, 80), 1);

		h.editor.handleInput(SHIFT_TAB);
		await settle();
		assert.equal(calls.cycleAgents, 1);
		h.editor.handleInput(CTRL_T);
		assert.equal(h.native.thinkCycle, 1);
	});

	it("leader m opens the native model picker with either editor startup order", async () => {
		for (const atelierFirst of [false, true]) {
			const h = makeHarness();
			let selections = 0;
			h.defaultEditor.actionHandlers.set("app.model.select", () => selections++);
			const token = {};
			if (atelierFirst) installAtelierEditor(h.ctx, token);
			const pi = fakePi();
			installShortcuts(pi, countingActions().actions);
			await pi.emit("session_start", {}, h.ctx);
			if (!atelierFirst) installAtelierEditor(h.ctx, token);
			h.editor.handleInput(CTRL_X);
			h.editor.handleInput("m");
			assert.equal(selections, 1);
			assert.equal(h.editor.isLeaderArmed, false);
			assert.equal(h.editor.getText(), "");
			assert.equal(frameCount(h.editor, 80), 1);
			h.editor.dispose();
		}
	});

	it("repeated atelier enable with the same token never nests frames", () => {
		const h = makeHarness();
		const token = {};
		assert.equal(installAtelierEditor(h.ctx, token), true);
		const firstFactory = h.ui.getEditorComponent();
		assert.equal(installAtelierEditor(h.ctx, token), true);
		assert.equal(installAtelierEditor(h.ctx, token), true);
		// Same-token enable is a no-op: factory identity and one frame only.
		assert.equal(h.ui.getEditorComponent(), firstFactory);
		assert.equal(frameCount(h.editor, 80), 1);
	});

	it("disable then re-enable leaves shortcuts intact (standalone + composed)", () => {
		const h = makeHarness();
		const token = {};
		assert.equal(installAtelierEditor(h.ctx, token), true);
		assert.ok(h.editor instanceof AtelierEditor);
		clearAtelierEditor(h.ctx, token);
		assert.ok(h.editor instanceof CustomEditor);
		assert.ok(!(h.editor instanceof AtelierEditor));
		assert.equal(h.ui.getEditorComponent(), undefined);
		assert.equal(installAtelierEditor(h.ctx, token), true);
		assert.ok(h.editor instanceof AtelierEditor);
		assert.equal(frameCount(h.editor, 80), 1);
	});

	it("fresh piastra session_start rebuild retains the frame; token removal peels it but keeps shortcuts", async () => {
		const h = makeHarness();
		const pi = fakePi();
		const { calls, actions } = countingActions();
		installShortcuts(pi, actions);
		await pi.emit("session_start", { reason: "startup" }, h.ctx);
		const token = {};
		assert.equal(installAtelierEditor(h.ctx, token), true);
		const composed = h.editor;
		assert.ok(composed instanceof PiastraEditor);

		// Fresh session (e.g. /reload): same ui, new ctx; rebuild must retain the frame.
		const freshCtx = { mode: "tui", ui: h.ui };
		await pi.emit("session_start", { reason: "reload" }, freshCtx);
		assert.ok(h.editor instanceof PiastraEditor);
		assert.notEqual(h.editor, composed);
		assert.equal(h.editor.getPresentations().length, 1);
		assert.equal(frameCount(h.editor, 80), 1);

		// Token removal peels the frame but keeps the shortcut editor.
		clearAtelierEditor(freshCtx, token);
		assert.ok(h.editor instanceof PiastraEditor);
		assert.equal(h.editor.getPresentations().length, 0);
		assert.equal(frameCount(h.editor, 80), 0);
		h.editor.handleInput(SHIFT_TAB);
		await settle();
		assert.equal(calls.cycleAgents, 1);
		h.editor.handleInput(CTRL_T);
		assert.equal(h.native.thinkCycle, 1);
	});

	it("tree navigation cancels the leader but retains typing and shortcuts on the same editor", async () => {
		for (const withAtelier of [false, true]) {
			const h = makeHarness();
			const pi = fakePi();
			const { calls, actions } = countingActions();
			installShortcuts(pi, actions);
			await pi.emit("session_start", {}, h.ctx);
			if (withAtelier) installAtelierEditor(h.ctx, {});
			const editor = h.editor;
			editor.handleInput(CTRL_X);
			await pi.emit("session_tree", {}, h.ctx);
			assert.equal(h.editor, editor);
			assert.equal(editor.isLeaderArmed, false);
			editor.handleInput("still typing");
			assert.equal(editor.getText(), "still typing");
			editor.handleInput(SHIFT_TAB);
			editor.handleInput(CTRL_T);
			editor.handleInput(CTRL_X);
			editor.handleInput("w");
			await settle();
			assert.equal(calls.cycleAgents, 1);
			assert.equal(calls.openWorkers, 1);
			assert.equal(h.native.thinkCycle, 1);
			editor.dispose();
		}
	});

	it("stale token and foreign-factory cleanup never clobber another editor", async () => {
		const h = makeHarness();
		const pi = fakePi();
		installShortcuts(pi, countingActions().actions);
		await pi.emit("session_start", { reason: "startup" }, h.ctx);
		const token = {};
		assert.equal(installAtelierEditor(h.ctx, token), true);
		const composedFactory = h.ui.getEditorComponent();
		const composedEditor = h.editor;

		clearAtelierEditor(h.ctx, {});
		assert.equal(h.ui.getEditorComponent(), composedFactory);
		assert.equal(h.editor, composedEditor);

		// Foreign factory (no capability metadata): atelier refuses, piastra warns + skips.
		const foreign = (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings);
		h.ui.setEditorComponent(foreign);
		const foreignFactory = h.ui.getEditorComponent();
		const foreignEditor = h.editor;
		assert.equal(installAtelierEditor(h.ctx, {}), false);
		assert.equal(h.ui.getEditorComponent(), foreignFactory);
		clearAtelierEditor(h.ctx, {});
		assert.equal(h.ui.getEditorComponent(), foreignFactory);
		assert.equal(h.editor, foreignEditor);
		const before = h.factories.length;
		await pi.emit("session_start", { reason: "reload" }, { mode: "tui", ui: h.ui });
		assert.equal(h.factories.length, before);
		assert.ok(h.notified.some(([message, kind]) => kind === "warning" && message.includes("shortcuts not installed")));
	});

	it("unsupported capability metadata is ignored by both installers", async () => {
		const h = makeHarness();
		const badVersion = (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings);
		Object.defineProperty(badVersion, "editorCapability", {
			value: { id: "piastra.shortcuts", version: 999, readPresentations: () => [] },
		});
		h.ui.setEditorComponent(badVersion);
		assert.equal(installAtelierEditor(h.ctx, {}), false);
		const pi = fakePi();
		installShortcuts(pi, countingActions().actions);
		const before = h.factories.length;
		await pi.emit("session_start", { reason: "startup" }, h.ctx);
		assert.equal(h.factories.length, before);

		const wrongId = (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings);
		Object.defineProperty(wrongId, "editorCapability", {
			value: { id: "some.other.editor", version: 1, readPresentations: () => [] },
		});
		h.ui.setEditorComponent(wrongId);
		assert.equal(installAtelierEditor(h.ctx, {}), false);
	});

	it("text and native extension-shortcut aliases pass through composition", async () => {
		const h = makeHarness();
		const pi = fakePi();
		installShortcuts(pi, countingActions().actions);
		await pi.emit("session_start", { reason: "startup" }, h.ctx);
		h.editor.handleInput("h");
		h.editor.handleInput("i");
		assert.equal(h.editor.getText(), "hi");

		const token = {};
		assert.equal(installAtelierEditor(h.ctx, token), true);
		// Text survives the Pi-style editor swap.
		assert.equal(h.editor.getText(), "hi");
		// Native ctrl+shift+a alias still routes via the copied onExtensionShortcut.
		h.editor.handleInput("\x1b[97;6u");
		assert.equal(h.alias.extensionShortcut, 1);
		assert.equal(h.editor.getText(), "hi");
		// Armed leader disarms and falls through to the same alias wiring.
		h.editor.handleInput(CTRL_X);
		h.editor.handleInput("\x1b[97;6u");
		assert.ok(!h.editor.isLeaderArmed);
		await settle();
		assert.equal(h.alias.extensionShortcut, 2);
	});

	it("standalone atelier frame render stays width-safe", () => {
		const h = makeHarness();
		const token = {};
		assert.equal(installAtelierEditor(h.ctx, token), true);
		for (const width of [80, 20, 8, 6]) {
			for (const line of h.editor.render(width)) assert.ok(visibleWidth(line) <= width);
		}
		assert.equal(frameCount(h.editor, 80), 1);
	});

	it("composed frame + leader hint: hint stays visible within width (frame never eats it)", async () => {
		const h = makeHarness();
		const pi = fakePi();
		installShortcuts(pi, countingActions().actions);
		await pi.emit("session_start", { reason: "startup" }, h.ctx);
		const token = {};
		assert.equal(installAtelierEditor(h.ctx, token), true);
		assert.ok(!plainRender(h.editor, 80).includes(LEADER_HINT.trim()));
		h.editor.handleInput(CTRL_X);
		assert.ok(h.editor.isLeaderArmed);
		const armed = h.editor.render(80);
		for (const line of armed) assert.ok(visibleWidth(line) <= 80);
		assert.ok(stripTerminalSequences(armed.join("\n")).includes(LEADER_HINT.trim()));
		assert.equal(frameCount(h.editor, 80), 1);
		// Narrow widths never throw and stay bounded (frame skipped below min width).
		for (const width of [5, 4, 2]) {
			for (const line of h.editor.render(width)) assert.ok(visibleWidth(line) <= width);
		}
		h.editor.dispose();
	});

	it("native TUI overlay focus routes Shift+Tab away from shortcuts and disarms the leader", async () => {
		const h = makeHarness();
		const pi = fakePi();
		const { calls, actions } = countingActions();
		installShortcuts(pi, actions);
		await pi.emit("session_start", {}, h.ctx);
		installAtelierEditor(h.ctx, {});
		const tui = new TuiMainScreen({ columns: 80, rows: 24, hideCursor() {} });
		// Exercise native focus and input routing without scheduling terminal output.
		tui.requestRender = () => {};
		tui.requestImmediateRender = () => {};
		tui.setFocus(h.editor);
		tui.handleTerminalInput(CTRL_X);
		assert.equal(h.editor.isLeaderArmed, true);
		let overlayInputs = 0;
		const overlay = { focused: false, render: () => ["workers"], invalidate() {},
			handleInput(data) { if (data === SHIFT_TAB) overlayInputs++; } };
		const handle = tui.showOverlay(overlay);
		assert.equal(h.editor.isLeaderArmed, false);
		tui.handleTerminalInput(SHIFT_TAB);
		await settle();
		assert.equal(overlayInputs, 1);
		assert.equal(calls.cycleAgents, 0);
		handle.hide();
		assert.equal(h.editor.focused, true);
		tui.handleTerminalInput(SHIFT_TAB);
		await settle();
		assert.equal(calls.cycleAgents, 1);
		h.editor.dispose();
	});

	it("basic focus routing without real TUI: blur and dispose cancel the leader", async () => {
		const h = makeHarness();
		const pi = fakePi();
		installShortcuts(pi, countingActions().actions);
		await pi.emit("session_start", { reason: "startup" }, h.ctx);
		const token = {};
		assert.equal(installAtelierEditor(h.ctx, token), true);
		h.editor.handleInput(CTRL_X);
		assert.ok(h.editor.isLeaderArmed);
		h.editor.focused = false;
		assert.ok(!h.editor.isLeaderArmed);
		h.editor.handleInput(CTRL_X);
		assert.ok(h.editor.isLeaderArmed);
		h.editor.dispose();
		assert.ok(!h.editor.isLeaderArmed);
		h.editor.handleInput(CTRL_X);
		assert.ok(!h.editor.isLeaderArmed);
	});
});
