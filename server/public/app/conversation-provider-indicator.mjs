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
