/**
 * Git Worktree Extension
 *
 * Slash commands (/wt is an alias for /worktree):
 *   /worktree                      list worktrees (interactive pick)
 *   /worktree ls                   list worktrees
 *   /worktree <branch>             create worktree for branch
 *   /worktree add <branch>         same as above
 *   /worktree open <branch>        start a fresh session in the worktree
 *   /worktree rm <branch>          remove worktree (confirms first)
 *   /worktree pr <number>          verify PR head, open piastra/pr/<number>
 *   /worktree resume               pick a session from ANY checkout of the repo
 *
 * In the interactive CLI, `add` (new or existing), `open`, a worktree picked
 * from `ls`, and `pr` start a brand-new empty session in the target worktree
 * and switch the running CLI to it. The current conversation is never copied
 * or modified; the new session gets its own file in the standard per-cwd
 * session directory, so `/resume` finds it like any other session.
 * `ctx.switchSession` rebuilds tools, extensions, resources, trust and
 * PiAstra's worker cwd for the worktree. Other hosts keep the path-copy
 * behaviour.
 *
 * Layout:
 *   ~/AGI/mobile/                  ← main checkout
 *   ~/.pi/worktrees/mobile/fix-login/  ← managed worktree for fix/login
 *
 * Safety:
 * - must be inside a git repo
 * - never force-push / hard-reset / clean -fdx
 * - rm always confirms
 * - rm --force only after a second confirm if worktree is dirty
 * - session switching refuses while the agent, a compaction/branch summary,
 *   queued messages, or PiAstra workers are busy
 * - a created worktree is kept (with its path reported) if its session switch
 *   is refused, cancelled, or fails
 */

import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pruneEmptySessions } from "./empty-sessions.mjs";
import { groupSessions, renderPicker, samePath as sameCheckoutPath } from "./resume.mjs";

type ExecResult = { code: number; stdout: string; stderr: string };

type Worktree = {
	path: string;
	head: string;
	branch: string | null; // null = detached
	bare: boolean;
	locked: boolean;
	prunable: boolean;
};

async function run(
	pi: ExtensionAPI,
	args: string[],
	cwd?: string,
): Promise<ExecResult> {
	const result = await pi.exec("git", args, cwd ? { cwd } : undefined);
	return {
		code: result.code ?? 0,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
	};
}

async function ensureRepo(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<string | null> {
	// ctx.cwd, not process.cwd: after a worktree session switch the process
	// directory is unchanged but the agent and its commands work in the new cwd.
	const inside = await run(pi, ["rev-parse", "--is-inside-work-tree"], ctx.cwd);
	if (inside.code !== 0 || inside.stdout !== "true") {
		ctx.ui.notify("Not inside a git repository", "error");
		return null;
	}
	const top = await run(pi, ["rev-parse", "--show-toplevel"], ctx.cwd);
	if (top.code !== 0 || !top.stdout) {
		ctx.ui.notify("Could not resolve repo root", "error");
		return null;
	}
	return top.stdout;
}

function parseWorktrees(porcelain: string): Worktree[] {
	const items: Worktree[] = [];
	let current: Partial<Worktree> | null = null;

	const push = () => {
		if (current?.path) {
			items.push({
				path: current.path,
				head: current.head ?? "",
				branch: current.branch ?? null,
				bare: current.bare ?? false,
				locked: current.locked ?? false,
				prunable: current.prunable ?? false,
			});
		}
		current = null;
	};

	for (const line of porcelain.split("\n")) {
		if (line.length === 0) {
			push();
			continue;
		}
		if (line.startsWith("worktree ")) {
			push();
			current = { path: line.slice("worktree ".length) };
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
		else if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length);
			current.branch = ref.startsWith("refs/heads/")
				? ref.slice("refs/heads/".length)
				: ref;
		} else if (line === "detached") current.branch = null;
		else if (line === "bare") current.bare = true;
		else if (line.startsWith("locked")) current.locked = true;
		else if (line.startsWith("prunable")) current.prunable = true;
	}
	push();
	return items;
}

async function listWorktrees(pi: ExtensionAPI, cwd: string): Promise<Worktree[]> {
	const result = await run(pi, ["worktree", "list", "--porcelain"], cwd);
	if (result.code !== 0) return [];
	return parseWorktrees(result.stdout);
}

