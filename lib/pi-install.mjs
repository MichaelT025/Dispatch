import spawn from 'cross-spawn';

export const PI_PINNED_VERSION = '0.85.1';
export const PI_PINNED_SPEC = '@earendil-works/pi-coding-agent@0.85.1';
export const PI_VERSION_ARGS = ['--version'];
export const PI_INSTALL_ARGS = ['install', '-g', '--ignore-scripts', PI_PINNED_SPEC];

function defaultProbe({ timeoutMs }) {
  return spawn.sync('pi', PI_VERSION_ARGS, { stdio: 'ignore', timeout: timeoutMs });
}

/**
 * Async install so AbortSignal cancellation actually kills the child process
 * (node's event loop cannot abort a sync spawn). Resolves to a
 * spawn-compatible result: { status, signal }. Rejects with AbortError on
 * cancellation, or a generic install error otherwise (never leaks output).
 */
function defaultInstall({ timeoutMs, signal }) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('npm', PI_INSTALL_ARGS, { stdio: 'inherit', timeout: timeoutMs, signal });
    } catch (error) {
      if (error?.name === 'AbortError') reject(error);
      else reject(new Error(`Could not install pinned Pi ${PI_PINNED_VERSION}. Run dispatch setup again to retry.`));
      return;
    }
    if (!child || typeof child.on !== 'function') {
      reject(new Error(`Could not install pinned Pi ${PI_PINNED_VERSION}. Run dispatch setup again to retry.`));
      return;
    }
    const onAbort = () => {
      try { child.kill?.('SIGTERM'); } catch { /* ignore */ }
      const error = new Error('Setup cancelled.');
      error.name = 'AbortError';
      error.code = 'EABORT';
      reject(error);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('error', () => {
      signal?.removeEventListener?.('abort', onAbort);
      if (signal?.aborted) {
        const error = new Error('Setup cancelled.');
        error.name = 'AbortError';
        error.code = 'EABORT';
        reject(error);
        return;
      }
      reject(new Error(`Could not install pinned Pi ${PI_PINNED_VERSION}. Run dispatch setup again to retry.`));
    });
    child.on('close', (code, sig) => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ status: code, signal: sig ?? null });
    });
  });
}

/**
 * Ensure a plain `pi` executable exists before Dispatch setup seeds config.
 * Side-effect free on import; all process I/O is injectable for tests.
 *
 * - Any discovered `pi` (any version) is left untouched: Dispatch always uses
 *   its own pinned dependency. A clean probe reports usage via `info`.
 * - Only ENOENT (spawn error code) means absent: asks explicit `confirm`
 *   before a global `npm install -g --ignore-scripts <pinned>`.
 * - A probe that errors, times out, exits nonzero, or is killed by a signal
 *   is NOT proof of a working `pi`: report "could not probe" and leave it
 *   untouched.
 * - Declined or failed installs reject with actionable errors. Never
 *   upgrades an existing `pi`.
 */
export async function ensurePlainPi({
  probe = defaultProbe,
  install = defaultInstall,
  confirm,
  info = () => {},
  timeoutMs = 10_000,
  signal,
} = {}) {
  throwIfAborted(signal);
  let result;
  try {
    result = await probe({ timeoutMs, signal });
  } catch (error) {
    return handleProbeError(error, { install, confirm, info, timeoutMs, signal });
  }
  const code = result?.error?.code;
  if (code === 'ENOENT') {
    return offerInstall({ install, confirm, info, timeoutMs, signal });
  }
  if (result?.error || result?.signal || typeof result?.status === 'number' && result.status !== 0) {
    // Non-ENOENT probe failure (EACCES, ETIMEDOUT, nonzero exit, signal):
    // a `pi` may exist but is not runnable/readable. Leave it alone;
    // Dispatch uses pinned. This is not a successful probe.
    info(
      `Could not probe for a plain 'pi'; leaving any existing install untouched. ` +
      `Dispatch uses its own pinned Pi ${PI_PINNED_VERSION}.`,
    );
    return { status: 'existing' };
  }
  if (result?.status !== 0) {
    info(
      `Could not probe for a plain 'pi'; leaving any existing install untouched. ` +
      `Dispatch uses its own pinned Pi ${PI_PINNED_VERSION}.`,
    );
    return { status: 'existing' };
  }
  info(
    `Found an existing 'pi'; leaving it untouched. ` +
    `Dispatch uses its own pinned Pi ${PI_PINNED_VERSION}.`,
  );
  return { status: 'existing' };
}

function handleProbeError(error, ctx) {
  if (error?.code === 'ENOENT') return offerInstall(ctx);
  if (error?.name === 'AbortError') throw error;
  ctx.info(
    `Could not probe for a plain 'pi'; leaving any existing install untouched. ` +
    `Dispatch uses its own pinned Pi ${PI_PINNED_VERSION}.`,
  );
  return { status: 'existing' };
}

async function offerInstall({ install, confirm, info, timeoutMs, signal }) {
  throwIfAborted(signal);
  if (typeof confirm !== 'function') {
    throw new Error(
      `No plain 'pi' executable was found. To install Pi ${PI_PINNED_VERSION} globally, ` +
      `run: npm ${PI_INSTALL_ARGS.join(' ')}`,
    );
  }
  const agreed = await confirm(
    `No plain 'pi' executable was found. Install pinned Pi ${PI_PINNED_VERSION} globally ` +
    `(npm install -g --ignore-scripts ${PI_PINNED_SPEC})?`,
  );
  throwIfAborted(signal);
  if (!agreed) {
    throw new Error('Setup declined: plain Pi install was not approved. Run dispatch setup again to proceed.');
  }
  let result;
  try {
    result = await install({ timeoutMs: Math.max(timeoutMs, 120_000), signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error(`Could not install pinned Pi ${PI_PINNED_VERSION}. Run dispatch setup again to retry.`);
  }
  throwIfAborted(signal);
  // Critical: only status === 0 with no signal/error counts as success.
  // { status: null, signal: 'SIGINT' } and similar must fail.
  if (result?.error || result?.signal || result?.status !== 0) {
    throw new Error(`Could not install pinned Pi ${PI_PINNED_VERSION}. Run dispatch setup again to retry.`);
  }
  info(`Installed pinned Pi ${PI_PINNED_VERSION} for plain 'pi' use. Dispatch still uses its own copy.`);
  return { status: 'installed' };
}

function throwIfAborted(signal) {
  signal?.throwIfAborted?.();
}
