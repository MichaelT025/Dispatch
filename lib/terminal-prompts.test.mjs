import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createTerminalInteraction } from './terminal-prompts.mjs';

function makeStreams({ tty = true } = {}) {
  const stdin = new EventEmitter();
  stdin.isTTY = tty;
  stdin.isRaw = false;
  stdin.setRawMode = function (mode) { this.isRaw = Boolean(mode); };
  stdin.resume = () => {};
  stdin.pause = () => {};
  // EventEmitter has on/removeListener already.
  const out = [];
  const stdout = { isTTY: tty, write: (t) => { out.push(String(t)); return true; } };
  return { stdin, stdout, out };
}

function type(stdin, text) {
  for (const ch of text) stdin.emit('data', ch);
}

test('non-TTY refuses clearly', () => {
  const { stdin, stdout } = makeStreams({ tty: false });
  assert.throws(() => createTerminalInteraction({ stdin, stdout }), /interactive terminal/);
});

test('select prompt maps numbers to ids; reprompts on bad input', async () => {
  const { stdin, stdout, out } = makeStreams();
  const { io, dispose } = createTerminalInteraction({ stdin, stdout });
  const pending = io.prompt({
    type: 'select', message: 'Pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
  });
  await new Promise((r) => setImmediate(r));
  type(stdin, '9\n');
  await new Promise((r) => setImmediate(r));
  type(stdin, '2\n');
  assert.equal(await pending, 'b');
  assert.ok(out.join('').includes('1) A'));
  dispose();
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.isRaw, false);
});

test('secret input is masked even on paste; listeners cleaned up', async () => {
  const { stdin, stdout, out } = makeStreams();
  const { io, dispose } = createTerminalInteraction({ stdin, stdout });
  const pending = io.prompt({ type: 'secret', message: 'Key' });
  await new Promise((r) => setImmediate(r));
  type(stdin, 'pasted-secret-123\n'); // single paste chunk, char-wise
  const value = await pending;
  assert.equal(value, 'pasted-secret-123');
  const text = out.join('');
  assert.ok(!text.includes('pasted-secret-123'), 'raw secret must not echo');
  assert.ok(text.includes('*'));
  assert.equal(stdin.listenerCount('data'), 0);
  dispose();
});

test('Ctrl+C aborts and restores raw mode and listeners', async () => {
  const { stdin, stdout } = makeStreams();
  const { io } = createTerminalInteraction({ stdin, stdout });
  const pending = io.prompt({ type: 'text', message: 'Name' });
  await new Promise((r) => setImmediate(r));
  type(stdin, '\x03');
  await assert.rejects(() => pending, /cancelled/i);
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.isRaw, false);
});

test('notify prints auth_url and device_code without secrets; confirm parses y/N', async () => {
  const { stdin, stdout, out } = makeStreams();
  const opened = [];
  const { io, dispose } = createTerminalInteraction({ stdin, stdout, openBrowser: async (u) => opened.push(u) });
  io.notify({ type: 'auth_url', url: 'https://example.com/auth', instructions: 'Sign in' });
  io.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://example.com/device' });
  io.notify({ type: 'progress', message: 'working...' });
  await new Promise((r) => setTimeout(r, 20));
  const text = out.join('');
  assert.ok(text.includes('https://example.com/auth'));
  assert.ok(text.includes('ABCD-1234'));
  assert.ok(text.includes('https://example.com/device'));
  assert.deepEqual(opened, ['https://example.com/auth']);
  const confirmPending = io.confirm('Proceed?');
  await new Promise((r) => setImmediate(r));
  type(stdin, 'y\n');
  assert.equal(await confirmPending, true);
  dispose();
});

test('bracketed paste wrappers split across chunks are stripped from secret', async () => {
  const { stdin, stdout, out } = makeStreams();
  const { io, dispose } = createTerminalInteraction({ stdin, stdout });
  const pending = io.prompt({ type: 'secret', message: 'Key' });
  await new Promise((r) => setImmediate(r));
  stdin.emit('data', '\x1b[200~pasted-');
  stdin.emit('data', 'secret-123\x1b[201~');
  stdin.emit('data', '\n');
  const value = await pending;
  assert.equal(value, 'pasted-secret-123');
  assert.ok(!out.join('').includes('pasted-secret-123'));
  dispose();
});

test('arrow escape sequences are ignored without literal bytes in value', async () => {
  const { stdin, stdout } = makeStreams();
  const { io, dispose } = createTerminalInteraction({ stdin, stdout });
  const pending = io.prompt({ type: 'secret', message: 'Key' });
  await new Promise((r) => setImmediate(r));
  stdin.emit('data', 'ab');
  stdin.emit('data', '\x1b[A');
  stdin.emit('data', '\x1b[D');
  stdin.emit('data', 'cd\n');
  assert.equal(await pending, 'abcd');
  dispose();
});

test('EOF rejects pending prompt and restores raw mode', async () => {
  const { stdin, stdout } = makeStreams();
  const { io, dispose } = createTerminalInteraction({ stdin, stdout });
  const pending = io.prompt({ type: 'text', message: 'Name' });
  await new Promise((r) => setImmediate(r));
  stdin.emit('end');
  await assert.rejects(() => pending, /cancelled/i);
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.isRaw, false);
  dispose();
});

test('dispose while prompt pending rejects and removes all listeners', async () => {
  const { stdin, stdout } = makeStreams();
  const { io, dispose } = createTerminalInteraction({ stdin, stdout });
  const pending = io.prompt({ type: 'secret', message: 'Key' });
  await new Promise((r) => setImmediate(r));
  dispose();
  await assert.rejects(() => pending, /cancelled/i);
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.isRaw, false);
});

test('auth_url with & uses injected safe opener, never a shell', async () => {
  const { stdin, stdout } = makeStreams();
  const opened = [];
  const { io, dispose } = createTerminalInteraction({ stdin, stdout, openBrowser: async (u) => opened.push(u) });
  io.notify({ type: 'auth_url', url: 'https://example.com/auth?code=abc&state=xyz', instructions: 'Sign in' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(opened, ['https://example.com/auth?code=abc&state=xyz']);
  dispose();
});
