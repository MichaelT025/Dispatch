import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommandCodeMessage } from '../src/overflow.ts';

test('both catalogs retain context-overflow recovery without swallowing quota errors', () => {
  for (const provider of ['commandcode', 'commandcode-api']) {
    const message = { role: 'assistant', provider, stopReason: 'error', errorMessage: 'Prompt too large' };
    assert.match(normalizeCommandCodeMessage(message).message.errorMessage, /^context_length_exceeded:/);
    assert.equal(normalizeCommandCodeMessage({ ...message, errorMessage: 'rate limit exceeded' }), undefined);
  }
  assert.equal(normalizeCommandCodeMessage({ role: 'assistant', provider: 'other', stopReason: 'error', errorMessage: 'Prompt too large' }), undefined);
});
