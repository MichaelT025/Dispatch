import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

test('/exit requests graceful shutdown without replacing /quit', async () => {
  const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
  const { extensions, errors } = await loadExtensions([entry], process.cwd());
  assert.deepEqual(errors, []);
  const commands = extensions[0].commands;
  assert.equal(commands.has('quit'), false);
  const exit = commands.get('exit');
  assert.ok(exit);
  assert.match(exit.description, /alias for \/quit/);
  let shutdowns = 0;
  await exit.handler('', { shutdown() { shutdowns++; } });
  assert.equal(shutdowns, 1);
});
