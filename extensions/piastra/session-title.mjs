/**
 * Automatic session titles.
 *
 * Pi only names a session through `/name` (a `session_info` entry); every
 * list falls back to the first user message, which is rarely a good label
 * ("so the fast agent's bread and butter is…"). After the first assistant
 * reply of an unnamed session, one small completion on the `fast` role's
 * model produces a 3–6 word title and stores it with the same
 * `session_info` mechanism, so `/resume`, `/wt resume` and the web UI all
 * show it. Fire-and-forget: it never blocks a turn, fails silently, runs at
 * most once per session, and never overwrites a name set by `/name`.
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

/**
 * The first user message and first assistant reply of a run, as text — or
 * null when the run has no reply yet (nothing worth titling).
 */
export function titleSource(messages) {
  const user = messages.find(m => m?.role === 'user' && textOf(m).trim());
  const assistant = messages.find(m => m?.role === 'assistant' && textOf(m).trim());
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
 * Wire the titler: after each agent run, title the session once when it has
 * no name yet. `resolveModel(ctx)` returns the model to use (the fast role's,
 * else the session's own); `complete(model, context, ctx)` performs the
 * request. Both are injected so the unit tests need no provider.
 */
export function createAutoTitler(pi, { enabled = true, resolveModel, complete, isWorkerSession = () => false, onError } = {}) {
  const attempted = new Set();
  const key = ctx => ctx?.sessionManager?.getSessionFile?.() || ctx?.sessionManager?.getSessionId?.() || '';
  const handler = async (event, ctx) => {
    if (!enabled) return;
    if (isWorkerSession(ctx)) return;
    if (typeof pi.getSessionName === 'function' && pi.getSessionName()) return;
    const id = key(ctx);
    if (!id || attempted.has(id)) return;
    const source = titleSource(event?.messages || []);
    if (!source) return;
    attempted.add(id);
    try {
      const model = await resolveModel(ctx);
      if (!model) return;
      const reply = await complete(model, titleContext(source), ctx);
      const title = cleanTitle(replyText(reply));
      // A name set meanwhile (the user typed /name while we waited) wins.
      if (!title || (typeof pi.getSessionName === 'function' && pi.getSessionName())) return;
      pi.setSessionName(title);
    } catch (error) {
      onError?.(error);
    }
  };
  pi.on('agent_end', handler);
  return {
    /** Forget attempts (a new session file may reuse an id after a fork). */
    reset() { attempted.clear(); },
    /** For tests: run the handler directly. */
    handle: handler
  };
}
