import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, completeTitle, createAutoTitler, titleContext, titleSource } from './session-title.mjs';

const text = (role, t) => ({ role, content: [{ type: 'text', text: t }], timestamp: 1 });

test('cleanTitle strips quotes, prefixes and punctuation and caps length', () => {
  assert.equal(cleanTitle('"Fix worker guard release."'), 'Fix worker guard release');
  assert.equal(cleanTitle('Title: Queue ack retention\nmore'), 'Queue ack retention');
  assert.equal(cleanTitle('  \n **Worktree resume picker**  '), 'Worktree resume picker');
  assert.equal(cleanTitle('one two three four five six seven eight nine ten'), 'one two three four five six seven eight');
  assert.equal(cleanTitle('x'.repeat(80)).length <= 60, true);
  assert.equal(cleanTitle(''), null);
  assert.equal(cleanTitle('""'), null);
  assert.equal(cleanTitle(undefined), null);
});

test('titleSource needs a user message and a reply', () => {
  assert.equal(titleSource([text('user', 'hi')]), null);
  assert.equal(titleSource([]), null);
  const src = titleSource([text('user', ' hi '), text('assistant', 'hello')]);
  assert.deepEqual(src, { user: 'hi', assistant: 'hello' });
  assert.match(titleContext(src).messages[0].content[0].text, /Developer:\nhi\n\nAgent:\nhello/);
});

function fakePi() {
  const handlers = {};
  let name;
  return {
    on: (event, handler) => { handlers[event] = handler; },
    setSessionName: n => { name = n; },
    getSessionName: () => name,
    fire: (event, ctx) => handlers.agent_end(event, ctx),
    get name() { return name; }
  };
}
const ctxFor = file => ({ sessionManager: { getSessionFile: () => file }, model: { id: 'session-model' } });
const branchFor = (file, messages, extra = {}) => ({
  ...ctxFor(file),
  ...extra,
  sessionManager: { ...ctxFor(file).sessionManager, getBranch: () => messages.map(message => ({ type: 'message', message })) }
});
const run = [text('user', 'please fix the guard'), text('assistant', 'Done, the guard now releases.')];

test('titles an unnamed session once with the resolved model', async () => {
  const pi = fakePi();
  const calls = [];
  createAutoTitler(pi, {
    resolveModel: async () => ({ id: 'fast' }),
    complete: async (model, context) => { calls.push([model.id, context.systemPrompt.length > 0]); return text('assistant', 'Fix guard release'); }
  });
  await pi.fire({ messages: run }, ctxFor('/s/a.jsonl'));
  assert.equal(pi.name, 'Fix guard release');
  pi.setSessionName(undefined);
  await pi.fire({ messages: run }, ctxFor('/s/a.jsonl'));
  assert.deepEqual(calls, [['fast', true]]);
});

test('never overwrites a name, skips workers, disabled, and runs without a reply', async () => {
  const pi = fakePi();
  let calls = 0;
  const titler = createAutoTitler(pi, {
    resolveModel: async () => ({ id: 'fast' }),
    complete: async () => { calls += 1; return text('assistant', 'Generated'); },
    isWorkerSession: ctx => ctx.sessionManager.getSessionFile().includes('/piastra/runs/')
  });
  pi.setSessionName('Mine');
  await pi.fire({ messages: run }, ctxFor('/s/named.jsonl'));
  assert.equal(pi.name, 'Mine');
  pi.setSessionName(undefined);
  await pi.fire({ messages: run }, ctxFor('/agent/piastra/runs/w1.jsonl'));
  assert.equal(pi.name, undefined);
  await pi.fire({ messages: [text('user', 'only me')] }, ctxFor('/s/noreply.jsonl'));
  assert.equal(pi.name, undefined);
  assert.equal(calls, 0);
  titler.reset();
  const off = fakePi();
  createAutoTitler(off, { enabled: false, resolveModel: async () => ({}), complete: async () => { calls += 1; return text('assistant', 'x'); } });
  await off.fire({ messages: run }, ctxFor('/s/off.jsonl'));
  assert.equal(calls, 0);
});

test('title completion uses the provider-compatible production options', async () => {
  const calls = [];
  const ctx = { modelRegistry: { complete: (...args) => { calls.push(args); return 'reply'; } } };
  const result = completeTitle({ id: 'fast' }, { messages: [] }, ctx);
  assert.equal(result, 'reply');
  assert.deepEqual(calls[0][2], { maxTokens: 256 });
  assert.equal('temperature' in calls[0][2], false);
});

