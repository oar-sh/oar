import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isConversationUsingOpenAIProvider,
  resolveConversationProviderType,
} from './conversation-provider-indicator.mjs';

test('resolves provider type from camelCase and snake_case fields', () => {
  assert.equal(resolveConversationProviderType({ runtimeProviderType: ' OpenAI ' }), 'openai');
  assert.equal(resolveConversationProviderType({ runtime_provider_type: 'GITHUB' }), 'github');
});

test('identifies OpenAI conversations only', () => {
  assert.equal(isConversationUsingOpenAIProvider({ runtimeProviderType: 'openai' }), true);
  assert.equal(isConversationUsingOpenAIProvider({ runtime_provider_type: 'OPENAI' }), true);
  assert.equal(isConversationUsingOpenAIProvider({ runtimeProviderType: 'github' }), false);
  assert.equal(isConversationUsingOpenAIProvider({}), false);
  assert.equal(isConversationUsingOpenAIProvider(null), false);
});
