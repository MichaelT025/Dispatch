import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, createAutoTitler, titleContext, titleSource } from './session-title.mjs';

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