test('provider errors, empty replies, and missing models retry on later agent_end', async () => {
  const pi = fakePi();
  const errors = [];
  let attempt = 0;
  createAutoTitler(pi, {
    resolveModel: async () => attempt === 2 ? null : ({ id: 'fast' }),
    complete: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('provider unavailable');
      return text('assistant', '');
    },
    onError: (error, ctx) => errors.push([error.message, ctx])
  });
  const ctx = ctxFor('/s/retry.jsonl');
  await pi.fire({ messages: run }, ctx);
  await pi.fire({ messages: run }, ctx);
  assert.equal(attempt, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'provider unavailable');
  assert.equal(errors[0][1], ctx);

  // Empty output and no model are also retryable, without repeated warnings.
  const retry = fakePi();
  let calls = 0;
  const retryErrors = [];
  createAutoTitler(retry, {
    resolveModel: async () => calls++ === 0 ? null : ({ id: 'fast' }),
    complete: async () => text('assistant', 'Retry title'),
    onError: error => retryErrors.push(error.message)
  });
  const retryCtx = ctxFor('/s/no-model.jsonl');
  await retry.fire({ messages: run }, retryCtx);
  await retry.fire({ messages: run }, retryCtx);
  assert.equal(retry.name, 'Retry title');
  assert.deepEqual(retryErrors, ['No model is available for automatic session titles.']);

  const empty = fakePi();
  let emptyCalls = 0;
  createAutoTitler(empty, {
    resolveModel: async () => ({ id: 'fast' }),
    complete: async () => text('assistant', ++emptyCalls === 1 ? '' : 'Recovered title'),
    onError: error => retryErrors.push(error.message)
  });
  const emptyCtx = ctxFor('/s/empty.jsonl');
  await empty.fire({ messages: run }, emptyCtx);
  await empty.fire({ messages: run }, emptyCtx);
  assert.equal(empty.name, 'Recovered title');
  assert.equal(emptyCalls, 2);
  assert.equal(retryErrors.includes('The title model returned an empty response.'), true);
});

test('assistant error and aborted replies are rejected and report errorMessage', async () => {
  for (const stopReason of ['error', 'aborted']) {
    const pi = fakePi();
    const errors = [];
    createAutoTitler(pi, {
      resolveModel: async () => ({ id: 'fast' }),
      complete: async () => text('assistant', 'must not be used'),
      onError: (error, ctx) => errors.push([error.message, ctx])
    });
    const ctx = ctxFor(`/s/${stopReason}.jsonl`);
    await pi.fire({ messages: [text('user', 'please fix'), { ...text('assistant', 'partial'), stopReason, errorMessage: 'Provider returned an error.' }] }, ctx);
    assert.equal(pi.name, undefined);
    assert.deepEqual(errors, [['Provider returned an error.', ctx]]);

    const returned = fakePi();
    const returnedErrors = [];
    createAutoTitler(returned, {
      resolveModel: async () => ({ id: 'fast' }),
      complete: async () => ({ ...text('assistant', 'partial title'), stopReason, errorMessage: 'Title provider failed.' }),
      onError: error => returnedErrors.push(error.message)
    });
    await returned.fire({ messages: run }, ctxFor(`/s/returned-${stopReason}.jsonl`));
    assert.equal(returned.name, undefined);
    assert.deepEqual(returnedErrors, ['Title provider failed.']);
  }
});

test('concurrent agent_end events share one in-flight request', async () => {
  const pi = fakePi();
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  createAutoTitler(pi, {
    resolveModel: async () => ({ id: 'fast' }),
    complete: async () => { calls += 1; await pending; return text('assistant', 'One request'); }
  });
  const ctx = ctxFor('/s/concurrent.jsonl');
  const first = pi.fire({ messages: run }, ctx);
  const second = pi.fire({ messages: run }, ctx);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(pi.name, 'One request');
});

test('a session switch while awaiting completion cannot name the new session', async () => {
  const pi = fakePi();
  let current = '/s/old.jsonl';
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  createAutoTitler(pi, {
    resolveModel: async () => ({ id: 'fast' }),
    complete: async () => { await pending; return text('assistant', 'Old session title'); }
  });
  const ctx = { sessionManager: { getSessionFile: () => current } };
  const oldRun = pi.fire({ messages: run }, ctx);
  // Let model resolution resume and enter the pending completion first.
  await Promise.resolve();
  current = '/s/new.jsonl';
  release();
  await oldRun;
  assert.equal(pi.name, undefined);
  await pi.fire({ messages: run }, ctx);
  assert.equal(pi.name, 'Old session title');
});

test('a name set while the request was in flight wins; errors are reported, not thrown', async () => {
  const pi = fakePi();
  const errors = [];
  createAutoTitler(pi, {
    resolveModel: async () => ({ id: 'fast' }),
    complete: async () => { pi.setSessionName('Typed meanwhile'); return text('assistant', 'Generated'); },
    onError: e => errors.push(e)
  });
  await pi.fire({ messages: run }, ctxFor('/s/race.jsonl'));
  assert.equal(pi.name, 'Typed meanwhile');
  const failing = fakePi();
  createAutoTitler(failing, { resolveModel: async () => { throw new Error('no model'); }, complete: async () => text('assistant', 'x'), onError: e => errors.push(e) });
  await failing.fire({ messages: run }, ctxFor('/s/fail.jsonl'));
  assert.equal(failing.name, undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'no model');
});

