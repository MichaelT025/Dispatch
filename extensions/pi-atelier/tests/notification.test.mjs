/**
 * Notification lifecycle integration tests.
 * Run: node --experimental-strip-types --test extensions/pi-atelier/tests/notification.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
	createCompletionNotifier,
	formatBody,
	formatTitle,
} from "../src/completion-notifier.ts";
import {
	askUserInputChanged,
	createNotificationRunState,
	inputPromptEnded,
	inputPromptStarted,
	inputRequestKey,
	settleNotificationRun,
	startNotificationRun,
	trackAgentEnd,
	trackAssistantMessage,
} from "../src/notification-policy.ts";

function fakeSpawn(calls) {
	return (command, args, options) => {
		calls.push({ command, args, options });
		return {
			kill() { return true; },
			once() { return this; },
			unref() {},
		};
	};
}

function notification(kind = "turn-settled") {
	return { kind, projectName: "dispatch-project", completedToolCount: 2, failedToolCount: 1 };
}

describe("Dispatch native notification lifecycle", () => {
	it("uses Dispatch branding and a distinct failed status", () => {
		assert.equal(formatTitle(notification()), "Dispatch · dispatch-project");
		assert.match(formatBody(notification("run-failed")), /^Run failed/);
		assert.match(formatBody(notification()), /^Turn settled/);
	});

	it("sends Linux notifications with notify-send and a suppress-sound hint", () => {
		const calls = [];
		const notifier = createCompletionNotifier({
			platform: "linux",
			isEnabled: () => true,
			spawn: fakeSpawn(calls),
		});
		notifier.runStarted();
		notifier.turnSettled(notification());
		assert.equal(calls.length, 1);
		assert.equal(calls[0].command, "notify-send");
		assert.deepEqual(calls[0].args, [
			"--hint",
			"boolean:suppress-sound:true",
			"Dispatch · dispatch-project",
			"Turn settled · 2 done · 1 failed",
		]);
		assert.equal(calls[0].options.stdio, "ignore");
		notifier.reset();
	});

	it("makes Windows toast audio explicitly silent", () => {
		const calls = [];
		const notifier = createCompletionNotifier({
			platform: "win32",
			isEnabled: () => true,
			spawn: fakeSpawn(calls),
		});
		notifier.runStarted();
		notifier.turnSettled(notification());
		assert.equal(calls[0].command, "powershell.exe");
		assert.match(calls[0].args.at(-1), /CreateElement\('audio'\)/);
		assert.match(calls[0].args.at(-1), /SetAttribute\('silent', 'true'\)/);
		notifier.reset();
	});

	it("silences disabled notifications, including non-TUI callers", () => {
		const calls = [];
		const notifier = createCompletionNotifier({
			platform: "linux",
			isEnabled: () => false,
			spawn: fakeSpawn(calls),
		});
		notifier.runStarted();
		notifier.turnSettled(notification());
		notifier.runFailed(notification("run-failed"));
		assert.deepEqual(calls, []);
	});

	it("does not settle while a Dispatch worker is active, then settles at the orchestrator", () => {
		const state = createNotificationRunState();
		startNotificationRun(state);
		assert.equal(settleNotificationRun(state, { isIdle: true, hasPendingMessages: false, activeWorkers: 1 }), undefined);
		assert.equal(state.active, true);
		assert.equal(settleNotificationRun(state, { isIdle: true, hasPendingMessages: false, activeWorkers: 0 }), "success");
	});

	it("waits for the retry and reports retry success, not the failed attempt", () => {
		const state = createNotificationRunState();
		startNotificationRun(state);
		trackAssistantMessage(state, { role: "assistant", stopReason: "error" });
		trackAgentEnd(state, { messages: [{ role: "assistant", stopReason: "error" }] });
		assert.equal(settleNotificationRun(state, { isIdle: true, hasPendingMessages: true, activeWorkers: 0 }), undefined);
		// Pi retries within one agent run; there is no second agent_start event.
		trackAssistantMessage(state, { role: "assistant", stopReason: "stop" });
		trackAgentEnd(state, {
			messages: [
				{ role: "assistant", stopReason: "error" },
				{ role: "assistant", stopReason: "stop" },
			],
		});
		assert.equal(settleNotificationRun(state, { isIdle: true, hasPendingMessages: false, activeWorkers: 0 }), "success");
	});

	it("reports a fatal error only after settlement", () => {
		const state = createNotificationRunState();
		startNotificationRun(state);
		trackAgentEnd(state, { messages: [{ role: "assistant", stopReason: "error" }] });
		assert.equal(settleNotificationRun(state, { isIdle: true, hasPendingMessages: false, activeWorkers: 0 }), "failed");
	});

	it("does not turn an abort into a success or failure alert", () => {
		const state = createNotificationRunState();
		startNotificationRun(state);
		trackAssistantMessage(state, { role: "assistant", stopReason: "aborted" });
		assert.equal(settleNotificationRun(state, { isIdle: true, hasPendingMessages: false, activeWorkers: 0 }), "aborted");
	});

	it("coalesces ui_prompt_start and ask-user for one blocking span", () => {
		const state = createNotificationRunState();
		startNotificationRun(state);
		assert.equal(inputPromptStarted(state), true);
		assert.equal(inputRequestKey(state), "blocking-1");
		assert.equal(askUserInputChanged(state, true), false);
		inputPromptEnded(state);
		assert.equal(askUserInputChanged(state, false), false);
		assert.equal(inputPromptStarted(state), true);
		assert.equal(inputRequestKey(state), "blocking-2");
	});

	it("delivers two distinct prompt spans through the actual notifier", () => {
		const calls = [];
		const notifier = createCompletionNotifier({
			platform: "linux",
			isEnabled: () => true,
			spawn: fakeSpawn(calls),
		});
		const state = createNotificationRunState();
		startNotificationRun(state);
		assert.equal(inputPromptStarted(state), true);
		const firstKey = inputRequestKey(state);
		notifier.inputRequested(firstKey, notification("input-requested"));
		inputPromptEnded(state);
		assert.equal(inputPromptStarted(state), true);
		const secondKey = inputRequestKey(state);
		notifier.inputRequested(secondKey, notification("input-requested"));
		assert.notEqual(firstKey, secondKey);
		assert.equal(calls.length, 2);
		notifier.reset();
	});

	it("does not emit input requests outside an active run", () => {
		const state = createNotificationRunState();
		assert.equal(inputPromptStarted(state), false);
		assert.equal(askUserInputChanged(state, true), false);
	});

	it("keeps the actual extension silent for an RPC/non-TUI session", () => {
		const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
		const indexUrl = pathToFileURL(path.join(root, "extensions", "index.ts")).href;
		const loader = path.join(root, "tests", "ts-extension-loader.mjs");
		const configUrl = pathToFileURL(path.join(root, "src", "config.ts")).href;
		const script = `
			import atelierExtension from ${JSON.stringify(indexUrl)};
			import { validateConfig } from ${JSON.stringify(configUrl)};
			const handlers = new Map();
			const eventHandlers = new Map();
			const calls = [];
			const errors = [];
			const events = {
				on(name, handler) {
					const list = eventHandlers.get(name) ?? [];
					list.push(handler); eventHandlers.set(name, list);
					return () => {};
				},
				emit(name, data) { for (const handler of eventHandlers.get(name) ?? []) handler(data); },
			};
			const pi = {
				on(name, handler) { handlers.set(name, handler); },
				registerCommand() {}, registerShortcut() {},
				getActiveTools() { return []; }, getAllTools() { return []; },
				events,
			};
			atelierExtension(pi, {
				loadConfig: () => validateConfig({ showSidebarOnStartup: false }), saveConfigPatch: async () => {},
				notificationPlatform: "linux",
				spawnNotificationProcess(command) { calls.push(command); return { kill() { return true; }, once(event, listener) { if (event === "exit") listener(); return this; }, unref() {} }; },
			});
			const rpcCtx = { mode: "rpc", sessionManager: {} };
			await handlers.get("session_start")({}, rpcCtx);
			await handlers.get("agent_start")({}, rpcCtx);
			await handlers.get("agent_settled")({}, rpcCtx);
			let workerCount = 1;
			const workerQueries = [];
			events.on("piastra:worker-guard", query => { workerQueries.push(workerCount); query.active = workerCount; });
			const manager = {
				getSessionName() { return undefined; }, getSessionFile() { return undefined; },
				getBranch() { return []; }, getEntries() { return []; },
			};
			const ui = {
				notify(...args) { errors.push(args); }, setFooter() {}, setEditorComponent() {}, getEditorComponent() { return undefined; },
				onTerminalInput() { return () => {}; },
			};
			const tuiCtx = {
				mode: "tui", cwd: process.cwd(), sessionManager: manager, ui,
				isProjectTrusted() { return false; }, getContextUsage() { return undefined; },
				isIdle() { return true; }, hasPendingMessages() { return false; },
			};
			await handlers.get("session_start")({}, tuiCtx);
			await handlers.get("agent_start")({}, tuiCtx);
			await handlers.get("agent_settled")({}, tuiCtx);
			workerCount = 0;
			await handlers.get("agent_settled")({}, tuiCtx);
			await handlers.get("session_shutdown")({}, tuiCtx);
			process.stdout.write(JSON.stringify({ calls, workerQueries, errors }));
			process.exit(0);
		`;
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--experimental-loader", pathToFileURL(loader).href, "--input-type=module", "-e", script],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		const evidence = JSON.parse(result.stdout.trim());
		assert.deepEqual(evidence.calls, ["notify-send"], JSON.stringify(evidence.errors));
		assert.deepEqual(evidence.errors, []);
		assert.deepEqual(evidence.workerQueries, [1, 0]);
	});
});
