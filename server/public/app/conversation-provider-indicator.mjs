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

export function isConversationUsingCursorProvider(conversation = null) {
  return resolveConversationProviderType(conversation) === 'cursor';
}

export function isConversationUsingGrokProvider(conversation = null) {
  return resolveConversationProviderType(conversation) === 'grok';
}

// An unresolved provider stays unlabelled rather than defaulting to Copilot, so
// a conversation the client has not loaded yet cannot claim the wrong provider.
export function conversationProviderIndicatorLabel(conversation = null) {
  const providerType = resolveConversationProviderType(conversation);
  if (providerType === 'openai') return 'OpenAI';
  if (providerType === 'claude') return 'Claude';
  if (providerType === 'cursor') return 'Cursor';
  if (providerType === 'grok') return 'Grok';
  if (providerType === 'github' || providerType === 'github-copilot') return 'Copilot';
  return '';
}

const SESSION_LOCK_LABELS = {
  github: 'GitHub Copilot',
  openai: 'OpenAI',
  'openai-image': 'OpenAI Image',
  claude: 'Claude SDK',
  cursor: 'Cursor SDK',
  grok: 'Grok',
};

export function isOpenAIImageModelId(modelId = '') {
  const normalized = String(modelId || '').trim().toLowerCase().replace(/^openai\//, '');
  return normalized.startsWith('gpt-image-') || normalized.startsWith('dall-e-');
}

// Image conversations are stored as the `openai` provider with an image model,
// so the image variant only exists as a derived label.
export function sessionLockProviderKey({ providerType = '', model = '' } = {}) {
  const normalized = String(providerType || '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'openai-byok') {
    return isOpenAIImageModelId(model) ? 'openai-image' : 'openai';
  }
  if (normalized === 'openai-image' || normalized === 'openai-image-byok') return 'openai-image';
  if (normalized === 'claude' || normalized === 'claude-agent-sdk' || normalized === 'anthropic') return 'claude';
  if (normalized === 'cursor') return 'cursor';
  if (normalized === 'grok' || normalized === 'xai' || normalized === 'xai-grok') return 'grok';
  if (normalized === 'github' || normalized === 'github-copilot') return 'github';
  return '';
}

export function sessionLockProviderLabel({ providerType = '', model = '' } = {}) {
  return SESSION_LOCK_LABELS[sessionLockProviderKey({ providerType, model })] || '';
}

// The list pill borrows the composer's provider palette, so it resolves the same
// key the session-lock note uses — including the derived OpenAI image variant.
export function conversationProviderIndicatorKey(conversation = null) {
  return sessionLockProviderKey({
    providerType: resolveConversationProviderType(conversation),
    model: conversation?.runtimeProviderModel
      || conversation?.runtimeModel
      || conversation?.preferredModel
      || '',
  });
}

export function sessionLockNoteText({ providerType = '', model = '', pinnedModel = '' } = {}) {
  const label = sessionLockProviderLabel({ providerType, model });
  if (!label) return '';
  const pinned = String(pinnedModel || '').trim();
  return `🔒 Session locked to ${label} models${pinned ? ` (${pinned})` : ''}.`;
}
