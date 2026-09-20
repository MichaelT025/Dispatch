import assert from 'node:assert/strict';
import test from 'node:test';

import { createUsageSidebar } from './sidebar.mjs';
import { createSidebarPanelRegistry } from '../pi-atelier/src/sidebar-panels.ts';

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

const snapshot = (usedPercent = 25) => [{
  providerId: 'openai-codex',
  displayName: 'Codex',
  state: 'ok',
  windows: [{ label: '5h', usedPercent, resetsAt: null }],
  fetchedAt: '2026-01-01T00:00:00.000Z',
  checkedAt: '2026-01-01T00:00:00.000Z',
  accountKey: 'opaque-account-secret',
}];

const registers = events => events.emitted
  .map(entry => entry.event)
  .filter(event => event?.type === 'register');

test('publishes only changed presentation data and never leaks account identity', () => {
  const events = new FakeEvents();
  const sidebar = createUsageSidebar(events, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });

  assert.equal(registers(events).length, 1);
  sidebar.update([]);
  assert.equal(registers(events).length, 1);
  sidebar.update(snapshot(25));
  assert.equal(registers(events).length, 2);
  sidebar.update(snapshot(25));
  assert.equal(registers(events).length, 2);
  sidebar.update(snapshot(26));
  assert.equal(registers(events).length, 3);

  for (const event of registers(events)) {
    assert.equal(event.source, 'pi-usage');
    assert.equal(event.panel.id, 'dispatch:subscriptions');
    assert.equal(JSON.stringify(event).includes('opaque-account-secret'), false);
    assert.equal(Object.hasOwn(event.panel, 'accountKey'), false);
  }
  sidebar.dispose();
});

test('replays the current register for valid discovery and unregisters once', () => {
  const events = new FakeEvents();
  const sidebar = createUsageSidebar(events, { now: () => 0 });
  const initialCount = registers(events).length;

  events.emit('pi-atelier:sidebar-panels', { version: 1, type: 'discover', requestId: 'atelier-1' });
  assert.equal(registers(events).length, initialCount + 1);
  assert.equal(registers(events).at(-1).requestId, 'atelier-1');
  events.emit('pi-atelier:sidebar-panels', { version: 1, type: 'discover', requestId: 'bad id' });
  assert.equal(registers(events).length, initialCount + 1);

  sidebar.dispose();
  sidebar.dispose();
  const unregistrations = events.emitted.map(entry => entry.event).filter(event => event?.type === 'unregister');
  assert.equal(unregistrations.length, 1);
  assert.deepEqual(unregistrations[0], {
    version: 1,
    type: 'unregister',
    source: 'pi-usage',
    revision: 3,
    id: 'dispatch:subscriptions',
  });
});

test('keeps revisions increasing when a new publisher instance takes over the same bus', () => {
  const events = new FakeEvents();
  const first = createUsageSidebar(events);
  first.dispose();
  const second = createUsageSidebar(events);
  second.update(snapshot(1));
  second.dispose();

  const revisions = events.emitted.map(entry => entry.event)
    .filter(event => event?.source === 'pi-usage')
    .map(event => event.revision);
  assert.deepEqual(revisions, [1, 2, 3, 4, 5]);
});

test('interoperates with the Atelier registry discovery and contribution protocol', () => {
  const events = new FakeEvents();
  const registry = createSidebarPanelRegistry({ events, instanceId: 'test' });
  const sidebar = createUsageSidebar(events, { now: () => 0 });

  let panel = registry.get('dispatch:subscriptions');
  assert.equal(panel?.available, true);
  assert.equal(panel?.source, 'pi-usage');
  assert.equal(panel?.rows.some(row => row.text.includes('Loading subscriptions')), true);

  sidebar.update(snapshot(33));
  panel = registry.get('dispatch:subscriptions');
  assert.equal(panel?.rows.some(row => row.text.includes('33% used')), true);

  registry.requestDiscovery();
  assert.equal(registry.get('dispatch:subscriptions')?.available, true);

  sidebar.dispose();
  assert.equal(registry.get('dispatch:subscriptions'), undefined);
  registry.dispose();
});
