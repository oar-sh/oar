import fs from 'node:fs';
import { countPlanLikeLines } from '../../shared/plan-lines.mjs';
import { EMPTY_TURN_COMPLETION_NOTE } from '../../shared/empty-turn-completion.mjs';
import { buildSteerSettleFailure, steerSettleFailureText } from '../../shared/steer-settle-failure.mjs';

const PLAN_BOARD_ACTIONS = [
  { id: 'autopilot', label: 'Implement in autopilot', mode: 'autopilot' },
  { id: 'interactive', label: 'Stop here and prompt myself', mode: 'agent' },
  { id: 'exit_only', label: 'Stop here', mode: 'agent' },
];

/**
 * The attempt-fencing echo for a row's write bodies. Every publish that names
 * a `messageId` also names the attempt it belongs to, so the relay can refuse
 * writes from a superseded attempt (a requeued row re-delivered elsewhere).
 * Omitted entirely when the row carries no attempt id (a pre-fencing relay).
 */
export function attemptFields(message) {
  return message?.attemptId ? { attemptId: message.attemptId } : {};
}

/** A 409 whose detail names `stale_attempt`: this attempt was superseded. */
export function isStaleAttemptError(error) {
  if (Number(error?.status) !== 409) return false;
  const detail = typeof error?.detail === 'string' ? error.detail : JSON.stringify(error?.detail || '');
  return detail.includes('stale_attempt');
}

export { buildSteerSettleFailure, steerSettleFailureText };
export const STEER_SETTLE_FAILED_TEXT = steerSettleFailureText('folded');

export function buildClaudePlanReadyBoardPayload({ message, planText = '' } = {}) {
  const summary = String(planText || '').trim();
  if (!summary) return null;
  return {
    queueId: message?.id,
    messageId: message?.id,
    conversationId: message?.conversationId,
    mode: message?.relayMode || 'agent',
    boardType: 'plan_ready',
    title: 'Plan ready for review',
    body: summary,
    actions: PLAN_BOARD_ACTIONS,
    recommendedAction: null,
    context: {
      source: 'exit_plan_mode',
      queueMessageId: message?.id || null,
      conversationId: message?.conversationId || null,
      relayMode: message?.relayMode || 'agent',
    },
  };
}

/**
 * The relay-facing half of a Claude turn: normalized actions in, HTTP calls to
 * the relay's activity/stream/response channels out. Owns no turn or process
 * state — every function takes the turn's relay message and the caller's
 * mutable turn state, so the session process can run any number of turns
 * (delivered or background-continuation) through one publisher.
 */
