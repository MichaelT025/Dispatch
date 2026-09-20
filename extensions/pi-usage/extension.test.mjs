import assert from 'node:assert/strict';
import test from 'node:test';

import { registerUsageExtension } from './extension.mjs';

class FakeEvents {
  constructor() {
    this.listeners = new Map();
    this.emitted = [];
  }

  on(channel, listener) {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
    return () => listeners.delete(listener);
  }

  emit(channel, event) {
    this.emitted.push({ channel, event });
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(event);
  }
}

function fakePi() {
  const events = new FakeEvents();
  const handlers = new Map();
  const commands = new Map();
  return {
    events,
    commands,
    on(name, handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    emit(name, event, ctx) {
      for (const handler of handlers.get(name) ?? []) handler(event, ctx);
    },
  };
}

const tuiContext = (file) => ({
  mode: 'tui',
  modelRegistry: {},
  sessionManager: { getSessionFile: () => file },
});

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

function injectedExtension({ env = {}, serviceFactory, pollingFactory, sidebarFactory, fetchOne, authResolver } = {}) {
  const pi = fakePi();
  const calls = { auth: 0, fetch: 0, services: [], pollings: [], sidebars: [] };
  const extension = registerUsageExtension(pi, {
    env,
    authResolver: authResolver ?? (() => {
      calls.auth += 1;
      return () => undefined;
    }),
    fetchOne: fetchOne ?? (async () => {
      calls.fetch += 1;
      return undefined;
    }),
    serviceFactory: serviceFactory ?? (options => {
      const service = {
        refreshCalls: 0,
        snapshot: [],
        refresh() {
          this.refreshCalls += 1;
          return Promise.resolve(this.snapshot);
        },
        getSnapshot() { return this.snapshot; },
        disposeCalls: 0,
        dispose() { this.disposeCalls += 1; },
        options,
      };
      calls.services.push(service);
      return service;
    }),
    pollingFactory: pollingFactory ?? (refresh => {
      const polling = { refresh, disposeCalls: 0, dispose() { this.disposeCalls += 1; } };
      calls.pollings.push(polling);
      return polling;
    }),
    sidebarFactory: sidebarFactory ?? (events => {
      const sidebar = { events, updateCalls: 0, disposeCalls: 0, update() { this.updateCalls += 1; }, dispose() { this.disposeCalls += 1; } };
      calls.sidebars.push(sidebar);
      return sidebar;
    }),
  });
  return { pi, extension, calls };
}

test('registration is inert: it only installs lifecycle and command hooks', () => {
  const { pi, extension, calls } = injectedExtension();

  assert.deepEqual(calls, { auth: 0, fetch: 0, services: [], pollings: [], sidebars: [] });
  assert.ok(pi.commands.has('usage'));
  extension.dispose();
  extension.dispose();
  assert.deepEqual(calls, { auth: 0, fetch: 0, services: [], pollings: [], sidebars: [] });
});

test('starts one usage stack for a TUI session, but never for rpc/json/print/worker sessions', () => {
  const { pi, calls } = injectedExtension();

  pi.emit('session_start', {}, tuiContext(undefined));
  assert.equal(calls.auth, 1);
  assert.equal(calls.services.length, 1);
  assert.equal(calls.pollings.length, 1);
  assert.equal(calls.sidebars.length, 1);
  assert.equal(calls.fetch, 0);

  for (const mode of ['rpc', 'json', 'print', 'worker']) {
    pi.emit('session_start', {}, { mode, modelRegistry: {}, sessionManager: { getSessionFile: () => undefined } });
  }
  assert.equal(calls.auth, 1);
  assert.equal(calls.services.length, 1);
  assert.equal(calls.pollings.length, 1);
  assert.equal(calls.sidebars.length, 1);
  assert.equal(calls.fetch, 0);
});

test('does not start usage when disabled by the environment', () => {
  const { pi, calls } = injectedExtension({ env: { DISPATCH_USAGE_DISABLED: '1' } });

  pi.emit('session_start', {}, tuiContext(undefined));
  assert.equal(calls.auth, 0);
  assert.equal(calls.services.length, 0);
  assert.equal(calls.pollings.length, 0);
  assert.equal(calls.sidebars.length, 0);
});

test('replacing a session and shutting down are idempotent and dispose every dependency', () => {
  const { pi, calls } = injectedExtension();

  pi.emit('session_start', {}, tuiContext(undefined));
  const first = [calls.services[0], calls.pollings[0], calls.sidebars[0]];
  pi.emit('session_start', {}, tuiContext(undefined));
  assert.deepEqual(first.map(item => item.disposeCalls), [1, 1, 1]);
  assert.equal(calls.services.length, 2);

  pi.emit('session_shutdown', {}, tuiContext(undefined));
  pi.emit('session_shutdown', {}, tuiContext(undefined));
  assert.deepEqual([calls.services[1], calls.pollings[1], calls.sidebars[1]].map(item => item.disposeCalls), [1, 1, 1]);
});

test('details and refresh commands delegate to the service, while cooldown remains its responsibility', async () => {
  const { pi, calls } = injectedExtension();
  pi.emit('session_start', {}, tuiContext(undefined));
  const service = calls.services[0];
  service.snapshot = [{
    providerId: 'openai-codex', displayName: 'Codex', state: 'ok', windows: [],
    fetchedAt: '2026-01-01T00:00:00.000Z', checkedAt: '2026-01-01T00:00:00.000Z',
    accountKey: 'must-not-be-presented',
  }];
  const command = pi.commands.get('usage').handler;
  const notifications = [];
  const ctx = { ...tuiContext(undefined), ui: { notify: (message, level) => notifications.push({ message, level }) } };

  await command('', ctx);
  assert.equal(service.refreshCalls, 0);
  assert.match(notifications[0].message, /Subscriptions \(account-level\)/);
  assert.equal(notifications[0].message.includes('must-not-be-presented'), false);

  await command('refresh', ctx);
  await command('refresh', ctx);
  assert.equal(service.refreshCalls, 2);
  assert.equal(calls.fetch, 0);
});

test('refresh has no late notification after shutdown', async () => {
  const pending = deferred();
  const notifications = [];
  const { pi, calls } = injectedExtension({
    serviceFactory: options => {
      const service = {
        refreshCalls: 0,
        refresh() { this.refreshCalls += 1; return pending.promise; },
        getSnapshot() { throw new Error('snapshot read after shutdown'); },
        dispose() {},
        options,
      };
      calls.services.push(service);
      return service;
    },
  });
  pi.emit('session_start', {}, tuiContext(undefined));
  const ctx = { ...tuiContext(undefined), ui: { notify: (message, level) => notifications.push({ message, level }) } };
  const commandPromise = pi.commands.get('usage').handler('refresh', ctx);
  pi.emit('session_shutdown', {}, ctx);
  pending.resolve([]);
  await commandPromise;

  assert.deepEqual(notifications, []);
});

test('invalid command arguments show help without refreshing', async () => {
  const { pi, calls } = injectedExtension();
  pi.emit('session_start', {}, tuiContext(undefined));
  const notifications = [];
  const ctx = { ...tuiContext(undefined), ui: { notify: (message, level) => notifications.push({ message, level }) } };

  await pi.commands.get('usage').handler('details please', ctx);
  assert.equal(calls.services[0].refreshCalls, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /Usage: \/usage or \/usage refresh/);
});
