import { buildCursorUserMessage } from './cursor-attachments.mjs';
import { buildCursorContextUsage } from './cursor-context-usage.mjs';
import { createSdkMessageNormalizer } from './sdk-message-normalizer.mjs';
import {
  createCursorAgentHandle,
  startCursorRun,
  classifyCursorError,
  isCursorAuthErrorMessage,
  readModelContextWindow,
  resolveCursorReasoningParams,
} from './cursor-sdk-adapter.mjs';
import { createAskUserTool } from './cursor-ask-user-tool.mjs';
import { createAskUserBridge } from '../../shared/ask-user-bridge.mjs';
import { countPlanLikeLines } from '../../shared/plan-lines.mjs';

const PLAN_BOARD_ACTIONS = [
  { id: 'autopilot', label: 'Implement in autopilot', mode: 'autopilot' },
  { id: 'interactive', label: 'Stop here and prompt myself', mode: 'agent' },
  { id: 'exit_only', label: 'Stop here', mode: 'agent' },
];

// The Cursor SDK's SendOptions carries only model/mode/callbacks — there is
// no per-turn instruction channel — so ask/autopilot steering rides on the
// user message text, mirroring the Copilot extension's prompt-context
// injection. Injected only when the mode changes so the session transcript
// is not spammed with repeated instructions.
const MODE_NUDGES = {
  ask: '[Relay mode: ask] Prioritize clarification questions before implementation work; '
    + 'do not make broad assumptions when a question would materially change the result.',
  autopilot: '[Relay mode: autopilot] Keep moving unless user input is truly blocking; avoid unnecessary questions.',
};

export function cursorModeNudge(relayMode, previousMode = '') {
  const mode = String(relayMode || 'agent').trim().toLowerCase();
  const previous = String(previousMode || '').trim().toLowerCase();
  if (mode === previous) return '';
  if (MODE_NUDGES[mode]) return MODE_NUDGES[mode];
  // Leaving a nudged mode must cancel the standing instruction; before any
  // nudge was sent there is nothing to cancel.
  if (MODE_NUDGES[previous]) return `[Relay mode: ${mode}] Previous relay-mode instructions no longer apply.`;
  return '';
}

// Cursor has no exit-plan tool, so the only board source is the plan-mode
// text-shape fallback; the payload otherwise matches the Claude worker's.
export function buildCursorPlanReadyBoardPayload({
  message,
  planText = '',
  source = 'plan-mode-fallback',
} = {}) {
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
      source,
      queueMessageId: message?.id || null,
      conversationId: message?.conversationId || null,
      relayMode: message?.relayMode || 'agent',
    },
  };
}

/**
 * Execute one delivered relay turn against the Cursor SDK, streaming
 * normalized events into the relay's activity channels and publishing the
 * final response. Mirrors the Claude worker's `handlePendingPayload`
 * contract (response / requeue / abort semantics).
 */
