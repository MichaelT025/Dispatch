// PiAstra fork regression tests for the vendored @juicesharp/rpiv-todo@2.9.0
// copy under extensions/pi-todo. Follows the pattern of
// scripts/install-cli.test.mjs: the entry point is loaded through Pi's own
// jiti extension loader (with its typebox/pi aliases and TS .js→.ts relative
// import resolution), never via a direct import of the TS source.
//
// Tests exercise only temporary profile/cwd/config directories — the user's
// real profile, ~/.config, and repository node_modules are never touched.
// State tests use fresh per-test session ids because the upstream store keeps
// module-level per-session slots.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const forkDir = path.join(repoRoot, 'extensions', 'pi-todo');
const forkIndex = path.join(forkDir, 'index.ts');

let envSaved;
let agentDir;
let cwdDir;
let configDir;
let loaderUrl;

test.before(async () => {
	// Temp profile + cwd + XDG config layer so loadConfig() (vendored
	// rpiv-config) reads an empty temp config and nothing user-owned.
	agentDir = await mkdtemp(path.join(tmpdir(), 'piastra-todo-agent-'));
	cwdDir = await mkdtemp(path.join(tmpdir(), 'piastra-todo-cwd-'));
	configDir = await mkdtemp(path.join(tmpdir(), 'piastra-todo-xdg-'));
	envSaved = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.XDG_CONFIG_HOME = configDir;
	const piEntryUrl = new URL(import.meta.resolve('@earendil-works/pi-coding-agent'));
	loaderUrl = new URL('./core/extensions/loader.js', piEntryUrl);
});

