// Unit tests for the acknowledged-delivery bridge (extensions/pi-queue/delivery.ts).
// The bridge wraps AgentSession.prototype.prompt, so these tests install a fake
// prompt on that prototype before the first send and then assert exactly what
// the bridge injects into the real prompt call.
//
// Run: node --experimental-strip-types --test extensions/pi-queue/delivery.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { PREFLIGHT_REJECTION_MESSAGE, sendUserMessageWithAck } from './delivery.ts';

const promptCalls = [];
let promptImpl = async (_text, options) => {
  options?.preflightResult?.(true);
};

// Installed before the bridge's first send, so the bridge captures this
// function as "original" and runs every scoped send through it.
AgentSession.prototype.prompt = function (text, options) {
  promptCalls.push({ text, options });
  return promptImpl(text, options);
};

function makePi(options = {}) {
  return {
    sendUserMessage(content, sendOptions) {
      const session = Object.create(AgentSession.prototype);
      const text = typeof content === 'string'
        ? content
        : content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      const promptOptions = {
        expandPromptTemplates: sendOptions?.expandPromptTemplates ?? false,
        streamingBehavior: sendOptions?.deliverAs,
        ...(options.previousPreflight ? { preflightResult: options.previousPreflight } : {}),
      };
      // Pi's runtime drops the promise but reports its rejection; emulate both.
      session.prompt(text, promptOptions).catch((error) => { options.onPromptError?.(error); });
    },
  };
}

function reset() {
  promptCalls.length = 0;
  promptImpl = async (_text, opts) => { opts?.preflightResult?.(true); };
}

test('resolves only once the real prompt reports preflight acceptance', async () => {
  reset();
  let resolved = false;
  promptImpl = async (_text, opts) => {
    // Pending preflight: the ack must not resolve before the signal.
    await new Promise((resolve) => setImmediate(resolve));
    opts?.preflightResult?.(true);
  };
  const pi = makePi();
  const ack = sendUserMessageWithAck(pi, 'hello').then(() => { resolved = true; });
  assert.equal(resolved, false, 'does not resolve on invocation');
  await ack;
  assert.equal(resolved, true);
});

test('rejects with the generic preflight error when Pi reports rejection', async () => {
  reset();
  const reported = [];
  promptImpl = async (_text, opts) => {
    opts?.preflightResult?.(false);
    throw new Error('authentic prompt error');
  };
  const pi = makePi({ onPromptError: (error) => reported.push(error) });
  await assert.rejects(
    sendUserMessageWithAck(pi, 'hello'),
    (error) => error.message === PREFLIGHT_REJECTION_MESSAGE,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reported.length, 1, 'the original prompt error still travels the runtime error path');
  assert.equal(reported[0].message, 'authentic prompt error');
});

test('preserves a previous preflightResult callback and every other prompt option', async () => {
  reset();
  const seen = [];
  const previous = [];
  promptImpl = async (_text, opts) => {
    seen.push(opts);
    opts?.preflightResult?.(true);
  };
  const pi = makePi({ previousPreflight: (success) => previous.push(success) });
  await sendUserMessageWithAck(pi, 'hello', { deliverAs: 'steer', expandPromptTemplates: true });
  assert.equal(previous.length, 1, 'the pre-existing callback still fires');
  assert.equal(previous[0], true);
  assert.equal(seen[0].streamingBehavior, 'steer', 'deliverAs is passed through');
  assert.equal(seen[0].expandPromptTemplates, true, 'expandPromptTemplates is passed through');
});

test('rejects when the host invocation throws synchronously', async () => {
  reset();
  const pi = { sendUserMessage() { throw new Error('synchronous boom'); } };
  await assert.rejects(sendUserMessageWithAck(pi, 'x'), /synchronous boom/);
});

test('rejects when the host never routes through AgentSession.prompt', async () => {
  reset();
  const pi = { sendUserMessage() { /* drops the call */ } };
  await assert.rejects(sendUserMessageWithAck(pi, 'x'), /unsupported host/);
});

test('nested sends during preflight never claim the outer acknowledgement', async () => {
  reset();
  const pi = makePi();
  promptImpl = async (text, opts) => {
    if (text === 'outer') {
      // Runs outside the ALS request scope, so it must not adopt the outer ack.
      pi.sendUserMessage('nested');
      opts?.preflightResult?.(true);
      return;
    }
    // The nested prompt deliberately never signals preflight.
  };
  await sendUserMessageWithAck(pi, 'outer');
  assert.deepEqual(promptCalls.map((call) => call.text), ['outer', 'nested']);
  const nested = promptCalls.find((call) => call.text === 'nested');
  assert.equal(nested.options.preflightResult, undefined, 'nested prompt is unscoped');
});

test('a duplicate or late preflight signal does not double-settle', async () => {
  reset();
  promptImpl = async (_text, opts) => {
    opts?.preflightResult?.(true);
    opts?.preflightResult?.(true);
    opts?.preflightResult?.(false);
  };
  await sendUserMessageWithAck(makePi(), 'x');
});

test('the prompt bridge installs idempotently across sends', async () => {
  reset();
  await sendUserMessageWithAck(makePi(), 'a');
  const installed = AgentSession.prototype.prompt;
  await sendUserMessageWithAck(makePi(), 'b');
  assert.equal(AgentSession.prototype.prompt, installed, 'repeat sends do not stack wrappers');
});
