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

// Every effort rung any provider speaks, lowest first. 'ultracode' sits on top
// but is a Claude mode rather than "more thinking", so it is never a clamp
// target and a remembered ultracode does not degrade to xhigh (it falls
// through to the next candidate — the existing "drops cleanly" rule).
export const REASONING_EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

function normalizeEffortList(efforts = []) {
  return (Array.isArray(efforts) ? efforts : [])
    .map((effort) => String(effort || '').trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Clamp rule, per candidate in priority order:
 *   1. the candidate itself when the model supports it;
 *   2. else the highest supported rung BELOW it, ignoring 'none'
 *      (gpt-5.6-terra@max → gpt-5.4-mini lands on xhigh);
 *   3. else the lowest supported rung ABOVE it, ignoring 'none'
 *      (a remembered 'minimal' on a model whose floor is 'low' → low);
 *   4. else the next candidate.
 * With no candidate usable: the lowest non-'none' rung the model offers (by
 * rung, whatever the list order), or 'none' when that is all there is; a
 * list with names off the ladder keeps its own order there. A caller with a
 * default of its own passes `fallback`, returned instead in that case.
 * Effort names off the ladder (image quality values, unknown providers) only
 * ever match exactly.
 */
export function nearestSupportedReasoningEffort(candidates = [], supportedEfforts = [], { fallback } = {}) {
  const options = normalizeEffortList(supportedEfforts);
  if (!options.length) return '';
  const rungOf = (effort) => REASONING_EFFORT_LADDER.indexOf(effort);
  const ranked = options
    .filter((option) => option !== 'none' && rungOf(option) >= 0)
    .sort((left, right) => rungOf(left) - rungOf(right));
  for (const candidate of normalizeEffortList(candidates)) {
    if (options.includes(candidate)) return candidate;
    const rung = rungOf(candidate);
    if (rung < 0 || candidate === 'ultracode') continue;
    const below = ranked.filter((option) => rungOf(option) < rung);
    if (below.length) return below[below.length - 1];
    const above = ranked.find((option) => rungOf(option) > rung && option !== 'ultracode');
    if (above) return above;
  }
  if (fallback !== undefined) return fallback;
  const lowest = ranked.find((option) => option !== 'ultracode');
  if (lowest && options.every((option) => rungOf(option) >= 0)) return lowest;
  return options.find((option) => option !== 'none') || options[0];
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
  return nearestSupportedReasoningEffort(
    [preferredEffort, storedEffort, currentEffort],
    supportedEfforts,
  );
}
