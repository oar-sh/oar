import fs from 'node:fs';
import { buildClaudeUserContent } from './claude-attachments.mjs';
import { createSdkMessageNormalizer } from './sdk-message-normalizer.mjs';
import { startClaudeTurn, createCanUseTool, readContextUsage, readPlanUsage } from './claude-sdk-adapter.mjs';
import { relocateClaudeTranscriptForCwd } from './claude-transcript-relocator.mjs';
import { createAskUserBridge } from '../../shared/ask-user-bridge.mjs';
import { EMPTY_TURN_COMPLETION_NOTE } from '../../shared/empty-turn-completion.mjs';
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
  readPlanUsageImpl = readPlanUsage,
  relocateTranscriptImpl = relocateClaudeTranscriptForCwd,
  // Ceiling on how long a turn's input gate may stay held for background work.
  backgroundLingerCapMs = 30 * 60_000,
  // With no gating tasks left, how much stream silence means no continuation
  // turn is coming (the CLI dequeues a settled task's notification within ~1s).
  backgroundIdleReleaseMs = 60_000,
  backgroundLingerPollMs = 5_000,
  // Test seam: overrides for the ask-user bridge (poll cadence, timeouts).
  askUserBridgeOptions = {},
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
      // One relay turn can carry several results when background tasks
      // auto-continue the session; every segment belongs in the reply.
      const text = String(payload.text || '').trim();
      if (text) state.resultTexts.push(text);
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

  /**
   * Ship the session's plan usage (rate-limit windows + cost totals) to the
   * relay. Falls back to the stable result fields when the experimental usage
   * control request is unavailable, so the card still gets session cost.
   * Advisory: a failure here must not disturb the turn's response.
   */
  async function publishPlanUsage(message, state) {
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
      resultTexts: [],
      lastStreamedText: '',
      responseModel: '',
      contextUsage: null,
      planUsage: null,
      modelUsage: null,
    };
    let aborted = false;
    let planBoardPosted = false;

    // Background-task bookkeeping for the input-gate hold. Releasing the gate
    // ends the CLI's stdin — the control transport that carries canUseTool
    // permission decisions — so it must stay held while background agents (and
    // the continuation turns their task notifications trigger) still need it.
    // Otherwise every mutating tool call after the first result fails with
    // "Tool permission request failed: AbortError: Stream closed".
    const linger = {
      live: new Map(), // taskId -> taskType, REPLACEd on each background_tasks action
      known: new Set(), // every session-level task id ever seen in the live set
      // A session-level task settled; its notification is queued and the CLI
      // is about to dequeue a continuation turn — hold the gate for it even
      // though the live set may already be empty. Cleared when the
      // continuation's own init arrives (the notification got delivered).
      notificationPending: false,
      startedAt: 0,
      lastMessageAt: Date.now(),
      timer: null,
      finalized: false,
    };
    // Backgrounded bash never gates: a dev server may run forever and its
    // death is tied to this CLI process either way. Its *settling* still sets
    // notificationPending above, so finite bash tasks get their continuation.
    const hasGatingTasks = () => [...linger.live.values()].some((type) => type !== 'local_bash');
    // In-flight canUseTool round-trips (AskUserQuestion, permission prompts)
    // gate too: a pending question produces no stream traffic while the human
    // thinks, and releasing the gate under it rejects the request with
    // "Tool permission stream closed". The question's own timeout bounds the
    // wait, so this cannot wedge the turn.
    let pendingControlRequests = 0;
    const shouldHoldGate = () => hasGatingTasks() || linger.notificationPending || pendingControlRequests > 0;

    function observeLinger(action) {
      if (action.channel === 'background_tasks') {
        linger.live = new Map(action.payload.tasks.map((task) => [task.taskId, task.taskType]));
        for (const task of action.payload.tasks) linger.known.add(task.taskId);
        return;
      }
      if (action.channel === 'background_task_settled') {
        if (linger.known.has(action.payload.taskId)) linger.notificationPending = true;
        return;
      }
      if (action.channel === 'init') linger.notificationPending = false;
    }

    const askUserBridge = createAskUserBridge({
      api,
      sdkSessionId,
      getActiveMessage: () => message,
      dbg,
      ...askUserBridgeOptions,
    });
    const baseCanUseTool = createCanUseTool({
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
    const canUseTool = async (toolName, input, options) => {
      pendingControlRequests += 1;
      try {
        return await baseCanUseTool(toolName, input, options);
      } finally {
        pendingControlRequests -= 1;
        // Restart the idle countdown from the answer, not from the last
        // stream message before the human started thinking.
        linger.lastMessageAt = Date.now();
      }
    };

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
    // The context breakdown has to be read here, while the input gate is
    // still holding the CLI alive: once the gate releases and the result
    // is consumed, the control transport is gone.
    async function finalizeTurn(reason) {
      if (linger.finalized) return;
      linger.finalized = true;
      if (linger.timer) {
        clearInterval(linger.timer);
        linger.timer = null;
      }
      if (reason !== 'result') dbg('releasing held input gate', reason, message.id);
      // Both control requests run against the same still-open transport;
      // issuing them concurrently keeps the gate hold to one timeout rather
      // than two, since this is on the path to the CLI's exit.
      const [contextUsage, planUsage] = await Promise.all([
        readContextUsageImpl(turn, dbg),
        readPlanUsageImpl(turn, dbg),
      ]);
      state.contextUsage = contextUsage;
      state.planUsage = planUsage;
      turn?.endInput?.();
    }

    // Runs only while the gate is held past a result. The idle release covers
    // a settled task whose continuation never materializes; the cap covers a
    // background agent that never finishes. Both end the turn the same way a
    // normal result would — the CLI exits once its stdin closes.
    function startLingerMonitor() {
      if (!linger.startedAt) linger.startedAt = Date.now();
      if (linger.timer) return;
      linger.timer = setInterval(() => {
        if (linger.finalized) return;
        // A human is deciding a pending question/permission: neither backstop
        // may close the control transport under it. The question's own
        // timeout resumes the countdown when it fires.
        if (pendingControlRequests > 0) return;
        const now = Date.now();
        const capped = now - linger.startedAt >= backgroundLingerCapMs;
        const idle = !hasGatingTasks() && now - linger.lastMessageAt >= backgroundIdleReleaseMs;
        if (!capped && !idle) return;
        finalizeTurn(capped ? 'linger-cap' : 'idle-release').catch(() => {});
      }, backgroundLingerPollMs);
      linger.timer.unref?.();
    }

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
        linger.lastMessageAt = Date.now();
        const actions = normalizer.normalize(sdkMessage);
        for (const action of actions) {
          observeLinger(action);
          await dispatchAction(message, action, state);
        }
        if (actions.some((action) => action.channel === 'result') && !linger.finalized) {
          if (shouldHoldGate()) {
            // Background work outlives this result; the CLI will run the
            // settled tasks' notifications as further turns, each ending in
            // its own result. Release only when nothing is left to continue.
            dbg(
              'holding input gate past result',
              message.id,
              `liveTasks=${linger.live.size}`,
              `notificationPending=${linger.notificationPending}`,
              `pendingControlRequests=${pendingControlRequests}`,
            );
            startLingerMonitor();
          } else {
            await finalizeTurn('result');
          }
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
      linger.finalized = true;
      if (linger.timer) {
        clearInterval(linger.timer);
        linger.timer = null;
      }
      turn?.endInput?.();
      controlPoller?.stop?.(controlState);
      // Runs on every exit path so a snapshot captured before the turn went
      // sideways still reaches the relay.
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

    // A turn that lingered for background work carries one text segment per
    // result; all of them are the answer, not just the last continuation's.
    const finalText = String(
      state.resultTexts.join('\n\n') || result.text || state.lastStreamedText || '',
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
    await publishResponse(message, { text: publishedText, model: responseModel });
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
