/**
 * Regression tests for the managed Dispatch footer tip.
 * Tests the ACTUAL renderFooterLine from src/footer.ts (loaded via Pi's own
 * jiti extension loader, same pattern as footer-agent-label.test.mjs) plus
 * the ACTUAL vendored extension entry (extensions/pi-atelier/extensions/index.ts)
 * driving a stub UI harness with a mutable getCommands stub.
 *
 * Contract:
 * - FooterState.dispatchHelpAvailable (optional boolean) derived per render in
 *   the extension getState by reading pi.getCommands() and requiring
 *   name === "dispatch-help" AND source === "extension".
 * - Tip "Tip: run /dispatch-help" renders immediately after model+thinking,
 *   only when the model segment is visible with an actual modelId.
 * - Muted palette, identical text in compact density, droppable before
 *   model+thinking on narrow terminals. Missing API/errors => false; retired
 *   footers never retain the tip.
 *
 * Run: node --test extensions/pi-atelier/tests/footer-dispatch-tip.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripTerminalSequences as strip, visibleWidth } from "@earendil-works/pi-tui";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const footerPath = path.join(repoRoot, "extensions", "pi-atelier", "src", "footer.ts");
const typesPath = path.join(repoRoot, "extensions", "pi-atelier", "src", "types.ts");
const atelierIndex = path.join(repoRoot, "extensions", "pi-atelier", "extensions", "index.ts");
const piastraIndex = path.join(repoRoot, "extensions", "piastra", "index.ts");

const TIP = "Tip: run /dispatch-help";

const COLORS = { accent: 35, success: 32, mdHeading: 33, thinkingLow: 34, thinkingMedium: 94, warning: 93, error: 31 };
const theme = {
	fg: (color, text) => `\x1b[${COLORS[color] ?? 37}m${text}\x1b[0m`,
	bold: (t) => t,
	italic: (t) => t,
};
const metrics = () => ({
	usageAvailable: false, costAvailable: false, input: 0, output: 0, cacheRead: 0,
	cacheWrite: 0, cost: 0, subscription: false, contextTokens: null,
	contextWindow: 0, contextPercent: null, autoCompact: null,
});
const state = (over = {}) => ({
	activity: "ready", dirty: false, workspacePulse: { status: "not-repo" },
	modelId: "test-model", thinkingLevel: "low",
	metrics: metrics(), extensionStatuses: [], ...over,
});

// Load real footer.ts + types.ts through Pi's jiti loader.
const agentDir = await mkdtemp(path.join(tmpdir(), "footer-tip-agent-"));
const cwd = await mkdtemp(path.join(tmpdir(), "footer-tip-cwd-"));
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const fixture = path.join(cwd, "probe.ts");
await writeFile(
	fixture,
	"import { renderFooterLine, createFooterComponent } from " + JSON.stringify(pathToFileURL(footerPath).href) + ";\n" +
	"import { DEFAULT_CONFIG } from " + JSON.stringify(pathToFileURL(typesPath).href) + ";\n" +
	"export default function (pi) {\n" +
	"  pi.registerCommand(\"probe\", { description: \"probe\", handler: async (args, ctx) => {\n" +
	"    ctx.capture = { renderFooterLine, createFooterComponent, DEFAULT_CONFIG };\n" +
	"  }});\n" +
	"}\n",
);
const piEntryUrl = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { loadExtensions, createExtensionRuntime } = await import(
	new URL("./core/extensions/loader.js", piEntryUrl).href
);
const loaded = await loadExtensions([fixture], cwd);
assert.deepEqual(loaded.errors, []);
const probeCtx = {};
await loaded.extensions.find((e) => e.path === fixture).commands.get("probe").handler("", probeCtx);
const { renderFooterLine, DEFAULT_CONFIG } = probeCtx.capture;
after(async () => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	await rm(agentDir, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

const line = (st, cfg = DEFAULT_CONFIG, width = 160, dots) =>
	renderFooterLine(st, cfg, theme, width, true, dots);

test("tip present with exact text immediately after model and thinking", () => {
	const out = strip(line(state({ dispatchHelpAvailable: true })));
	assert.ok(out.includes(TIP), `missing tip: ${out}`);
	const modelIdx = out.indexOf("test-model");
	const thinkIdx = out.indexOf("low");
	const tipIdx = out.indexOf(TIP);
	assert.ok(modelIdx >= 0 && thinkIdx > modelIdx && tipIdx > thinkIdx,
		`tip must follow model+thinking: ${out}`);
});

test("no tip without the flag, with false, or with legacy signals only", () => {
	assert.ok(!strip(line(state())).includes(TIP));
	assert.ok(!strip(line(state({ dispatchHelpAvailable: false }))).includes(TIP));
	// Legacy statuses / model names alone are never enough.
	assert.ok(!strip(line(state({ extensionStatuses: ["Agent: orchestrator"] }))).includes(TIP));
	assert.ok(!strip(line(state({ modelId: "dispatch-model", extensionStatuses: ["Agent: general"] }))).includes(TIP));
});

test("no tip when the model segment is hidden or there is no model", () => {
	const hidden = { ...DEFAULT_CONFIG, segmentLayout: DEFAULT_CONFIG.segmentLayout.map((e) => e.id === "model" ? { ...e, visible: false } : e) };
	assert.ok(!strip(line(state({ dispatchHelpAvailable: true }), hidden)).includes(TIP));
	assert.ok(!strip(line(state({ dispatchHelpAvailable: true, modelId: undefined }))).includes(TIP));
	assert.ok(!strip(line(state({ dispatchHelpAvailable: true, modelId: "" }))).includes(TIP));
	// Tip may show without a thinking level as long as a model is present.
	assert.ok(strip(line(state({ dispatchHelpAvailable: true, thinkingLevel: undefined }))).includes(TIP));
});

test("tip appears exactly once", () => {
	const out = strip(line(state({ dispatchHelpAvailable: true })));
	assert.equal(out.split(TIP).length - 1, 1, `duplicated tip: ${out}`);
});

test("tip text identical in compact density with muted color", () => {
	const compact = { ...DEFAULT_CONFIG, density: "compact" };
	for (const cfg of [DEFAULT_CONFIG, compact]) {
		const out = line(state({ dispatchHelpAvailable: true }), cfg);
		assert.ok(strip(out).includes(TIP), `missing tip (${cfg.density})`);
		assert.ok(out.includes(`\x1b[37m${TIP}`), `tip must use muted palette (${cfg.density}): ${JSON.stringify(out)}`);
	}
	const noColor = renderFooterLine(state({ dispatchHelpAvailable: true }), DEFAULT_CONFIG, theme, 160, false);
	assert.ok(strip(noColor).includes(TIP), "tip must survive no-color mode");
});

test("tip drops before model+thinking on narrow terminals; warning/error retained", () => {
	const wide = strip(line(state({ activity: "warning", dispatchHelpAvailable: true }), DEFAULT_CONFIG, 160));
	assert.ok(wide.includes(TIP) && wide.includes("WARNING"), wide);
	// Tip is droppable before model+thinking: at the first width where the tip
	// drops, model and thinking must still be present, and nothing overflows.
	let droppedAt = -1;
	for (let w = 160; w >= 20; w -= 2) {
		const narrow = strip(line(state({ dispatchHelpAvailable: true }), DEFAULT_CONFIG, w));
		assert.ok(visibleWidth(line(state({ dispatchHelpAvailable: true }), DEFAULT_CONFIG, w)) <= w, `overflow at ${w}`);
		if (!narrow.includes(TIP)) { droppedAt = w; break; }
	}
	assert.ok(droppedAt > 0, "tip must drop on narrow terminals");
	const dropped = strip(line(state({ dispatchHelpAvailable: true }), DEFAULT_CONFIG, droppedAt));
	assert.ok(dropped.includes("test-model"), `model must survive the tip at ${droppedAt}: ${dropped}`);
	const errLine = strip(line(state({ activity: "error", dispatchHelpAvailable: true }), DEFAULT_CONFIG, 160));
	assert.ok(errLine.includes("ERROR"), errLine);
});

// --- Actual extension integration: live getCommands derivation ---

function makeUi() {
	const footers = [];
	const notified = [];
	return {
		footers, notified,
		ui: {
			theme: { fg: (_s, t) => t },
			setFooter: (f) => { footers.push(f ?? undefined); },
			notify: (m, k) => { notified.push([m, k]); },
			onTerminalInput: () => () => {},
			custom: () => { throw new Error("unexpected overlay"); },
		},
	};
}
const makeSessionManager = () => ({
	getSessionName: () => undefined, getSessionFile: () => undefined,
	getBranch: () => [], getEntries: () => [],
});
const footerData = (statuses = []) => ({
	getGitBranch: () => undefined,
	getExtensionStatuses: () => new Map(statuses.map((s, i) => [i, s])),
	onBranchChange: () => () => {},
});
const renderFooter = (factory, width = 160) => {
	const tui = { requestRender() {} };
	const comp = factory(tui, theme, footerData([]));
	try {
		return strip(comp.render(width).join("\n"));
	} finally {
		comp.dispose?.();
	}
};

async function loadAtelierWithCommands(commandsRef) {
	const iAgent = await mkdtemp(path.join(tmpdir(), "tip-int-agent-"));
	const iCwd = await mkdtemp(path.join(tmpdir(), "tip-int-cwd-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = iAgent;
	await writeFile(path.join(iAgent, "pi-atelier.json"), JSON.stringify({ showSidebarOnStartup: false }));
	const runtime = createExtensionRuntime();
	runtime.getActiveTools = () => [];
	runtime.getAllTools = () => [];
	runtime.getThinkingLevel = () => undefined;
	runtime.getCommands = () => commandsRef.current;
	const result = await loadExtensions([atelierIndex], iCwd, undefined, runtime);
	assert.deepEqual(result.errors, []);
	const ext = result.extensions.find((e) => e.path === atelierIndex);
	assert.ok(ext);
	const ui = makeUi();
	const sessionManager = makeSessionManager();
	const ctx = {
		mode: "tui", cwd: iCwd, ui: ui.ui, sessionManager,
		getContextUsage: () => undefined, model: { id: "live-model", provider: "test" },
		modelRegistry: { isUsingOAuth: () => false },
		isProjectTrusted: () => false, isIdle: () => true,
	};
	for (const h of ext.handlers.get("session_start") ?? []) await h({ reason: "startup" }, ctx);
	return {
		ext, ui, ctx, sessionManager, runtime, commandsRef,
		async teardown() {
			// Shut down first so Atelier runtimes/refresh jobs/footer timers are
			// disposed before tempdirs vanish; best-effort so cleanup never masks
			// the test result, and the env restore always runs in finally.
			try {
				for (const h of ext.handlers.get("session_shutdown") ?? []) {
					try {
						await h({ reason: "shutdown" }, ctx);
					} catch {
						// Session teardown is best-effort during test cleanup.
					}
				}
			} finally {
				try {
					if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
					else process.env.PI_CODING_AGENT_DIR = prev;
				} finally {
					await rm(iAgent, { recursive: true, force: true });
					await rm(iCwd, { recursive: true, force: true });
				}
			}
		},
	};
}

test("integration: tip follows live getCommands true/false without reload; legacy statuses insufficient", async () => {
	const commandsRef = { current: [] };
	const env = await loadAtelierWithCommands(commandsRef);
	try {
		assert.ok(env.ui.footers.length >= 1, "footer installed");
		const factory = env.ui.footers[env.ui.footers.length - 1];
		// Legacy Agent status alone: no tip.
		let out = renderFooter(factory);
		assert.ok(!out.includes(TIP), `legacy status must not imply tip: ${out}`);
		// Provider appears later (either load order): next render shows the tip.
		commandsRef.current = [{ name: "dispatch-help", source: "extension", description: "help" }];
		out = renderFooter(factory);
		assert.ok(out.includes(TIP), `tip must appear once dispatch-help registers: ${out}`);
		assert.ok(out.indexOf(TIP) > out.indexOf("live-model"), `tip after model: ${out}`);
		// Provider unloads: tip disappears on the next render.
		commandsRef.current = [];
		out = renderFooter(factory);
		assert.ok(!out.includes(TIP), `tip must vanish when dispatch-help unloads: ${out}`);
		// Only the extension command counts: prompt/skill/builtin/default sources,
		// a missing source, skill namespacing, and near-miss names are rejected.
		for (const entry of [
			{ name: "dispatch-help", source: "prompt" },
			{ name: "dispatch-help", source: "skill" },
			{ name: "skill:dispatch-help", source: "skill" },
			{ name: "dispatch-help", source: "builtin" },
			{ name: "dispatch-help", source: "default" },
			{ name: "dispatch-help" },
			{ name: "dispatch", source: "extension" },
			{ name: "dispatch-help:2", source: "extension" },
		]) {
			commandsRef.current = [entry];
			assert.ok(!renderFooter(factory).includes(TIP), `namesake must not imply tip: ${JSON.stringify(entry)}`);
		}
	} finally {
		await env.teardown();
	}
});

test("integration: throwing/missing getCommands means no tip; stale footer never retains it", async () => {
	const commandsRef = { current: [{ name: "dispatch-help", source: "extension", description: "help" }] };
	const env = await loadAtelierWithCommands(commandsRef);
	try {
		const factory = env.ui.footers[env.ui.footers.length - 1];
		assert.ok(renderFooter(factory).includes(TIP));
		const listImpl = env.runtime.getCommands;
		// A throwing catalog reads as unavailable on every render.
		env.runtime.getCommands = () => { throw new Error("catalog boom"); };
		assert.ok(!renderFooter(factory).includes(TIP), "throwing getCommands must mean no tip");
		// A truly absent catalog (deleted, not just null) also reads as unavailable.
		delete env.runtime.getCommands;
		assert.ok(!renderFooter(factory).includes(TIP), "missing getCommands must mean no tip");
		env.runtime.getCommands = undefined;
		assert.ok(!renderFooter(factory).includes(TIP), "undefined getCommands must mean no tip");
		// Non-array results are equally false.
		env.runtime.getCommands = () => null;
		assert.ok(!renderFooter(factory).includes(TIP), "null catalog must mean no tip");
		env.runtime.getCommands = () => ({ nope: true });
		assert.ok(!renderFooter(factory).includes(TIP), "object catalog must mean no tip");
		// Restore the list projection: in-place catalog mutations (not reloads)
		// drive the tip on the next render.
		env.runtime.getCommands = listImpl;
		assert.ok(renderFooter(factory).includes(TIP));
		commandsRef.current.splice(0, commandsRef.current.length);
		assert.ok(!renderFooter(factory).includes(TIP), "removing the entry must hide the tip");
		commandsRef.current.push({ name: "dispatch-help", source: "extension", description: "help" });
		assert.ok(renderFooter(factory).includes(TIP), "re-adding the entry must restore the tip");
		// Retire the session: the outlived footer reports inert state without the tip.
		for (const h of env.ext.handlers.get("session_shutdown") ?? []) await h({ reason: "shutdown" }, env.ctx);
		commandsRef.current = [{ name: "dispatch-help", source: "extension" }];
		const stale = renderFooter(factory);
		assert.ok(!stale.includes(TIP), `retired footer must not retain tip: ${stale}`);
		assert.ok(!stale.includes("live-model"), `retired footer must not retain model: ${stale}`);
	} finally {
		await env.teardown();
	}
});

// --- Production catalog proof: real piastra registration in both load orders ---

// Derive getCommands from the REAL registered command maps of both extensions
// loaded together via Pi's own loader (no session or model requests), mirroring
// agent-session's { name: invocationName, source: "extension" } projection (no
// duplicate names here, so invocationName === name).
async function loadAtelierWithPiastra(first, second) {
	const iAgent = await mkdtemp(path.join(tmpdir(), "tip-cat-agent-"));
	const iCwd = await mkdtemp(path.join(tmpdir(), "tip-cat-cwd-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = iAgent;
	await writeFile(path.join(iAgent, "pi-atelier.json"), JSON.stringify({ showSidebarOnStartup: false }));
	const runtime = createExtensionRuntime();
	runtime.getActiveTools = () => [];
	runtime.getAllTools = () => [];
	runtime.getThinkingLevel = () => undefined;
	const result = await loadExtensions([first, second], iCwd, undefined, runtime);
	assert.deepEqual(result.errors, []);
	runtime.getCommands = () =>
		result.extensions.flatMap((e) => [...e.commands.keys()].map((name) => ({ name, source: "extension" })));
	const ext = result.extensions.find((e) => e.path === atelierIndex);
	assert.ok(ext);
	const ui = makeUi();
	const sessionManager = makeSessionManager();
	const ctx = {
		mode: "tui", cwd: iCwd, ui: ui.ui, sessionManager,
		getContextUsage: () => undefined, model: { id: "live-model", provider: "test" },
		modelRegistry: { isUsingOAuth: () => false },
		isProjectTrusted: () => false, isIdle: () => true,
	};
	// Only the atelier session_start runs: piastra registration already happened
	// at load, and its session handlers (worker panels/guards) are out of scope.
	for (const h of ext.handlers.get("session_start") ?? []) await h({ reason: "startup" }, ctx);
	return {
		ext, ui, ctx, result, runtime,
		async teardown() {
			try {
				for (const e of result.extensions) {
					for (const h of e.handlers.get("session_shutdown") ?? []) {
						try {
							await h({ reason: "shutdown" }, ctx);
						} catch {
							// Session teardown is best-effort during test cleanup.
						}
					}
				}
			} finally {
				try {
					if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
					else process.env.PI_CODING_AGENT_DIR = prev;
				} finally {
					await rm(iAgent, { recursive: true, force: true });
					await rm(iCwd, { recursive: true, force: true });
				}
			}
		},
	};
}

for (const order of [[piastraIndex, atelierIndex], [atelierIndex, piastraIndex]]) {
	const label = order[0] === piastraIndex ? "piastra-first" : "atelier-first";
	test(`production catalog: real piastra dispatch-help drives the tip (${label})`, async () => {
		const env = await loadAtelierWithPiastra(order[0], order[1]);
		try {
			const names = env.result.extensions.flatMap((e) => [...e.commands.keys()]);
			assert.ok(names.includes("dispatch-help"), `piastra must register dispatch-help: ${names}`);
			assert.ok(env.ui.footers.length >= 1, "footer installed");
			const factory = env.ui.footers[env.ui.footers.length - 1];
			const out = renderFooter(factory);
			assert.ok(out.includes(TIP), `tip must show against the real catalog: ${out}`);
			// Without the real entry the same footer hides the tip.
			env.runtime.getCommands = () =>
				env.result.extensions
					.flatMap((e) => [...e.commands.keys()])
					.filter((name) => name !== "dispatch-help")
					.map((name) => ({ name, source: "extension" }));
			assert.ok(!renderFooter(factory).includes(TIP), "tip must vanish without dispatch-help");
		} finally {
			await env.teardown();
		}
	});
}
