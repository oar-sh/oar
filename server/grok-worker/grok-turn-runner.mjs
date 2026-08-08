import {
  createGrokAgentHandle,
  startGrokTurn,
  classifyGrokError,
} from './grok-sdk-adapter.mjs';
import { buildGrokContextUsage, resolveGrokContextWindow } from './grok-context-usage.mjs';
import { extractGrokUsageFromPromptResult, normalizeGrokTurnUsage } from '../services/plan-usage-grok.mjs';
import { countPlanLikeLines } from '../../shared/plan-lines.mjs';

const PLAN_BOARD_ACTIONS = [
  { id: 'autopilot', label: 'Implement in autopilot', mode: 'autopilot' },
  { id: 'interactive', label: 'Stop here and prompt myself', mode: 'agent' },
  { id: 'exit_only', label: 'Stop here', mode: 'agent' },
];

// Grok has no exit-plan tool, so the only board source is the plan-mode
// text-shape fallback; the payload matches the Claude/Cursor workers'.
export function buildGrokPlanReadyBoardPayload({
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

function buildGrokTerminalError(classified, message) {
  return {
    kind: 'grok-turn-failed',
    code: classified.code,
    stableCode: classified.code,
    message: classified.message,
    failedAt: new Date().toISOString(),
    queueMessageId: String(message?.id || '') || null,
  };
}

const MODE_NUDGES = {
  ask: '[Relay mode: ask] Prioritize clarification questions before implementation work; '
    + 'do not make broad assumptions when a question would materially change the result.',
  autopilot: '[Relay mode: autopilot] Keep moving unless user input is truly blocking; avoid unnecessary questions.',
  plan: '[Relay mode: plan] Produce a concrete plan before making code changes; prefer outlining steps over implementing.',
};

export function grokModeNudge(relayMode, previousMode = '') {
  const mode = String(relayMode || 'agent').trim().toLowerCase();
  const previous = String(previousMode || '').trim().toLowerCase();
  if (mode === previous) return '';
  if (MODE_NUDGES[mode]) return MODE_NUDGES[mode];
  if (MODE_NUDGES[previous]) return `[Relay mode: ${mode}] Previous relay-mode instructions no longer apply.`;
  return '';
}

export function buildGrokUserText(message = {}) {
  const text = String(message?.text || message?.content || '').trim();
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const notes = [];
  for (const attachment of attachments) {
    const name = String(attachment?.name || attachment?.filename || '').trim();
    const pathValue = String(attachment?.path || attachment?.absolutePath || '').trim();
    if (pathValue) notes.push(`[Attached file: ${pathValue}]`);
    else if (name) notes.push(`[Attached file: ${name}]`);
  }
  return [text, ...notes].filter(Boolean).join('\n\n');
}

/**
 * Execute one delivered relay turn against the Grok CLI ACP surface.
 */
export function createGrokTurnRunner({
  api,
  sdkSessionId,
  cwd,
  defaultModel = '',
  command = 'grok',
  alwaysApprove = true,
  controlPoller,
  createAgentHandleImpl = createGrokAgentHandle,
  startGrokTurnImpl = startGrokTurn,
  classifyErrorImpl = classifyGrokError,
  dbg = () => {},
} = {}) {
  let agentHandle = null;
  let grokNativeSessionId = '';
  let activeMessage = null;
  let waitingForTurn = false;
  let currentAbortController = null;
  let lastNudgedRelayMode = '';

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
      dbg('grok agent close failed on dispose', error?.message || String(error));
    }
    agentHandle = null;
  }

  async function persistNativeSessionId(message, sessionId) {
    const normalized = String(sessionId || '').trim();
    if (!normalized || normalized === grokNativeSessionId) return;
    try {
      await api('POST', '/api/grok-native-session', {
        conversationId: message.conversationId,
        grokNativeSessionId: normalized,
      });
      grokNativeSessionId = normalized;
    } catch (error) {
      dbg('grok native session persist failed', error?.message || String(error));
    }
  }

  async function ensureAgentHandle(message, model) {
    if (agentHandle) return agentHandle;
    const resumeId = String(message.grokNativeSessionId || grokNativeSessionId || '').trim();
    agentHandle = await createAgentHandleImpl({
      command,
      cwd,
      alwaysApprove,
      nativeSessionId: resumeId,
      model,
      dbg,
    });
    if (agentHandle.sessionId) {
      await persistNativeSessionId(message, agentHandle.sessionId);
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

  async function dispatchAction(message, action, state) {
    const { channel, payload } = action;
    if (channel === 'init') {
      state.responseModel = payload.model || state.responseModel;
      await persistNativeSessionId(message, payload.sessionId);
      return;
    }
    if (channel === 'stream') {
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
      state.responseModel = payload.model || state.responseModel;
      // Prefer the prompt-result usage blob; fall back to a normalized stream usage.
      if (payload?.usage) {
        state.turnUsage = normalizeGrokTurnUsage(payload.usage)
          || extractGrokUsageFromPromptResult({ _meta: payload.usage })
          || state.turnUsage;
      }
    }
  }

  /**
   * Ship the turn's token usage to the relay as a context-window breakdown.
   * Advisory data: a failure here must not disturb the turn's response.
   */
  async function publishContextUsage(message, state, model) {
    if (!state.turnUsage) return;
    const usageModel = state.responseModel || state.turnUsage.modelId || model || '';
    const contextWindow = resolveGrokContextWindow(
      usageModel,
      agentHandle?.discovered?.contextWindowsByModel || {},
    );
    const built = buildGrokContextUsage({
      usage: state.turnUsage,
      model: usageModel,
      contextWindow,
    });
    if (!built) return;
    await api('POST', '/api/grok-context-usage', {
      conversationId: message.conversationId,
      sdkSessionId,
      model: usageModel,
      contextUsage: built.contextUsage,
      modelUsage: built.modelUsage,
    }).catch((error) => {
      dbg('context usage publish failed', error?.message || String(error));
    });
  }

  /**
   * Ship per-turn token/cost totals for the Check Usage Grok card. Advisory:
   * failures never disturb the turn reply.
   */
  async function publishPlanUsage(message, state) {
    if (!state.turnUsage) return;
    await api('POST', '/api/grok-plan-usage', {
      conversationId: message.conversationId,
      sdkSessionId,
      usage: state.turnUsage,
      model: state.responseModel || state.turnUsage.modelId || '',
      capturedAt: state.turnUsage.capturedAt || new Date().toISOString(),
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
    const state = {
      result: null,
      lastStreamedText: '',
      responseModel: '',
      turnUsage: null,
    };
    let aborted = false;

    // The conversation's Grok model is pinned at bootstrap; the relay 409s a
    // per-message switch before delivery, so the request here can only match
    // the pinned model (or 'auto'). The handle keeps the model the session
    // was created with — it is never relabeled to a merely requested one.
    const requestedModel = String(message.model || '').trim();
    const perTurnModel = requestedModel && requestedModel.toLowerCase() !== 'auto'
      ? requestedModel
      : '';
    const model = perTurnModel
      || String(message.providerModel || '').trim()
      || defaultModel;

    await ensureAgentHandle(message, model);

    const modeNudge = grokModeNudge(message.relayMode, lastNudgedRelayMode);
    const userText = buildGrokUserText(message);
    const promptText = [modeNudge, userText].filter(Boolean).join('\n\n');
    const pendingNudgedRelayMode = String(message.relayMode || 'agent').trim().toLowerCase();

    let turn = null;
    let planBoardPosted = false;
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
      while (true) {
        try {
          turn = startGrokTurnImpl({
            handle: agentHandle,
            text: promptText,
            reasoningEffort: message.reasoningEffort || '',
            abortSignal: abortController.signal,
            dbg,
          });
          for await (const action of turn) {
            await dispatchAction(message, action, state);
          }
          lastNudgedRelayMode = pendingNudgedRelayMode;
          break;
        } catch (error) {
          // A stale agent whose previous prompt never settled reports busy;
          // one close-and-resume usually clears it. A second busy is terminal
          // (classified grok.agent_busy upstream).
          if (busyRetries === 0 && classifyErrorImpl(error).isBusy) {
            busyRetries += 1;
            dbg('grok agent busy, recreating handle for one retry');
            await dispose();
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
      // Publish on every exit path that may have captured usage (including
      // abort after a partial result) without delaying the reply path below.
      await publishContextUsage(message, state, model);
      await publishPlanUsage(message, state);
    }

    if (aborted) {
      await publishFinalStream(message, state.lastStreamedText);
      return true;
    }

    const result = state.result;
    const responseModel = state.responseModel || model || null;
    if (!result) {
      // The turn ended without a terminal result; surface what streamed, or
      // requeue so a transient hiccup is retried instead of burning the
      // queue entry on a user-visible failure (Claude/Cursor parity).
      const fallbackText = String(state.lastStreamedText || '').trim();
      if (fallbackText) {
        await publishFinalStream(message, fallbackText);
        await publishResponse(message, { text: fallbackText, model: responseModel });
      } else {
        await api('POST', '/api/requeue', { messageId: message.id }).catch(() => {});
      }
      return true;
    }

    if (result.isError) {
      const classified = classifyErrorImpl(new Error(result.errorMessage || result.stopReason || 'turn error'));
      const errorText = classified.isAuth
        ? `System note: the Grok agent could not authenticate (${classified.message})`
        : String(state.lastStreamedText || result.text || '').trim();
      await publishFinalStream(message, state.lastStreamedText);
      await publishResponse(message, {
        text: errorText,
        model: responseModel,
        terminalError: buildGrokTerminalError(classified, message),
      });
      return true;
    }

    const finalText = String(result.text || state.lastStreamedText || '').trim();
    if (
      !planBoardPosted
      && String(message.relayMode || '').trim().toLowerCase() === 'plan'
      && countPlanLikeLines(finalText) >= 2
    ) {
      const boardPayload = buildGrokPlanReadyBoardPayload({ message, planText: finalText });
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
    const message = pending?.message || pending;
    if (!message?.id) return false;
    if (waitingForTurn) {
      dbg('turn already active; rejecting concurrent deliver', message.id);
      return false;
    }
    waitingForTurn = true;
    activeMessage = message;
    try {
      return await runTurn(message);
    } catch (error) {
      const classified = classifyErrorImpl(error);
      dbg('turn failed', classified.code, classified.message);
      // The guidance rides on the response text — there is no separate
      // system-note channel (Claude/Cursor parity).
      await publishResponse(message, {
        text: classified.isAuth
          ? `System note: the Grok agent could not authenticate (${classified.message})`
          : `System note: the Grok turn failed (${classified.message}).`,
        model: message.providerModel || defaultModel || null,
        terminalError: buildGrokTerminalError(classified, message),
      });
      // Recreate handle after hard failures so the next turn is clean.
      try { await dispose(); } catch { /* ignore */ }
      return true;
    } finally {
      waitingForTurn = false;
      activeMessage = null;
      currentAbortController = null;
    }
  }

  return {
    handlePendingPayload,
    getActiveQueueMessageId,
    isTurnActive,
    dispose,
  };
}
