import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { runSetup } from './setup.mjs';
import { resolveDispatchPaths } from './state.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryHomes = [];
after(async () => {
  for (const home of temporaryHomes) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makePaths(tag) {
  const home = mkdtempSync(join(tmpdir(), `dispatch-setup-${tag}-`));
  temporaryHomes.push(home);
  return resolveDispatchPaths({ env: {}, home, packageRoot: REPO_ROOT });
}

function makeIo(overrides = {}) {
  const infos = [];
  const state = { prompts: [], ...overrides };
  const io = {
    prompt: state.prompt ?? (async () => { throw new Error('unexpected prompt'); }),
    notify: (e) => infos.push(e),
    info: (t) => infos.push({ type: 'info-text', message: t }),
    confirm: async () => true,
    ...overrides,
  };
  return { io, infos, state };
}

function makeRuntime({ credentials = [], loginImpl, getModelImpl } = {}) {
  const calls = [];
  let creds = [...credentials];
  return {
    calls,
    runtime: {
      async listCredentials() { calls.push('listCredentials'); return [...creds]; },
      async login(providerId, type, interaction) {
        calls.push(`login:${providerId}:${type}`);
        if (loginImpl) return loginImpl(providerId, type, interaction, (c) => { creds = c; });
        creds.push({ providerId, type });
        return { providerId };
      },
      getModel(providerId, modelId) {
        calls.push(`getModel:${providerId}/${modelId}`);
        if (getModelImpl) return getModelImpl(providerId, modelId);
        return { id: modelId };
      },
      // Must never be called by setup:
      async checkAuth() { throw new Error('checkAuth must not be called'); },
      async getAuth() { throw new Error('getAuth must not be called'); },
      async completeSimple() { throw new Error('no inference in setup'); },
    },
  };
}

test('fresh setup: mandatory codex login then explicit go skip seeds Luna', async () => {
  const paths = makePaths('fresh');
  const order = [];
  const { runtime, calls } = makeRuntime();
  const { io, infos } = makeIo({
    prompt: async (p) => {
      assert.equal(p.type, 'select');
      return 'skip';
    },
  });
  const state = await runSetup({
    paths,
    io,
    ensurePi: async () => { order.push('ensurePi'); return { status: 'existing' }; },
    createModelRuntime: async (opts) => {
      order.push('create');
      assert.ok(opts.authPath.endsWith(join('agent', 'auth.json')));
      assert.equal(opts.refreshOnCreate, false);
      assert.equal(opts.allowModelNetwork, false);
      return runtime;
    },
  });
  assert.equal(state.setupComplete, true);
  assert.equal(state.go, 'skipped');
  assert.deepEqual(order, ['ensurePi', 'create']);
  assert.ok(calls.includes('login:openai-codex:oauth'));
  assert.ok(!calls.some((c) => c.startsWith('login:opencode-go')));
  const prefs = JSON.parse(await readFile(join(paths.agentDir, 'piastra', 'agents.json'), 'utf8'));
  assert.deepEqual(prefs.roles.general, { model: 'openai-codex/gpt-5.6-luna', thinking: 'medium' });
  // No raw errors surfaced.
  assert.ok(!infos.join(' ').includes('invalid_grant'));
});

test('existing codex oauth is kept; go configure logs in with api_key', async () => {
  const paths = makePaths('configure');
  const { runtime, calls } = makeRuntime({
    credentials: [{ providerId: 'openai-codex', type: 'oauth' }],
    loginImpl: async (providerId, type, interaction, setCredentials) => {
      const key = await interaction.prompt({ type: 'secret', message: 'Go API key' });
      assert.equal(key, 'go-key-123');
      setCredentials([{ providerId: 'openai-codex', type: 'oauth' }, { providerId, type }]);
    },
  });
  const seen = [];
  const { io } = makeIo({
    prompt: async (p) => {
      if (p.type === 'select') return 'configure';
      if (p.type === 'secret') { seen.push(p); return 'go-key-123'; }
      throw new Error('unexpected prompt ' + p.type);
    },
  });
  const state = await runSetup({
    paths, io,
    ensurePi: async () => ({ status: 'existing' }),
    createModelRuntime: async () => runtime,
  });
  assert.equal(state.go, 'configured');
  // Codex login must NOT rerun when oauth metadata already exists.
  assert.ok(!calls.includes('login:openai-codex:oauth'));
  assert.ok(calls.includes('login:opencode-go:api_key'));
  assert.equal(seen.length, 1);
});

test('existing codex api_key still requires OAuth', async () => {
  const paths = makePaths('apikey');
  const { runtime, calls } = makeRuntime({ credentials: [{ providerId: 'openai-codex', type: 'api_key' }] });
  const { io } = makeIo({ prompt: async () => 'skip' });
  await runSetup({
    paths, io,
    ensurePi: async () => ({ status: 'existing' }),
    createModelRuntime: async () => runtime,
  });
  assert.ok(calls.includes('login:openai-codex:oauth'));
});

test('rerun preserves prior go choice without reprompting', async () => {
  const paths = makePaths('rerun');
  const first = makeRuntime({ credentials: [{ providerId: 'openai-codex', type: 'oauth' }] });
  const { io: io1 } = makeIo({ prompt: async () => 'skip' });
  await runSetup({ paths, io: io1, ensurePi: async () => ({ status: 'existing' }), createModelRuntime: async () => first.runtime });
  let prompted = false;
  const { io: io2 } = makeIo({ prompt: async () => { prompted = true; return 'skip'; } });
  const second = makeRuntime({ credentials: [{ providerId: 'openai-codex', type: 'oauth' }] });
  const state = await runSetup({ paths, io: io2, ensurePi: async () => ({ status: 'existing' }), createModelRuntime: async () => second.runtime });
  assert.equal(state.go, 'skipped');
  assert.equal(prompted, false);
});

test('raw SDK errors are redacted; sync error reports generic retry', async () => {
  const paths = makePaths('redact');
  const secret = 'sk-live-SECRET-TOKEN-xyz';
  const bad = makeRuntime({
    loginImpl: async () => { throw new Error(`token exchange failed: ${secret} invalid_grant`); },
  });
  const { io } = makeIo({ prompt: async () => 'skip' });
  await assert.rejects(() => runSetup({
    paths, io,
    ensurePi: async () => ({ status: 'existing' }),
    createModelRuntime: async () => bad.runtime,
  }), (error) => {
    assert.ok(!String(error.message).includes(secret), 'secret leaked');
    assert.ok(!String(error.message).includes('invalid_grant'));
    return true;
  });

  const paths2 = makePaths('syncretry');
  const syncErr = makeRuntime({
    loginImpl: async () => {
      const e = new Error('sync failed');
      e.name = 'CredentialSynchronizationError';
      throw e;
    },
  });
  const { io: io2 } = makeIo({ prompt: async () => 'skip' });
  await assert.rejects(() => runSetup({
    paths: paths2, io: io2,
    ensurePi: async () => ({ status: 'existing' }),
    createModelRuntime: async () => syncErr.runtime,
  }), /saved but setup could not finish syncing/);
});

test('secret !command input is rejected, never passed to the SDK', async () => {
  const paths = makePaths('bangcmd');
  let sdkSaw = null;
  const { runtime } = makeRuntime({
    loginImpl: async (providerId, type, interaction) => {
      sdkSaw = await interaction.prompt({ type: 'secret', message: 'key' });
      return {};
    },
  });
  const { io } = makeIo({
    prompt: async (p) => {
      if (p.type === 'select') return 'configure';
      return 'whatever';
    },
  });
  // Wrap io so the secret answer is a !command.
  const bangIo = {
    ...io,
    prompt: async (p) => {
      if (p.type === 'secret') return '!cat /etc/passwd';
      return io.prompt(p);
    },
  };
  await assert.rejects(() => runSetup({
    paths, io: bangIo,
    ensurePi: async () => ({ status: 'existing' }),
    createModelRuntime: async () => runtime,
  }), /Command-based secret input/);
  assert.equal(sdkSaw, null);
});

test('empty go key does not become skip: configure failure aborts, skip is explicit', async () => {
  const paths = makePaths('emptykey');
  const { runtime } = makeRuntime({
    credentials: [{ providerId: 'openai-codex', type: 'oauth' }],
    loginImpl: async (providerId, type, interaction) => {
      await interaction.prompt({ type: 'secret', message: 'Go key' });
      throw new Error('empty key rejected by provider');
    },
  });
  const { io } = makeIo({
    prompt: async (p) => {
      if (p.type === 'select') return 'configure';
      if (p.type === 'secret') return '';
      throw new Error('unexpected');
    },
  });
  await assert.rejects(() => runSetup({
    paths, io,
    ensurePi: async () => ({ status: 'existing' }),
    createModelRuntime: async () => runtime,
  }), /A value is required/);
});

test('whitespace-only go key is rejected explicitly', async () => {
  const paths = makePaths('blankgo');
  const { runtime } = makeRuntime({
    credentials: [{ providerId: 'openai-codex', type: 'oauth' }],
    loginImpl: async (providerId, type, interaction) => {
      await interaction.prompt({ type: 'secret', message: 'Go key' });
      throw new Error('must not reach provider');
    },
  });
  const { io } = makeIo({
    prompt: async (p) => {
      if (p.type === 'select') return 'configure';
      if (p.type === 'secret') return '   ';
      throw new Error('unexpected');
    },
  });
  await assert.rejects(() => runSetup({
    paths, io,
    ensurePi: async () => ({ status: 'existing' }),
    createModelRuntime: async () => runtime,
  }), /A value is required/);
});

test('leading-whitespace !command is rejected, never stored', async () => {
  const paths = makePaths('bangws');
  let sdkSaw = 'not-called';
  const { runtime } = makeRuntime({
    credentials: [{ providerId: 'openai-codex', type: 'oauth' }],
    loginImpl: async (providerId, type, interaction) => {
      sdkSaw = await interaction.prompt({ type: 'secret', message: 'Go key' });
      return {};
    },
  });
  const { io } = makeIo({
    prompt: async (p) => {
      if (p.type === 'select') return 'configure';
      if (p.type === 'secret') return '  !do-evil';
      throw new Error('unexpected');
    },
  });
  await assert.rejects(() => runSetup({
    paths, io,
    ensurePi: async () => ({ status: 'existing' }),
    createModelRuntime: async () => runtime,
  }), /Command-based secret input/);
  assert.equal(sdkSaw, 'not-called');
});

test('runtime create failure is generic and redacted', async () => {
  const paths = makePaths('badcreate');
  const secret = 'sk-live-CREATE-SECRET';
  const { io } = makeIo({ prompt: async () => 'skip' });
  await assert.rejects(() => runSetup({
    paths, io,
    ensurePi: async () => ({ status: 'existing' }),
    createModelRuntime: async () => { throw new Error(`auth.json parse ${secret}`); },
  }), (error) => {
    assert.ok(!String(error.message).includes(secret), 'secret leaked');
    assert.match(String(error.message), /could not start the model runtime/i);
    return true;
  });
});

test('create receives explicit modelsStorePath and signal', async () => {
  const paths = makePaths('storepath');
  const { runtime } = makeRuntime({ credentials: [{ providerId: 'openai-codex', type: 'oauth' }] });
  const { io } = makeIo({ prompt: async () => 'skip' });
  const controller = new AbortController();
  let seen;
  await runSetup({
    paths, io, signal: controller.signal,
    ensurePi: async () => ({ status: 'existing' }),
    createModelRuntime: async (opts) => { seen = opts; return runtime; },
  });
  assert.ok(String(seen.modelsStorePath).endsWith(join('agent', 'models-store.json')));
  assert.equal(seen.signal, controller.signal);
  assert.equal(seen.refreshOnCreate, false);
  assert.equal(seen.allowModelNetwork, false);
});

test('stale configured marker without credential re-prompts instead of claiming auth', async () => {
  const paths = makePaths('stalego');
  // Seed a previous run that marked go configured.
  const first = makeRuntime({ credentials: [{ providerId: 'openai-codex', type: 'oauth' }] });
  const { io: io1 } = makeIo({
    prompt: async (p) => {
      if (p.type === 'select') return 'configure';
      if (p.type === 'secret') return 'go-key-1';
      throw new Error('unexpected');
    },
  });
  const withKey = makeRuntime({
    credentials: [{ providerId: 'openai-codex', type: 'oauth' }],
    loginImpl: async (pid, type, interaction, setCreds) => {
      if (pid === 'opencode-go') {
        await interaction.prompt({ type: 'secret', message: 'k' });
        setCreds([{ providerId: 'openai-codex', type: 'oauth' }, { providerId: 'opencode-go', type: 'api_key' }]);
        return {};
      }
      return {};
    },
  });
  await runSetup({ paths, io: io1, ensurePi: async () => ({ status: 'existing' }), createModelRuntime: async () => withKey.runtime });
  // Second run: credential was removed. Must prompt again, not claim complete.
  const second = makeRuntime({ credentials: [{ providerId: 'openai-codex', type: 'oauth' }] });
  let prompted = false;
  const { io: io2 } = makeIo({ prompt: async () => { prompted = true; return 'skip'; } });
  const state = await runSetup({ paths, io: io2, ensurePi: async () => ({ status: 'existing' }), createModelRuntime: async () => second.runtime });
  assert.equal(prompted, true);
  assert.equal(state.go, 'skipped');
});

test('inherited PI env is restored after setup (success and failure)', async () => {
  const paths = makePaths('envok');
  process.env.PI_CODING_AGENT_DIR = '/tmp/inherited-agent';
  process.env.PI_CODING_AGENT_SESSION_DIR = '/tmp/inherited-sessions';
  const { runtime } = makeRuntime({ credentials: [{ providerId: 'openai-codex', type: 'oauth' }] });
  const { io } = makeIo({ prompt: async () => 'skip' });
  await runSetup({ paths, io, ensurePi: async () => ({ status: 'existing' }), createModelRuntime: async () => runtime });
  assert.equal(process.env.PI_CODING_AGENT_DIR, '/tmp/inherited-agent');
  assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, '/tmp/inherited-sessions');
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;

  const paths2 = makePaths('envfail');
  process.env.PI_CODING_AGENT_DIR = '/tmp/keep-me';
  const { io: io2 } = makeIo({ prompt: async () => 'skip' });
  await assert.rejects(() => runSetup({
    paths: paths2, io: io2,
    ensurePi: async () => { throw new Error('probe boom'); },
    createModelRuntime: async () => { throw new Error('must not create'); },
  }));
  assert.equal(process.env.PI_CODING_AGENT_DIR, '/tmp/keep-me');
  assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, undefined);
  delete process.env.PI_CODING_AGENT_DIR;
});

test('catalog read errors fail closed with a generic message', async () => {
  const paths = makePaths('catfail');
  const { runtime } = makeRuntime({
    credentials: [{ providerId: 'openai-codex', type: 'oauth' }],
    getModelImpl: () => { throw new Error('catalog exploded'); },
  });
  const { io } = makeIo({ prompt: async () => 'skip' });
  await assert.rejects(() => runSetup({
    paths, io,
    ensurePi: async () => ({ status: 'existing' }),
    createModelRuntime: async () => runtime,
  }), /could not verify the required model/i);
});
