'use strict';

import { openAIReasoningEffortsForModel } from '../../shared/openai-reasoning.mjs';

export const DEFAULT_CLAUDE_REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
export const DEFAULT_GROK_REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high']);

function normalizeEffort(value) {
  return String(value || '').trim().toLowerCase();
}

function effortsForModel(effortsByModel, model) {
  const key = normalizeEffort(model);
  if (!key || !effortsByModel || typeof effortsByModel !== 'object') return null;
  const efforts = effortsByModel[key];
  return Array.isArray(efforts) ? efforts.map(normalizeEffort).filter(Boolean) : null;
}

// Returns the tiers a provider/model pair accepts, or null when the tiers are
// unknown. null is not "no reasoning": Cursor models that predate effort
// discovery must pass the request through so the worker can validate it against
// the live model params instead of the relay silently disabling thinking.
export function supportedReasoningEffortsForProviderModel({
  providerType = '',
  model = '',
  cursorSettings = null,
  claudeSettings = null,
  grokSettings = null,
  reasoningByModel = null,
} = {}) {
  const provider = normalizeEffort(providerType);
  if (provider === 'cursor') return effortsForModel(cursorSettings?.effortsByModel, model);
  if (provider === 'claude') {
    return effortsForModel(claudeSettings?.effortsByModel, model) || [...DEFAULT_CLAUDE_REASONING_EFFORTS];
  }
  if (provider === 'grok') {
    return effortsForModel(grokSettings?.effortsByModel, model) || [...DEFAULT_GROK_REASONING_EFFORTS];
  }
  if (provider === 'openai' || provider === 'openai-image') {
    const efforts = openAIReasoningEffortsForModel(model);
    return Array.isArray(efforts) && efforts.length ? efforts.map(normalizeEffort).filter(Boolean) : null;
  }
  return effortsForModel(reasoningByModel, model);
}

// Mirrors the per-turn rules on the message path so a New Chat selection and
// the first send agree: a supported tier is kept, an unsupported one clamps to
// the provider's off-switch, an unstated one takes the provider default, and an
// unknown tier list passes through.
//
// `strict` reproduces the one provider that refuses rather than clamps: OpenAI
// answers an unsupported effort with a 400, so bootstrap must not store a value
// the first send would reject.
export function resolveProviderReasoningEffort({
  requestedEffort = '',
  supportedEfforts = null,
  strict = false,
} = {}) {
  const requested = normalizeEffort(requestedEffort);
  const supported = Array.isArray(supportedEfforts)
    ? supportedEfforts.map(normalizeEffort).filter(Boolean)
    : null;
  if (!supported) return { ok: true, effort: requested, supported: [] };
  const providerDefault = supported.includes('none') ? 'none' : (supported[0] || '');
  if (!requested) return { ok: true, effort: providerDefault, supported };
  if (supported.includes(requested)) return { ok: true, effort: requested, supported };
  if (strict) {
    return {
      ok: false,
      effort: '',
      supported,
      error: `Reasoning effort "${requested}" is not supported`,
    };
  }
  return { ok: true, effort: providerDefault, supported };
}