function slugHash(value: string): string {
	// A small deterministic hash keeps otherwise-distinct Unicode branch names
	// from all falling back to the same directory.
	let hash = 2166136261;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

function isWindowsReservedName(slug: string): boolean {
	const stem = slug.split(".", 1)[0].toLowerCase();
	return (
		["con", "prn", "aux", "nul"].includes(stem) ||
		/^(com|lpt)[1-9]$/.test(stem)
	);
}

export function branchSlug(branch: string): string {
	const name = branch.replace(/^refs\/heads\//, "");
	const slug = name
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	if (slug && !isWindowsReservedName(slug)) return slug;
	return `branch-${slugHash(name)}`;
}

function shortHead(head: string): string {
	return head.length > 8 ? head.slice(0, 8) : head;
}

function formatWt(wt: Worktree, mainPath: string): string {
	const isMain = wt.path === mainPath;
	const name = wt.branch ?? `(detached ${shortHead(wt.head)})`;
	const tags = [
		isMain ? "main" : null,
		wt.locked ? "locked" : null,
		wt.prunable ? "prunable" : null,
		wt.bare ? "bare" : null,
	]
		.filter(Boolean)
		.join(", ");
	return tags ? `${name}  →  ${wt.path}  (${tags})` : `${name}  →  ${wt.path}`;
}

async function detectDefaultBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const remoteHead = await run(
		pi,
		["symbolic-ref", "refs/remotes/origin/HEAD"],
		cwd,
	);
	if (remoteHead.code === 0 && remoteHead.stdout) {
		const match = remoteHead.stdout.match(/refs\/remotes\/origin\/(.+)$/);
		if (match?.[1]) return match[1];
	}
	for (const candidate of ["main", "master"]) {
		const local = await run(
			pi,
			["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
			cwd,
		);
		if (local.code === 0) return candidate;
		const remote = await run(
			pi,
			["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
			cwd,
		);
		if (remote.code === 0) return candidate;
	}
	return "main";
}

function mainWorktreePath(worktrees: Worktree[]): string {
	// First entry from `git worktree list` is the main worktree.
	return worktrees[0]?.path ?? "";
}

/** Compare two worktree paths regardless of separator/case differences. */
function samePath(left: string, right: string): boolean {
	const a = resolve(left);
	const b = resolve(right);
	return process.platform === "win32"
		? a.toLowerCase() === b.toLowerCase()
		: a === b;
}

export function resolveWorktreePath(
	mainPath: string,
	branch: string,
	home = homedir(),
): string {
	return join(home, ".pi", "worktrees", basename(mainPath), branchSlug(branch));
}

/** Shared event channel: PiAstra answers synchronously whether workers are running. */
export const WORKER_GUARD_CHANNEL = "piastra:worker-guard";

export type PiastraActivity = {
	activeWorkers: number;
	compacting: boolean;
	summarizing: boolean;
};

/**
 * Ask a loaded PiAstra extension for its switch-blocking state: delegated
 * workers plus the compaction and branch-summary phases that `ctx.isIdle()`
 * does not expose. The event bus is synchronous; absent PiAstra simply means
 * nothing is busy. Older PiAstra copies answer only `active`, so the extra
 * flags default to false.
 */
export function piastraActivity(pi: ExtensionAPI): PiastraActivity {
	const query = {
		type: "query",
		busy: false,
		active: 0,
		compacting: false,
		summarizing: false,
	};
	pi.events.emit(WORKER_GUARD_CHANNEL, query);
	return {
		activeWorkers:
			Number.isInteger(query.active) && query.active > 0 ? query.active : 0,
		compacting: query.compacting === true,
		summarizing: query.summarizing === true,
	};
}

export function activePiastraWorkers(pi: ExtensionAPI): number {
	return piastraActivity(pi).activeWorkers;
}

export function worktreeSwitchRefusal(state: {
	idle: boolean;
	pending: boolean;
	activeWorkers: number;
	compacting?: boolean;
	summarizing?: boolean;
}): string | undefined {
	if (!state.idle) {
		return "Wait for the current turn to finish, or stop it before switching to a worktree session.";
	}
	if (state.compacting) {
		return "Context compaction is still running. Wait for it to finish before switching to a worktree session.";
	}
	if (state.summarizing) {
		return "A branch summary is still running. Wait for it to finish before switching to a worktree session.";
	}
	if (state.pending) {
		return "Queued messages are waiting. Wait for them to be sent or clear the queue before switching to a worktree session.";
	}
	if (state.activeWorkers > 0) {
		return `${state.activeWorkers} PiAstra worker${state.activeWorkers === 1 ? " is" : "s are"} still running. Wait for completion or cancel the delegate call before switching to a worktree session.`;
	}
	return undefined;
}

/** Collect every switch-blocking condition this host can observe. */
function switchRefusal(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): string | undefined {
	const activity = piastraActivity(pi);
	return worktreeSwitchRefusal({
		idle: ctx.isIdle(),
		pending: ctx.hasPendingMessages(),
		activeWorkers: activity.activeWorkers,
		compacting: activity.compacting,
		summarizing: activity.summarizing,
	});
}

export type WorktreeSwitchOutcome =
	| "switched"
	| "unsupported"
	| "refused"
	| "cancelled"
	| "failed";

/**
 * Persist the empty header generated by `SessionManager.create` as the first
 * line of its reserved file. The exclusive `wx` flag guarantees an existing
 * session file is never overwritten if a path ever collides. No conversation
 * entries and no `parentSession` are copied, so the result is a fresh session
 * in the target cwd that `/resume` discovers through the standard per-cwd
 * session directory.
 */
export async function persistFreshSessionHeader(
	manager: SessionManager,
): Promise<{ file: string; line: string }> {
	const header = manager.getHeader();
	const file = manager.getSessionFile();
	if (!header || !file) {
		throw new Error("SessionManager did not generate a session header");
	}
	if (header.parentSession !== undefined) {
		throw new Error("A fresh worktree session must not have a parent session");
	}
	const line = `${JSON.stringify(header)}\n`;
	await writeFile(file, line, { flag: "wx" });
	return { file, line };
}

/**
 * Remove a session file this switch created, but only while it still contains
 * exactly the header that was written. If anything else landed in it, it may
 * already be in use, so leave it in place.
 */
async function removeOwnUnusedSession(created: {
	file: string;
	line: string;
}): Promise<void> {
	try {
		if ((await readFile(created.file, "utf8")) !== created.line) return;
		await rm(created.file, { force: true });
	} catch { /* already gone or unreadable; leave it alone */ }
}

/**
 * Start a brand-new empty session in the target worktree and switch to it.
 *
 * `SessionManager.create` reserves a unique file in the standard per-cwd
 * session directory and `persistFreshSessionHeader` writes its generated
 * header with the exclusive `wx` flag. `ctx.switchSession` then tears the old
 * runtime down and rebuilds extensions, tools, resources, trust and the agent
 * cwd for the worktree. The old `pi`/`ctx` are invalid once the switch starts,
 * so the success notice is emitted only from the replacement-session callback
 * and the caller returns immediately afterwards.
 */
export async function switchToWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	targetPath: string,
	title: string,
): Promise<WorktreeSwitchOutcome> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			"Session switching is available only in the interactive CLI.",
			"info",
		);
		return "unsupported";
	}

	const refusal = switchRefusal(pi, ctx);
	if (refusal) {
		ctx.ui.notify(`${refusal}\n\nThe session was not changed.`, "warning");
		return "refused";
	}

	// Captured while the old context is valid. The file itself is never
	// modified; it only tells the user where the earlier conversation stays.
	const sourceFile = ctx.sessionManager.getSessionFile();
	const sourceSaved = !!sourceFile && existsSync(sourceFile);

	let created: { file: string; line: string };
	try {
		created = await persistFreshSessionHeader(
			SessionManager.create(targetPath),
		);
	} catch (error: any) {
		ctx.ui.notify(
			`Could not prepare a fresh session in the worktree:\n${error?.message || error}`,
			"error",
		);
		return "refused";
	}

	// Show the recovery paths while the old context still exists: if rebuilding
	// the runtime fails (the host may exit before this command resumes),
	// `pi --session <sourceFile>` reopens the original conversation.
	ctx.ui.notify(
		`Starting a fresh session in ${title}\n${targetPath}\n\nNew session file:\n${created.file}\n\n` +
			(sourceSaved
				? `The current conversation stays saved at:\n${sourceFile}\nIf the worktree session fails to start, restart Pi with:\npi --session "${sourceFile}"`
				: "The current conversation is not saved to a file, so it will not be recoverable after this switch."),
		"info",
	);

	try {
		const result = await ctx.switchSession(created.file, {
			withSession: async (replacement) => {
				replacement.ui.notify(
					`Started a fresh session in ${title}\n${targetPath}\n\n` +
						"Tools, extensions, Git and PiAstra workers now use this worktree." +
						(sourceSaved
							? `\nThe earlier conversation stays saved at:\n${sourceFile}`
							: "\nThe earlier conversation was ephemeral and is not saved."),
					"info",
				);
			},
		});
		if (result.cancelled) {
			await removeOwnUnusedSession(created);
			ctx.ui.notify(
				"Session switch was cancelled; the current conversation is unchanged and the new session file was removed.",
				"warning",
			);
			return "cancelled";
		}
		return "switched";
	} catch (error: any) {
		// The host tears the old runtime down before it builds the replacement,
		// so the old context may already be invalid. Keep this best-effort and
		// keep the recovery information truthful: the original session was never
		// modified and the new file is still on disk.
		try {
			ctx.ui.notify(
				`Fresh worktree session did not start:\n${error?.message || error}\n\n` +
					(sourceSaved
						? `The original session stays saved at:\n${sourceFile}\n`
						: "The original conversation is not saved.\n") +
					`New session file:\n${created.file}`,
				"error",
			);
		} catch { /* the old context may be gone after teardown */ }
		return "failed";
	}
}