after(async () => {
	if (envSaved) {
		if (envSaved.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = envSaved.PI_CODING_AGENT_DIR;
		if (envSaved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = envSaved.XDG_CONFIG_HOME;
	}
	await rm(agentDir, { recursive: true, force: true });
	await rm(cwdDir, { recursive: true, force: true });
	await rm(configDir, { recursive: true, force: true });
});

let loadCount = 0;
let loadedExtension;

/** Load the vendored fork once through Pi's real extension loader. */
async function loadFork() {
	const { loadExtensions } = await import(loaderUrl.href);
	const result = await loadExtensions([forkIndex], cwdDir);
	assert.deepEqual(result.errors, [], 'fork must load with zero errors');
	const extension = result.extensions.find((e) => e.path === forkIndex);
	assert.ok(extension, 'vendored rpiv-todo entry should load');
	return extension;
}

async function getLoaded() {
	loadCount++;
	if (!loadedExtension) loadedExtension = await loadFork();
	return loadedExtension;
}

let sessionCounter = 0;
function nextSid() {
	sessionCounter++;
	return `piastra-fork-test-${process.pid}-${loadCount}-${sessionCounter}`;
}

/** Fake extension ctx shaped like the pieces the fork's handlers touch. */
function makeCtx({ sid, branch = [], hasUI = true, ui }) {
	return {
		hasUI,
		sessionManager: {
			getSessionId: () => sid,
			getBranch: () => branch,
		},
		ui,
	};
}

/** Fake UI context recording every setWidget call (registration and removal). */
function makeFakeUi() {
	const widgetCalls = [];
	const notifications = [];
	return {
		widgetCalls,
		notifications,
		registeredWidgets: new Set(['foreign-widget']),
		setWidget(key, factory, options) {
			widgetCalls.push({ key, factory, options });
			if (factory === undefined) this.registeredWidgets.delete(key);
			else this.registeredWidgets.add(key);
		},
		notify(message, level) {
			notifications.push({ message, level });
		},
		theme: undefined,
	};
}

async function runTool(extension, ctx, params) {
	const tool = extension.tools.get('todo');
	assert.ok(tool, 'todo tool must be registered');
	return tool.definition.execute(`call-${sessionCounter}`, params, undefined, undefined, ctx);
}

function branchEntryFromDetails(details) {
	return {
		type: 'message',
		message: { role: 'toolResult', toolName: 'todo', details },
	};
}

test('vendored fork resolves rpiv-config locally with its license and no package dependency', async () => {
	// Assert the dependency wiring, not which unrelated packages happen to be
	// installed in this developer's checkout. Installer tests also load a
	// copied runtime from an isolated temporary profile.
	const pkg = JSON.parse(await readFile(path.join(forkDir, 'package.json'), 'utf8'));
	assert.equal(pkg.name, '@juicesharp/rpiv-todo');
	assert.equal(pkg.version, '2.9.0');
	assert.equal(pkg.dependencies?.['@juicesharp/rpiv-config'], undefined);
	assert.ok(pkg.dependencies?.typebox, 'typebox dependency kept (Pi-aliased)');
	assert.equal(pkg.peerDependenciesMeta?.['@juicesharp/rpiv-i18n']?.optional, true, 'i18n peer stays optional');
	assert.deepEqual(pkg.pi?.extensions, ['./index.ts'], 'upstream pi manifest entry preserved');

	// Pristine vendored dependency with preserved license files.
	for (const vendorFile of ['index.ts', 'config.ts', 'package.json', 'CHANGELOG.md', 'README.md', 'LICENSE']) {
		assert.ok(existsSync(path.join(forkDir, 'vendor', 'rpiv-config', vendorFile)), `vendor file ${vendorFile}`);
	}
	const vendorPkg = JSON.parse(await readFile(path.join(forkDir, 'vendor', 'rpiv-config', 'package.json'), 'utf8'));
	assert.equal(vendorPkg.name, '@juicesharp/rpiv-config');
	assert.equal(vendorPkg.version, '2.9.0');
	assert.equal(vendorPkg.license, 'MIT');

	// The only import of the config helper points at the vendored copy.
	const configSource = await readFile(path.join(forkDir, 'config.ts'), 'utf8');
	assert.doesNotMatch(configSource, /from ["']@juicesharp\/rpiv-config/);
	assert.doesNotMatch(configSource, /import ["']@juicesharp\/rpiv-config/);
	assert.match(configSource, /vendor\/rpiv-config\/index\.js/);
	// The whole runtime must be free of non-vendored rpiv-config imports.
	for (const runtimeFile of ['index.ts', 'todo.ts', 'todo-overlay.ts']) {
		const source = await readFile(path.join(forkDir, runtimeFile), 'utf8');
		assert.doesNotMatch(source, /from ["']@juicesharp\/rpiv-config/);
	}
});

test('fork loads through Pi loader: todo tool and /todos exist, no collapse shortcut registered', async () => {
	const extension = await getLoaded();
	assert.ok(extension.tools.has('todo'), 'todo tool registered');
	assert.ok(extension.commands.has('todos'), '/todos command registered');
	assert.equal(extension.shortcuts.size, 0, 'overlay collapse shortcut must not be registered');
	assert.ok(Array.from(extension.handlers.keys()).includes('session_start'));
	assert.ok(Array.from(extension.handlers.keys()).includes('session_shutdown'));
});

test('todo tool create/update/list/get with validation and dependency cycles, from original state code', async () => {
	const extension = await getLoaded();
	const sid = nextSid();
	const ctx = makeCtx({ sid });

	// Validation: create requires a subject.
	const badCreate = await runTool(extension, ctx, { action: 'create' });
	assert.equal(badCreate.details.error, 'subject required for create');
	assert.match(badCreate.content[0].text, /subject required for create/);

	// Create.
	const created = await runTool(extension, ctx, { action: 'create', subject: 'Research existing tool' });
	assert.equal(created.details.tasks.length, 1);
	assert.equal(created.details.tasks[0].subject, 'Research existing tool');
	assert.equal(created.details.tasks[0].status, 'pending');
	assert.match(created.content[0].text, /Created #1: Research existing tool/);

	// Update with transition + activeForm.
	const updated = await runTool(extension, ctx, { action: 'update', id: 1, status: 'in_progress', activeForm: 'researching tools' });
	assert.match(updated.content[0].text, /Updated #1 \(pending → in_progress\)/);
	assert.equal(updated.details.tasks[0].activeForm, 'researching tools');

	// Dependencies: #2 blocked by #1.
	await runTool(extension, ctx, { action: 'create', subject: 'Write design', blockedBy: [1] });
	const getTwo = await runTool(extension, ctx, { action: 'get', id: 2 });
	assert.match(getTwo.content[0].text, /blockedBy: #1/);

	// Cycle rejected: #1 cannot also be blocked by #2.
	const cycle = await runTool(extension, ctx, { action: 'update', id: 1, addBlockedBy: [2] });
	assert.equal(cycle.details.error, 'addBlockedBy would create a cycle in the blockedBy graph');
	assert.match(cycle.content[0].text, /cycle/);

	// The failed cycle left the state untouched.
	const list = await runTool(extension, ctx, { action: 'list' });
	assert.doesNotMatch(list.content[0].text, /#1.*⛓/);
	assert.match(list.content[0].text, /\[in_progress\] #1 Research existing tool \(researching tools\)/);
	assert.match(list.content[0].text, /\[pending\] #2 Write design ⛓ #1/);

	// No-effect update reported as "No change".
	const noop = await runTool(extension, ctx, { action: 'update', id: 1, status: 'in_progress' });
	assert.match(noop.content[0].text, /No change: #1 already matches/);

	// completed is one-way: never back to in_progress.
	const done = await runTool(extension, ctx, { action: 'update', id: 1, status: 'completed' });
	assert.match(done.content[0].text, /Updated #1 \(in_progress → completed\)/);
	const restart = await runTool(extension, ctx, { action: 'update', id: 1, status: 'in_progress' });
	assert.equal(restart.details.error, 'illegal transition completed → in_progress');
});

test('/todos dialog works from state: interactive notify and headless error (i18n fallback)', async () => {
	const extension = await getLoaded();
	const sid = nextSid();
	const ctx = makeCtx({ sid });

	await runTool(extension, ctx, { action: 'create', subject: 'Task one' });
	await runTool(extension, ctx, { action: 'create', subject: 'Task two', description: 'details' });

	const command = extension.commands.get('todos');
	assert.ok(command, '/todos registered');

	// Interactive: grouped by status with counts header.
	const ui = makeFakeUi();
	await command.handler('', makeCtx({ sid, ui }));
	assert.equal(ui.notifications.length, 1);
	assert.match(ui.notifications[0].message, /2 pending/);
	assert.match(ui.notifications[0].message, /── Pending ──/);
	assert.match(ui.notifications[0].message, /#1 Task one/);
	assert.match(ui.notifications[0].message, /#2 Task two/);

	// Headless: English fallback error (i18n bridge without the optional SDK).
	const headlessUi = makeFakeUi();
	await command.handler('', makeCtx({ sid, hasUI: false, ui: headlessUi }));
	assert.equal(headlessUi.notifications[0].level, 'error');
	assert.match(headlessUi.notifications[0].message, /\/todos requires interactive mode/);
});

test('replay rebuilds state from branch details with per-session isolation', async () => {
	const extension = await getLoaded();
	const handlers = extension.handlers;
	const sessionStart = handlers.get('session_start')[0];
	const shutdown = handlers.get('session_shutdown')[0];

	const sidA = nextSid();
	const ctxA = makeCtx({ sid: sidA });
	await sessionStart({}, ctxA);
	await runTool(extension, ctxA, { action: 'create', subject: 'Replayable task' });
	await runTool(extension, ctxA, { action: 'update', id: 1, status: 'in_progress' });

	// A later session replays the branch's LAST todo details.
	const sidB = nextSid();
	const branch = [branchEntryFromDetails({ action: 'update', params: {}, tasks: [{ id: 1, subject: 'Replayable task', status: 'in_progress' }], nextId: 2 })];
	const ctxB = makeCtx({ sid: sidB, branch });
	await sessionStart({}, ctxB);
	const listB = await runTool(extension, ctxB, { action: 'list' });
	assert.match(listB.content[0].text, /\[in_progress\] #1 Replayable task/);

	// Session isolation: tombstoning #1 in B does not affect A's slot.
	await runTool(extension, ctxB, { action: 'delete', id: 1 });
	const listA = await runTool(extension, ctxA, { action: 'list' });
	assert.match(listA.content[0].text, /#1 Replayable task/);
	const listBAfter = await runTool(extension, ctxB, { action: 'list' });
	assert.match(listBAfter.content[0].text, /No tasks/);

	// Fresh session without branch replays empty (shutdown eviction + isolation).
	const sidC = nextSid();
	await sessionStart({}, makeCtx({ sid: sidC }));
	const listC = await runTool(extension, makeCtx({ sid: sidC }), { action: 'list' });
	assert.match(listC.content[0].text, /No tasks/);

	// Shutdown evicts the slot: a new session for the same sid starts empty.
	await shutdown({}, ctxA);
	const listAAfterShutdown = await runTool(extension, ctxA, { action: 'list' });
	assert.match(listAAfterShutdown.content[0].text, /No tasks/);
});

test('lifecycle with visible tasks never registers the rpiv-todos widget, never touches other widgets, and schedules no prewarm timer', async () => {
	// Watch for the disabled pre-warm timer (setTimeout with PREWARM_DELAY_MS)
	// during the whole load window.
	const scheduledDelays = [];
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = function patched(fn, delay, ...rest) {
		scheduledDelays.push(delay);
		return originalSetTimeout(fn, delay, ...rest);
	};
	let extension;
	try {
		const { loadExtensions } = await import(loaderUrl.href);
		const result = await loadExtensions([forkIndex], cwdDir);
		assert.deepEqual(result.errors, []);
		extension = result.extensions.find((e) => e.path === forkIndex);
		assert.ok(extension);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
	assert.equal(
		scheduledDelays.filter((delay) => delay === 2000).length,
		0,
		'overlay pre-warm timer (PREWARM_DELAY_MS = 2000) must not be scheduled',
	);

	const ui = makeFakeUi(); // starts with a foreign widget registered
	const sid = nextSid();
	const details = {
		action: 'create',
		params: {},
		tasks: [
			{ id: 1, subject: 'Visible pending task', status: 'pending' },
			{ id: 2, subject: 'Visible active task', status: 'in_progress', activeForm: 'working' },
			{ id: 3, subject: 'Completed task', status: 'completed' },
		],
		nextId: 4,
	};
	const ctx = makeCtx({ sid, branch: [branchEntryFromDetails(details)], ui });

	const sessionStart = extension.handlers.get('session_start')[0];
	const toolEnd = extension.handlers.get('tool_execution_end')[0];
	const agentStart = extension.handlers.get('agent_start')[0];
	assert.ok(sessionStart && toolEnd && agentStart, 'lifecycle handlers present');

	await sessionStart({}, ctx);
	await toolEnd({ toolName: 'todo', isError: false });
	await agentStart({});
	await toolEnd({ toolName: 'todo', isError: false });

	// Wait past the upstream pre-warm delay to prove nothing schedules/loads
	// the overlay module in the background either.
	await new Promise((resolve) => originalSetTimeout(resolve, 2500));

	assert.deepEqual(
		ui.widgetCalls,
		[],
		'no widget may be registered or removed under key rpiv-todos — or any other key',
	);
	assert.ok(ui.registeredWidgets.has('foreign-widget'), 'pre-existing foreign widgets survive the lifecycle');
	assert.equal(extension.shortcuts.size, 0, 'collapse shortcut still absent after lifecycle');
});
