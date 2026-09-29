import { getActiveSession } from '../runtime/session-registry.mjs';
import { createRelayQuestion, waitForRelayQuestion } from "../../../../shared/question-wait.mjs";
import { extractRequestedSchema } from "../../../../shared/question-schema.mjs";

export function createQuestionBridge({
  api,
  dbg,
  sleep,
  questionWaitTimeoutMs,
  getQuestionWaitTimeoutMs,
  questionPollMs,
  getActiveMessage,
  extractQuestionPrompt,
  extractQuestionChoices,
  serializeRequest,
}) {
  function firstDefined(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  }

  function extractAllowFreeform(request) {
    const value = firstDefined(
      request?.allow_freeform,
      request?.allowFreeform,
      request?.toolArgs?.allow_freeform,
      request?.toolArgs?.allowFreeform,
      request?.input?.allow_freeform,
      request?.input?.allowFreeform,
      request?.arguments?.allow_freeform,
      request?.arguments?.allowFreeform,
    );
    if (value === undefined) return undefined;
    return !!value;
  }

  function resolveQuestionWaitTimeoutMs(timeoutMs = null) {
    if (timeoutMs !== null && timeoutMs !== undefined) {
      const requested = Number(timeoutMs);
      if (Number.isFinite(requested) && requested >= 0) return requested;
    }
    if (typeof getQuestionWaitTimeoutMs === "function") {
      const dynamic = Number(getQuestionWaitTimeoutMs());
      if (Number.isFinite(dynamic) && dynamic >= 0) return dynamic;
    }
    const fallback = Number(questionWaitTimeoutMs);
    return Number.isFinite(fallback) && fallback >= 0 ? fallback : 0;
  }

  // The wait survives a relay that is briefly not there
  // (shared/question-wait.mjs).
  function waitForRelayQuestionAnswer(questionId, timeoutMs = null) {
    return waitForRelayQuestion({
      api,
      questionId,
      deadlineMs: resolveQuestionWaitTimeoutMs(timeoutMs),
      pollMs: questionPollMs,
      sleep,
      trimAnswer: false,
      dbg,
    });
  }

  async function forwardRelayQuestion(request) {
    const activeMsg = getActiveMessage();
    const choices = extractQuestionChoices(request);
    const allowFreeform = extractAllowFreeform(request);
    const activeSession = getActiveSession();
    const questionTimeoutMs = resolveQuestionWaitTimeoutMs();
    const requestedSchema = extractRequestedSchema(request);
    const questionPayload = {
      queueId: activeMsg?.id,
      messageId: activeMsg?.id,
      conversationId: activeMsg?.conversationId,
      mode: activeMsg?.relayMode || "agent",
      prompt: extractQuestionPrompt(request),
      choices,
      allowFreeform: allowFreeform ?? !choices.length,
      requestedSchema: requestedSchema || undefined,
      sdk_session_id: activeSession?.sdkSessionId || undefined,
      timeout_ms: questionTimeoutMs,
      context: {
        source: "onUserInputRequest",
        rationale: "Agent requested clarification to continue this turn.",
        queueMessageId: activeMsg?.id || null,
        conversationId: activeMsg?.conversationId || null,
        relayMode: activeMsg?.relayMode || "agent",
      },
      request: serializeRequest(request),
    };

    const questionId = await createRelayQuestion({ api, payload: questionPayload, sleep, dbg });

    dbg(
      "relay question created",
      questionId,
      "for msgId",
      activeMsg.id,
      "prompt=",
      questionPayload.prompt,
      "choices=",
      String(questionPayload.choices?.length || 0),
      "fields=",
      String(requestedSchema?.properties ? Object.keys(requestedSchema.properties).length : 0),
    );

    return waitForRelayQuestionAnswer(questionId, questionTimeoutMs);
  }

  return {
    forwardRelayQuestion,
    waitForRelayQuestionAnswer,
  };
}