/**
 * Activate a worktree after `/worktree add`, `open`, `ls` selection or `pr`.
 * Interactive hosts always switch to a fresh session there; every other host
 * never switches and keeps the path-copy behaviour.
 */
async function activateWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	worktreePath: string,
	title: string,
	created: boolean,
): Promise<WorktreeSwitchOutcome | undefined> {
	if (ctx.mode === "tui") {
		return await switchToWorktree(
			pi,
			ctx,
			worktreePath,
			created ? `new worktree ${title}` : title,
		);
	}

	const copied = await copyToClipboard(pi, worktreePath);
	ctx.ui.notify(
		`${created ? "Created" : "Worktree"}: ${title}\n→ ${worktreePath}${copied ? "\n(path copied)" : ""}\n\nNext: cd ${worktreePath} && pi`,
		"info",
	);
	return undefined;
}

/**
 * A created worktree is never removed because its session switch did not
 * complete. Report the path and the manual recovery options so the user is not
 * left with an undiscovered worktree.
 */
function reportCreatedWorktreeNotSwitched(
	ctx: ExtensionCommandContext,
	title: string,
	worktreePath: string,
	outcome: WorktreeSwitchOutcome,
): void {
	try {
		ctx.ui.notify(
			`Worktree created, but the session was not switched to it.\n${title}\n→ ${worktreePath}\n\n` +
				`The worktree is kept. To use it now:\n` +
				`cd "${worktreePath}" && pi\n` +
				`or run /worktree open ${title} once the current turn, queue, and workers are clear.`,
			outcome === "refused" ? "warning" : "error",
		);
	} catch { /* the old context may already be gone after a failed teardown */ }
}

