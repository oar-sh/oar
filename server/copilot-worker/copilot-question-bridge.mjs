// Bridges the Copilot runtime's two blocking interactive surfaces onto the
// relay's question cards:
//
//   * `onUserInputRequest` — the model called `ask_user`. Phase 1 answered these
//     in-band with a "not supported" note; this asks the human.
//   * `onPermissionRequest` in **ask** mode — the model wants to run a mutating
//     tool. Phase 1 blanket-rejected; this offers approve/deny.
//
// Both are wired to the SAME relay endpoints the extension's
// `skills/question-bridge.mjs` uses, so a question raised by the SDK engine
// renders as the identical card, answers through the identical route, and
// honours the identical timeout as one raised by the extension engine.
//
// The polling/timeout/abort loop is NOT re-implemented here: it is
// `createAskUserBridge(...).waitForRelayQuestionAnswer` from
// `shared/ask-user-bridge.mjs`, reused verbatim. Only the CREATE payload is
// local, because Copilot's request shape carries things the shared
// `handleAskUserQuestion` cannot express — a real `allowFreeform` (the shared
// helper hardcodes `true`) and a single question rather than a Claude-style
// question array. Composing the waiter instead of copying it keeps one
// implementation of the abort semantics.
import { createAskUserBridge } from '../../shared/ask-user-bridge.mjs';
import {
  DEFAULT_QUESTION_TIMEOUT_MS,
  QUESTION_TIMEOUT_CONTINUATION_TEXT,
} from '../../shared/question-timeout.mjs';
import { describePermissionRequest } from './copilot-sdk-adapter.mjs';

/** Choice labels for a permission card. Freeform text is treated as denial. */
export const PERMISSION_APPROVE_CHOICE = 'Approve';
export const PERMISSION_DENY_CHOICE = 'Deny';

/**
 * Normalize the runtime's `choices` into a string array.
 *
 * `choices` is documented as nullable — `null` means "no choices, free text
 * only" and must NOT become `[]`-with-`allowFreeform:false`, which would render
 * a card the user cannot answer at all.
 */
export function normalizeUserInputChoices(choices) {
  if (!Array.isArray(choices)) return [];
  return choices
    .map((choice) => (typeof choice === 'string' ? choice : String(choice?.label ?? choice?.value ?? '')))
    .map((choice) => choice.trim())
    .filter(Boolean);
}

/**
 * Did the human type their own answer rather than pick an offered choice?
 *
 * The relay wire path is identical for both (the UI posts the chosen label as
 * `answer`), so this is derived rather than reported. An answer that exactly
 * matches an offered choice is a selection; anything else — including the
 * timeout continuation text — is freeform. `wasFreeform` is REQUIRED by
 * `UserInputResponse` and the runtime's deserializer is strict, so it must
 * always be a real boolean.
 */
export function deriveWasFreeform(answer, choices) {
  const normalized = normalizeUserInputChoices(choices);
  if (!normalized.length) return true;
  const value = String(answer ?? '').trim();
  return !normalized.some((choice) => choice === value);
}

