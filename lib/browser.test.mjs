import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { openBrowser } from './browser.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.unrefCalled = false;
  }
  unref() {
    this.unrefCalled = true;
    return this;
  }
}

function spawnDouble(capture, { emit = 'spawn' } = {}) {
  return (command, args, options) => {
    capture.command = command;
    capture.args = args;
    capture.options = options;
    const child = new FakeChild();
    capture.child = child;
    if (emit === 'spawn') queueMicrotask(() => child.emit('spawn'));
    else if (emit === 'error') queueMicrotask(() => child.emit('error', new Error('spawn failed')));
    return child;
  };
}

test('windows opener passes & url as single argv with shell:false', { timeout: 5000 }, async () => {
  const capture = {};
  const url = 'http://127.0.0.1:8790/?a=1&b=2';
  await openBrowser(url, { platform: 'win32', spawnProcess: spawnDouble(capture) });
  assert.equal(capture.command, 'rundll32.exe');
  assert.deepEqual(capture.args, ['url.dll,FileProtocolHandler', url]);
  assert.equal(capture.args[1].includes('&'), true);
  assert.equal(capture.options.shell, false);
  assert.equal(capture.options.stdio, 'ignore');
  assert.equal(capture.child.unrefCalled, true);
});

test('posix openers use open/xdg-open with shell:false', { timeout: 5000 }, async () => {
  for (const [platform, command] of [['darwin', 'open'], ['linux', 'xdg-open']]) {
    const capture = {};
    const url = 'https://example.com/path?q=1';
    await openBrowser(url, { platform, spawnProcess: spawnDouble(capture) });
    assert.equal(capture.command, command);
    assert.deepEqual(capture.args, [url]);
    assert.equal(capture.options.shell, false);
  }
});

test('non-HTTP and embedded userinfo are rejected before spawn', { timeout: 5000 }, async () => {
  for (const bad of [
    'ftp://example.com/file',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://user:pass@127.0.0.1:8790/',
    'https://user@127.0.0.1:8790/',
  ]) {
    let spawned = false;
    const spawnProcess = () => {
      spawned = true;
      return new FakeChild();
    };
    // Space URL may throw from URL parse or our guard; both are rejections.
    await assert.rejects(() => openBrowser(bad, { platform: 'linux', spawnProcess }), /Only HTTP/);
    assert.equal(spawned, false, `must not spawn for ${bad}`);
  }
});

test('spawn error rejects via fake EventEmitter child', { timeout: 5000 }, async () => {
  const capture = {};
  await assert.rejects(
    () => openBrowser('http://127.0.0.1:8790/', { platform: 'linux', spawnProcess: spawnDouble(capture, { emit: 'error' }) }),
    /spawn failed/,
  );
});
