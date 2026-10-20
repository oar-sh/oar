'use strict';

// What a send to an existing conversation runs with when the request names no
// model or no effort. The answer is the conversation's own choice, never the
// relay-wide catalog default: a plain POST /api/message from a script or an
// agent used to switch a Copilot conversation to the catalog's first model and
// to effort 'none', and then saved that as the conversation's preference.
//
// The effort clamp is the composer's own (public/app/conversation-preferences.mjs),
// so the relay and the page settle on the same level for the same model.
import { nearestSupportedReasoningEffort } from '../public/app/conversation-preferences.mjs';

const AUTO_MODEL = 'auto';

function toText(value) {
  return String(value ?? '').trim();
}

/**
 * The model an existing conversation was last set to, in this order:
 *   1. the conversation's saved preference (what the composer shows);
 *   2. the runtime session's model (provider_model, else model);
 *   3. the model of the latest user message.
 * 'auto' is not a model a later turn can run on, so it is skipped. Null when
 * the conversation has none of these: the caller falls back to the catalog.
 */
export function inheritedConversationModel({
  conversation = null,
  runtimeSession = null,
  latestUserMessageModel = '',
} = {}) {
  // provider_model and model are looked at one by one, so an 'auto' in one
  // does not hide a real model in the other.
  const candidates = [
    { source: 'conversation', model: toText(conversation?.preferred_model) },
    { source: 'runtime', model: toText(runtimeSession?.provider_model) },
    { source: 'runtime', model: toText(runtimeSession?.model) },
    { source: 'message', model: toText(latestUserMessageModel) },
  ];
  return candidates.find((entry) => entry.model && entry.model.toLowerCase() !== AUTO_MODEL) || null;
}

/**
 * The effort for a turn that names none: the first candidate the model
 * supports (or the nearest level to it), else the model's lowest level that
 * is not 'none'. 'none' comes back only when it is the only level, or when a
 * candidate asks for it and the model has it. '' when the model lists no
 * levels at all. A provider whose own default is better than "the lowest
 * level" passes `fallback`, returned when no candidate matches or clamps.
 */
export function fallbackReasoningEffort(candidates = [], supportedEfforts = [], { fallback } = {}) {
  return nearestSupportedReasoningEffort(
    (Array.isArray(candidates) ? candidates : [candidates]).map(toText).filter(Boolean),
    supportedEfforts,
    { fallback },
  );
}