export function createCopilotQuestionBridge({
  api,
  sdkSessionId = '',
  getActiveMessage,
  questionPollMs = 1500,
  questionTimeoutMs = DEFAULT_QUESTION_TIMEOUT_MS,
  sleep,
  dbg = () => {},
} = {}) {
  const shared = createAskUserBridge({
    api,
    sdkSessionId,
    getActiveMessage,
    questionPollMs,
    questionTimeoutMs,
    ...(sleep ? { sleep } : {}),
    dbg,
  });

  // Question ids this worker created and has not yet seen settle. Shutdown
  // walks these so a pending card is timed out deliberately rather than left
  // spinning in the UI until the relay's 10s expiry sweeper notices.
  const pendingQuestionIds = new Set();

  async function createQuestion({ prompt, choices, allowFreeform, source, rationale, extra = {} }) {
    const activeMsg = typeof getActiveMessage === 'function' ? getActiveMessage() : null;
    const payload = {
      // The relay 409s ("No active relay turn") unless this queue row is
      // `processing`, which is exactly the state a blocking handler runs in.
      queueId: activeMsg?.id,
      messageId: activeMsg?.id,
      conversationId: activeMsg?.conversationId,
      mode: activeMsg?.relayMode || 'agent',
      prompt,
      choices,
      allowFreeform,
      sdk_session_id: sdkSessionId || undefined,
      timeout_ms: questionTimeoutMs,
      context: {
        source,
        rationale,
        queueMessageId: activeMsg?.id || null,
        conversationId: activeMsg?.conversationId || null,
        relayMode: activeMsg?.relayMode || 'agent',
        ...extra,
      },
    };
    const created = await api('POST', '/api/relay-question', payload);
    const questionId = created?.question?.id;
    if (!questionId) throw new Error('Relay question could not be created');
    return questionId;
  }

  async function ask(spec, { signal } = {}) {
    const questionId = await createQuestion(spec);
    pendingQuestionIds.add(questionId);
    dbg('relay question created', questionId, spec.source, spec.prompt.slice(0, 80));
    try {
      return await shared.waitForRelayQuestionAnswer(questionId, { signal });
    } finally {
      pendingQuestionIds.delete(questionId);
    }
  }

  /**
   * `onUserInputRequest` → a relay question card → `{ answer, wasFreeform }`.
   *
   * Never throws: a handler that throws is auto-answered `user-not-available`
   * by the SDK for permissions, and for user input it would fail the tool call
   * silently. A relay that is unreachable therefore degrades to the same
   * in-band note phase 1 always returned, which lets the model continue.
   */
  async function askUserInput(request, { signal } = {}) {
    const question = String(request?.question || '').trim();
    const choices = normalizeUserInputChoices(request?.choices);
    // `allowFreeform` is only meaningful alongside choices; with none, the card
    // must accept free text or it cannot be answered.
    const allowFreeform = choices.length ? request?.allowFreeform !== false : true;
    const result = await ask({
      prompt: question || 'Copilot asked for input to continue this turn.',
      choices,
      allowFreeform,
      source: 'onUserInputRequest',
      rationale: 'Copilot requested clarification to continue this turn.',
      extra: { requestId: String(request?.requestId || '') || undefined },
    }, { signal });
    const answer = String(result?.answer ?? '');
    return {
      answer,
      wasFreeform: result?.timedOut ? true : deriveWasFreeform(answer, choices),
      timedOut: result?.timedOut === true,
    };
  }

  /**
   * `onPermissionRequest` in ask mode → an approve/deny card.
   *
   * Freeform is allowed and anything that is not exactly "Approve" denies —
   * so a human can type *why* they are refusing and the model receives it as
   * feedback instead of a bare refusal.
   */
  async function askToolApproval(request, { signal } = {}) {
    const description = describePermissionRequest(request);
    const result = await ask({
      prompt: `Copilot wants to run:\n\n${description}\n\nApprove this action?`,
      choices: [PERMISSION_APPROVE_CHOICE, PERMISSION_DENY_CHOICE],
      allowFreeform: true,
      source: 'onPermissionRequest',
      rationale: 'Copilot requested permission to run a tool in ask mode.',
      extra: {
        requestId: String(request?.requestId || '') || undefined,
        permissionKind: String(request?.kind || '') || undefined,
      },
    }, { signal });
    const answer = String(result?.answer ?? '').trim();
    const approved = !result?.timedOut && answer.toLowerCase() === PERMISSION_APPROVE_CHOICE.toLowerCase();
    // The denial note is composed HERE rather than in the permission handler so
    // the handler never needs to know the card's choice labels — that would be
    // an import cycle (this module already imports the request describer from
    // the adapter). A freeform denial carries the human's own reason; a plain
    // "Deny" click does not, so echoing the button label back at the model as
    // though it were an explanation is avoided.
    const feedback = answer && answer.toLowerCase() !== PERMISSION_DENY_CHOICE.toLowerCase()
      ? answer
      : 'The user declined this action.';
    return { approved, answer, feedback, timedOut: result?.timedOut === true, description };
  }

  /**
   * Settle every card this worker is still waiting on. Called on shutdown: the
   * process is about to stop polling, so a card left `pending` would sit in the
   * UI inviting an answer that nothing will ever read.
   */
  async function cancelPendingQuestions() {
    const ids = [...pendingQuestionIds];
    pendingQuestionIds.clear();
    await Promise.all(ids.map((questionId) => api('POST', `/api/relay-question/${questionId}/timeout`, {})
      .catch(() => {})));
    return ids.length;
  }

  return {
    askUserInput,
    askToolApproval,
    cancelPendingQuestions,
    pendingQuestionCount: () => pendingQuestionIds.size,
    // Re-exported so the runner can wait on a question id it created itself.
    waitForRelayQuestionAnswer: shared.waitForRelayQuestionAnswer,
  };
}

export { QUESTION_TIMEOUT_CONTINUATION_TEXT };