function findWorktree(
	worktrees: Worktree[],
	query: string,
): Worktree | undefined {
	const q = query.trim();
	if (!q) return undefined;
	// Exact path
	const byPath = worktrees.find((w) => w.path === q);
	if (byPath) return byPath;
	// Exact branch
	const byBranch = worktrees.find((w) => w.branch === q);
	if (byBranch) return byBranch;
	// Slug match (fix-login matches fix/login)
	const slug = branchSlug(q);
	const bySlug = worktrees.find(
		(w) => w.branch !== null && branchSlug(w.branch) === slug,
	);
	if (bySlug) return bySlug;
	// Path suffix
	const bySuffix = worktrees.find(
		(w) => w.path.endsWith(`/${q}`) || w.path.endsWith(`-${slug}`),
	);
	return bySuffix;
}

async function copyToClipboard(pi: ExtensionAPI, text: string): Promise<boolean> {
	// macOS pbcopy via bash; quiet-fail on Linux/etc.
	const piped = await pi
		.exec("bash", ["-c", 'printf %s "$1" | pbcopy', "--", text])
		.catch(() => null);
	return !!piped && (piped.code ?? 1) === 0;
}

async function refExists(
	pi: ExtensionAPI,
	cwd: string,
	ref: string,
): Promise<boolean> {
	const r = await run(pi, ["show-ref", "--verify", "--quiet", ref], cwd);
	return r.code === 0;
}

