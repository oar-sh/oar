import { nearestSupportedReasoningEffort } from './conversation-preferences.mjs';
import { buildContextTierOptions, UNKNOWN_WINDOW_LABEL } from './context-tier-options.mjs';
import { modelMetadataFor } from './model-selector-options.mjs';

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

/**
 * The model New Chat starts on, from the values its list offers: the
 * composer's last model when the list has it, else the provider's own
 * default (Claude API's settings model; the list is sorted by name, so its
 * first entry is no default), else Auto when allowed, else ''. '' leaves the
 * list's first entry.
 */
export function preselectNewConversationModel(values = [], {
  storedModel = '',
  providerDefault = '',
  allowAuto = true,
} = {}) {
  const offered = new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean));
  const stored = String(storedModel || '').trim();
  if (stored && offered.has(stored)) return stored;
  const fallback = String(providerDefault || '').trim();
  if (fallback && offered.has(fallback)) return fallback;
  if (allowAuto && offered.has('auto')) return 'auto';
  return '';
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

// Same clamp as the composer (nearestSupportedReasoningEffort) so a remembered
// tier lands on the same rung whichever picker starts the chat.
export function resolvePreferredReasoningEffort(efforts = [], preferredValues = []) {
  return nearestSupportedReasoningEffort(
    Array.isArray(preferredValues) ? preferredValues : [preferredValues],
    normalizeReasoningEfforts(efforts),
  );
}

/**
 * The read-only context row of the New Chat modal. Only Copilot chats show it:
 * the modal has no tier preference to persist (the composer's long_context
 * choice is stored only as a Claude "[1m]" id), so it mirrors what the composer
 * chip will read for the chosen model and hides when no window is known
 * ("auto", stale metadata).
 */
export function newConversationContextTierState(catalog = {}, { provider = '', modelId = '' } = {}) {
  const providerKey = normalizeProviderKey(provider);
  if (providerKey !== 'github') return { visible: false, options: [] };
  const options = buildContextTierOptions({
    modelId,
    providerType: providerKey,
    metadata: modelMetadataFor(modelId, catalog?.modelMetadataByModel || {}) || {},
  });
  const known = options.filter((option) => option.label !== UNKNOWN_WINDOW_LABEL);
  return { visible: known.length > 0, options: known };
}
