import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNewConversationModelChoices,
  reasoningChoicesForProviderModel,
  resolvePreferredReasoningEffort,
  shouldPromptForNewConversationModel,
} from './new-conversation-model-choice.mjs';

test('prompts for a new model while OpenAI is enabled', () => {
  assert.equal(shouldPromptForNewConversationModel({ provider: 'openai' }), true);
  assert.equal(shouldPromptForNewConversationModel({ provider: 'openai-byok' }), true);
  assert.equal(shouldPromptForNewConversationModel({ provider: 'openai-image' }), true);
  assert.equal(shouldPromptForNewConversationModel({ provider: 'github' }), false);
  assert.equal(shouldPromptForNewConversationModel({ provider: '' }), false);
});

test('new conversation choices exclude temporary runtime-locked models', () => {
  assert.deepEqual(buildNewConversationModelChoices([
    { value: 'auto', label: 'Auto' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'retired-model', label: 'Locked retired model', runtimeModelLock: true },
    { value: 'gpt-4o', label: 'Duplicate' },
  ]), [
    { value: 'auto', label: 'Auto' },
    { value: 'gpt-4o', label: 'GPT-4o' },
  ]);
});

test('resolves provider-specific reasoning choices for model selection modal', () => {
  assert.deepEqual(reasoningChoicesForProviderModel({
    reasoningByProvider: {
      openai: {
        'gpt-5.6': ['none', 'low', 'medium', 'high'],
      },
    },
    reasoningByModel: {
      'gpt-5.6': ['none'],
    },
  }, { provider: 'openai-byok', modelId: 'gpt-5.6' }), ['none', 'low', 'medium', 'high']);
});

test('prefers remembered reasoning effort and otherwise avoids none when possible', () => {
  assert.equal(
    resolvePreferredReasoningEffort(['none', 'low', 'medium'], ['high', 'medium']),
    'medium',
  );
  assert.equal(
    resolvePreferredReasoningEffort(['none', 'low', 'medium'], ['']),
    'low',
  );
});