async function createWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
	branch: string,
	base?: string,
): Promise<void> {
	const worktrees = await listWorktrees(pi, cwd);
	const mainPath = mainWorktreePath(worktrees) || cwd;

	const existing = findWorktree(worktrees, branch);
	if (existing) {
		await activateWorktree(
			pi,
			ctx,
			existing.path,
			existing.branch ?? "detached",
			false,
		);
		return;
	}

	const path = resolveWorktreePath(mainPath, branch);
	const pathTaken = worktrees.find((w) => w.path === path);
	if (pathTaken) {
		ctx.ui.notify(
			`Path already used by another worktree:\n${path}\n(${pathTaken.branch ?? "detached"})`,
			"error",
		);
		return;
	}

	// Refuse before touching Git when a session switch would be unsafe. The
	// same conditions are enforced again by session_before_switch in PiAstra.
	if (ctx.mode === "tui") {
		const refusal = switchRefusal(pi, ctx);
		if (refusal) {
			ctx.ui.notify(`${refusal}\n\nThe worktree was not created.`, "warning");
			return;
		}
	}

	const localRef = `refs/heads/${branch}`;
	const remoteRef = `refs/remotes/origin/${branch}`;
	const hasLocal = await refExists(pi, cwd, localRef);
	const hasRemote = await refExists(pi, cwd, remoteRef);

	// Refresh remote tip when we might need it.
	if (!hasLocal) {
		await run(pi, ["fetch", "origin", branch], cwd);
	}

	const hasLocalAfter = hasLocal || (await refExists(pi, cwd, localRef));
	const hasRemoteAfter = hasRemote || (await refExists(pi, cwd, remoteRef));

	let add: ExecResult;
	if (hasLocalAfter) {
		// Reuse existing local branch.
		add = await run(pi, ["worktree", "add", path, branch], cwd);
	} else if (hasRemoteAfter) {
		// Create local branch tracking origin/<branch>.
		add = await run(
			pi,
			["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`],
			cwd,
		);
	} else {
		// Brand-new branch off base (default: origin/main or main).
		const baseBranch = base ?? (await detectDefaultBranch(pi, cwd));
		// Prefer origin/<base> when available.
		const originBase = `origin/${baseBranch}`;
		const startPoint = (await refExists(
			pi,
			cwd,
			`refs/remotes/${originBase}`,
		))
			? originBase
			: (await refExists(pi, cwd, `refs/heads/${baseBranch}`))
				? baseBranch
				: baseBranch;

		// Make sure base is fresh when it's a remote ref.
		if (startPoint.startsWith("origin/")) {
			await run(pi, ["fetch", "origin", baseBranch], cwd);
		}

		add = await run(
			pi,
			["worktree", "add", "-b", branch, path, startPoint],
			cwd,
		);
	}

	if (add.code !== 0) {
		ctx.ui.notify(
			`worktree add failed:\n${add.stderr || add.stdout}`,
			"error",
		);
		return;
	}

	await activateWorktree(pi, ctx, path, branch, true).then((outcome) => {
		if (outcome && outcome !== "switched") {
			reportCreatedWorktreeNotSwitched(ctx, branch, path, outcome);
		}
	});
}

async function openWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
	query: string,
): Promise<void> {
	const worktrees = await listWorktrees(pi, cwd);
	const wt = findWorktree(worktrees, query);
	if (!wt) {
		ctx.ui.notify(
			`No worktree matching "${query}"\nTry /worktree ls`,
			"error",
		);
		return;
	}
	await activateWorktree(pi, ctx, wt.path, wt.branch ?? "detached", false);
}

async function removeWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
	query: string,
): Promise<void> {
	const worktrees = await listWorktrees(pi, cwd);
	const mainPath = mainWorktreePath(worktrees);
	const wt = findWorktree(worktrees, query);

	if (!wt) {
		ctx.ui.notify(`No worktree matching "${query}"`, "error");
		return;
	}
	if (wt.path === mainPath) {
		ctx.ui.notify("Refusing to remove the main worktree", "error");
		return;
	}
	if (samePath(wt.path, ctx.cwd)) {
		ctx.ui.notify(
			"Refusing to remove the worktree this session is running in. Switch to another worktree first.",
			"error",
		);
		return;
	}
	if (wt.locked) {
		ctx.ui.notify(`Worktree is locked:\n${wt.path}`, "error");
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(
			"Refusing to remove a worktree without interactive confirmation.",
			"error",
		);
		return;
	}
	const ok = await ctx.ui.confirm(
		"Remove worktree?",
		`${wt.branch ?? "detached"}\n${wt.path}\n\nBranch is kept. Only the worktree directory is removed.`,
	);
	if (!ok) {
		ctx.ui.notify("Aborted", "warning");
		return;
	}

	let rm = await run(pi, ["worktree", "remove", wt.path], cwd);
	if (rm.code !== 0) {
		const detail = rm.stderr || rm.stdout;
		const dirty =
			/dirty|contains modified|git worktree remove --force/i.test(detail);

		if (dirty && ctx.hasUI) {
			const force = await ctx.ui.confirm(
				"Worktree has local changes",
				`${detail}\n\nForce remove? Uncommitted changes in the worktree will be lost.`,
			);
			if (!force) {
				ctx.ui.notify("Aborted", "warning");
				return;
			}
			rm = await run(pi, ["worktree", "remove", "--force", wt.path], cwd);
		}

		if (rm.code !== 0) {
			ctx.ui.notify(
				`worktree remove failed:\n${rm.stderr || rm.stdout}`,
				"error",
			);
			return;
		}
	}

	ctx.ui.notify(
		`Removed worktree\n${wt.branch ?? "detached"}  →  ${wt.path}\n(branch kept)`,
		"info",
	);
}

