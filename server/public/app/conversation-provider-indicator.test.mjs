import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conversationProviderIndicatorKey,
  conversationProviderIndicatorLabel,
  isConversationUsingCursorProvider,
  isConversationUsingGrokProvider,
  isConversationUsingOpenAIProvider,
  isOpenAIImageModelId,
  resolveConversationProviderType,
  sessionLockNoteText,
  sessionLockProviderKey,
  sessionLockProviderLabel,
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

test('identifies Cursor conversations only', () => {
  assert.equal(isConversationUsingCursorProvider({ runtimeProviderType: 'cursor' }), true);
  assert.equal(isConversationUsingCursorProvider({ runtime_provider_type: ' Cursor ' }), true);
  assert.equal(isConversationUsingCursorProvider({ runtimeProviderType: 'github' }), false);
  assert.equal(isConversationUsingCursorProvider({ runtimeProviderType: 'claude' }), false);
  assert.equal(isConversationUsingCursorProvider({}), false);
  assert.equal(isConversationUsingCursorProvider(null), false);
});

test('identifies Grok conversations only', () => {
  assert.equal(isConversationUsingGrokProvider({ runtimeProviderType: 'grok' }), true);
  assert.equal(isConversationUsingGrokProvider({ runtime_provider_type: ' Grok ' }), true);
  assert.equal(isConversationUsingGrokProvider({ runtimeProviderType: 'github' }), false);
  assert.equal(isConversationUsingGrokProvider({ runtimeProviderType: 'claude' }), false);
  assert.equal(isConversationUsingGrokProvider({}), false);
  assert.equal(isConversationUsingGrokProvider(null), false);
});

test('labels provider indicator per provider type', () => {
  assert.equal(conversationProviderIndicatorLabel({ runtimeProviderType: 'cursor' }), 'Cursor');
  assert.equal(conversationProviderIndicatorLabel({ runtime_provider_type: 'CURSOR' }), 'Cursor');
  assert.equal(conversationProviderIndicatorLabel({ runtimeProviderType: 'claude' }), 'Claude');
  assert.equal(conversationProviderIndicatorLabel({ runtimeProviderType: 'grok' }), 'Grok');
  assert.equal(conversationProviderIndicatorLabel({ runtimeProviderType: 'openai' }), 'OpenAI');
  assert.equal(conversationProviderIndicatorLabel({ runtimeProviderType: 'github' }), 'Copilot');
  assert.equal(conversationProviderIndicatorLabel({ runtime_provider_type: 'GitHub-Copilot' }), 'Copilot');
  assert.equal(conversationProviderIndicatorLabel({ runtimeProviderType: '' }), '');
  assert.equal(conversationProviderIndicatorLabel({}), '');
  assert.equal(conversationProviderIndicatorLabel(null), '');
});

test('keys the provider pill to the composer palette', () => {
  assert.equal(conversationProviderIndicatorKey({ runtimeProviderType: 'cursor' }), 'cursor');
  assert.equal(conversationProviderIndicatorKey({ runtime_provider_type: 'CLAUDE' }), 'claude');
  assert.equal(conversationProviderIndicatorKey({ runtimeProviderType: 'grok' }), 'grok');
  assert.equal(conversationProviderIndicatorKey({ runtimeProviderType: 'github-copilot' }), 'github');
  assert.equal(
    conversationProviderIndicatorKey({ runtimeProviderType: 'openai', runtimeModel: 'gpt-4o' }),
    'openai',
  );
  assert.equal(
    conversationProviderIndicatorKey({ runtimeProviderType: 'openai', runtimeProviderModel: 'gpt-image-1' }),
    'openai-image',
  );
  assert.equal(
    conversationProviderIndicatorKey({ runtimeProviderType: 'openai', preferredModel: 'dall-e-3' }),
    'openai-image',
  );
  assert.equal(conversationProviderIndicatorKey({}), '');
  assert.equal(conversationProviderIndicatorKey(null), '');
});

test('detects OpenAI image model ids', () => {
  assert.equal(isOpenAIImageModelId('gpt-image-1'), true);
  assert.equal(isOpenAIImageModelId('openai/gpt-image-1-mini'), true);
  assert.equal(isOpenAIImageModelId(' DALL-E-3 '), true);
  assert.equal(isOpenAIImageModelId('gpt-4o'), false);
  assert.equal(isOpenAIImageModelId(''), false);
});

test('maps session lock provider keys, including the derived image variant', () => {
  assert.equal(sessionLockProviderKey({ providerType: 'github' }), 'github');
  assert.equal(sessionLockProviderKey({ providerType: 'GitHub-Copilot' }), 'github');
  assert.equal(sessionLockProviderKey({ providerType: 'openai', model: 'gpt-4o' }), 'openai');
  assert.equal(sessionLockProviderKey({ providerType: 'openai-byok', model: '' }), 'openai');
  assert.equal(sessionLockProviderKey({ providerType: 'openai', model: 'gpt-image-1' }), 'openai-image');
  assert.equal(sessionLockProviderKey({ providerType: 'openai-image' }), 'openai-image');
  assert.equal(sessionLockProviderKey({ providerType: ' Claude ' }), 'claude');
  assert.equal(sessionLockProviderKey({ providerType: 'anthropic' }), 'claude');
  assert.equal(sessionLockProviderKey({ providerType: 'cursor' }), 'cursor');
  assert.equal(sessionLockProviderKey({ providerType: 'grok' }), 'grok');
  assert.equal(sessionLockProviderKey({ providerType: 'xai' }), 'grok');
  assert.equal(sessionLockProviderKey({ providerType: 'unknown' }), '');
  assert.equal(sessionLockProviderKey(), '');
});

test('labels every supported session lock provider', () => {
  assert.equal(sessionLockProviderLabel({ providerType: 'github' }), 'GitHub Copilot');
  assert.equal(sessionLockProviderLabel({ providerType: 'openai', model: 'gpt-5' }), 'OpenAI');
  assert.equal(sessionLockProviderLabel({ providerType: 'openai', model: 'dall-e-3' }), 'OpenAI Image');
  assert.equal(sessionLockProviderLabel({ providerType: 'claude' }), 'Claude SDK');
  assert.equal(sessionLockProviderLabel({ providerType: 'cursor' }), 'Cursor SDK');
  assert.equal(sessionLockProviderLabel({ providerType: 'grok' }), 'Grok');
  assert.equal(sessionLockProviderLabel({ providerType: '' }), '');
});

test('builds the composer session lock note', () => {
  assert.equal(
    sessionLockNoteText({ providerType: 'github' }),
    '🔒 Session locked to GitHub Copilot models.',
  );
  assert.equal(
    sessionLockNoteText({ providerType: 'cursor', model: 'composer-1' }),
    '🔒 Session locked to Cursor SDK models.',
  );
  assert.equal(
    sessionLockNoteText({ providerType: 'openai', model: 'gpt-4o', pinnedModel: 'gpt-4o' }),
    '🔒 Session locked to OpenAI models (gpt-4o).',
  );
  assert.equal(
    sessionLockNoteText({ providerType: 'openai', model: 'gpt-image-1', pinnedModel: ' gpt-image-1 ' }),
    '🔒 Session locked to OpenAI Image models (gpt-image-1).',
  );
  assert.equal(sessionLockNoteText({ providerType: 'unknown', pinnedModel: 'gpt-4o' }), '');
  assert.equal(sessionLockNoteText(), '');
});
