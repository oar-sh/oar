// The `context` block a relay question card carries: who asked, why, for which
// queue row, and the few presentation hints the card renders from. Workers
// send it on POST /api/relay-question; it is stored inside the question's
// request envelope and served back to the client. Anything not listed here is
// dropped, so a new hint the client reads must be added here too (the
// multi-select flag was once silently stripped this way).

/**
 * @param {unknown} rawContext
 * @param {{ normalizeRelayMode?: (mode: string) => string | null, defaultRelayMode?: string }} [options]
 */
export function sanitizeRelayQuestionContext(rawContext, {
  normalizeRelayMode = (mode) => String(mode || '').trim().toLowerCase() || null,
  defaultRelayMode = 'agent',
} = {}) {
  if (!rawContext || typeof rawContext !== 'object' || Array.isArray(rawContext)) return null;
  const context = {};
  if (typeof rawContext.source === 'string' && rawContext.source.trim()) {
    context.source = rawContext.source.trim().slice(0, 64);
  }
  if (typeof rawContext.rationale === 'string' && rawContext.rationale.trim()) {
    context.rationale = rawContext.rationale.trim().slice(0, 240);
  }
  if (typeof rawContext.queueMessageId === 'string' && rawContext.queueMessageId.trim()) {
    context.queueMessageId = rawContext.queueMessageId.trim();
  }
  if (typeof rawContext.conversationId === 'string' && rawContext.conversationId.trim()) {
    context.conversationId = rawContext.conversationId.trim();
  }
  if (typeof rawContext.relayMode === 'string' && rawContext.relayMode.trim()) {
    context.relayMode = normalizeRelayMode(rawContext.relayMode) || defaultRelayMode;
  }
  // The card renders checkmarks instead of one-shot buttons when several
  // answers are allowed (Claude's AskUserQuestion `multiSelect`, or the
  // Copilot worker's wording heuristic). Only an explicit `true` is kept.
  if (rawContext.multiSelect === true) context.multiSelect = true;
  // Providers whose ask tool cannot always say so (Copilot) mark their choice
  // cards with this: the card then offers a "Select several" switch, so the
  // user can pick several answers even when the model did not flag it.
  if (rawContext.allowMultiSelect === true) context.allowMultiSelect = true;
  // Claude's short question label ("Workers", "Visibility").
  if (typeof rawContext.header === 'string' && rawContext.header.trim()) {
    context.header = rawContext.header.trim().slice(0, 120);
  }
  return Object.keys(context).length ? context : null;
}
