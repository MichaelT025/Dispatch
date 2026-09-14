/**
 * Regression tests for the port of the audited pre-fork
 * agent-label patch. Tests the ACTUAL renderFooterLine/createFooterComponent
 * from src/footer.ts (loaded via Pi's own jiti extension loader, same URL
 * pattern as scripts/install-cli.test.mjs) — never synthetic extracted code.
 *
 * Expected behavior:
 * - known plain status /^Agent: (orchestrator|general|fast|review)$/ replaces
 *   the READY/workingLabel text with the UPPERCASE role, keeping working dots
 *   and agent-specific colors (warning/error activity colors take precedence);
 * - WARNING/ERROR append "ROLE · WARNING/ERROR";
 * - missing/unrelated/unknown Agent statuses fall back to existing labels.
 *
 * Run: node --test extensions/pi-atelier/tests/footer-agent-label.test.mjs
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
const ROLES = ["orchestrator", "general", "fast", "review"];

const COLORS = { accent: 35, success: 32, mdHeading: 33, thinkingLow: 34, warning: 93, error: 31 };
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
	metrics: metrics(), extensionStatuses: [], ...over,
});

// Load the real footer.ts through Pi's jiti loader: a temp fixture extension
// imports footer.ts + types.ts by absolute file URL and exposes them via a
// temporary command handler's ctx.capture. Temp agentDir/cwd only; the real
// config is never touched and no dependency is introduced.
const agentDir = await mkdtemp(path.join(tmpdir(), "footer-label-agent-"));
const cwd = await mkdtemp(path.join(tmpdir(), "footer-label-cwd-"));
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
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", piEntryUrl).href);
const loaded = await loadExtensions([fixture], cwd);
assert.deepEqual(loaded.errors, []);
const probeCtx = {};
await loaded.extensions.find((e) => e.path === fixture).commands.get("probe").handler("", probeCtx);
const { renderFooterLine, createFooterComponent, DEFAULT_CONFIG } = probeCtx.capture;
after(async () => {
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	await rm(agentDir, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

const line = (st, cfg = DEFAULT_CONFIG, width = 120, dots) =>
	renderFooterLine(st, cfg, theme, width, true, dots);

for (const role of ROLES) {
	const ROLE = role.toUpperCase();
	test(`ready shows uppercase ${ROLE} instead of READY`, () => {
		const out = line(state({ activity: "ready", extensionStatuses: [`Agent: ${role}`] }));
		assert.ok(out.includes(ROLE), `missing ${ROLE}: ${strip(out)}`);
		assert.ok(!strip(out).includes("READY"), `READY not replaced: ${strip(out)}`);
	});
	test(`working shows uppercase ${ROLE} with dots instead of workingLabel`, () => {
		const out = line(state({ activity: "working", workingLabel: "Crunching", extensionStatuses: [`Agent: ${role}`] }));
		const plain = strip(out);
		assert.ok(plain.includes(`${ROLE}...`), `missing ${ROLE} with dots: ${plain}`);
		assert.ok(!plain.includes("Crunching") && !plain.includes("WORKING"), `workingLabel leaked: ${plain}`);
	});
	test(`warning/error append ${ROLE} · WARNING/ERROR`, () => {
		for (const activity of ["warning", "error"]) {
			const out = strip(line(state({ activity, extensionStatuses: [`Agent: ${role}`] })));
			assert.ok(out.includes(`${ROLE} · ${activity.toUpperCase()}`), `missing suffix: ${out}`);
		}
	});
}

test("ready/working role label in comfortable and compact density", () => {
	const compact = { ...DEFAULT_CONFIG, density: "compact" };
	for (const cfg of [DEFAULT_CONFIG, compact]) {
		assert.ok(line(state({ activity: "ready", extensionStatuses: ["Agent: fast"] }), cfg).includes("FAST"));
		assert.ok(strip(line(state({ activity: "working", extensionStatuses: ["Agent: fast"] }), cfg)).includes("FAST"));
	}
});

test("missing/unrelated/unknown Agent status falls back (incl. workingLabel)", () => {
	assert.ok(strip(line(state({ activity: "ready" }))).includes("READY"));
	assert.ok(strip(line(state({ activity: "ready", extensionStatuses: ["Build ok"] }))).includes("READY"));
	assert.ok(strip(line(state({ activity: "ready", extensionStatuses: ["Agent: bogus"] }))).includes("READY"));
	const working = strip(line(state({ activity: "working", workingLabel: "Crunching" })));
	assert.ok(working.includes("Crunching"), `workingLabel lost: ${working}`);
	assert.ok(strip(line(state({ activity: "working", extensionStatuses: ["Agent: bogus"] }))).includes("WORKING"));
});

test("changing extensionStatuses updates the role on the next render", () => {
	const st = state({ activity: "ready", extensionStatuses: ["Agent: orchestrator"] });
	assert.ok(line(st).includes("ORCHESTRATOR"));
	st.extensionStatuses = ["Agent: review"];
	const out = line(st);
	assert.ok(out.includes("REVIEW") && !out.includes("ORCHESTRATOR"), strip(out));
});

test("role line stays within the given width", () => {
	const out = line(state({ activity: "working", extensionStatuses: ["Agent: orchestrator"] }), DEFAULT_CONFIG, 40);
	assert.ok(visibleWidth(out) <= 40, `overflow: ${visibleWidth(out)}: ${strip(out)}`);
});

test("agent label colors match requested roles in both densities and ready/working states", () => {
	const expected = {
		orchestrator: { rgb: '177;140;255', themeCode: 35 },
		general: { rgb: '255;220;100', themeCode: 93 },
		fast: { rgb: '110;168;254', themeCode: 34 },
		review: { rgb: '126;211;137', themeCode: 32 },
	};
	for (const [role, color] of Object.entries(expected)) {
		for (const density of ['comfortable', 'compact']) {
			for (const activity of ['ready', 'working']) {
				const st = state({ activity, extensionStatuses: [`Agent: ${role}`] });
				const cfg = { ...DEFAULT_CONFIG, density };
				const named = renderFooterLine(st, cfg, { ...theme, name: 'dark' }, 120);
				assert.ok(named.includes(`\x1b[38;2;${color.rgb}m● ${role.toUpperCase()}`));
				assert.ok(line(st, cfg).includes(`\x1b[${color.themeCode}m● ${role.toUpperCase()}`));
				const noColor = renderFooterLine(st, cfg, { ...theme, name: 'dark' }, 120, false);
				assert.ok(noColor.includes(`\x1b[37m● ${role.toUpperCase()}`));
				assert.ok(!noColor.includes('\x1b[38;2;'), 'no fixed RGB in no-color mode');
			}
		}
	}
});

test("warning and error activity colors override every agent color", () => {
	for (const role of ROLES) {
		for (const [activity, rgb, code] of [['warning', '255;159;67', 93], ['error', '255;93;115', 31]]) {
			const st = state({ activity, extensionStatuses: [`Agent: ${role}`] });
			const label = `● ${role.toUpperCase()} · ${activity.toUpperCase()}`;
			assert.ok(line(st).includes(`\x1b[${code}m${label}`));
			const named = renderFooterLine(st, DEFAULT_CONFIG, { ...theme, name: 'dark' }, 120);
			assert.ok(named.includes(`\x1b[38;2;${rgb}m${label}`));
		}
	}
});

test("live agent changes update the color as well as the name", () => {
	const st = state({ extensionStatuses: ['Agent: general'] });
	assert.ok(line(st).includes('\x1b[93m● GENERAL'));
	st.extensionStatuses = ['Agent: review'];
	const updated = line(st);
	assert.ok(updated.includes('\x1b[32m● REVIEW'));
	assert.ok(!updated.includes('GENERAL'));
});

test("working role keeps its color and animation; timer cleaned up", () => {
	const workingRole = line(state({ activity: "working", extensionStatuses: ["Agent: fast"] }));
	const workingPlain = line(state({ activity: "working", workingLabel: "X" }));
	assert.ok(workingRole.includes("\x1b[34m● FAST"), strip(workingRole));
	assert.ok(workingPlain.includes("\x1b[33m● X"), 'standalone working color is unchanged');
	const readyRole = line(state({ activity: "ready", extensionStatuses: ["Agent: fast"] }));
	assert.ok(readyRole.includes("\x1b[34m● FAST"), strip(readyRole));

	const origSet = globalThis.setInterval, origClear = globalThis.clearInterval;
	let created = 0, cleared = 0, unsub = 0;
	globalThis.setInterval = (...a) => (created++, origSet(...a));
	globalThis.clearInterval = (...a) => (cleared++, origClear(...a));
	let comp;
	try {
		const st = state({ activity: "working", extensionStatuses: ["Agent: fast"] });
		comp = createFooterComponent({
			getState: () => st, getConfig: () => DEFAULT_CONFIG, theme,
			requestRender: () => {}, onBranchChange: () => () => { unsub++; },
		});
		comp.render(120);
		assert.ok(created >= 1, "working animation timer not started");
		comp.dispose();
		assert.ok(cleared >= 1 && unsub === 1, `timer leak: cleared=${cleared} unsub=${unsub}`);
	} finally {
		comp?.dispose();
		globalThis.setInterval = origSet;
		globalThis.clearInterval = origClear;
	}
});
