import { join } from 'node:path';
import { completeDispatchSetup, readDispatchState, seedDispatchConfiguration } from './state.mjs';
import { ensurePlainPi } from './pi-install.mjs';

const CODEX_PROVIDER = 'openai-codex';
const GO_PROVIDER = 'opencode-go';
const LUNA_MODEL = 'openai-codex/gpt-5.6-luna';
const ASTRA_MODEL = 'openai-codex/gpt-6-astra';

/**
 * Explicit first-run setup wizard. All Pi SDK imports are dynamic and happen
 * only after Dispatch isolation env is set; this module itself is
 * side-effect free on import. Tests inject `io`, `ensurePi` and
 * `createModelRuntime` so no real `pi` probe/install, auth files, or model
 * calls ever run under test.
 */
export async function runSetup({
  paths,
  io,
  signal,
  ensurePi = ensurePlainPi,
  createModelRuntime,
} = {}) {
  if (!paths?.agentDir || !paths?.stateFile) throw new Error('Setup requires Dispatch paths.');
  if (!io || typeof io.prompt !== 'function' || typeof io.notify !== 'function' ||
      typeof io.info !== 'function' || typeof io.confirm !== 'function') {
    throw new Error('Setup requires an interaction channel.');
  }
  signal?.throwIfAborted?.();

  // Capture inherited isolation env so tests (and callers) never leak the
  // Dispatch override globally; the launcher sets it for the actual run.
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  let runtime;
  try {
    // Explicit setup step only: never an install hook. Probe first so a missing
    // plain `pi` offers the pinned global install before any config is seeded.
    await ensurePi({
      confirm: (text) => io.confirm(text),
      info: (text) => io.info(text),
      signal,
    });
    signal?.throwIfAborted?.();

    await seedDispatchConfiguration(paths);
    signal?.throwIfAborted?.();

    // Isolate the Pi SDK before it loads: ignore inherited PI_* dirs and point
    // the child/runtime config at the Dispatch agent directory.
    process.env.PI_CODING_AGENT_DIR = paths.agentDir;
    process.env.PI_CODING_AGENT_SESSION_DIR = join(paths.agentDir, 'sessions');

    const create = createModelRuntime ?? defaultCreateModelRuntime;
    try {
      runtime = await create({
        authPath: join(paths.agentDir, 'auth.json'),
        modelsPath: join(paths.agentDir, 'models.json'),
        modelsStorePath: join(paths.agentDir, 'models-store.json'),
        refreshOnCreate: false,
        allowModelNetwork: false,
        signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'EABORT') throw error;
      throw new Error('Setup could not start the model runtime. Run dispatch setup again.');
    }
    signal?.throwIfAborted?.();
    const interaction = toLoginInteraction(io, signal);

    // Metadata-only listing: never resolve secrets, env, or commands.
    let credentials = [];
    try {
      credentials = [...(await runtime.listCredentials({ signal }))];
    } catch {
      throw new Error('Setup could not read Dispatch credentials. Run dispatch setup again.');
    }
    const has = (providerId, type) =>
      credentials.some((c) => c?.providerId === providerId && c?.type === type);

    // Mandatory Codex OAuth. An existing api_key credential must NOT satisfy
    // this step: OAuth is required.
    if (!has(CODEX_PROVIDER, 'oauth')) {
      io.info('Codex sign-in is required to finish setup.');
      await loginSafely(runtime, CODEX_PROVIDER, 'oauth', interaction, 'Codex sign-in');
      try {
        credentials = [...(await runtime.listCredentials({ signal }))];
      } catch {
        throw new Error('Setup could not read Dispatch credentials. Run dispatch setup again.');
      }
      if (!credentials.some((c) => c?.providerId === CODEX_PROVIDER && c?.type === 'oauth')) {
        throw new Error('Codex sign-in did not complete. Run dispatch setup again.');
      }
    } else {
      io.info('Codex sign-in found; keeping the stored credential.');
    }

    // Optional Go: a previous explicit choice is preserved on rerun, but a
    // stored 'configured' marker without the credential must NOT count as
    // authenticated: re-prompt (or refuse) instead of claiming completion.
    let go;
    try {
      go = (await readDispatchState(paths))?.go;
    } catch {
      throw new Error('Dispatch state is malformed. Fix or remove it, then run dispatch setup again.');
    }
    if (go === 'configured' && !has(GO_PROVIDER, 'api_key')) {
      // Credential was removed after a previous run: ask again.
      go = undefined;
    }
    if (go !== 'configured' && go !== 'skipped') {
      if (has(GO_PROVIDER, 'api_key')) {
        go = 'configured';
        io.info('Go API key found; keeping the stored credential.');
      } else {
        go = await chooseGo(io, signal);
        if (go === 'configured') {
          await loginSafely(runtime, GO_PROVIDER, 'api_key', interaction, 'Go API key setup');
          try {
            credentials = [...(await runtime.listCredentials({ signal }))];
          } catch {
            throw new Error('Setup could not read Dispatch credentials. Run dispatch setup again.');
          }
          if (!credentials.some((c) => c?.providerId === GO_PROVIDER && c?.type === 'api_key')) {
            throw new Error('Go API key setup did not complete. Run dispatch setup again.');
          }
        }
      }
    }

    // Verify the required local model catalog entries (no network/inference):
    // Luna is required when Go was skipped; the default Astra orchestrator
    // model is always verified when a real catalog exists.
    verifyRequiredModels(runtime, go);

    signal?.throwIfAborted?.();
    const state = await completeDispatchSetup(paths, { go });
    io.info('Setup complete.');
    return state;
  } finally {
    // ModelRuntime exposes no dispose today; only clean up when it exists.
    try {
      if (typeof runtime?.dispose === 'function') await runtime.dispose();
    } catch { /* best effort */ }
    try {
      await io.dispose?.();
    } catch { /* best effort */ }
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDir;
  }
}

async function defaultCreateModelRuntime(options) {
  try {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    return await ModelRuntime.create({
      authPath: options.authPath,
      modelsPath: options.modelsPath,
      modelsStorePath: options.modelsStorePath,
      refreshOnCreate: false,
      allowModelNetwork: false,
      signal: options.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'EABORT') throw error;
    throw new Error('Setup could not start the model runtime. Run dispatch setup again.');
  }
}

/**
 * Adapt injected `io` to the SDK AuthInteraction: combine the outer setup
 * signal with each per-prompt signal (manual prompt aborts when the OAuth
 * callback wins) without letting an outer Ctrl+C leak into unrelated flows.
 * Rejects blank secret input and `!command` input (even with leading
 * whitespace) so the SDK never executes commands or stores empty keys, and
 * never surfaces raw SDK values/errors to the terminal.
 */
function toLoginInteraction(io, outerSignal) {
  return {
    signal: outerSignal,
    async prompt(input) {
      const combined = combineSignals(outerSignal, input?.signal);
      try {
        const value = await io.prompt(
          input && typeof input === 'object' ? { ...input, signal: combined.signal } : input,
        );
        if ((input?.type === 'secret' || input?.type === 'manual_code') && typeof value === 'string') {
          if (value.trim() === '') {
            throw new Error('A value is required. Enter the value directly or cancel setup.');
          }
          if (value.trimStart().startsWith('!')) {
            throw new Error('Command-based secret input is not accepted. Enter the value directly.');
          }
        }
        return value;
      } finally {
        combined.dispose();
      }
    },
    notify(event) {
      // Forward only safe display fields; never raw credential objects.
      io.notify(event);
    },
  };
}

function combineSignals(...signals) {
  const active = signals.filter((s) => s && typeof s.aborted === 'boolean');
  const controller = new AbortController();
  const onAbort = () => {
    try { controller.abort(); } catch { /* ignore */ }
  };
  for (const s of active) {
    if (s.aborted) { onAbort(); break; }
    s.addEventListener?.('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const s of active) s.removeEventListener?.('abort', onAbort);
    },
  };
}

async function loginSafely(runtime, providerId, type, interaction, stage) {
  try {
    await runtime.login(providerId, type, interaction);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'EABORT') throw error;
    // CredentialSynchronizationError means the credential committed but the
    // local snapshot did not sync: report a generic retry, never the
    // credential or cause.
    if (error?.name === 'CredentialSynchronizationError') {
      throw new Error(`${stage} was saved but setup could not finish syncing. Run dispatch setup again.`);
    }
    if (error instanceof Error && (
      error.message === 'Command-based secret input is not accepted. Enter the value directly.' ||
      error.message === 'A value is required. Enter the value directly or cancel setup.'
    )) {
      throw error;
    }
    // Raw SDK errors can contain secrets (token exchange); always redact.
    throw new Error(`${stage} failed. Run dispatch setup again.`);
  }
}

async function chooseGo(io, signal) {
  signal?.throwIfAborted?.();
  const choice = await io.prompt({
    type: 'select',
    message: 'Configure a Go API key (optional)?',
    options: [
      { id: 'configure', label: 'Configure', description: 'Store a Go API key' },
      { id: 'skip', label: 'Skip', description: 'Use Codex for General and Fast' },
    ],
    ...(signal ? { signal } : {}),
  });
  if (choice === 'configure') return 'configured';
  if (choice === 'skip') return 'skipped';
  // Blank/unknown answers must never silently become "skipped".
  throw new Error('Invalid choice.');
}

function verifyRequiredModels(runtime, go) {
  // Local catalog only: never availability/network inference.
  const needsLuna = go !== 'configured';
  try {
    if (typeof runtime?.getModel !== 'function') return; // synthetic runtime without catalog
    if (needsLuna) {
      const [lunaProvider, ...lunaRest] = LUNA_MODEL.split('/');
      const luna = runtime.getModel(lunaProvider, lunaRest.join('/'));
      if (luna === undefined || luna === null) {
        throw new Error(`Setup could not verify the required model ${LUNA_MODEL}. Run dispatch setup again.`);
      }
    }
    const [astraProvider, ...astraRest] = ASTRA_MODEL.split('/');
    const astra = runtime.getModel(astraProvider, astraRest.join('/'));
    if (astra === undefined || astra === null) {
      throw new Error(`Setup could not verify the required model ${ASTRA_MODEL}. Run dispatch setup again.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Setup could not verify the required model')) throw error;
    // Catalog read failures fail closed: the catalog could not be verified.
    throw new Error('Setup could not verify the required models. Run dispatch setup again.');
  }
}
