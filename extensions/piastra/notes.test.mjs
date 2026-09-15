import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNotes, noteName, sessionRunDir } from './notes.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piastra-notes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test('notes persist between batches/resume and stay isolated by parent session', async t => {
  const dir = await fixture(t);
  const first = createNotes(dir, 'parent-1');
  assert.equal(first.dir, path.join(dir, 'piastra', 'runs', 'parent-1', 'notes'));
  await first.write('api-audit.md', 'Evidence: docs and baseline abc123');
  const resumed = createNotes(dir, 'parent-1');
  assert.match((await resumed.read('api-audit')).text, /baseline abc123/);
  assert.deepEqual((await resumed.list()).details.names, ['api-audit.md']);
  assert.deepEqual((await createNotes(dir, 'parent-2').list()).details.names, []);
});
test('concurrent publication is atomic and cannot overwrite sibling notes', async t => {
  const dir = await fixture(t);
  const notes = createNotes(dir, 'parent');
  const results = await Promise.allSettled([notes.write('same', 'one'), notes.write('same', 'two')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /already exists/);
  assert.match((await notes.read('same')).text, /\n(one|two)$/);
});
test('note paths reject traversal, absolute paths and Windows special names', () => {
  for (const name of ['../x', '/x', 'C:\\x', 'x/y', 'a\\b', '.', 'CON.md', 'NUL', 'a:stream', '', '-bad']) assert.throws(() => noteName(name));
  assert.throws(() => sessionRunDir('/agent', '../escape'));
  assert.equal(noteName('api-audit.md'), 'api-audit.md');
});
test('notes enforce UTF-8 byte limits and cancellation', async t => {
  const notes = createNotes(await fixture(t), 'parent');
  await assert.rejects(notes.write('large', '汉'.repeat(14000)), /40000/);
  await assert.rejects(notes.write('empty', ' '), /nonempty/);
  await assert.rejects(notes.write('cancel', 'text', AbortSignal.abort()));
  assert.deepEqual((await notes.list()).details.names, []);
});
test('notes reject symlinked session directories', async t => {
  const dir = await fixture(t);
  await mkdir(path.join(dir, 'piastra', 'runs'), { recursive: true });
  const outside = path.join(dir, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(dir, 'piastra', 'runs', 'parent'), process.platform === 'win32' ? 'junction' : 'dir');
  const notes = createNotes(dir, 'parent');
  await assert.rejects(notes.write('escape', 'text'), /symlink/);
  await assert.rejects(notes.list(), /symlink/);
});
