const DEFAULT_FALLBACK_MODE = 'agent';

// Stored preferences arrive as '' when unset, so `??` would treat them as real
// values and block every fallback behind them.
export function normalizePreferenceValue(value) {
  return String(value ?? '').trim();
}

export function firstDefinedPreference(...values) {
  for (const value of values) {
    const normalized = normalizePreferenceValue(value);
    if (normalized) return normalized;
  }
  return '';
}

function normalizeModeList(modes = []) {
  return Array.isArray(modes)
    ? modes.map((mode) => String(mode || '').trim()).filter(Boolean)
    : [];
}

function normalizeModelList(models = []) {
  return Array.isArray(models)
    ? models.map((model) => String(model || '').trim()).filter(Boolean)
    : [];
}

export function resolveConversationComposerSelection({
  preferredRelayMode = '',
  preferredModel = '',
  selectedMode = '',
  selectedModel = '',
  supportedModes = [],
  supportedModels = [],
  fallbackMode = DEFAULT_FALLBACK_MODE,
  fallbackModel = '',
} = {}) {
  const allowedModes = normalizeModeList(supportedModes);
  const allowedModels = normalizeModelList(supportedModels);
  const modeFallback = allowedModes.includes(fallbackMode)
    ? fallbackMode
    : (allowedModes[0] || DEFAULT_FALLBACK_MODE);
  const preferredMode = String(preferredRelayMode || '').trim();
  const nextMode = allowedModes.includes(preferredMode)
    ? preferredMode
    : (allowedModes.includes(String(selectedMode || '').trim())
      ? String(selectedMode || '').trim()
      : modeFallback);

  const modelCandidates = [
    String(preferredModel || '').trim(),
    String(selectedModel || '').trim(),
    String(fallbackModel || '').trim(),
    allowedModels[0] || '',
  ].filter(Boolean);
  // Provider catalogs own their casing, so a stored id that only differs in
  // case still resolves to the catalog entry instead of dropping to a fallback.
  const matchAllowedModel = (candidate) => allowedModels.find(
    (allowed) => allowed === candidate || allowed.toLowerCase() === candidate.toLowerCase(),
  );
  const nextModel = allowedModels.length
    ? (modelCandidates.map(matchAllowedModel).find(Boolean) || allowedModels[0])
    : (modelCandidates[0] || '');

  return {
    mode: nextMode,
    model: nextModel,
  };
}

// Priority: an explicit request (conversation preference, or the effort being
// carried across a user model change) beats what the previous conversation left
// in the DOM. Reversing those two is what let a New Chat "high" become "low".
export function resolveComposerReasoningEffort({
  preferredEffort = '',
  storedEffort = '',
  currentEffort = '',
  supportedEfforts = [],
} = {}) {
  const options = (Array.isArray(supportedEfforts) ? supportedEfforts : [])
    .map((effort) => String(effort || '').trim().toLowerCase())
    .filter(Boolean);
  if (!options.length) return '';
  const candidates = [preferredEffort, storedEffort, currentEffort]
    .map((effort) => String(effort || '').trim().toLowerCase())
    .filter(Boolean);
  const match = candidates.find((candidate) => options.includes(candidate));
  if (match) return match;
  return options.find((option) => option !== 'none') || options[0];
}
