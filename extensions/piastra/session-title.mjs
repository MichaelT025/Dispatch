/**
 * Automatic session titles.
 *
 * Pi only names a session through `/name` (a `session_info` entry); every
 * list falls back to the first user message, which is rarely a good label
 * ("so the fast agent's bread and butter is…"). After the first assistant
 * reply of an unnamed session, one small completion on the `fast` role's
 * model produces a 3–6 word title and stores it with the same
 * `session_info` mechanism, so `/resume`, `/wt resume` and the web UI all
 * show it. The agent_end handler is awaited; failed requests can be retried
 * on a later reply, and a name set by `/name` always wins.
 */

/** Longest title kept, in characters, after cleaning. */
export const TITLE_MAX_CHARS = 60;
/** Most words kept in a title. */
export const TITLE_MAX_WORDS = 8;
/** Characters of the first user message / reply the model gets to see. */
const EXCERPT_CHARS = 1200;

const textOf = message => (Array.isArray(message?.content)
  ? message.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
  : typeof message?.content === 'string' ? message.content : '');
const failedStopReasons = new Set(['error', 'aborted']);
const assistantFailure = messages => messages.find(message =>
  message?.role === 'assistant' && failedStopReasons.has(message.stopReason));

/**
 * The first user message and first assistant reply of a run, as text — or
 * null when the run has no reply yet (nothing worth titling).
 */
export function titleSource(messages) {
  const user = messages.find(m => m?.role === 'user' && textOf(m).trim());
  const assistant = messages.find(m => m?.role === 'assistant' && textOf(m).trim() && !failedStopReasons.has(m.stopReason));
  if (!user || !assistant) return null;
  return { user: textOf(user).trim().slice(0, EXCERPT_CHARS), assistant: textOf(assistant).trim().slice(0, EXCERPT_CHARS) };
}

