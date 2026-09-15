/**
 * Real extension lifecycle integration test: PiAstra shortcuts x Pi Atelier.
 *
 * Unlike tests/editor-cooperation.test.mjs (which imports the editor helpers
 * directly), this test exercises the ACTUAL vendored extension entry point
 * extensions/pi-atelier/extensions/index.ts through Pi's own jiti extension
 * loader (the same loadExtensions URL path as the installer smoke test in
 * scripts/install-cli.test.mjs), then drives the loaded Extension's real
 * handlers map (session_start / session_shutdown / atelier command) against
 * a stub UI harness. PiAstra's side uses the real production
 * installShortcuts factory from extensions/piastra/shortcuts.ts.
 *
 * Covered:
 * - real Atelier startup installs a composed editor (single PiastraEditor
 *   carrying the Atelier frame; every PiAstra mapping + native fallback works)
 * - /atelier disable + enable retains shortcuts (frame peels / restores)
 * - session_shutdown in BOTH handler orders, then restart: no stale editor
 *   reconstruction (old factory is retired, fresh editor has exactly one frame)
 *
 * Isolation: temp agentDir (PI_CODING_AGENT_DIR) + temp cwd; no providers,
 * no global config, no TUI terminal. The stub ui provides setFooter,
 * get/setEditorComponent (Pi-style swap), notify, theme, onTerminalInput;
 * ctx.ui.custom throws so any unexpected overlay (e.g. sidebar shown at
 * startup) fails loudly instead of hanging. The stub sessionManager +
 * getUsage surface is enough for startup; the loader runtime's
 * getActiveTools/getAllTools are stubbed to [] so sidebar snapshots never
 * touch the unbound extension runtime.
 *
 * Run: node --experimental-strip-types --test extensions/pi-atelier/tests/shortcut-lifecycle.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { installShortcuts, PiastraEditor } from "../../piastra/shortcuts.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const atelierIndex = path.join(repoRoot, "extensions", "pi-atelier", "extensions", "index.ts");

const SHIFT_TAB = "[Z";
const CTRL_X = "";
const CTRL_T = "";
const CTRL_O = "";
const ESCAPE = "";

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

/**
 * Mimics pi interactive-mode setCustomEditorComponent semantics: save text,
 * blur the old editor, construct the new editor via the factory, copy native
 * actionHandlers + default onExtensionShortcut alias wiring, focus the new one.
 * Plus footer capture, onTerminalInput, and a custom() that throws so any
 * unexpected overlay (sidebar shown at startup) fails loudly.
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
		footers: [],
		editor: defaultEditor,
		defaultEditor,
		ctx: null,
	};
	const ui = {
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
		setFooter: (factory) => { harness.footers.push(factory ?? undefined); },
		notify: (message, kind) => { notified.push([message, kind]); },
		onTerminalInput: () => () => {},
		custom: () => { throw new Error("unexpected overlay in lifecycle test (sidebar must stay hidden)"); },
	};
	harness.ui = ui;
	return harness;
}

const makeSessionManager = () => ({
	getSessionName: () => undefined,
	getSessionFile: () => undefined,
	getBranch: () => [],
	getEntries: () => [],
});
const makeCtx = (harness, cwd, sessionManager) => ({
	mode: "tui",
	cwd,
	ui: harness.ui,
	sessionManager,
	// AtelierRuntime reads usage/model surface at construction (refreshUsage).
	getContextUsage: () => undefined,
	model: undefined,
	modelRegistry: { isUsingOAuth: () => false },
	isProjectTrusted: () => false,
	isIdle: () => true,
});

/** Minimal fake ExtensionAPI surface for PiAstra's installShortcuts. */
function fakePiastraPi() {
	const handlers = new Map();
	return {
		handlers,
		on(name, fn) {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
		},
		events: { emit() { return false; }, on: () => () => {} },
	};
}

/** Load the REAL vendored Atelier entry through Pi's own jiti loader. */
async function loadRealAtelier(cwd) {
	const piEntryUrl = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const loaderUrl = new URL("./core/extensions/loader.js", piEntryUrl);
	const { loadExtensions, createExtensionRuntime } = await import(loaderUrl.href);
	const runtime = createExtensionRuntime();
	runtime.getActiveTools = () => [];
	runtime.getAllTools = () => [];
	// AtelierRuntime.refreshUsage() runs at startup and reads the thinking level.
	runtime.getThinkingLevel = () => undefined;
	runtime.getSessionName = () => undefined;
	runtime.getCommands = () => [];
	const result = await loadExtensions([atelierIndex], cwd, undefined, runtime);
	return result;
}

const handlersFor = (map, name) => map.get(name) ?? [];
async function emitAll(map, name, event, ctx) {
	for (const handler of handlersFor(map, name)) await handler(event, ctx);
}

const plainRender = (editor, width) => stripTerminalSequences(editor.render(width).join("\n"));
const frameCount = (editor, width) =>
	plainRender(editor, width).split("\n").filter((line) => line.includes("╭")).length;

