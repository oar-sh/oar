// Cursor models without a 'thinking' parameter (or an 'effort' value of 'none')
// cannot be told to stop reasoning. The relay still sends 'none' on the wire —
// the SDK just receives no reasoning parameter and the model runs its default —
// so the option is labelled for what it does instead of promising an off switch.
export const PROVIDER_DEFAULT_EFFORT_LABEL = 'default';

export function normalizeProviderKey(providerType = '') {
  const key = String(providerType || '').trim().toLowerCase();
  if (key === 'openai-byok') return 'openai';
  if (key === 'openai-image' || key === 'openai-image-byok') return 'openai';
  if (key === 'github-copilot') return 'github';
  return key;
}

export function isReasoningOffUnsupported(catalog = null, providerType = '', modelId = '') {
  const provider = normalizeProviderKey(providerType);
  const model = String(modelId || '').trim().toLowerCase();
  if (!provider || !model) return false;
  return catalog?.reasoningOffUnsupportedByProvider?.[provider]?.[model] === true;
}

export function reasoningEffortOptionLabel(effort, { reasoningOffUnsupported = false } = {}) {
  const value = String(effort || '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'none' && reasoningOffUnsupported) return PROVIDER_DEFAULT_EFFORT_LABEL;
  return value;
}
