// Integration tests for the acknowledged queue-delivery fix, driven through the
// REAL locally installed SDK + extension loader (`@earendil-works/pi-coding-agent`
// from this repo's node_modules) rather than the external PiAstra fork.
//
// The vendored extension `index.ts` and a co-loaded tap extension are discovered
// and executed by the actual DefaultResourceLoader/ExtensionRunner, then driven
// via the real `session.prompt` extension-command path. The session deliberately
// runs with no model, so the real prompt preflight rejects deterministically
// before any network call ("No model selected"). That is the failure the fix must
// survive without losing rows.
//
// Run: node --experimental-strip-types --test extensions/pi-queue/delivery-sdk.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { latestQueueSnapshot } from './queue-persistence.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const queueIndex = join(root, 'extensions', 'pi-queue', 'index.ts');

// Co-extension tap loaded by the real loader. It records every `input` event and
// every Atelier panel publication, and can defer one extension-sourced input
// (returning `{ action: "handled" }` only after the test releases it) so the
// acknowledgement/commit path is exercised without matching payload text.
const tapSource = String.raw`
export default function (pi) {
  const tap = { inputs: [], panels: [], gate: undefined };
  globalThis.__deliverySdkTap = tap;
  pi.on('input', async (event) => {
    tap.inputs.push({
      text: event.text,
      source: event.source,
      streamingBehavior: event.streamingBehavior,
    });
    const gate = tap.gate;
    if (gate && gate.armed && event.source === 'extension') {
      gate.armed = false;
      gate.deferred += 1;
      await new Promise((resolve) => { gate.release = resolve; });
      return { action: 'handled' };
    }
    return { action: 'continue' };
  });
  pi.events.on('pi-atelier:sidebar-panels', (event) => {
    if (event && event.version === 1 && event.type === 'register' && event.panel && event.panel.id === 'piastra:queue') {
      tap.panels.push(event.panel);
    }
  });
};
`;

const delay = (ms) => new Promise((resolveStep) => setTimeout(resolveStep, ms));

/** Bounded polling: integration events settle on the real loader's schedule. */
async function waitFor(predicate, label, { timeout = 8000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(interval);
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
}

async function createHarness() {
  const tmp = await mkdtemp(join(tmpdir(), 'piastra-delivery-sdk-'));
  const cwd = join(tmp, 'work');
  const agentDir = join(tmp, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const tapPath = join(agentDir, 'tap-extension.ts');
  await writeFile(tapPath, tapSource, 'utf8');
  // Isolated settings/agent dir: only the real extension + tap load, no default
  // provider/model, no auth.json, no ambient project extensions.
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ extensions: [queueIndex, tapPath] }, null, 2) + '\n',
    'utf8',
  );

  const services = await createAgentSessionServices({ cwd, agentDir });
  assert.deepEqual(
    services.resourceLoader.getExtensions().errors,
    [],
    'the real loader must load index.ts + tap without errors',
  );
  assert.ok(globalThis.__deliverySdkTap, 'tap extension ran');

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
  });
  await session.bindExtensions({ mode: 'rpc' });
  // The queue extension's session_start schedules a 0ms editor-install timer;
  // flush it while the ctx is still valid, before any test disposes (dispose
  // invalidates the extension ctx without clearing extension-owned timers).
  await delay(20);

  // Force the explicit failure path regardless of any ambient provider
  // credentials the CI environment may expose: no model means the real prompt
  // preflight throws before it ever reaches a provider.
  session.agent.state.model = undefined;
  assert.equal(session.model, undefined, 'harness must run without a model');

  return { session, agentDir, cwd };
}

function latestSnapshot(session) {
  return latestQueueSnapshot(session.sessionManager.getBranch());
}

function userTexts(session) {
  return session.messages
    .filter((message) => message.role === 'user')
    .map((message) => (Array.isArray(message.content)
      ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      : String(message.content)));
}

test('idle /st preflight rejection keeps the row and parks the queue', { timeout: 30000 }, async () => {
  const { session } = await createHarness();
  try {
    await session.prompt('/st keep-me');

    const state = await waitFor(
      () => (globalThis.__piastraPiQueueState?.paused && globalThis.__piastraPiQueueState.pending === 1
        ? globalThis.__piastraPiQueueState
        : undefined),
      'rejected steer to park with exactly one row',
    );
    assert.equal(state.pending, 1);
    assert.equal(state.paused, true);

    const snapshot = await waitFor(() => {
      const snap = latestSnapshot(session);
      return snap && snap.rows.length === 1 && snap.rows[0].text === 'keep-me' ? snap : undefined;
    }, 'persisted queue snapshot containing keep-me');
    assert.equal(snapshot.rows[0].lane, 'steer');
    assert.equal(snapshot.rows[0].text, 'keep-me');

    // The rejected prompt never became real user history.
    assert.deepEqual(userTexts(session), [], 'no user message may contain the rejected row');
    assert.ok(!userTexts(session).some((text) => text.includes('keep-me')));

    // The delivery did go through the real prompt/input path before rejecting.
    const tap = globalThis.__deliverySdkTap;
    assert.ok(
      tap.inputs.some((input) => input.source === 'extension' && input.text.includes('keep-me')),
      'the rejected delivery reached the real input pipeline',
    );

    const panel = tap.panels.at(-1);
    assert.ok(panel, 'queue sidebar panel was published');
    assert.ok(panel.rows.some((row) => row.text.includes('keep-me') && row.text.includes('[Steer]')));
    assert.ok(panel.title.includes('paused'));
  } finally {
    session.dispose();
  }
});

