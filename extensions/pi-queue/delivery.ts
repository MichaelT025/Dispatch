import { AsyncLocalStorage } from "node:async_hooks";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	AgentSession,
	type ExtensionAPI,
	type PromptOptions,
} from "@earendil-works/pi-coding-agent";

/**
 * Acknowledged delivery for Pi's fire-and-forget `sendUserMessage`.
 *
 * `ExtensionAPI.sendUserMessage` returns `void` and discards the underlying
 * `AgentSession.prompt()` promise, so an extension cannot tell a prompt that
 * was actually accepted (preflight cleared and the run started/queued) from
 * one rejected before it ever reached the agent. A queued row that assumed
 * success and removed itself would then be lost.
 *
 * The bridge wraps `AgentSession.prototype.prompt` once per process and uses
 * an `AsyncLocalStorage` request scope: only our own `sendUserMessage`
 * invocation runs inside it, the wrapper claims the request, injects a
 * `preflightResult` callback next to any existing one, and returns the
 * original full-run promise untouched. Nested or unrelated prompt calls run
 * outside the scope (see `als.exit` below) and can never steal the
 * acknowledgement.
 */

/** Generic rejection surface used when Pi's prompt preflight returns false. */
export const PREFLIGHT_REJECTION_MESSAGE = "Queued prompt was rejected before it started";

export interface AckSendOptions {
	/** Delivery mode while streaming: "steer" or "followUp". */
	deliverAs?: "steer" | "followUp";
	/** Dispatch extension commands and expand skill/prompt templates. */
	expandPromptTemplates?: boolean;
}

type PromptMethod = AgentSession["prompt"];
type PromptHost = { prompt: PromptMethod } & Record<PropertyKey, unknown>;
type SendContent = string | (TextContent | ImageContent)[];

interface AckRequest {
	/** Set by the prompt wrapper when it adopts this request. */
	claimed: boolean;
	/** Guards against a second resolve/reject from a late prompt. */
	settled: boolean;
	resolve(): void;
	reject(error: Error): void;
}

interface BridgeState {
	als: AsyncLocalStorage<AckRequest>;
	original: PromptMethod;
}

/**
 * Shared per-process bridge state. `Symbol.for` makes the marker stable across
 * extension module reloads, so `index.ts` being re-evaluated never stacks a
 * second wrapper (which would break the acknowledgement handshake).
 */
const BRIDGE_STATE = Symbol.for("@piastra/pi-queue.delivery-bridge.v1");

function bridgeState(): BridgeState {
	const proto = AgentSession.prototype as unknown as PromptHost;
	const existing = proto[BRIDGE_STATE] as BridgeState | undefined;
	if (existing) return existing;

	const original = proto.prompt;
	const als = new AsyncLocalStorage<AckRequest>();
	const wrapper = function (
		this: AgentSession,
		text: string,
		options?: PromptOptions,
	): Promise<void> {
		const request = als.getStore();
		// Only the first scoped prompt is ours; anything nested or unrelated
		// falls straight through to the original implementation.
		if (!request || request.claimed) return original.call(this, text, options);
		request.claimed = true;
		const previous = options?.preflightResult;
		const patched: PromptOptions = {
			...(options ?? {}),
			preflightResult: (success: boolean) => {
				if (success) request.resolve();
				else request.reject(new Error(PREFLIGHT_REJECTION_MESSAGE));
				previous?.(success);
			},
		};
		// Leave the ALS scope before entering the original prompt: its own
		// prompts/commands must not be able to claim our request.
		return als.exit(() => original.call(this, text, patched));
	};

	proto[BRIDGE_STATE] = { als, original };
	proto.prompt = wrapper;
	return proto[BRIDGE_STATE] as unknown as BridgeState;
}

/**
 * Send one user message and resolve only once Pi's prompt preflight accepts
 * it. Rejects with the generic preflight error when Pi reports rejection, or
 * with the thrown error when the host invocation itself throws synchronously.
 * Pi's original prompt promise is never awaited here or swallowed: rejection
 * still travels Pi's normal `send_user_message` error path.
 */
export function sendUserMessageWithAck(
	pi: Pick<ExtensionAPI, "sendUserMessage">,
	content: SendContent,
	options?: AckSendOptions,
): Promise<void> {
	const { als } = bridgeState();
	return new Promise<void>((resolve, reject) => {
		const request: AckRequest = {
			claimed: false,
			settled: false,
			resolve: () => {
				if (request.settled) return;
				request.settled = true;
				resolve();
			},
			reject: (error) => {
				if (request.settled) return;
				request.settled = true;
				reject(error);
			},
		};
		try {
			als.run(request, () => {
				pi.sendUserMessage(content, options);
			});
		} catch (error) {
			request.reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		if (!request.claimed) {
			request.reject(new Error("Pi did not acknowledge the queued prompt (unsupported host)"));
		}
	});
}
