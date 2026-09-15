import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEmptySessionText, pruneEmptySessions, removeEmptySession } from './empty-sessions.mjs';

const header = '{"type":"session","version":3,"id":"s1","timestamp":"2026-09-14T22:00:00.000Z","cwd":"/repo"}';
const modelChange = '{"type":"model_change","id":"m1","parentId":null,"timestamp":1,"provider":"p","modelId":"m"}';
const agentEntry = '{"type":"custom","customType":"piastra-agent","id":"c1","parentId":"m1","timestamp":2,"data":{}}';
const message = '{"type":"message","id":"u1","parentId":"c1","timestamp":3,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}';
const named = '{"type":"session_info","id":"n1","parentId":"m1","timestamp":3,"name":"Keep me"}';

test('header-only and settings-only files are empty; anything with content is not', () => {
  assert.equal(isEmptySessionText(`${header}\n`), true);
  assert.equal(isEmptySessionText(`${header}\n${modelChange}\n${agentEntry}\n`), true);
  assert.equal(isEmptySessionText(`${header}\n${modelChange}\n${message}\n`), false);
  assert.equal(isEmptySessionText(`${header}\n${named}\n`), false);
});

test('unreadable or headerless input is never empty', () => {
  assert.equal(isEmptySessionText(''), false);
  assert.equal(isEmptySessionText('not json\n'), false);
  assert.equal(isEmptySessionText(`${modelChange}\n`), false);
  assert.equal(isEmptySessionText(`${header}\n{broken`), false);
});

test('removeEmptySession deletes only empty files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-empty-'));
  const empty = join(dir, 'empty.jsonl');
  const used = join(dir, 'used.jsonl');
  await writeFile(empty, `${header}\n${modelChange}\n`);
  await writeFile(used, `${header}\n${message}\n`);
  assert.equal(await removeEmptySession(empty), true);
  assert.equal(existsSync(empty), false);
  assert.equal(await removeEmptySession(used), false);
  assert.equal(await readFile(used, 'utf8'), `${header}\n${message}\n`);
  assert.equal(await removeEmptySession(join(dir, 'missing.jsonl')), false);
  assert.equal(await removeEmptySession(undefined), false);
});

test('pruneEmptySessions skips the live file, named and non-empty sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-prune-'));
  const files = { a: join(dir, 'a.jsonl'), live: join(dir, 'live.jsonl'), named: join(dir, 'named.jsonl'), used: join(dir, 'used.jsonl') };
  for (const f of Object.values(files)) await writeFile(f, `${header}\n`);
  const infos = [
    { path: files.a, messageCount: 0 },
    { path: files.live, messageCount: 0 },
    { path: files.named, messageCount: 0, name: 'Named' },
    { path: files.used, messageCount: 4 }
  ];
  const removed = await pruneEmptySessions(infos, files.live);
  assert.deepEqual(removed, [files.a]);
  assert.equal(existsSync(files.live), true);
  assert.equal(existsSync(files.named), true);
  assert.equal(existsSync(files.used), true);
});