test('/queue-drain rejection retains exact ids/text/order and re-injects both on retry', { timeout: 30000 }, async () => {
  const { session } = await createHarness();
  try {
    await session.prompt('/q one');
    await session.prompt('/q two');
    assert.equal(globalThis.__piastraPiQueueState.pending, 2);
    assert.equal(globalThis.__piastraPiQueueState.paused, true, 'idle /q parks the queue paused');

    await session.prompt('/queue-drain');
    await waitFor(
      () => (globalThis.__piastraPiQueueState?.paused && latestSnapshot(session)?.rows.length === 2
        ? true
        : undefined),
      'rejected drain to keep both rows',
    );

    const rows = () => latestSnapshot(session).rows.map((row) => ({ id: row.id, text: row.text, lane: row.lane }));
    assert.deepEqual(rows(), [
      { id: 'follow-up-1', text: 'one', lane: 'followUp' },
      { id: 'follow-up-2', text: 'two', lane: 'followUp' },
    ]);

    const tap = globalThis.__deliverySdkTap;
    const extensionInputs = () => tap.inputs.filter((input) => input.source === 'extension');
    assert.equal(extensionInputs().length, 1, 'the first drain injected exactly once');
    assert.equal(extensionInputs()[0].text, 'one\ntwo', 'both rows ship in timeline order');

    // A retry still sees the untouched rows: same ids, text, order.
    await session.prompt('/queue-drain');
    await waitFor(() => extensionInputs().length === 2, 'second drain injection');
    // Preflight rejection is asynchronous (Pi >= 0.86 awaits model catalog
    // discovery first); wait for it to re-park the queue before asserting.
    await waitFor(() => (globalThis.__piastraPiQueueState?.paused ? true : undefined), 'rejected retry to re-park the queue');
    assert.equal(extensionInputs()[1].text, 'one\ntwo');
    assert.deepEqual(rows(), [
      { id: 'follow-up-1', text: 'one', lane: 'followUp' },
      { id: 'follow-up-2', text: 'two', lane: 'followUp' },
    ]);
    assert.equal(globalThis.__piastraPiQueueState.pending, 2);
    assert.equal(globalThis.__piastraPiQueueState.paused, true);
  } finally {
    session.dispose();
  }
});

test('deferred extension input gates the drain ack: one injection, then handled acceptance commits', { timeout: 30000 }, async () => {
  const { session } = await createHarness();
  try {
    await session.prompt('/q alpha');
    await session.prompt('/q beta');
    assert.equal(globalThis.__piastraPiQueueState.pending, 2);

    const tap = globalThis.__deliverySdkTap;
    const gate = { armed: true, deferred: 0, release: undefined };
    tap.gate = gate;

    await session.prompt('/queue-drain');
    await waitFor(
      () => (gate.deferred === 1 && typeof gate.release === 'function' ? true : undefined),
      'tap to defer the extension input',
    );

    // Preflight has NOT been signalled yet: rows stay, and extra drains cannot
    // inject a second time because dispatchInFlight guards the lane.
    assert.equal(globalThis.__piastraPiQueueState.pending, 2);
    assert.deepEqual(latestSnapshot(session).rows.map((row) => row.text), ['alpha', 'beta']);
    const extensionInputs = () => tap.inputs.filter((input) => input.source === 'extension');
    assert.equal(extensionInputs().length, 1);

    await session.prompt('/queue-drain');
    await session.prompt('/queue-drain');
    await session.prompt('/queue-drain');
    assert.equal(gate.deferred, 1, 'only one extension input was ever deferred');
    assert.equal(extensionInputs().length, 1, 'repeated drains caused only one injection');
    assert.equal(globalThis.__piastraPiQueueState.pending, 2);

    // Release: the handler reports handled, the real prompt signals preflight
    // true, and the acknowledged rows are committed and tombstoned.
    gate.release();
    await waitFor(
      () => (globalThis.__piastraPiQueueState.pending === 0 ? true : undefined),
      'rows committed after handled acceptance',
    );
    const tombstone = await waitFor(
      () => {
        const snap = latestSnapshot(session);
        return snap && snap.rows.length === 0 ? snap : undefined;
      },
      'empty tombstone snapshot',
    );
    assert.equal(tombstone.paused, true);
    assert.equal(extensionInputs().length, 1, 'release did not inject a duplicate');
  } finally {
    session.dispose();
  }
});

test('unscoped session.prompt still reaches the original prompt and forwards preflightResult', { timeout: 30000 }, async () => {
  const { session } = await createHarness();
  try {
    const calls = [];
    await assert.rejects(
      session.prompt('hello there', { preflightResult: (success) => calls.push(success) }),
      /No model selected/,
    );
    assert.deepEqual(calls, [false], 'the caller-supplied preflight callback fired with the real result');
  } finally {
    session.dispose();
  }
});