export function createCursorTurnRunner({
  api,
  sdkSessionId,
  cwd,
  defaultModel = '',
  apiKey = '',
  storeDir = '',
  controlPoller,
  createAgentHandleImpl = createCursorAgentHandle,
  startCursorRunImpl = startCursorRun,
  classifyErrorImpl = classifyCursorError,
  readContextWindowImpl = readModelContextWindow,
  resolveModelParamsImpl = resolveCursorReasoningParams,
  createNormalizerImpl = createSdkMessageNormalizer,
  buildUserMessageImpl = buildCursorUserMessage,
  dbg = () => {},
} = {}) {
  // Unlike the Claude worker, the agent handle (and the custom tools bound
  // into it) outlives a single turn, so the ask_user tool is built once here
  // and reaches the active turn's state through these closures.
  let agentHandle = null;
  let cursorAgentId = '';
  let activeMessage = null;
  let waitingForTurn = false;
  let currentAbortController = null;
  // Mirrors the Copilot extension's lastPromptedRelayMode: full mode
  // instructions ride on the first message of a mode and on mode changes only.
  let lastNudgedRelayMode = '';

  const bridge = createAskUserBridge({
    api,
    getActiveMessage: () => activeMessage,
    sdkSessionId,
    questionSource: 'ask_user',
    questionRationale: 'Cursor requested clarification to continue this turn.',
    dbg,
  });
  const askUserTool = createAskUserTool({
    bridge,
    getAbortSignal: () => currentAbortController?.signal || null,
    dbg,
  });
  const customTools = {
    ask_user: {
      description: askUserTool.description,
      inputSchema: askUserTool.inputSchema,
      execute: askUserTool.execute,
    },
  };

  function getActiveQueueMessageId() {
    return waitingForTurn ? String(activeMessage?.id || '') : '';
  }

  function isTurnActive() {
    return waitingForTurn;
  }

  async function dispose() {
    try {
      await agentHandle?.close?.();
    } catch (error) {
      dbg('cursor agent close failed on dispose', error?.message || String(error));
    }
    agentHandle = null;
  }

  async function persistAgentId(message, agentId) {
    const normalized = String(agentId || '').trim();
    if (!normalized || normalized === cursorAgentId) return;
    try {
      await api('POST', '/api/cursor-agent-id', {
        conversationId: message.conversationId,
        cursorAgentId: normalized,
      });
      // Only cache after the server accepted it, so a failed persist is
      // retried on the next turn — resume across worker restarts depends on
      // the server-side copy.
      cursorAgentId = normalized;
    } catch (error) {
      dbg('cursor agent id persist failed', error?.message || String(error));
    }
  }

  async function ensureAgentHandle(message, model) {
    if (!agentHandle) {
      const durableId = String(message.cursorAgentId || '').trim() || cursorAgentId;
      const options = { apiKey, model, cwd, storeDir, sdkSessionId, customTools, dbg };
      try {
        agentHandle = await createAgentHandleImpl({ ...options, agentId: durableId });
      } catch (error) {
        if (!durableId) throw error;
        // The durable agent may have been pruned server-side; fall back to a
        // fresh agent rather than wedging the conversation.
        dbg('cursor agent resume failed, creating fresh agent', error?.message || String(error));
        agentHandle = await createAgentHandleImpl({ ...options, agentId: '' });
      }
    }
    // Runs even when the handle is reused, so a persist that failed on an
    // earlier turn is retried here.
    if (agentHandle.agentId && agentHandle.agentId !== cursorAgentId) {
      await persistAgentId(message, agentHandle.agentId);
    }
    return agentHandle;
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

  async function dispatchAction(message, action, state, normalizer) {
    const { channel, payload } = action;
    if (channel === 'init') {
      // The durable agent id is persisted at handle creation, not from init.
      state.responseModel = payload.model || state.responseModel;
      return;
    }
    if (channel === 'stream') {
      // Only the main thread's text can stand in for the answer: subagent
      // text landing here would publish a subagent's prose as the reply on
      // the abort / error / no-result fallback paths below.
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
      state.lastUsage = payload.usage || state.lastUsage;
      state.responseModel = state.responseModel || normalizer.model || '';
    }
  }

  /**
   * Ship the turn's token usage to the relay as a context-window breakdown.
   * Advisory data: a failure here must not disturb the turn's response.
   */
  async function publishContextUsage(message, state, model) {
    if (!state.lastUsage) return;
    const usageModel = state.responseModel || model || '';
    const contextWindow = await readContextWindowImpl({ apiKey, model: usageModel, dbg })
      .catch(() => null);
    const built = buildCursorContextUsage({
      usage: state.lastUsage,
      model: usageModel,
      contextWindow,
    });
    if (!built) return;
    await api('POST', '/api/cursor-context-usage', {
      conversationId: message.conversationId,
      sdkSessionId,
      model: usageModel,
      contextUsage: built.contextUsage,
      modelUsage: built.modelUsage,
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
    currentAbortController = new AbortController();
    const abortController = currentAbortController;
    let normalizer = createNormalizerImpl();
    const state = {
      result: null,
      lastStreamedText: '',
      responseModel: '',
      lastUsage: null,
    };
    let aborted = false;
    let planBoardPosted = false;

    // Per-message model wins so the composer can switch models between turns.
    // Cursor model ids are unprefixed, so any non-auto value is accepted.
    const requestedModel = String(message.model || '').trim();
    const perTurnModel = requestedModel && requestedModel.toLowerCase() !== 'auto'
      ? requestedModel
      : '';
    const model = perTurnModel
      || String(message.providerModel || '').trim()
      || defaultModel;

    await ensureAgentHandle(message, model);
    const userMessage = buildUserMessageImpl(message);
    const modeNudge = cursorModeNudge(message.relayMode, lastNudgedRelayMode);
    if (modeNudge) userMessage.text = [modeNudge, userMessage.text].filter(Boolean).join('\n\n');
    // Committed only once the send reached the transport (before the loop's
    // break below) — a turn that dies before delivery must re-inject the
    // nudge next time, or a mode change would be silently swallowed.
    const pendingNudgedRelayMode = String(message.relayMode || 'agent').trim().toLowerCase();
    // Per-turn like the model: the composer's effort maps onto Cursor model
    // params, and null (no mapping / lookup failure) sends the model default.
    const modelParams = await resolveModelParamsImpl({
      apiKey,
      model,
      reasoningEffort: message.reasoningEffort || '',
      dbg,
    });

    let turn = null;
    const controlState = controlPoller?.start?.({
      queueMessageId: message.id,
      onAbortTurn: async () => {
        aborted = true;
        abortController.abort();
        await turn?.cancel?.();
      },
    });

    try {
      let busyRetries = 0;
      let staleAuthRetries = 0;
      while (true) {
        try {
          turn = startCursorRunImpl({
            agent: agentHandle.agent,
            message: userMessage,
            model,
            modelParams,
            relayMode: message.relayMode,
            abortSignal: abortController.signal,
            dbg,
          });
          for await (const event of turn) {
            const actions = normalizer.normalize(event);
            for (const action of actions) {
              await dispatchAction(message, action, state, normalizer);
            }
          }
          // A long-lived handle whose exchanged auth expired fails as a
          // terminal ERROR result, not a thrown AuthenticationError, and the
          // API key itself is usually still valid — so recreate the handle
          // and retry once. A second auth failure is a real key problem and
          // falls through to the isError publish below.
          if (
            staleAuthRetries === 0
            && !aborted
            && !abortController.signal.aborted
            && state.result?.isError
            // Classify on the SDK status message only: result.text is the
            // model's own prose and mentioning "invalid api key" in an answer
            // must never trigger a silent re-run.
            && isCursorAuthErrorMessage(state.result.errorMessage)
          ) {
            staleAuthRetries += 1;
            dbg('cursor auth error result, recreating handle for one retry');
            await agentHandle?.close?.();
            agentHandle = null;
            await ensureAgentHandle(message, model);
            normalizer = createNormalizerImpl();
            state.result = null;
            state.lastStreamedText = '';
            state.responseModel = '';
            state.lastUsage = null;
            // The failed attempt already streamed partial text to the relay;
            // clear it and leave a trace so the retry doesn't read as the
            // same turn silently rewriting itself.
            await publishFinalStream(message, '');
            await postActivity(message, 'Cursor session re-authenticated; retrying this message on a fresh agent handle.');
            continue;
          }
          lastNudgedRelayMode = pendingNudgedRelayMode;
          break;
        } catch (error) {
          // A stale handle whose previous run never settled server-side
          // reports busy; one close-and-resume usually clears it. A second
          // busy is terminal (classified cursor.agent_busy upstream).
          if (busyRetries === 0 && classifyErrorImpl(error).isBusy) {
            busyRetries += 1;
            dbg('cursor agent busy, recreating handle for one retry');
            await agentHandle?.close?.();
            agentHandle = null;
            await ensureAgentHandle(message, model);
            continue;
          }
          throw error;
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
      controlPoller?.stop?.(controlState);
      // Runs on every exit path so usage captured before the turn went
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
      // The run ended without a terminal status message; surface what streamed.
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
      // Reaching here with an auth error means the fresh-handle retry above
      // already failed too, so the key itself needs renewing. Only the SDK
      // status message is auth-classified — result.text is model prose.
      const authMessage = String(result.errorMessage || '').trim();
      const isAuthFailure = isCursorAuthErrorMessage(authMessage);
      const errorText = isAuthFailure
        ? `System note: the Cursor runtime could not authenticate (${authMessage}). Set or renew the Cursor API key in provider settings, then retry.`
        : result.text || `Cursor turn failed (${result.subtype || 'unknown error'}).`;
      const code = isAuthFailure ? 'authentication_failed' : result.subtype || 'unknown';
      await publishFinalStream(message, state.lastStreamedText);
      await publishResponse(message, {
        text: errorText,
        model: responseModel,
        terminalError: {
          kind: 'cursor-turn-failed',
          code,
          stableCode: `cursor.${code}`,
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
      const boardPayload = buildCursorPlanReadyBoardPayload({ message, planText: finalText });
      if (boardPayload) {
        await api('POST', '/api/relay-board', boardPayload).catch(() => {});
        planBoardPosted = true;
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
      const classified = classifyErrorImpl(error);
      dbg('cursor turn failed', message.id, classified.message);
      await publishResponse(message, {
        text: classified.isAuth
          ? `System note: the Cursor runtime could not authenticate (${classified.message}). Set or renew the Cursor API key in provider settings, then retry.`
          : `System note: the Cursor turn failed (${classified.message}).`,
        model: null,
        terminalError: {
          kind: 'cursor-turn-failed',
          code: classified.code,
          stableCode: classified.stableCode,
          message: classified.message,
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
    dispose,
  };
}
