import fs from 'node:fs';
import { buildClaudeUserContent } from './claude-attachments.mjs';
import { createSdkMessageNormalizer } from './sdk-message-normalizer.mjs';
import { startClaudeTurn, createCanUseTool, readContextUsage } from './claude-sdk-adapter.mjs';
import { relocateClaudeTranscriptForCwd } from './claude-transcript-relocator.mjs';
import { createAskUserBridge } from '../../shared/ask-user-bridge.mjs';
import { countPlanLikeLines } from '../../shared/plan-lines.mjs';

const PLAN_BOARD_ACTIONS = [
  { id: 'autopilot', label: 'Implement in autopilot', mode: 'autopilot' },
  { id: 'interactive', label: 'Stop here and prompt myself', mode: 'agent' },
  { id: 'exit_only', label: 'Stop here', mode: 'agent' },
];

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
 * Execute one delivered relay turn against the Claude Agent SDK, streaming
 * normalized events into the relay's activity channels and publishing the
 * final response. Mirrors the Copilot extension's `handlePendingPayload`
 * contract (response / requeue / abort semantics).
 */
export function createClaudeTurnRunner({
  api,
  sdkSessionId,
  cwd,
  defaultModel = '',
  controlPoller,
  pathToClaudeCodeExecutable = '',
  startClaudeTurnImpl = startClaudeTurn,
  readContextUsageImpl = readContextUsage,
  relocateTranscriptImpl = relocateClaudeTranscriptForCwd,
  dbg = () => {},
} = {}) {
  let activeMessage = null;
  let claudeNativeSessionId = '';
  let waitingForTurn = false;

  function getActiveQueueMessageId() {
    return waitingForTurn ? String(activeMessage?.id || '') : '';
  }

  function isTurnActive() {
    return waitingForTurn;
  }

  async function postActivity(message, text, subagentRunId = null) {
    if (!text) return;
    await api('POST', '/api/activity', {
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || 'agent',
      text,
      ...(subagentRunId ? { subagentRunId } : {}),
    }).catch(() => {});
  }

  async function persistNativeSessionId(message, sessionId) {
    const normalized = String(sessionId || '').trim();
    if (!normalized || normalized === claudeNativeSessionId) return;
    try {
      await api('POST', '/api/claude-native-session', {
        conversationId: message.conversationId,
        claudeNativeSessionId: normalized,
      });
      // Only cache after the server accepted it, so a failed persist is
      // retried on the next turn — resume across worker restarts depends on
      // the server-side copy.
      claudeNativeSessionId = normalized;
    } catch (error) {
      dbg('claude native session persist failed', error?.message || String(error));
    }
  }

  async function dispatchAction(message, action, state) {
    const { channel, payload } = action;
    if (channel === 'init') {
      state.responseModel = payload.model || state.responseModel;
      await persistNativeSessionId(message, payload.sessionId);
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
      }).catch(() => {});
      return;
    }
    if (channel === 'activity') {
      await postActivity(message, payload.text, payload.subagentRunId);
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
      }).catch(() => {});
      return;
    }
    if (channel === 'result') {
      state.result = payload;
      state.modelUsage = payload.modelUsage || null;
    }
  }

  /**
   * Ship the turn's context-window breakdown to the relay, which serves it back
   * to the UI as the composer indicator and the context-usage modal. Advisory
   * data: a failure here must not disturb the turn's response.
   */
  async function publishContextUsage(message, state, model) {
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

  async function publishFinalStream(message, text) {
    await api('POST', '/api/stream', {
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || 'agent',
      text: String(text || ''),
      done: true,
    }).catch(() => {});
  }

  async function publishResponse(message, { text, model, terminalError = null, modelOrigin }) {
    await api('POST', '/api/response', {
      messageId: message.id,
      conversationId: message.conversationId,
      text: String(text || ''),
      model: model || null,
      modelOrigin: modelOrigin
        || (String(message?.model || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual'),
      ...(terminalError ? { terminalError } : {}),
    }).catch(async () => {
      await api('POST', '/api/requeue', { messageId: message.id }).catch(() => {});
    });
  }

  async function runTurn(message) {
    const abortController = new AbortController();
    const normalizer = createSdkMessageNormalizer();
    const state = {
      result: null,
      lastStreamedText: '',
      responseModel: '',
      contextUsage: null,
      modelUsage: null,
    };
    let aborted = false;
    let planBoardPosted = false;

    const askUserBridge = createAskUserBridge({
      api,
      sdkSessionId,
      getActiveMessage: () => message,
      dbg,
    });
    const canUseTool = createCanUseTool({
      askUserBridge,
      dbg,
      onExitPlanMode: async (input) => {
        // The CLI sends both `plan` and `planFilePath`; the inline plan is
        // authoritative, the plan file covers CLI versions that stop inlining
        // it. When neither yields text the plan-shaped-final-text fallback
        // below still gets a chance to post the board.
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
        planBoardPosted = true;
        await api('POST', '/api/relay-board', boardPayload).catch((error) => {
          dbg('plan board publish failed', error?.message || String(error));
        });
        return true;
      },
    });

    const resume = String(message.claudeNativeSessionId || claudeNativeSessionId || '').trim();
    // The CLI resolves `resume` inside the project directory for *this* CWD, so
    // a session whose workspace root changed has to bring its transcript along
    // or every turn from here on fails with "No conversation found".
    if (resume) relocateTranscriptImpl({ nativeSessionId: resume, cwd, dbg });
    // Per-message model wins so the composer can switch Claude models between
    // turns; the conversation's provider model and worker default are fallbacks.
    const requestedModel = String(message.model || '').trim();
    const perTurnModel = requestedModel.toLowerCase() !== 'auto' && requestedModel.toLowerCase().startsWith('claude-')
      ? requestedModel
      : '';
    const model = perTurnModel
      || String(message.providerModel || '').trim()
      || defaultModel;
    const content = buildClaudeUserContent(message);

    const controlState = controlPoller?.start?.({
      queueMessageId: message.id,
      onAbortTurn: async () => {
        aborted = true;
        abortController.abort();
      },
    });

    let turn = null;
    try {
      turn = startClaudeTurnImpl({
        content,
        cwd,
        model,
        resume,
        relayMode: message.relayMode || 'agent',
        reasoningEffort: message.reasoningEffort || '',
        abortController,
        canUseTool,
        pathToClaudeCodeExecutable,
        dbg,
      });
      for await (const sdkMessage of turn) {
        const actions = normalizer.normalize(sdkMessage);
        for (const action of actions) {
          await dispatchAction(message, action, state);
        }
        // The context breakdown has to be read here, while the input gate is
        // still holding the CLI alive: once the gate releases and the result
        // is consumed, the control transport is gone.
        if (actions.some((action) => action.channel === 'result')) {
          state.contextUsage = await readContextUsageImpl(turn, dbg);
          turn.endInput?.();
        }
      }
    } catch (error) {
      if (aborted || abortController.signal.aborted) {
        dbg('turn aborted', message.id);
        await publishFinalStream(message, state.lastStreamedText);
        return true;
      }
      throw error;
    } finally {
      // Release the input gate on every exit path (abort, error, no result) —
      // a still-gated stream would keep the CLI process alive forever.
      turn?.endInput?.();
      controlPoller?.stop?.(controlState);
      // Runs on every exit path so a snapshot captured before the turn went
      // sideways still reaches the relay.
      await publishContextUsage(message, state, model);
    }

    if (aborted) {
      await publishFinalStream(message, state.lastStreamedText);
      return true;
    }

    const result = state.result;
    const responseModel = state.responseModel || model || null;
    if (!result) {
      // The SDK stream ended without a result envelope; surface what streamed.
      const fallbackText = String(state.lastStreamedText || normalizer.finalStreamText() || '').trim();
      if (fallbackText) {
        await publishFinalStream(message, fallbackText);
        await publishResponse(message, { text: fallbackText, model: responseModel });
      } else {
        await api('POST', '/api/requeue', { messageId: message.id }).catch(() => {});
      }
      return true;
    }

    if (result.isError) {
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
      });
      return true;
    }

    const finalText = String(result.text || state.lastStreamedText || '').trim();
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
    if (!finalText) {
      await api('POST', '/api/requeue', { messageId: message.id }).catch(() => {});
      return true;
    }
    await publishFinalStream(message, finalText);
    await publishResponse(message, { text: finalText, model: responseModel });
    return true;
  }

  async function handlePendingPayload(pending) {
    const message = pending?.message || null;
    if (!message) return false;
    activeMessage = message;
    waitingForTurn = true;
    try {
      return await runTurn(message);
    } catch (error) {
      const errorText = String(error?.message || error || 'unknown error');
      dbg('claude turn failed', message.id, errorText);
      const isAuthError = /authentication|logged in|login|credential|api key/i.test(errorText);
      await publishResponse(message, {
        text: isAuthError
          ? `System note: the Claude runtime could not authenticate (${errorText}). Log in with the Claude CLI on the relay host (run \`claude\`), then retry.`
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
      return true;
    } finally {
      waitingForTurn = false;
      activeMessage = null;
    }
  }

  return {
    handlePendingPayload,
    getActiveQueueMessageId,
    isTurnActive,
  };
}