async function listAndMaybeOpen(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
): Promise<void> {
	const worktrees = await listWorktrees(pi, cwd);
	if (worktrees.length === 0) {
		ctx.ui.notify("No worktrees found", "info");
		return;
	}
	const mainPath = mainWorktreePath(worktrees);
	const lines = worktrees.map((w) => formatWt(w, mainPath));

	if (!ctx.hasUI) {
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	const choice = await ctx.ui.select(
		"Worktrees (select to start a fresh session in one)",
		lines,
	);
	if (!choice) return;
	const picked = worktrees.find((w) => formatWt(w, mainPath) === choice);
	if (!picked) return;

	await activateWorktree(pi, ctx, picked.path, picked.branch ?? "detached", false);
}

async function createFromPr(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
	prNumber: string,
): Promise<void> {
	if (!/^\d+$/.test(prNumber)) {
		ctx.ui.notify(`Usage: /worktree pr <number>\nGot: ${prNumber}`, "error");
		return;
	}

	// The PR flow below fetches into local refs. Guard before the first
	// mutating fetch so a refused switch leaves the repository untouched.
	if (ctx.mode === "tui") {
		const refusal = switchRefusal(pi, ctx);
		if (refusal) {
			ctx.ui.notify(`${refusal}\n\nThe worktree was not created.`, "warning");
			return;
		}
	}

	// A fork PR may call its branch "main" or use any other local branch name.
	// Its head name is display-only: never fetch into or open that local branch.
	prNumber = BigInt(prNumber).toString();
	const view = await pi.exec(
		"gh",
		["pr", "view", prNumber, "--json", "headRefName,headRefOid,title"],
		{ cwd },
	);

	if ((view.code ?? 1) !== 0) {
		ctx.ui.notify(
			`gh pr view ${prNumber} failed:\n${(view.stderr || view.stdout || "").trim()}\n\nIs GitHub CLI installed and authenticated?`,
			"error",
		);
		return;
	}

	let data: { headRefName?: unknown; headRefOid?: unknown; title?: unknown };
	try {
		data = JSON.parse(view.stdout ?? "{}");
		if (!data || typeof data !== "object") throw new Error("Invalid PR metadata");
	} catch {
		ctx.ui.notify(`Could not parse gh output:\n${view.stdout}`, "error");
		return;
	}
	if (typeof data.headRefName !== "string" || !data.headRefName ||
		typeof data.headRefOid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(data.headRefOid)) {
		ctx.ui.notify(`PR #${prNumber} has no valid head branch and commit; refusing to create a worktree.`, "error");
		return;
	}

	const expectedHead = data.headRefOid.toLowerCase();
	const fetchedRef = `refs/piastra/pull/${prNumber}/head`;
	const branch = `piastra/pr/${prNumber}`;
	const localRef = `refs/heads/${branch}`;
	// Only this private, non-branch ref may be force-updated (PRs can be rebased).
	// Never use shared FETCH_HEAD as a start point: another fetch can replace it.
	const fetchPr = await run(
		pi,
		["fetch", "--no-tags", "origin", `+refs/pull/${prNumber}/head:${fetchedRef}`],
		cwd,
	);
	if (fetchPr.code !== 0) {
		ctx.ui.notify(`Could not fetch PR #${prNumber}:\n${fetchPr.stderr || fetchPr.stdout}\n\nNo worktree was opened.`, "error");
		return;
	}
	const fetched = await run(pi, ["rev-parse", "--verify", `${fetchedRef}^{commit}`], cwd);
	if (fetched.code !== 0 || fetched.stdout !== expectedHead) {
		ctx.ui.notify(
			`Fetched head does not match PR #${prNumber}.\nExpected: ${expectedHead}\nFetched: ${fetched.stdout || fetched.stderr}\n\n` +
			"The PR may have changed, or gh and origin may refer to different repositories. Check origin and retry; no worktree was opened.",
			"error",
		);
		return;
	}

	// Exact managed branch only. General add/open's slug and suffix aliases are
	// convenient for manual navigation, but cannot prove PR identity.
	const worktrees = await listWorktrees(pi, cwd);
	const existing = worktrees.find((wt) => wt.branch === branch);
	const hasLocal = await refExists(pi, cwd, localRef);
	if (hasLocal) {
		const local = await run(pi, ["rev-parse", "--verify", `${localRef}^{commit}`], cwd);
		if (local.code !== 0 || local.stdout !== expectedHead) {
			ctx.ui.notify(
				`Refusing to open PR #${prNumber}: existing branch ${branch} differs from the PR head.\n` +
				`Expected: ${expectedHead}\nLocal: ${local.stdout || local.stderr}\n\n` +
				"The branch and any worktree/local changes are preserved. To create a fresh checkout, rename the existing branch and move its worktree away from the managed path before retrying; nothing was reset.",
				"error",
			);
			return;
		}
	}

	const path = existing?.path ?? resolveWorktreePath(mainWorktreePath(worktrees) || cwd, branch);
	if (!existing) {
		const pathTaken = worktrees.find((wt) => wt.path === path);
		if (pathTaken) {
			ctx.ui.notify(`Path already used by another worktree:\n${path}\n(${pathTaken.branch ?? "detached"})`, "error");
			return;
		}
		if (ctx.mode === "tui") {
			const refusal = switchRefusal(pi, ctx);
			if (refusal) {
				ctx.ui.notify(`${refusal}\n\nThe worktree was not created.`, "warning");
				return;
			}
		}
		const add = await run(
			pi,
			hasLocal
				? ["worktree", "add", path, branch]
				: ["worktree", "add", "-b", branch, path, expectedHead],
			cwd,
		);
		if (add.code !== 0) {
			ctx.ui.notify(`worktree add failed:\n${add.stderr || add.stdout}`, "error");
			return;
		}
	}

	// Check the actual checkout, not just a possibly stale worktree-list entry.
	// This also fails closed if another Git operation changed it while we waited.
	const head = await run(pi, ["rev-parse", "--verify", "HEAD^{commit}"], path);
	const checkedOutRef = await run(pi, ["symbolic-ref", "--quiet", "HEAD"], path);
	if (head.code !== 0 || head.stdout !== expectedHead || checkedOutRef.code !== 0 || checkedOutRef.stdout !== localRef) {
		ctx.ui.notify(
			`Refusing to open PR #${prNumber}: worktree no longer matches ${branch} at ${expectedHead}.\n` +
			`Worktree kept at:\n${path}\n\nNo session switch was attempted; inspect the checkout and retry.`,
			"error",
		);
		return;
	}
	ctx.ui.notify(`PR #${prNumber}${typeof data.title === "string" ? `: ${data.title}` : ""}\n${data.headRefName} → ${branch} (${shortHead(expectedHead)})`, "info");
	const outcome = await activateWorktree(pi, ctx, path, branch, !existing);
	if (!existing && outcome && outcome !== "switched") {
		reportCreatedWorktreeNotSwitched(ctx, branch, path, outcome);
	}
}

/**
 * Switch the running CLI to an existing session file (any checkout of the
 * repository). `ctx.switchSession` rebuilds the runtime in the session's own
 * cwd, so tools, Git and PiAstra workers follow it — the same mechanism
 * `/worktree open` uses for a fresh session, with the same guards.
 */
async function switchToSessionFile(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	target: { path: string; cwd: string; label: string },
	branch: string,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			`Session switching is available only in the interactive CLI.\nResume it with:\ncd "${target.cwd}" && pi --session "${target.path}"`,
			"info",
		);
		return;
	}
	const refusal = switchRefusal(pi, ctx);
	if (refusal) {
		ctx.ui.notify(`${refusal}\n\nThe session was not changed.`, "warning");
		return;
	}
	try {
		const result = await ctx.switchSession(target.path, {
			withSession: async (replacement) => {
				replacement.ui.notify(
					`Resumed "${target.label}" in ${branch}\n${target.cwd}\n\nTools, extensions, Git and PiAstra workers now use this checkout.`,
					"info",
				);
			},
		});
		if (result.cancelled) {
			ctx.ui.notify("Session switch was cancelled; the current conversation is unchanged.", "warning");
		}
	} catch (error: any) {
		try {
			ctx.ui.notify(`Could not resume the session:\n${error?.message || error}`, "error");
		} catch { /* the old context may be gone after teardown */ }
	}
}

