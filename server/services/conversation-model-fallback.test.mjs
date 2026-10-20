import test from 'node:test';
import assert from 'node:assert/strict';

import { fallbackReasoningEffort, inheritedConversationModel } from './conversation-model-fallback.mjs';

test('the conversation\'s saved model comes first, then the runtime session, then the latest user message', () => {
  const runtimeSession = { provider_model: 'claude-opus-5', model: 'gpt-5.4-mini' };
  assert.deepEqual(
    inheritedConversationModel({ conversation: { preferred_model: 'gpt-6-orbit' }, runtimeSession, latestUserMessageModel: 'gpt-5' }),
    { source: 'conversation', model: 'gpt-6-orbit' },
  );
  assert.deepEqual(
    inheritedConversationModel({ conversation: { preferred_model: '' }, runtimeSession, latestUserMessageModel: 'gpt-5' }),
    { source: 'runtime', model: 'claude-opus-5' },
  );
  assert.deepEqual(
    inheritedConversationModel({ runtimeSession: { provider_model: null, model: 'gpt-5.4-mini' } }),
    { source: 'runtime', model: 'gpt-5.4-mini' },
  );
  assert.deepEqual(
    inheritedConversationModel({ conversation: {}, runtimeSession: {}, latestUserMessageModel: ' gpt-5-high ' }),
    { source: 'message', model: 'gpt-5-high' },
  );
});

test('"auto" is skipped, and nothing at all means the caller falls back to the catalog', () => {
  assert.deepEqual(
    inheritedConversationModel({ conversation: { preferred_model: 'Auto' }, runtimeSession: { model: 'auto' }, latestUserMessageModel: 'gpt-5' }),
    { source: 'message', model: 'gpt-5' },
  );
  // An 'auto' provider_model does not hide the runtime's real model.
  assert.deepEqual(
    inheritedConversationModel({ runtimeSession: { provider_model: 'auto', model: 'gpt-5.4-mini' }, latestUserMessageModel: 'gpt-5' }),
    { source: 'runtime', model: 'gpt-5.4-mini' },
  );
  assert.equal(inheritedConversationModel({}), null);
  assert.equal(inheritedConversationModel(), null);
});

test('the effort fallback keeps a supported choice, clamps an unsupported one, and avoids none', () => {
  const sol = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  assert.equal(fallbackReasoningEffort(['high'], sol), 'high');
  assert.equal(fallbackReasoningEffort(['', 'high'], sol), 'high');
  assert.equal(fallbackReasoningEffort(['max'], ['low', 'medium', 'high']), 'high');
  assert.equal(fallbackReasoningEffort(['minimal'], ['none', 'low', 'high']), 'low');
  // No choice to keep: the lowest real level, not 'none'.
  assert.equal(fallbackReasoningEffort([], sol), 'low');
  assert.equal(fallbackReasoningEffort([null, undefined], sol), 'low');
  // 'none' only when asked for and offered, or when it is all there is.
  assert.equal(fallbackReasoningEffort(['none'], sol), 'none');
  assert.equal(fallbackReasoningEffort([], ['none']), 'none');
  assert.equal(fallbackReasoningEffort(['high'], []), '');
  // A provider default of its own, for an effort that neither matches nor clamps.
  assert.equal(fallbackReasoningEffort(['ultracode'], ['none', 'low', 'high'], { fallback: '' }), '');
  assert.equal(fallbackReasoningEffort(['max'], ['none', 'low', 'high'], { fallback: '' }), 'high');
});
