import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommandCodeMessage } from '../src/overflow.ts';
import { COMMAND_CODE_PROVIDER_IDS } from '../src/catalog.ts';

test('every Command Code provider retains context-overflow recovery without swallowing quota errors', () => {
  assert.deepEqual([...COMMAND_CODE_PROVIDER_IDS], ['commandcode', 'commandcode-plan', 'commandcode-api']);
  for (const provider of COMMAND_CODE_PROVIDER_IDS) {
    const message = { role: 'assistant', provider, stopReason: 'error', errorMessage: 'Prompt too large' };
    assert.match(normalizeCommandCodeMessage(message)?.message.errorMessage ?? '', /^context_length_exceeded:/, provider);
    assert.equal(normalizeCommandCodeMessage({ ...message, errorMessage: 'rate limit exceeded' }), undefined);
    // The session model identifies the provider when the message does not.
    const fromModel = normalizeCommandCodeMessage({ ...message, provider: 'unknown' }, provider);
    assert.match(fromModel?.message.errorMessage ?? '', /^context_length_exceeded:/, provider);
  }
  assert.equal(normalizeCommandCodeMessage({ role: 'assistant', provider: 'other', stopReason: 'error', errorMessage: 'Prompt too large' }), undefined);
});