/**
 * `/worktree resume`: every session of the repository, grouped by checkout,
 * in one picker. Picking a session switches to it (in its own checkout);
 * picking a checkout header starts a fresh session there. Sessions that never
 * received a message are pruned on the way — they are the leftovers of
 * fresh-session switches nobody typed into.
 */
async function resumeAcrossWorktrees(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
): Promise<void> {
	const worktrees = await listWorktrees(pi, cwd);
	if (worktrees.length === 0) {
		ctx.ui.notify("No worktrees found", "info");
		return;
	}
	const all = await SessionManager.listAll();
	const repoSessions = all.filter((info) =>
		worktrees.some((wt) => sameCheckoutPath(wt.path, info.cwd)),
	);
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	const removed = await pruneEmptySessions(repoSessions, currentSessionFile);
	const groups = groupSessions(worktrees, repoSessions, ctx.cwd);
	const { lines, targets } = renderPicker(groups, { currentSessionFile, home: homedir() });

	if (!ctx.hasUI) {
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}
	const title = removed.length > 0
		? `Sessions across worktrees (removed ${removed.length} empty session file${removed.length === 1 ? "" : "s"})`
		: "Sessions across worktrees";
	const choice = await ctx.ui.select(title, lines);
	if (!choice) return;
	const target = targets[lines.indexOf(choice)];
	if (!target) return;
	if (target.kind === "worktree") {
		await activateWorktree(pi, ctx, target.path, target.branch, false);
		return;
	}
	if (target.live) {
		ctx.ui.notify("That is the current session.", "info");
		return;
	}
	const branch = groups.find((g) => sameCheckoutPath(g.worktree.path, target.cwd))?.worktree.branch ?? "detached";
	await switchToSessionFile(pi, ctx, target, branch);
}

