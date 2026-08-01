const DEFAULT_FALLBACK_MODE = 'agent';

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
  const nextModel = allowedModels.length
    ? (modelCandidates.find((candidate) => allowedModels.includes(candidate)) || allowedModels[0])
    : (modelCandidates[0] || '');

  return {
    mode: nextMode,
    model: nextModel,
  };
}
