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

export function isConversationUsingDeepSeekProvider(conversation = null) {
  return resolveConversationProviderType(conversation) === 'deepseek';
}

// A Claude chat on the saved Claude Console key: the same Claude worker as
// `claude`, on another bill. A chat can switch between the two.
export function isConversationUsingClaudeApiProvider(conversation = null) {
  return resolveConversationProviderType(conversation) === 'claude-api';
}

// Its own provider, never a flavour of `claude`: the session runs in a sandbox
// at Anthropic, so nothing that is true of a local Claude worker (modes,
// effort, steering, a working directory) may be assumed for it.
export function isConversationUsingClaudeCloudProvider(conversation = null) {
  return resolveConversationProviderType(conversation) === 'claude-cloud';
}

// The marker that tells a cloud chat from a local Claude one at a glance.
const CLAUDE_CLOUD_MARKER = '☁';

const PROVIDER_NAMES = Object.freeze({
  openai: 'OpenAI',
  claude: 'Claude',
  'claude-api': 'Claude API',
  'claude-cloud': 'Claude Cloud',
  cursor: 'Cursor',
  grok: 'Grok',
  deepseek: 'DeepSeek',
  github: 'Copilot',
  'github-copilot': 'Copilot',
});

// A provider type's name as the list pill and the question card say it; ''
// when unknown. The relay's question push uses it too
// (services/push-dispatch-service.mjs).
export function providerDisplayName(providerType = '') {
  return PROVIDER_NAMES[String(providerType || '').trim().toLowerCase()] || '';
}

function conversationProviderName(conversation = null) {
  return providerDisplayName(resolveConversationProviderType(conversation));
}

// An unresolved provider stays unlabelled rather than defaulting to Copilot, so
// a conversation the client has not loaded yet cannot claim the wrong provider.
export function conversationProviderIndicatorLabel(conversation = null) {
  const name = conversationProviderName(conversation);
  return isConversationUsingClaudeCloudProvider(conversation) ? `${CLAUDE_CLOUD_MARKER} ${name}` : name;
}

// A question card names the runtime that asks, the way the list pill names it.
// Unresolved reads plain "Question": every card used to say "Copilot question",
// Claude's and Cursor's included.
export function questionCardHeadLabel(conversation = null) {
  const provider = conversationProviderName(conversation);
  return provider ? `${provider} question` : 'Question';
}

const SESSION_LOCK_LABELS = {
  github: 'GitHub Copilot',
  openai: 'OpenAI',
  'openai-image': 'OpenAI Image',
  claude: 'Claude SDK',
  // The same Claude SDK models as `claude`, named for the bill, as the pill
  // and New Chat name it.
  'claude-api': 'Claude API',
  cursor: 'Cursor SDK',
  grok: 'Grok',
  deepseek: 'DeepSeek',
  'claude-cloud': `${CLAUDE_CLOUD_MARKER} Claude Cloud`,
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
  if (normalized === 'claude-api') return 'claude-api';
  if (normalized === 'claude-cloud') return 'claude-cloud';
  if (normalized === 'cursor') return 'cursor';
  if (normalized === 'grok' || normalized === 'xai' || normalized === 'xai-grok') return 'grok';
  if (normalized === 'deepseek') return 'deepseek';
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