function parseArgs(raw: string): { cmd: string; rest: string } {
	const trimmed = raw.trim();
	if (!trimmed) return { cmd: "ls", rest: "" };
	const [first, ...restParts] = trimmed.split(/\s+/);
	const rest = restParts.join(" ").trim();
	const sub = first.toLowerCase();
	if (["ls", "list", "add", "open", "rm", "remove", "pr", "resume", "help"].includes(sub)) {
		return { cmd: sub === "list" ? "ls" : sub === "remove" ? "rm" : sub, rest };
	}
	// Default: treat first token (and rest) as branch name for add.
	return { cmd: "add", rest: trimmed };
}

export default function (pi: ExtensionAPI) {
	const command: Parameters<ExtensionAPI["registerCommand"]>[1] = {
		description:
			"Create, list, open, resume, or remove git worktrees (/worktree, /worktree ls|add|open|rm|pr|resume)",
		getArgumentCompletions: (prefix) => {
			const subs = ["ls", "add", "open", "rm", "pr", "resume", "help"];
			const p = prefix.trim();
			// Complete subcommands only for the first token.
			if (!p.includes(" ")) {
				const hits = subs.filter((s) => s.startsWith(p));
				return hits.map((s) => ({ value: s, label: s }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			const cwd = await ensureRepo(pi, ctx);
			if (!cwd) return;

			const { cmd, rest } = parseArgs(args);

			switch (cmd) {
				case "help": {
					ctx.ui.notify(
						[
							"/wt is an alias for /worktree (all subcommands)",
							"/worktree                 list + pick (fresh session there)",
							"/worktree ls              list",
							"/worktree <branch>        create + fresh session there",
							"/worktree add <branch>    create + fresh session there",
							"/worktree open <branch>   fresh session there",
							"/worktree rm <branch>     remove (keeps branch)",
							"/worktree pr <number>     worktree from PR",
							"/worktree resume          pick a session from any checkout (switches there)",
						].join("\n"),
						"info",
					);
					return;
				}
				case "ls": {
					await listAndMaybeOpen(pi, ctx, cwd);
					return;
				}
				case "add": {
					if (!rest) {
						ctx.ui.notify("Usage: /worktree add <branch>", "error");
						return;
					}
					const branch = rest.split(/\s+/)[0];
					await createWorktree(pi, ctx, cwd, branch);
					return;
				}
				case "open": {
					if (!rest) {
						ctx.ui.notify("Usage: /worktree open <branch>", "error");
						return;
					}
					await openWorktree(pi, ctx, cwd, rest.split(/\s+/)[0]);
					return;
				}
				case "rm": {
					if (!rest) {
						ctx.ui.notify("Usage: /worktree rm <branch>", "error");
						return;
					}
					await removeWorktree(pi, ctx, cwd, rest.split(/\s+/)[0]);
					return;
				}
				case "resume": {
					await resumeAcrossWorktrees(pi, ctx, cwd);
					return;
				}
				case "pr": {
					if (!rest) {
						ctx.ui.notify("Usage: /worktree pr <number>", "error");
						return;
					}
					await createFromPr(pi, ctx, cwd, rest.split(/\s+/)[0]);
					return;
				}
				default: {
					ctx.ui.notify(`Unknown /worktree command: ${cmd}`, "error");
				}
			}
		},
	};
	pi.registerCommand("worktree", command);
	pi.registerCommand("wt", { ...command, description: "Alias for /worktree" });
}
