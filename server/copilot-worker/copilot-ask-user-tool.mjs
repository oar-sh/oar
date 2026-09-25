// The relay's own `ask_user` tool for Copilot SDK sessions.
//
// The runtime's built-in `ask_user` offers the model only `question` and
// `choices` (captured from the request body, runtime 1.0.88), so a model has
// no way to say "the user may pick several of these" — and the relay could
// only guess from the wording. The SDK lets a host register a tool that
// overrides a built-in one of the same name (`overridesBuiltInTool`), so the
// worker registers this superset instead: the same name and fields every
// model already knows, plus `multi_select`. Verified with the fake-provider
// probe (2026-09-25): the model sees exactly one `ask_user` with this schema,
// the handler receives the call, and the built-in path is never used.
//
// Pure: schema, argument parsing and the result wording. The session process
// wires the handler to the relay question bridge.

import { normalizeUserInputChoices } from './copilot-question-bridge.mjs';

export const RELAY_ASK_USER_TOOL_NAME = 'ask_user';

export const RELAY_ASK_USER_TOOL_DESCRIPTION = [
  'Ask the user a question and wait for their response.',
  'Use this tool when you need to ask the user questions during execution. This allows you to:',
  '1. Gather user preferences or requirements',
  '2. Clarify ambiguous instructions',
  '3. Get decisions on implementation choices as you work',
  '4. Offer choices to the user about what direction to take',
  'The question is shown to the user as a card with a button per choice.',
  'Set multi_select to true when the user may pick several of the choices (the choices are not',
  'mutually exclusive); the answer then lists every pick, separated by ", ". Leave it false or',
  'omit it when exactly one choice applies.',
].join('\n');

export const RELAY_ASK_USER_TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'The question to ask the user. Ensure only one question is asked at a time - do not bundle multiple questions together.',
    },
    choices: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional list of choices for a multiple choice question. Prefer providing choices when possible.',
    },
    multi_select: {
      type: 'boolean',
      description: 'true when the user may pick several of the choices; false or omitted when exactly one applies.',
    },
  },
  required: ['question'],
});

/** The call's arguments, tolerating the camelCase spelling some models emit. */
export function parseAskUserToolArguments(args) {
  const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  return {
    question: String(source.question || '').trim(),
    choices: normalizeUserInputChoices(source.choices),
    multiSelect: source.multi_select === true || source.multiSelect === true,
  };
}

/**
 * The tool result the model reads, worded like the built-in's ("User
 * selected: b" for a choice, "User responded: …" for anything else) so a
 * model's habits carry over. A timed-out card returns the bridge's
 * continuation text as it is.
 */
export function formatAskUserToolResult({ answer, wasFreeform = true, timedOut = false } = {}) {
  const text = String(answer ?? '').trim();
  if (timedOut) return text;
  if (!text) return 'User responded with an empty answer.';
  // `wasFreeform` comes from the question bridge (`deriveWasFreeform`), the
  // single owner of "was this one of the offered choices".
  return wasFreeform === false ? `User selected: ${text}` : `User responded: ${text}`;
}

/**
 * Whether a session create/resume failure is the runtime refusing the
 * override (an older runtime without `overridesBuiltInTool`, or one that
 * rejects replacing this built-in). Anything else is a real failure.
 */
export function isToolOverrideRejection(error) {
  const message = String(error?.message || error || '');
  if (/overridesBuiltInTool/i.test(message)) return true;
  // The tool named together with an override/clash complaint — a message that
  // merely mentions ask_user (a replayed call in history, say) is not one.
  return /\bask_user\b/i.test(message) && /(built-?in|clash|conflict|overrid|duplicate)/i.test(message);
}