/** The completion request for a title (system prompt + one user turn). */
export function titleContext(source) {
  return {
    systemPrompt: 'You write short titles for chat sessions between a developer and a coding agent. Reply with the title only: 3 to 6 words, sentence case, no quotes, no trailing period, no emoji. Name the task or subject, not the participants.',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Developer:\n${source.user}\n\nAgent:\n${source.assistant}\n\nTitle:` }],
      timestamp: Date.now()
    }]
  };
}

/**
 * Normalize a model reply into a usable title: first non-empty line, quotes
 * and a "Title:" prefix stripped, trailing punctuation dropped, capped at
 * TITLE_MAX_WORDS words / TITLE_MAX_CHARS characters. Empty → null.
 */
export function cleanTitle(raw) {
  if (typeof raw !== 'string') return null;
  let line = raw.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  line = line.replace(/^(title|session)\s*[:\-–]\s*/i, '');
  line = line.replace(/^["'“”‘’`*_#]+|["'“”‘’`*_]+$/g, '').trim();
  line = line.replace(/[.!。]+$/g, '').trim();
  if (!line) return null;
  const words = line.split(/\s+/).slice(0, TITLE_MAX_WORDS);
  let title = words.join(' ');
  if (title.length > TITLE_MAX_CHARS) title = title.slice(0, TITLE_MAX_CHARS).replace(/\s+\S*$/, '').trim() || title.slice(0, TITLE_MAX_CHARS);
  return title;
}

/** Text of an assistant message returned by `complete`. */
export function replyText(message) {
  return textOf(message);
}

/**
 * Complete a title using the production request settings. Keep this separate
 * from the lifecycle handler so the provider options are covered by tests.
 */
export function completeTitle(model, context, ctx) {
  return ctx.modelRegistry.complete(model, context, {
    maxTokens: 256,
    sessionId: ctx.sessionManager.getSessionId()
  });
}

/**
 * Wire the titler: after each agent run, title the session once when it has
 * no name yet. `resolveModel(ctx)` returns the model to use (the fast role's,
 * else the session's own); `complete(model, context, ctx)` performs the
 * request. Both are injected so the unit tests need no provider.
 */
export function createAutoTitler(pi, { enabled = true, resolveModel, complete, isWorkerSession = () => false, onError } = {}) {
  const inFlight = new Set();
  const successful = new Set();
  const reported = new Set();
  const key = ctx => ctx?.sessionManager?.getSessionFile?.() || ctx?.sessionManager?.getSessionId?.() || '';
  const currentName = () => typeof pi.getSessionName === 'function' ? pi.getSessionName() : undefined;
  const hasName = () => Boolean(currentName());
  const notify = (ctx, message, level = 'warning') => {
    try { ctx?.ui?.notify?.(message, level); } catch { /* UI reporting must not fail the command. */ }
  };
  const report = (id, error, ctx, explicit = false) => {
    if (!explicit) {
      if (reported.has(id)) return;
      reported.add(id);
    }
    let delivered = false;
    try {
      if (onError) {
        onError(error, ctx, explicit);
        delivered = true;
      }
    } catch { /* UI reporting must not fail the hook. */ }
    if (explicit && !delivered) {
      const detail = error?.message || String(error);
      notify(ctx, `Session rename failed: ${detail}`, 'error');
    }
  };
  const stillCurrent = (ctx, id, originalName) => key(ctx) === id && currentName() === originalName;
  const completeRequest = async ({ id, originalName, source, ctx, explicit }) => {
    try {
      const model = await resolveModel(ctx);
      // The session or its name may have changed while model selection was pending.
      if (!stillCurrent(ctx, id, originalName)) return;
      if (!model) {
        report(id, new Error(`No model is available for ${explicit ? '' : 'automatic '}session titles.`), ctx, explicit);
        return;
      }
      const reply = await complete(model, titleContext(source), ctx);
      // Never apply a late completion to a renamed or replaced session.
      if (!stillCurrent(ctx, id, originalName)) return;
      const failedReply = assistantFailure([reply]) || (failedStopReasons.has(reply?.stopReason) ? reply : null);
      if (failedReply) {
        const detail = failedReply.errorMessage || `Title request ${failedReply.stopReason}; no title was generated.`;
        report(id, new Error(String(detail)), ctx, explicit);
        return;
      }
      const title = cleanTitle(replyText(reply));
      if (!title) {
        report(id, new Error('The title model returned an empty response.'), ctx, explicit);
        return;
      }
      // A name set meanwhile (the user typed /name while we waited) wins.
      if (!stillCurrent(ctx, id, originalName)) return;
      pi.setSessionName(title);
      if (explicit) notify(ctx, `Session renamed: ${title}`, 'info');
      else successful.add(id);
    } catch (error) {
      report(id, error, ctx, explicit);
    }
  };
  const handler = async (event, ctx) => {
    if (!enabled || isWorkerSession(ctx) || hasName()) return;
    const id = key(ctx);
    if (!id || successful.has(id) || inFlight.has(id)) return;
    const messages = event?.messages || [];
    const source = titleSource(messages);
    const failed = source ? null : assistantFailure(messages);
    if (!source && !failed) return;
    const originalName = currentName();
    inFlight.add(id);
    try {
      if (failed) {
        const detail = failed.errorMessage || `Assistant run ${failed.stopReason}; no title was generated.`;
        report(id, new Error(String(detail)), ctx);
        return;
      }
      await completeRequest({ id, originalName, source, ctx, explicit: false });
    } finally {
      inFlight.delete(id);
    }
  };
  const rename = async (args, ctx) => {
    const text = typeof args === 'string' ? args.trim() : Array.isArray(args) ? args.join(' ').trim() : '';
    if (text) {
      notify(ctx, 'Usage: /rename takes no arguments; use /name for a manual session name.', 'warning');
      return;
    }
    if (isWorkerSession(ctx)) return;
    if (typeof ctx?.isIdle === 'function' && !ctx.isIdle()) {
      notify(ctx, 'Cannot rename while the agent is busy.', 'warning');
      return;
    }
    const id = key(ctx);
    if (!id) {
      notify(ctx, 'Cannot rename: the active session has no identity.', 'error');
      return;
    }
    if (inFlight.has(id)) {
      notify(ctx, 'A session title request is already in progress.', 'warning');
      return;
    }
    const branch = ctx?.sessionManager?.getBranch?.() || [];
    const messages = Array.isArray(branch)
      ? branch.filter(entry => entry?.type === 'message' && entry.message).map(entry => entry.message)
      : [];
    const source = titleSource(messages);
    if (!source) {
      notify(ctx, 'Cannot rename: need a meaningful user message and assistant reply.', 'warning');
      return;
    }
    // Capture both before the asynchronous model request: /name and session
    // switches must win over a late explicit rename result.
    const originalName = currentName();
    inFlight.add(id);
    try {
      await completeRequest({ id, originalName, source, ctx, explicit: true });
    } finally {
      inFlight.delete(id);
    }
  };
  pi.on('agent_end', handler);
  return {
    /** Forget title state (a new session file may reuse an id after a fork). */
    reset() { inFlight.clear(); successful.clear(); reported.clear(); },
    /** For tests: run the handler directly. */
    handle: handler,
    /** Explicitly regenerate the title, including for named/auto-disabled sessions. */
    rename
  };
}
