export function resolveConversationProviderType(conversation = null) {
  const providerType = String(
    conversation?.runtimeProviderType
    ?? conversation?.runtime_provider_type
    ?? '',
  ).trim().toLowerCase();
  return providerType;
}

export function isConversationUsingOpenAIProvider(conversation = null) {
  return resolveConversationProviderType(conversation) === 'openai';
}

export function isConversationUsingClaudeProvider(conversation = null) {
  return resolveConversationProviderType(conversation) === 'claude';
}

export function conversationProviderIndicatorLabel(conversation = null) {
  const providerType = resolveConversationProviderType(conversation);
  if (providerType === 'openai') return 'OpenAI';
  if (providerType === 'claude') return 'Claude';
  return '';
}