export function createClaudeTurnPublisher({ api, dbg = () => {}, takeWorkflowRuns = null } = {}) {
  function drainWorkflowRuns({ terminal = false } = {}) {
    if (terminal || typeof takeWorkflowRuns !== 'function') return null;
    return takeWorkflowRuns();
  }

  async function postActivity(message, text, subagentRunId = null, metadata = null) {
    if (!text) return;
    await api('POST', '/api/activity', {
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || 'agent',
      text,
      ...(subagentRunId ? { subagentRunId } : {}),
      ...(metadata && typeof metadata === 'object' ? { metadata } : {}),
      ...attemptFields(message),
    }).catch(() => {});
  }

  async function dispatchAction(message, action, state) {
    const { channel, payload } = action;
    if (channel === 'init') {
      state.responseModel = payload.model || state.responseModel;
      return;
    }
    if (channel === 'stream') {
      // Only the main thread's text can stand in for the answer. Subagent text
      // is forwarded too (forwardSubagentText), and letting it land here would
      // publish a subagent's prose as the reply on the abort / error / no-result
      // fallback paths below.
      if (!payload.subagentRunId) state.lastStreamedText = payload.text;
      await api('POST', '/api/stream', {
        messageId: message.id,
        conversationId: message.conversationId,
        mode: message.relayMode || 'agent',
        text: payload.text,
        done: payload.done === true,
        ...(payload.subagentRunId ? { subagentRunId: payload.subagentRunId } : {}),
        ...attemptFields(message),
      }).catch(() => {});
      return;
    }
    if (channel === 'thought') {
      await api('POST', '/api/thought', {
        messageId: message.id,
        conversationId: message.conversationId,
        mode: message.relayMode || 'agent',
        reasoningId: payload.reasoningId,
        text: payload.text,
        done: payload.done === true,
        ...(payload.subagentRunId ? { subagentRunId: payload.subagentRunId } : {}),
        ...attemptFields(message),
      }).catch(() => {});
      return;
    }
    if (channel === 'activity') {
      await postActivity(message, payload.text, payload.subagentRunId, payload.metadata || null);
      return;
    }
    if (channel === 'subagent') {
      await api('POST', '/api/subagent-run', {
        messageId: message.id,
        conversationId: message.conversationId,
        subagentRunId: payload.subagentRunId,
        parentSubagentId: payload.parentSubagentId || undefined,
        displayName: payload.displayName || undefined,
        status: payload.status,
        ...attemptFields(message),
      }).catch(() => {});
      return;
    }
    if (channel === 'result') {
      state.result = payload;
      state.modelUsage = payload.modelUsage || null;
      const text = String(payload.text || '').trim();
      if (text) state.resultTexts.push(text);
    }
  }

  /**
   * Ship the turn's context-window breakdown to the relay, which serves it back
   * to the UI as the composer indicator and the context-usage modal. Advisory
   * data: a failure here must not disturb the turn's response.
   */
  async function publishContextUsage({ message, state, model, sdkSessionId }) {
    if (!state.contextUsage && !state.modelUsage) return;
    await api('POST', '/api/claude-context-usage', {
      conversationId: message.conversationId,
      sdkSessionId,
      model: state.responseModel || model || null,
      contextUsage: state.contextUsage,
      modelUsage: state.modelUsage,
    }).catch((error) => {
      dbg('context usage publish failed', error?.message || String(error));
    });
  }

  /**
   * Ship the session's plan usage (rate-limit windows + cost totals) to the
   * relay. Falls back to the stable result fields when the experimental usage
   * control request is unavailable, so the card still gets session cost.
   * Advisory: a failure here must not disturb the turn's response.
   */
  async function publishPlanUsage({ message, state, sdkSessionId }) {
    const totalCostUsd = state.result?.totalCostUsd ?? null;
    // A cost with no per-model breakdown is still a usable fallback payload, so
    // it has to count as a reason to publish or the card loses session cost on
    // any turn the SDK reports without `modelUsage`.
    if (!state.planUsage && !state.modelUsage && totalCostUsd === null) return;
    await api('POST', '/api/claude-plan-usage', {
      conversationId: message.conversationId,
      sdkSessionId,
      usage: state.planUsage,
      modelUsage: state.modelUsage,
      totalCostUsd,
    }).catch((error) => {
      dbg('plan usage publish failed', error?.message || String(error));
    });
  }

  async function publishFinalStream(message, text) {
    await api('POST', '/api/stream', {
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || 'agent',
      text: String(text || ''),
      done: true,
      ...attemptFields(message),
    }).catch(() => {});
  }

  /**
   * Returns the outcome: 'published' (the relay took it), 'stale' (another
   * attempt owns the row), 'failed' (not taken and NOT requeued), or
   * 'requeued'. A `kind` marks a row whose prompt the CLI already consumed —
   * 'absorbed' (the reply continues through the next, steered message) or
   * 'stopped' (steered into a turn the user stopped) — and such a row is never
   * requeued, since re-delivery would run the prompt a second time; the
   * caller owns retrying it. `requeueOnFailure: false` opts any other publish
   * into the same contract.
   */
  async function publishResponse(message, {
    text,
    model,
    terminalError = null,
    modelOrigin,
    absorbed = false,
    kind = null,
    requeueOnFailure = true,
    // Ids of steered queue rows pushed into the turn this response finishes
    // and still unsettled: the relay marks them consumed in the same
    // transaction, so no recovery path ever re-runs them (at-most-once even
    // if this worker dies before settling them).
    consumedSteerIds = null,
    // A caller retrying one publish drains the settled workflow digests ONCE
    // and passes them to every attempt, so a failed attempt cannot lose them.
    workflowRuns: presetWorkflowRuns,
  }) {
    const responseKind = kind || (absorbed ? 'absorbed' : null);
    // Final digests of workflows that settled since the last response ride the
    // next successful response publish — the summarizing turn is the natural
    // transcript anchor for the "Finished background task" card. Terminal
    // failures skip the drain so the digests stay buffered for a later turn;
    // if this POST fails (→ requeue) or the process dies before any response
    // publishes, the drained digests are lost — acceptable v1.
    const workflowRuns = presetWorkflowRuns !== undefined
      ? presetWorkflowRuns
      : drainWorkflowRuns({ terminal: Boolean(terminalError) });
    const consumed = Array.isArray(consumedSteerIds)
      ? consumedSteerIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    try {
      await api('POST', '/api/response', {
        messageId: message.id,
        conversationId: message.conversationId,
        text: String(text || ''),
        model: model || null,
        modelOrigin: modelOrigin
          || (String(message?.model || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual'),
        ...(Array.isArray(workflowRuns) && workflowRuns.length ? { workflowRuns } : {}),
        ...(terminalError ? { terminalError } : {}),
        // The relay stamps the assistant message's kind from these: 'absorbed'
        // renders as merged into the next (steered) user message, 'stopped' as
        // a steer the user's Stop cut off unanswered.
        ...(responseKind === 'absorbed' ? { absorbed: true } : {}),
        ...(responseKind && responseKind !== 'absorbed' ? { kind: responseKind } : {}),
        ...(consumed.length ? { consumedSteerIds: consumed } : {}),
        ...attemptFields(message),
      });
      return 'published';
    } catch (error) {
      // A stale_attempt 409 means the row already moved on to another attempt
      // (requeued and re-delivered); the requeue would 409 the same way, and
      // the newer attempt owes the row its answer — drop this one.
      if (isStaleAttemptError(error)) {
        dbg('response refused as stale_attempt; dropping', message.id);
        return 'stale';
      }
      if (responseKind || !requeueOnFailure) {
        dbg('response publish failed; not requeuing a consumed prompt', message.id, error?.message || String(error));
        return 'failed';
      }
      await api('POST', '/api/requeue', { messageId: message.id, ...attemptFields(message) }).catch(() => {});
      return 'requeued';
    }
  }

  /**
   * Post the plan-ready review board for an ExitPlanMode interception. The CLI
   * sends both `plan` and `planFilePath`; the inline plan is authoritative, the
   * plan file covers CLI versions that stop inlining it. Returns false when no
   * plan text could be recovered so the caller's plan-shaped-final-text
   * fallback still gets a chance to post the board.
   */
  async function publishPlanBoard(message, input) {
    let planText = String(input?.plan || input?.summary || '').trim();
    if (!planText) {
      const planFilePath = String(input?.planFilePath || '').trim();
      if (planFilePath) {
        try {
          planText = String(fs.readFileSync(planFilePath, 'utf8') || '').trim();
        } catch (error) {
          dbg('plan file read failed', planFilePath, error?.message || String(error));
        }
      }
    }
    const boardPayload = buildClaudePlanReadyBoardPayload({ message, planText });
    if (!boardPayload) return false;
    await api('POST', '/api/relay-board', boardPayload).catch((error) => {
      dbg('plan board publish failed', error?.message || String(error));
    });
    return true;
  }

  /**
   * Publish a completed (non-error, non-aborted) turn: final stream snapshot,
   * plan-mode fallback board, response row. Mirrors the pre-session-process
   * turn runner's tail exactly.
   */
  async function publishCompletedTurn({ message, state, responseModel, planBoardPosted, consumedSteerIds = null }) {
    const result = state.result;
    const finalText = String(
      state.resultTexts.join('\n\n') || result?.text || state.lastStreamedText || '',
    ).trim();
    if (
      !planBoardPosted
      && String(message.relayMode || '').trim().toLowerCase() === 'plan'
      && countPlanLikeLines(finalText) >= 2
    ) {
      const boardPayload = buildClaudePlanReadyBoardPayload({ message, planText: finalText });
      if (boardPayload) {
        boardPayload.context.source = 'plan-mode-fallback';
        await api('POST', '/api/relay-board', boardPayload).catch(() => {});
      }
    }
    // Same reasoning as the Cursor worker: a terminal, non-error result with no
    // prose is a completed turn (the model can end on tool activity alone), and
    // requeuing it re-runs deterministically empty work until the retry cap
    // fails the message with a misleading "Relay timeout".
    const publishedText = finalText || EMPTY_TURN_COMPLETION_NOTE;
    await publishFinalStream(message, publishedText);
    await publishResponse(message, { text: publishedText, model: responseModel, consumedSteerIds });
  }

  async function publishErrorResult({ message, state, responseModel, consumedSteerIds = null }) {
    const result = state.result;
    const errorText = result.text
      || `Claude turn failed (${result.subtype || 'unknown error'}).`;
    await publishFinalStream(message, state.lastStreamedText);
    await publishResponse(message, {
      text: errorText,
      model: responseModel,
      terminalError: {
        kind: 'claude-turn-failed',
        code: result.subtype || 'unknown',
        stableCode: `claude.${result.subtype || 'unknown'}`,
        message: errorText,
        failedAt: new Date().toISOString(),
        queueMessageId: String(message.id || '') || null,
      },
      consumedSteerIds,
    });
  }

  async function publishTurnException({ message, errorText }) {
    const isAuthError = /authentication|logged in|login|credential|api key/i.test(errorText);
    await publishResponse(message, {
      text: isAuthError
        ? `System note: the Claude runtime could not authenticate (${errorText}). Log in again from Settings → Providers → Claude → Relogin (or run \`claude\` on the relay host), then retry.`
        : `System note: the Claude turn failed (${errorText}). Retry or send a new message.`,
      model: null,
      terminalError: {
        kind: 'claude-turn-failed',
        code: isAuthError ? 'authentication_failed' : 'turn-error',
        stableCode: isAuthError ? 'claude.authentication_failed' : 'claude.turn-error',
        message: errorText,
        failedAt: new Date().toISOString(),
        queueMessageId: String(message.id || '') || null,
      },
    });
  }

  return {
    postActivity,
    drainWorkflowRuns,
    dispatchAction,
    publishContextUsage,
    publishPlanUsage,
    publishFinalStream,
    publishResponse,
    publishPlanBoard,
    publishCompletedTurn,
    publishErrorResult,
    publishTurnException,
  };
}
