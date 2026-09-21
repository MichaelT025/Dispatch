export type NotificationRunOutcome = "success" | "failed" | "aborted";

export interface NotificationRunState {
	active: boolean;
	outcome: NotificationRunOutcome;
	inputPromptActive: boolean;
	askUserInputActive: boolean;
	inputRequestSequence: number;
}

export function createNotificationRunState(): NotificationRunState {
	return {
		active: false,
		outcome: "success",
		inputPromptActive: false,
		askUserInputActive: false,
		inputRequestSequence: 0,
	};
}

export function startNotificationRun(state: NotificationRunState): void {
	state.active = true;
	state.outcome = "success";
	state.inputPromptActive = false;
	state.askUserInputActive = false;
	state.inputRequestSequence = 0;
}

export function trackAssistantMessage(state: NotificationRunState, message: unknown): void {
	if (typeof message !== "object" || message === null) return;
	const assistant = message as { role?: unknown; stopReason?: unknown };
	if (assistant.role !== "assistant") return;
	const outcome = assistantOutcome(message);
	if (outcome) state.outcome = outcome;
	else if (assistant.stopReason !== "pending") state.outcome = "success";
}

export function trackAgentEnd(state: NotificationRunState, event: unknown): void {
	if (typeof event !== "object" || event === null) return;
	const agentEnd = event as { aborted?: unknown; messages?: unknown };
	if (agentEnd.aborted === true) {
		state.outcome = "aborted";
		return;
	}
	if (!Array.isArray(agentEnd.messages)) return;
	for (let index = agentEnd.messages.length - 1; index >= 0; index -= 1) {
		const message = agentEnd.messages[index];
		if (typeof message !== "object" || message === null) continue;
		const assistant = message as { role?: unknown; stopReason?: unknown };
		if (assistant.role !== "assistant") continue;
		const outcome = assistantOutcome(message);
		state.outcome = outcome ?? (assistant.stopReason === "pending" ? state.outcome : "success");
		return;
	}
}

export function inputPromptStarted(state: NotificationRunState): boolean {
	if (!state.active) return false;
	const alreadyBlocking = state.inputPromptActive || state.askUserInputActive;
	state.inputPromptActive = true;
	return startBlockingSpan(state, alreadyBlocking);
}

export function inputPromptEnded(state: NotificationRunState): void {
	state.inputPromptActive = false;
	endBlockingSpan(state);
}

export function askUserInputChanged(state: NotificationRunState, active: boolean): boolean {
	if (!active) {
		state.askUserInputActive = false;
		endBlockingSpan(state);
		return false;
	}
	if (!state.active) return false;
	const alreadyBlocking = state.inputPromptActive || state.askUserInputActive;
	state.askUserInputActive = true;
	return startBlockingSpan(state, alreadyBlocking);
}

export function inputRequestKey(state: NotificationRunState): string {
	return `blocking-${state.inputRequestSequence}`;
}

/**
 * The only point at which a native completion notification may be emitted.
 * Agent-end can be retried, followed by queued messages, or represent a worker;
 * all three gates must be clear before this consumes the run state.
 */
export function settleNotificationRun(
	state: NotificationRunState,
	checks: { isIdle: boolean; hasPendingMessages: boolean; activeWorkers: number },
): NotificationRunOutcome | undefined {
	if (
		!state.active ||
		!checks.isIdle ||
		checks.hasPendingMessages ||
		!Number.isFinite(checks.activeWorkers) ||
		checks.activeWorkers !== 0
	)
		return undefined;
	state.active = false;
	state.inputPromptActive = false;
	state.askUserInputActive = false;
	endBlockingSpan(state);
	return state.outcome;
}

function startBlockingSpan(state: NotificationRunState, alreadyBlocking: boolean): boolean {
	if (alreadyBlocking) return false;
	state.inputRequestSequence += 1;
	return true;
}

function endBlockingSpan(state: NotificationRunState): void {
	// Keep the span id monotonic for the whole run. The notifier deduplicates by
	// this key, so resetting it here would suppress a later distinct prompt.
	if (state.inputPromptActive || state.askUserInputActive) return;
}

function assistantOutcome(message: unknown): NotificationRunOutcome | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const assistant = message as { role?: unknown; stopReason?: unknown };
	if (assistant.role !== "assistant") return undefined;
	if (assistant.stopReason === "error") return "failed";
	if (assistant.stopReason === "aborted") return "aborted";
	return undefined;
}
