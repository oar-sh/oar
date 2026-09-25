// Bridges the Copilot runtime's blocking interactive surfaces onto the
// relay's question cards:
//
//   * `onUserInputRequest` — the model called `ask_user`. Phase 1 answered these
//     in-band with a "not supported" note; this asks the human.
//   * `onPermissionRequest` in **ask** mode — the model wants to run a mutating
//     tool. Phase 1 blanket-rejected; this offers approve/deny.
//   * `onElicitationRequest` — a structured form (MCP elicitation). The card
//     carries the `requestedSchema`, the relay validates the submission, and
//     the answer comes back as `structuredAnswer` (`askStructured`).
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
import { looksLikeMultiSelectQuestion } from '../../shared/question-multi-select.mjs';
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
  // Creates still in flight. Shutdown's snapshot of `pendingQuestionIds` only
  // covers cards whose create already RETURNED — a POST in flight when
  // `cancelPendingQuestions` runs would otherwise resolve just after the
  // snapshot and leave its card pending forever. Each tracked promise also
  // covers the expiry the create performs itself when it lands after closing
  // started, so awaiting the set is awaiting the whole late-card teardown.
  const inflightCreates = new Set();
  // One-way: set by `cancelPendingQuestions`. From then on no new card is
  // minted and any card a late create produces is expired at birth.
  let closing = false;

  async function expireQuestion(questionId) {
    await api('POST', `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
  }

  async function createQuestion({ prompt, choices, allowFreeform, source, rationale, requestedSchema, timeoutMs, extra = {} }) {
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
      // Top-level, as the create route reads it: the relay stores it as the
      // card's `requestSchema` and validates the eventual `structuredAnswer`
      // against it.
      ...(requestedSchema ? { requestedSchema } : {}),
      sdk_session_id: sdkSessionId || undefined,
      // Fences the card to the delivering attempt: the server refuses creation
      // once the row has been requeued to a newer attempt (same field the
      // shared bridge sends).
      attemptId: activeMsg?.attemptId || undefined,
      timeout_ms: timeoutMs ?? questionTimeoutMs,
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
    // Shutdown already began: nothing will ever poll an answer, so minting a
    // card would only strand it in the UI. Shaped like a timeout so the caller
    // degrades exactly as it does for an unanswered card.
    if (closing) return { answer: QUESTION_TIMEOUT_CONTINUATION_TEXT, timedOut: true };
    const create = (async () => {
      const questionId = await createQuestion(spec);
      if (closing) {
        // The create raced `cancelPendingQuestions` and lost: its card was
        // born after the shutdown snapshot, so it is expired here, at birth —
        // the one place that still knows its id.
        dbg('relay question expired at birth (bridge closing)', questionId);
        await expireQuestion(questionId);
        return null;
      }
      pendingQuestionIds.add(questionId);
      return questionId;
    })();
    inflightCreates.add(create);
    let questionId;
    try {
      questionId = await create;
    } finally {
      inflightCreates.delete(create);
    }
    if (questionId === null) return { answer: QUESTION_TIMEOUT_CONTINUATION_TEXT, timedOut: true };
    dbg('relay question created', questionId, spec.source, spec.prompt.slice(0, 80));
    try {
      return await shared.waitForRelayQuestionAnswer(questionId, {
        signal,
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      });
    } finally {
      pendingQuestionIds.delete(questionId);
    }
  }

  /**
   * A structured elicitation (audit #17) → a schema-carrying relay card →
   * `{ structuredAnswer, answer, timedOut }`.
   *
   * The card is created with a top-level `requestedSchema`; the relay's answer
   * route validates the submission against it and stores `structuredAnswer`,
   * which the shared waiter reads back off the GET payload. A card that times
   * out, is cancelled, or was answered without a validatable structured body
   * comes back with `structuredAnswer: null` — the caller declines in that
   * case, so a half-valid submission can never be forced into a form result.
   */
  async function askStructured({ prompt, requestedSchema, timeoutMs }, { signal } = {}) {
    const result = await ask({
      prompt: String(prompt || '').trim() || 'Copilot needs structured input to continue this turn.',
      choices: [],
      allowFreeform: true,
      requestedSchema,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      source: 'onElicitationRequest',
      rationale: 'Copilot requested a structured form answer to continue this turn.',
    }, { signal });
    const structuredAnswer = result?.structuredAnswer && typeof result.structuredAnswer === 'object'
      && !Array.isArray(result.structuredAnswer)
      ? result.structuredAnswer
      : null;
    return {
      structuredAnswer,
      answer: String(result?.answer ?? ''),
      timedOut: result?.timedOut === true,
    };
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
    // Multi-select, in order of trust: the model's own flag (the relay's
    // `ask_user` tool has `multi_select`; the runtime's built-in one has no
    // such field), then the wording ("select all that apply"). Either way
    // every Copilot choice card also offers the "Select several" switch
    // (`allowMultiSelect`), because a model can forget to say so. The answer
    // comes back as the labels joined with ", ", which the model reads as a
    // freeform reply.
    // A request that demands exactly one of the offered choices
    // (`allowFreeform: false`) gets neither: a joined answer would be outside
    // the set the runtime asked for.
    const canPickSeveral = choices.length >= 2 && allowFreeform;
    const multiSelect = canPickSeveral
      && (request?.multiSelect === true || looksLikeMultiSelectQuestion(question, choices));
    const result = await ask({
      prompt: question || 'Copilot asked for input to continue this turn.',
      choices,
      allowFreeform,
      source: String(request?.source || '').trim() || 'onUserInputRequest',
      rationale: 'Copilot requested clarification to continue this turn.',
      extra: {
        requestId: String(request?.requestId || '') || undefined,
        ...(multiSelect ? { multiSelect: true } : {}),
        ...(canPickSeveral ? { allowMultiSelect: true } : {}),
      },
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
   *
   * `closing` is set FIRST, then the in-flight creates are awaited, so the
   * snapshot below cannot miss a card: a create that resolves after this line
   * sees `closing` and expires its own card before its tracked promise
   * settles. Returns only the count of cards timed out from the snapshot —
   * late-born cards are torn down but were never pending.
   */
  async function cancelPendingQuestions() {
    closing = true;
    if (inflightCreates.size) await Promise.allSettled([...inflightCreates]);
    const ids = [...pendingQuestionIds];
    pendingQuestionIds.clear();
    await Promise.all(ids.map((questionId) => expireQuestion(questionId)));
    return ids.length;
  }

  return {
    askUserInput,
    askToolApproval,
    askStructured,
    cancelPendingQuestions,
    pendingQuestionCount: () => pendingQuestionIds.size,
    // Re-exported so the runner can wait on a question id it created itself.
    waitForRelayQuestionAnswer: shared.waitForRelayQuestionAnswer,
  };
}

export { QUESTION_TIMEOUT_CONTINUATION_TEXT };