test('/rename regenerates named and auto-disabled sessions from the active branch', async () => {
  const pi = fakePi();
  pi.setSessionName('Previous title');
  const calls = [];
  const titler = createAutoTitler(pi, {
    enabled: false,
    resolveModel: async () => ({ id: 'fast' }),
    complete: async (_model, context) => {
      calls.push(context.messages[0].content[0].text);
      return text('assistant', ['Fresh title', 'Fresher title', 'Freshest title'][calls.length - 1] || 'Latest title');
    }
  });
  const ctx = branchFor('/s/rename.jsonl', [
    { role: 'toolResult', content: [{ type: 'text', text: 'earlier tool output' }] },
    { role: 'user', content: [{ type: 'text', text: '  meaningful request  ' }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'ignore this' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'useful answer' }] },
  ], { isIdle: () => true });
  await titler.rename('', ctx);
  assert.equal(pi.name, 'Fresh title');
  assert.match(calls[0], /Developer:\nmeaningful request\n\nAgent:\nuseful answer/);
  await titler.rename('', ctx);
  assert.equal(pi.name, 'Fresher title');
  pi.setSessionName(undefined);
  await titler.rename('', ctx);
  assert.equal(pi.name, 'Freshest title');
  assert.equal(calls.length, 3);
});

test('/rename validates usage and history without making a provider request', async () => {
  const pi = fakePi();
  const notices = [];
  let calls = 0;
  const titler = createAutoTitler(pi, {
    resolveModel: async () => ({ id: 'fast' }),
    complete: async () => { calls += 1; return text('assistant', 'nope'); }
  });
  const ctx = branchFor('/s/validate.jsonl', [], { isIdle: () => true, ui: { notify: (...notice) => notices.push(notice) } });
  await titler.rename('manual name', ctx);
  await titler.rename('', ctx);
  assert.equal(calls, 0);
  assert.match(notices[0][0], /Usage: \/rename/);
  assert.match(notices[0][0], /\/name/);
  assert.match(notices[1][0], /meaningful user message/);
});

test('/rename reports every request failure and keeps the prior name', async () => {
  const pi = fakePi();
  pi.setSessionName('Keep this');
  const errors = [];
  const titler = createAutoTitler(pi, {
    resolveModel: async () => ({ id: 'fast' }),
    complete: async () => text('assistant', ''),
    onError: (error, _ctx, explicit) => errors.push([error.message, explicit])
  });
  const ctx = branchFor('/s/errors.jsonl', run, { isIdle: () => true });
  await titler.rename('', ctx);
  await titler.rename('', ctx);
  assert.equal(pi.name, 'Keep this');
  assert.deepEqual(errors, [
    ['The title model returned an empty response.', true],
    ['The title model returned an empty response.', true],
  ]);
});

test('/rename refuses busy and concurrent requests using the shared gate', async () => {
  const pi = fakePi();
  let release;
  let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const titler = createAutoTitler(pi, {
    resolveModel: async () => ({ id: 'fast' }),
    complete: async () => { calls += 1; await pending; return text('assistant', 'Only title'); }
  });
  const ctx = branchFor('/s/busy.jsonl', run, { isIdle: () => true });
  const first = titler.rename('', ctx);
  await Promise.resolve();
  await titler.rename('', ctx);
  assert.equal(calls, 1);
  const notices = [];
  await titler.rename('', { ...ctx, isIdle: () => false, ui: { notify: (...notice) => notices.push(notice) } });
  assert.equal(notices.length, 1);
  assert.match(notices[0][0], /busy/);
  release();
  await first;
  assert.equal(pi.name, 'Only title');
});

test('/rename discards results after a manual name or session switch', async () => {
  for (const change of ['name', 'session']) {
    const pi = fakePi();
    let current = '/s/old-rename.jsonl';
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const completionStarted = new Promise(resolve => { started = resolve; });
    const titler = createAutoTitler(pi, {
      resolveModel: async () => ({ id: 'fast' }),
      complete: async () => { started(); await pending; return text('assistant', 'Stale title'); }
    });
    const ctx = branchFor(current, run, { isIdle: () => true });
    ctx.sessionManager.getSessionFile = () => current;
    const request = titler.rename('', ctx);
    await completionStarted;
    if (change === 'name') pi.setSessionName('Manual name');
    else current = '/s/new-rename.jsonl';
    release();
    await request;
    assert.equal(pi.name, change === 'name' ? 'Manual name' : undefined);
  }
});
