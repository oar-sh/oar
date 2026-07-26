export function shouldPromptForNewConversationModel({ provider = '' } = {}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  return normalizedProvider === 'openai'
    || normalizedProvider === 'openai-byok'
    || normalizedProvider === 'openai-image'
    || normalizedProvider === 'openai-image-byok';
}

export function buildNewConversationModelChoices(options = []) {
  const seen = new Set();
  const choices = [];
  for (const option of Array.isArray(options) ? options : []) {
    const value = String(option?.value || '').trim();
    if (!value || option?.runtimeModelLock === true || seen.has(value)) continue;
    seen.add(value);
    choices.push({
      value,
      label: String(option?.label || value),
    });
  }
  return choices;
}

function normalizeProviderKey(provider = '') {
  const key = String(provider || '').trim().toLowerCase();
  if (key === 'openai-byok') return 'openai';
  if (key === 'github-copilot') return 'github';
  return key;
}

export function normalizeReasoningEfforts(efforts = []) {
  const out = [];
  const seen = new Set();
  for (const effort of Array.isArray(efforts) ? efforts : []) {
    const value = String(effort || '').trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function reasoningChoicesForProviderModel(catalog = {}, {
  provider = '',
  modelId = '',
} = {}) {
  const normalizedModelId = String(modelId || '').trim().toLowerCase();
  if (!normalizedModelId) return [];
  const providerKey = normalizeProviderKey(provider);
  const providerOptions = catalog?.reasoningByProvider?.[providerKey]?.[normalizedModelId];
  if (Array.isArray(providerOptions) && providerOptions.length > 0) {
    return normalizeReasoningEfforts(providerOptions);
  }
  return normalizeReasoningEfforts(catalog?.reasoningByModel?.[normalizedModelId] || []);
}

export function resolvePreferredReasoningEffort(efforts = [], preferredValues = []) {
  const normalizedEfforts = normalizeReasoningEfforts(efforts);
  if (!normalizedEfforts.length) return '';
  const candidates = Array.isArray(preferredValues) ? preferredValues : [preferredValues];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim().toLowerCase();
    if (value && normalizedEfforts.includes(value)) return value;
  }
  const firstNonNone = normalizedEfforts.find((value) => value !== 'none');
  return firstNonNone || normalizedEfforts[0];
}
