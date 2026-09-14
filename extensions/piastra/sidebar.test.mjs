import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerSidebar } from './sidebar.mjs';

test('sidebar handles late discovery, deduplicates updates and cleans up', () => {
  const listeners = new Set(), emitted = [];
  const events = {
    on(_channel, fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(_channel, event) { emitted.push(event); for (const fn of listeners) fn(event); },
  };
  const views = new Map();
  const sidebar = createWorkerSidebar(events, views);
  sidebar.publish(); sidebar.publish();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].panel.title, 'Workers · 0 active');
  events.emit('', { version: 1, type: 'discover', requestId: 'late-load' });
  assert.equal(emitted.at(-1).requestId, 'late-load');
  for (let id = 1; id <= 20; id++) views.set(id, { worker: { id, role: 'general', status: 'running', task: 'Task', model: 'test/model' } });
  sidebar.publish();
  const update = emitted.at(-1);
  assert.equal(update.panel.title, 'Workers · 20 active');
  assert.ok(update.panel.rows.length <= 24);
  assert.ok(update.panel.rows.some(row => row.text === '13 more active workers'));
  const live = { id: 21, role: 'fast', status: 'running', started: Date.now() - 4000, activity: 'Reading target', task: 'Check target', model: 'test/model' };
  views.clear();
  views.set(21, { worker: live });
  sidebar.publish();
  assert.match(emitted.at(-1).panel.rows.find(row => row.text.startsWith('#21')).text, / · [34]s$/);
  views.clear(); sidebar.publish();
  assert.equal(emitted.at(-1).panel.title, 'Workers · 0 active');
  sidebar.dispose();
  assert.equal(listeners.size, 0);
  assert.equal(emitted.at(-1).type, 'unregister');
});
