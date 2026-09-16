/**
 * Production terminal interaction adapter for the Dispatch setup wizard.
 * Side-effect free on import. `createTerminalInteraction` refuses non-TTY
 * use clearly; injected `io` doubles are allowed in tests (runSetup itself
 * never probes TTY).
 */

import { openBrowser as sharedOpenBrowser } from './browser.mjs';

const CTRL_C = '\x03';
const ENTER_ALIASES = new Set(['\r', '\n', '\r\n']);

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export function createTerminalInteraction({
  stdin = process.stdin,
  stdout = process.stdout,
  signal: outerSignal,
  openBrowser = sharedOpenBrowser,
} = {}) {
  if (!stdin?.isTTY || !stdout?.isTTY) {
    throw new Error('Setup requires an interactive terminal. Run dispatch setup in a TTY.');
  }
  let disposed = false;
  const state = { rawActive: false, onData: null, onEnd: null, onClose: null, prevRaw: false };
  // Rejected when a prompt is pending and dispose/EOF/abort happens.
  let pending = null;

  function write(text) {
    stdout.write(text);
  }

  function restore() {
    if (state.onData && stdin.removeListener) {
      try { stdin.removeListener('data', state.onData); } catch { /* ignore */ }
      state.onData = null;
    }
    if (state.onEnd && stdin.removeListener) {
      try { stdin.removeListener('end', state.onEnd); } catch { /* ignore */ }
      state.onEnd = null;
    }
    if (state.onClose && stdin.removeListener) {
      try { stdin.removeListener('close', state.onClose); } catch { /* ignore */ }
      state.onClose = null;
    }
    if (state.rawActive) {
      try {
        if (typeof stdin.setRawMode === 'function') stdin.setRawMode(state.prevRaw);
      } catch { /* ignore */ }
      try { stdin.pause?.(); } catch { /* ignore */ }
      state.rawActive = false;
    }
    pending = null;
  }

  function dispose() {
    disposed = true;
    const p = pending;
    restore();
    try { outerSignal?.removeEventListener?.('abort', onOuterAbort); } catch { /* ignore */ }
    if (p) {
      try { p.reject(cancelledError()); } catch { /* ignore */ }
    }
  }

  function onOuterAbort() {
    const p = pending;
    restore();
    if (p) {
      try { p.reject(cancelledError()); } catch { /* ignore */ }
    }
  }

  function checkUsable(signal) {
    if (disposed) throw cancelledError();
    outerSignal?.throwIfAborted?.();
    signal?.throwIfAborted?.();
  }

  /** Read one line with echo (text/select/confirm). Resolves without newline. */
  function readLine({ signal, mask = false } = {}) {
    checkUsable(signal);
    return new Promise((resolve, reject) => {
      let buffer = '';
      // Bracketed-paste + escape-sequence filter state. Paste wrappers may
      // span chunks, so carry partial sequences across data events.
      let inPaste = false;
      let escCarry = '';
      const cleanup = () => {
        restore();
        try { outerSignal?.removeEventListener?.('abort', onOuter); } catch { /* ignore */ }
        try { signal?.removeEventListener?.('abort', onInner); } catch { /* ignore */ }
        try { stdin.removeListener?.('end', onStreamEnd); } catch { /* ignore */ }
        try { stdin.removeListener?.('close', onStreamEnd); } catch { /* ignore */ }
        if (pending?.resolve === doResolve) pending = null;
      };
      const doResolve = (value) => { cleanup(); resolve(value); };
      const doReject = (error) => {
        cleanup();
        try { restore(); } catch { /* ignore */ }
        reject(error);
      };
      const onAbort = () => { doReject(cancelledError()); };
      const onOuter = () => onAbort();
      const onInner = () => onAbort();
      const onStreamEnd = () => { doReject(cancelledError()); };
      pending = { resolve: doResolve, reject: doReject };
      outerSignal?.addEventListener?.('abort', onOuter, { once: true });
      signal?.addEventListener?.('abort', onInner, { once: true });

      const prevRaw = Boolean(stdin.isRaw);
      state.prevRaw = prevRaw;
      try {
        if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
      } catch (error) {
        doReject(error);
        return;
      }
      state.rawActive = true;
      try { stdin.resume?.(); } catch { /* ignore */ }

      // Filter one logical stream (carry + chunk) into plain input chars.
      // Escape/navigation sequences are dropped without echo; paste
      // wrappers are consumed and never enter the secret.
      function filterChunk(text) {
        let src = escCarry + text;
        escCarry = '';
        let out = '';
        let i = 0;
        while (i < src.length) {
          if (inPaste) {
            if (src.startsWith(PASTE_END, i)) {
              inPaste = false;
              i += PASTE_END.length;
              continue;
            }
            // A truncated tail may be a partial PASTE_END; hold it.
            const tail = src.slice(i);
            if (PASTE_END.startsWith(tail)) {
              escCarry = tail;
              break;
            }
            out += src[i];
            i += 1;
            continue;
          }
          if (src.startsWith(PASTE_START, i)) {
            inPaste = true;
            i += PASTE_START.length;
            continue;
          }
          if (src[i] === '\x1b') {
            const tail = src.slice(i);
            // Partial escape/paste-start at chunk end: wait for more data.
            if (PASTE_START.startsWith(tail) || PASTE_END.startsWith(tail) ||
                tail === '\x1b' || tail === '\x1b[' || tail === '\x1b[2' ||
                tail === '\x1b[20' || tail === '\x1b[200' || tail === '\x1b[201' ||
                tail === '\x1bO') {
              escCarry = tail;
              break;
            }
            // CSI: ESC [ params intermediates final(@-~). Drop entirely.
            if (tail[1] === '[') {
              const m = tail.match(/^\x1b\[[0-9;?]*[A-Za-z~]/);
              if (m) {
                i += m[0].length;
                continue;
              }
              // Unrecognized CSI tail: drop the ESC and continue.
              i += 1;
              continue;
            }
            // SS3: ESC O + letter (arrows etc). Drop.
            if (tail[1] === 'O' && tail.length >= 3) {
              i += 3;
              continue;
            }
            // Bare ESC or unknown sequence: drop the ESC byte only so no
            // literal escape bytes ever enter secrets.
            i += 1;
            continue;
          }
          out += src[i];
          i += 1;
        }
        return out;
      }

      const onData = (chunk) => {
        let text;
        try {
          text = filterChunk(String(chunk));
        } catch (error) {
          doReject(error);
          return;
        }
        for (const ch of text) {
          if (ch === CTRL_C) {
            doReject(cancelledError());
            return;
          }
          if (ch === '\r' || ch === '\n') {
            write('\n');
            const line = buffer;
            buffer = '';
            doResolve(line);
            return;
          }
          if (ch === '\x7f' || ch === '\b') {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              write('\b \b');
            }
            continue;
          }
          // Drop other control characters (navigation, etc.) without echo
          // so literal bytes never leak into secrets.
          const code = ch.codePointAt(0);
          if (code !== undefined && code < 0x20 && ch !== '\t') continue;
          buffer += ch;
          write(mask ? '*' : ch);
        }
      };
      state.onData = onData;
      state.onEnd = onStreamEnd;
      state.onClose = onStreamEnd;
      stdin.on('data', onData);
      stdin.once?.('end', onStreamEnd);
      stdin.once?.('close', onStreamEnd);
    });
  }

  async function prompt(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid prompt.');
    const kind = input.type;
    if (kind === 'select') {
      const options = Array.isArray(input.options) ? input.options : [];
      if (options.length === 0) throw new Error('Invalid prompt.');
      write(`${input.message ?? 'Choose an option:'}\n`);
      options.forEach((opt, i) => {
        const extra = opt?.description ? ` - ${opt.description}` : '';
        write(`  ${i + 1}) ${opt?.label ?? opt?.id}${extra}\n`);
      });
      for (;;) {
        checkUsable(input.signal);
        write(`Enter a number (1-${options.length}): `);
        const answer = (await readLine({ signal: input.signal })).trim();
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) {
          const picked = options[n - 1];
          if (!picked || typeof picked.id !== 'string') throw new Error('Invalid prompt.');
          return picked.id;
        }
        write(`Enter a number between 1 and ${options.length}.\n`);
      }
    }
    if (kind === 'text') {
      write(`${input.message ?? ''}${input.placeholder ? ` (${input.placeholder})` : ''}\n> `);
      return readLine({ signal: input.signal });
    }
    if (kind === 'secret' || kind === 'manual_code') {
      write(`${input.message ?? 'Enter value:'}\n> `);
      const value = await readLine({ signal: input.signal, mask: true });
      write('\n');
      return value;
    }
    throw new Error('Invalid prompt.');
  }

  function info(text) {
    write(`${String(text)}\n`);
  }

  async function confirm(text) {
    checkUsable();
    write(`${text} [y/N]: `);
    const answer = (await readLine({})).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  }

  function notify(event) {
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'info':
      case 'progress':
        if (typeof event.message === 'string') write(`${event.message}\n`);
        break;
      case 'auth_url': {
        const url = String(event.url ?? '');
        if (event.instructions) write(`${event.instructions}\n`);
        // Print the authorization URL (never callback secrets); open it too.
        write(`${url}\n`);
        void tryOpen(url);
        break;
      }
      case 'device_code': {
        write(`Enter code ${event.userCode} at ${event.verificationUri}\n`);
        break;
      }
      default:
        break;
    }
  }

  async function tryOpen(url) {
    if (!url) return;
    // Shared safe opener (no shell interpolation); injected double in tests.
    try {
      await openBrowser(url);
    } catch { /* print is enough */ }
  }

  const io = { prompt, notify, info, confirm, dispose, isTerminal: true };
  return { io, dispose };
}

function cancelledError() {
  const error = new Error('Setup cancelled.');
  error.name = 'AbortError';
  error.code = 'EABORT';
  return error;
}

export { ENTER_ALIASES };