async function setup() {
	const agentDir = await mkdtemp(path.join(tmpdir(), "atelier-lifecycle-agent-"));
	const cwd = await mkdtemp(path.join(tmpdir(), "atelier-lifecycle-cwd-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir; // getAgentDir() reads this per call
	// Keep the sidebar hidden at startup so no overlay is ever requested.
	await writeFile(path.join(agentDir, "pi-atelier.json"), JSON.stringify({ showSidebarOnStartup: false }));
	const result = await loadRealAtelier(cwd);
	return {
		agentDir,
		cwd,
		previousAgentDir,
		result,
		async teardown() {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await rm(agentDir, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

function atelierExtFrom(result) {
	assert.deepEqual(result.errors, [], "real Atelier entry must load with zero errors");
	const ext = result.extensions.find((e) => e.path === atelierIndex);
	assert.ok(ext, "vendored Atelier entry should load");
	assert.ok(ext.commands.has("atelier"), "loaded copy registers the /atelier command");
	assert.ok(Array.from(ext.handlers.keys()).includes("session_start"), "loaded copy handles session_start");
	assert.ok(Array.from(ext.handlers.keys()).includes("session_shutdown"), "loaded copy handles session_shutdown");
	return ext;
}

test("real Atelier startup via Pi loader installs composed editor; disable/enable retains shortcuts", async () => {
	const env = await setup();
	try {
		const ext = atelierExtFrom(env.result);
		const harness = makeHarness();
		const piastraPi = fakePiastraPi();
		const { calls, actions } = countingActions();
		installShortcuts(piastraPi, actions);

		const sessionManager = makeSessionManager();
		const ctx = makeCtx(harness, env.cwd, sessionManager);

		// PiAstra first, then real Atelier startup.
		await emitAll(piastraPi.handlers, "session_start", { reason: "startup" }, ctx);
		assert.ok(harness.editor instanceof PiastraEditor, "piastra installs its editor first");
		await emitAll(ext.handlers, "session_start", { reason: "startup" }, ctx);
		assert.deepEqual(
			harness.notified.filter(([, kind]) => kind === "error"),
			[],
			`atelier startup must not error: ${JSON.stringify(harness.notified)}`,
		);

		// Real Atelier startup composed its frame onto the PiAstra editor.
		assert.ok(harness.editor instanceof PiastraEditor, "composed editor stays a PiastraEditor");
		assert.equal(harness.editor.getPresentations().length, 1, "exactly one Atelier frame presentation");
		assert.equal(frameCount(harness.editor, 80), 1, "one frame renders");
		assert.ok(harness.footers.length >= 1, "atelier installs its footer");

		// Shortcuts registered through the real loader extension object.
		assert.ok(ext.shortcuts.has("alt+a"), "atelier registers its configured shortcut");
		assert.ok(ext.shortcuts.has("ctrl+shift+r"), "atelier registers the resize shortcut");

		// Every PiAstra mapping + native fallback works on the composed editor.
		harness.editor.handleInput(SHIFT_TAB);
		await settle();
		assert.equal(calls.cycleAgents, 1, "Shift+Tab still cycles agents");
		assert.equal(harness.native.thinkCycle, 0);
		harness.editor.handleInput(CTRL_T);
		assert.equal(harness.native.thinkCycle, 1, "Ctrl+T still reaches native thinking cycle");
		harness.editor.handleInput(CTRL_O);
		assert.equal(harness.native.expand, 1, "Ctrl+O falls back to native tools expand");
		harness.editor.handleInput(CTRL_X);
		harness.editor.handleInput(ESCAPE);
		assert.ok(!harness.editor.isLeaderArmed, "leader arms and Esc cancels without abort");
		assert.equal(harness.native.interrupt, 0);

		// /atelier disable peels the frame but retains the shortcut editor.
		const command = ext.commands.get("atelier");
		assert.ok(command, "atelier command present");
		await command.handler("disable", ctx);
		assert.ok(harness.editor instanceof PiastraEditor, "disable keeps the PiAstra editor (shortcuts retained)");
		assert.equal(harness.editor.getPresentations().length, 0, "disable peels the Atelier frame");
		assert.equal(frameCount(harness.editor, 80), 0);
		harness.editor.handleInput(SHIFT_TAB);
		await settle();
		assert.equal(calls.cycleAgents, 2, "shortcuts survive disable");
		harness.editor.handleInput(CTRL_T);
		assert.equal(harness.native.thinkCycle, 2);

		// /atelier enable restores the frame without nesting.
		await command.handler("enable", ctx);
		assert.ok(harness.editor instanceof PiastraEditor, "enable restores the composed editor");
		assert.equal(harness.editor.getPresentations().length, 1, "enable restores exactly one frame");
		assert.equal(frameCount(harness.editor, 80), 1);
		harness.editor.handleInput(SHIFT_TAB);
		await settle();
		assert.equal(calls.cycleAgents, 3, "shortcuts survive re-enable");
	} finally {
		await env.teardown();
	}
});

for (const shutdownOrder of ["piastra-first", "atelier-first"]) {
	for (const restartOrder of ["piastra-first", "atelier-first"]) {
		test(`shutdown ${shutdownOrder}, restart startup ${restartOrder}: one frame, no stale reconstruction, disable/enable after restart`, async () => {
			const env = await setup();
			try {
				const ext = atelierExtFrom(env.result);
				const harness = makeHarness();
				const piastraPi = fakePiastraPi();
				const { calls, actions } = countingActions();
				installShortcuts(piastraPi, actions);

				const firstManager = makeSessionManager();
				const firstCtx = makeCtx(harness, env.cwd, firstManager);
				await emitAll(piastraPi.handlers, "session_start", { reason: "startup" }, firstCtx);
				await emitAll(ext.handlers, "session_start", { reason: "startup" }, firstCtx);
				assert.ok(harness.editor instanceof PiastraEditor);
				assert.equal(harness.editor.getPresentations().length, 1);
				const staleEditor = harness.editor;
				const staleFactory = harness.ui.getEditorComponent();

				// Shutdown in the order under test, using the same session ctx so
				// Atelier's session-identity guard matches the active session.
				const shutdownFirst = shutdownOrder === "piastra-first" ? piastraPi.handlers : ext.handlers;
				const shutdownSecond = shutdownOrder === "piastra-first" ? ext.handlers : piastraPi.handlers;
				await emitAll(shutdownFirst, "session_shutdown", { reason: "shutdown" }, firstCtx);
				await emitAll(shutdownSecond, "session_shutdown", { reason: "shutdown" }, firstCtx);

				// Restart on the SAME UI: brand-new session (new ctx + sessionManager),
				// with session_start emitted in the restart order under test. In the
				// atelier-first order the retired Piastra factory receives the new
				// Atelier token via capability metadata (never constructing an
				// editor), and the next Piastra session consumes only current entries.
				const secondManager = makeSessionManager();
				const secondCtx = makeCtx(harness, env.cwd, secondManager);
				const restartFirst = restartOrder === "piastra-first" ? piastraPi.handlers : ext.handlers;
				const restartSecond = restartOrder === "piastra-first" ? ext.handlers : piastraPi.handlers;
				await emitAll(restartFirst, "session_start", { reason: "startup" }, secondCtx);
				await emitAll(restartSecond, "session_start", { reason: "startup" }, secondCtx);
				assert.deepEqual(
					harness.notified.filter(([, kind]) => kind === "error"),
					[],
					`restart must not error: ${JSON.stringify(harness.notified)}`,
				);

				// Fresh composed editor: not the stale instance, exactly one frame,
				// and the retired factory refuses reconstruction.
				assert.ok(harness.editor instanceof PiastraEditor, "restart rebuilds the shortcut editor");
				assert.notEqual(harness.editor, staleEditor, "restart does not reuse the stale editor");
				assert.equal(harness.editor.getPresentations().length, 1, "restart composes exactly one frame");
				assert.equal(frameCount(harness.editor, 80), 1, "no nested frames after restart");
				assert.throws(
					() => staleFactory(harness.tui, harness.theme, harness.keybindings),
					/retired session/,
					"stale factory must refuse reconstruction",
				);

				// Shortcuts work on the restarted session.
				harness.editor.handleInput(SHIFT_TAB);
				await settle();
				assert.equal(calls.cycleAgents, 1, "Shift+Tab works after restart");
				harness.editor.handleInput(CTRL_T);
				assert.equal(harness.native.thinkCycle, 1, "native fallback works after restart");

				// /atelier disable removes the CURRENT session's frame (0 entries)
				// while keeping the shortcut editor; re-enable restores exactly one.
				const command = ext.commands.get("atelier");
				assert.ok(command, "atelier command present");
				await command.handler("disable", secondCtx);
				assert.ok(harness.editor instanceof PiastraEditor, "disable keeps the PiAstra editor");
				assert.equal(harness.editor.getPresentations().length, 0, "disable removes the current frame");
				assert.equal(frameCount(harness.editor, 80), 0, "no frame after disable");
				harness.editor.handleInput(SHIFT_TAB);
				await settle();
				assert.equal(calls.cycleAgents, 2, "shortcuts survive post-restart disable");
				await command.handler("enable", secondCtx);
				assert.ok(harness.editor instanceof PiastraEditor, "enable restores the composed editor");
				assert.equal(harness.editor.getPresentations().length, 1, "re-enable restores exactly one frame");
				assert.equal(frameCount(harness.editor, 80), 1, "re-enable does not nest frames");

				// Second shutdown cycle (same order) stays clean: no errors, no throws.
				await emitAll(shutdownFirst, "session_shutdown", { reason: "shutdown" }, secondCtx);
				await emitAll(shutdownSecond, "session_shutdown", { reason: "shutdown" }, secondCtx);
				assert.deepEqual(
					harness.notified.filter(([, kind]) => kind === "error"),
					[],
					`second shutdown must not error: ${JSON.stringify(harness.notified)}`,
				);
			} finally {
				await env.teardown();
			}
		});
	}
}
