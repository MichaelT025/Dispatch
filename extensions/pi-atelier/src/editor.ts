import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** │ + padding on each side. */
export const EDITOR_FRAME_CHROME = 4;
export const EDITOR_FRAME_MIN_WIDTH = 6;

const RULE_PATTERN = /^─+(?: [↑↓] \d+ more ─*)?(?:\.{0,3})?$/;

export function isEditorRuleText(plain: string): boolean {
	return plain.length > 0 && RULE_PATTERN.test(plain);
}

function padToVisible(text: string, width: number): string {
	const current = visibleWidth(text);
	if (current === width) return text;
	if (current > width) return truncateToWidth(text, width, "");
	return `${text}${" ".repeat(width - current)}`;
}

function expandRule(line: string, width: number): string {
	const plain = stripTerminalSequences(line);
	const body = isEditorRuleText(plain) ? plain : "─".repeat(Math.max(0, visibleWidth(plain)));
	if (visibleWidth(body) >= width) return padToVisible(body, width);
	return `${body}${"─".repeat(width - visibleWidth(body))}`;
}

function findBottomRuleIndex(lines: readonly string[], innerWidth: number): number {
	for (let index = lines.length - 1; index >= 1; index -= 1) {
		const line = lines[index];
		if (!line) continue;
		const plain = stripTerminalSequences(line);
		if (visibleWidth(plain) === innerWidth && isEditorRuleText(plain)) return index;
	}
	return Math.max(0, lines.length - 1);
}

function framedRule(
	innerRule: string,
	outerBodyWidth: number,
	leftCap: string,
	rightCap: string,
	borderColor: (text: string) => string,
): string {
	return borderColor(`${leftCap}${expandRule(innerRule, outerBodyWidth)}${rightCap}`);
}

function framedRow(line: string, innerWidth: number, borderColor: (text: string) => string): string {
	return `${borderColor("│")} ${padToVisible(line, innerWidth)} ${borderColor("│")}`;
}

/** Wrap Pi editor lines in a rounded frame with one column of inner padding. */
export function frameEditorLines(
	inner: readonly string[],
	width: number,
	borderColor: (text: string) => string,
): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	if (safeWidth < EDITOR_FRAME_MIN_WIDTH || inner.length === 0) {
		return inner.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	const innerWidth = safeWidth - EDITOR_FRAME_CHROME;
	const outerBodyWidth = safeWidth - 2;
	const bottom = findBottomRuleIndex(inner, innerWidth);
	const topRule = inner[0] ?? "─".repeat(innerWidth);
	const bottomRule = inner[bottom] ?? "─".repeat(innerWidth);
	const framed: string[] = [framedRule(topRule, outerBodyWidth, "╭", "╮", borderColor)];

	for (let index = 1; index < bottom; index += 1) {
		framed.push(framedRow(inner[index] ?? "", innerWidth, borderColor));
	}
	for (let index = bottom + 1; index < inner.length; index += 1) {
		framed.push(framedRow(inner[index] ?? "", innerWidth, borderColor));
	}

	framed.push(framedRule(bottomRule, outerBodyWidth, "╰", "╯", borderColor));
	return framed.map((line) => truncateToWidth(line, safeWidth, ""));
}

// PiAstra fork: versioned factory capability, mirrored structurally in
// piastra/shortcuts.ts. No cross-package imports: Atelier remains standalone.
const CAPABILITY_KEY = "editorCapability";
const CAPABILITY_VERSION = 1;
const FRAME_ID = "piastra.atelier-frame";

function capability(factory: any): any {
	const value = factory?.[CAPABILITY_KEY];
	return value?.version === CAPABILITY_VERSION &&
		(value.id === "piastra.shortcuts" || value.id === FRAME_ID) &&
		typeof value.readPresentations === "function" ? value : undefined;
}

/** Compose only with PiAstra's explicit capability; leave foreign editors alone. */
export function installAtelierEditor(ctx: any, ownerToken: object): boolean {
	const previous = ctx.ui.getEditorComponent();
	const current = capability(previous);
	const entry = {
		id: FRAME_ID,
		ownerToken,
		chrome: EDITOR_FRAME_CHROME,
		minWidth: EDITOR_FRAME_MIN_WIDTH,
		decorate: (inner: readonly string[], width: number, context: { borderColor: (text: string) => string }) =>
			frameEditorLines(inner, width, context.borderColor),
	};
	if (current?.readPresentations().some((item: any) => item.ownerToken === ownerToken)) return true;
	if (current?.id === "piastra.shortcuts" && typeof current.composePresentation === "function") {
		const factory = current.composePresentation(entry);
		if (!factory) return false;
		ctx.ui.setEditorComponent(factory);
		return true;
	}
	if (previous && current?.id !== FRAME_ID) return false;
	const factory = (tui: any, theme: any, keybindings: any) => new AtelierEditor(tui, theme, keybindings);
	Object.defineProperty(factory, CAPABILITY_KEY, { value: {
		id: FRAME_ID,
		version: CAPABILITY_VERSION,
		readPresentations: () => [entry],
	} });
	ctx.ui.setEditorComponent(factory);
	return true;
}

/** Remove only this session's frame, never another extension's input editor. */
export function clearAtelierEditor(ctx: any, ownerToken: object): void {
	const current = capability(ctx.ui.getEditorComponent());
	if (!current?.readPresentations().some((item: any) => item.ownerToken === ownerToken)) return;
	if (current.id === "piastra.shortcuts") {
		if (typeof current.withoutPresentationsFor !== "function") return;
		const factory = current.withoutPresentationsFor(ownerToken);
		if (factory) ctx.ui.setEditorComponent(factory);
	} else {
		ctx.ui.setEditorComponent(undefined);
	}
}

/** Pi composer with Atelier's rounded frame. Preserves thinking-level borderColor. */
export class AtelierEditor extends CustomEditor {
	override render(width: number): string[] {
		const safeWidth = Math.max(0, Math.trunc(width));
		if (safeWidth < EDITOR_FRAME_MIN_WIDTH) return super.render(safeWidth);
		return frameEditorLines(super.render(safeWidth - EDITOR_FRAME_CHROME), safeWidth, this.borderColor);
	}
}
