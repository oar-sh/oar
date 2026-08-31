// Owns the CopilotClient / CopilotSession lifecycle for one relay conversation
// and runs the delivered turns through them.
//
// Contract-wise this is the Cursor/Claude worker's `handlePendingPayload`
// runner with a different engine underneath: same relay channels, same
// response/requeue/abort semantics, same terminal-error record shape. The
// engine-specific part is that the Copilot SDK does not hand back an async
// iterator for a turn — `send()` resolves as soon as the prompt is accepted —
// so the turn is driven as a small state machine over the session's event
// callback. `sendAndWait()` is deliberately unused: it has a hard 60s internal
// timeout after which it merely stops waiting, which would silently strand
// every long turn.
import {
  USER_INPUT_UNSUPPORTED_ANSWER,
  classifyCopilotSessionError,
  classifyCopilotTurnException,
  copilotAgentModeForRelayMode,
  copilotPermissionDecision,
  isSessionNotFoundError,
  observeRuntimeExit,
  resolveCopilotSdkPaths,
  startCopilotClient,
} from './copilot-sdk-adapter.mjs';
import { buildCopilotMessageOptions } from './copilot-attachments.mjs';
import { createCopilotEventNormalizer } from './copilot-sdk-event-normalizer.mjs';
import { EMPTY_TURN_COMPLETION_NOTE } from '../../shared/empty-turn-completion.mjs';

// How long the runtime may sit with no session activity before the worker
// closes it. The worker process itself stays up and reconnects lazily on the
// next delivery — same trade the Claude worker makes (`gracefulShutdown('idle')`
// ends the CLI, not the worker), because holding the ws link is cheap while
// holding a runtime subprocess per idle conversation is not.
const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60_000;
const DEFAULT_LIFECYCLE_POLL_MS = 5_000;
// Mirrors the Cursor adapter's `stallTimeoutMs`. Emphatically NOT 0: the
// worker's 10s heartbeat keeps renewing the relay's processing lease
// (messages-routes.mjs), so without a stall ceiling a turn whose runtime went
// quiet holds its queue row open indefinitely and no watchdog can free it.
const DEFAULT_TURN_STALL_TIMEOUT_MS = 120_000;

/**
 * Appended to the partial answer when the RUNTIME interrupted the turn on its
 * own (as opposed to the user aborting through the relay). The row has to be
 * settled by this worker in that case, because nothing server-side is waiting
 * to settle it.
 */
export const RUNTIME_INTERRUPTED_NOTE =
  'System note: the Copilot runtime interrupted this turn before it finished. '
  + 'Resend the message to continue.';

export function createCopilotSdkSessionRunner({
  api,
  sdkSessionId,
  cwd,
  defaultModel = '',
  controlPoller = null,
  env = process.env,
  clientName = 'copilot-web-relay',
  logLevel = 'error',
  // Injection seams. Tests pass a fake client/session pair; nothing in this
  // module imports the real SDK (that lives in copilot-sdk-adapter.mjs).
  resolvePathsImpl = resolveCopilotSdkPaths,
  startClientImpl = startCopilotClient,
  createNormalizerImpl = createCopilotEventNormalizer,
  buildMessageOptionsImpl = buildCopilotMessageOptions,
  // Threading seam for `MessageOptions.mode` ("enqueue" | "immediate"). Phase 1
  // sends without a mode (the runtime default); phase 2 probes steering and
  // returns a mode from here without touching the send path.
  resolveSendModeImpl = () => '',
  idleShutdownMs = DEFAULT_IDLE_SHUTDOWN_MS,
  lifecyclePollMs = DEFAULT_LIFECYCLE_POLL_MS,
  // 0 disables (matching the background-task timeout's 0 = no-limit
  // convention). When set, a turn that goes this long without a single event
  // fails terminally instead of holding the queue row until the relay's own
  // delivery watchdog gives up.
  turnStallTimeoutMs = DEFAULT_TURN_STALL_TIMEOUT_MS,
  dbg = () => {},
} = {}) {
  let client = null;
  let session = null;
  let sdkPaths = null;
  let appliedModel = '';
  let activeTurn = null;
  let lifecycleTimer = null;
  let lastActivityAt = Date.now();
  let lastTurnUsage = null;
  let starting = null;
  let disposed = false;
  let detachRuntimeExit = () => {};
  // Every event is handled on one chain so the relay POSTs for a turn land in
  // the order the runtime produced them; the SDK's callback is synchronous and
  // would otherwise interleave awaits.
  let dispatchChain = Promise.resolve();

  function touch() {
    lastActivityAt = Date.now();
  }

  // ---------------------------------------------------------------- publish --

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
      // Inert: the response's model is read straight off the normalizer when
      // the turn settles, so there is nothing to mirror into turn state here.
      return;
    }
    if (channel === 'stream') {
      // Only main-thread text can stand in for the answer on the abort/error
      // fallback paths; subagent text would publish as the reply.
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
    }
    // The `subagent` channel has no producer in phase 1 — the normalizer
    // filters the subagent lane rather than publishing it. Phase 2 adds the
    // publisher and the channel together.
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

  function terminalErrorRecord(message, classified) {
    return {
      kind: 'copilot-turn-failed',
      code: classified.code,
      stableCode: classified.stableCode,
      message: classified.text,
      failedAt: new Date().toISOString(),
      queueMessageId: String(message.id || '') || null,
    };
  }

  /**
   * Per-turn usage capture. There is no worker-side Copilot usage ingest route
   * today — the Copilot plan card is built relay-side from quota snapshots the
   * relay fetches itself (`services/plan-usage-copilot.mjs`), and no
   * `/api/copilot-plan-usage` endpoint exists to post to. So this records the
   * turn's tokens/cost/TTFT (and any quota snapshot the failure path saw) on
   * the runner and logs it; wiring an ingest endpoint is phase 2's job.
   */
  function captureTurnUsage(message, result) {
    const usage = result?.usage || null;
    const contextUsage = result?.contextUsage || null;
    if (!usage && !contextUsage) return;
    lastTurnUsage = {
      conversationId: message.conversationId,
      sdkSessionId,
      messageId: message.id,
      model: result?.model || appliedModel || defaultModel || '',
      usage,
      contextUsage,
      capturedAt: new Date().toISOString(),
    };
    dbg('turn usage', JSON.stringify({
      model: lastTurnUsage.model,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cost: usage?.cost ?? null,
      modelCalls: usage?.modelCalls ?? null,
      timeToFirstTokenMs: usage?.timeToFirstTokenMs ?? null,
      contextTokens: contextUsage?.currentTokens ?? null,
      hasQuotaSnapshots: !!usage?.quotaSnapshots,
    }));
  }

  // ---------------------------------------------------------------- session --

  function routeEvent(event) {
    touch();
    const turn = activeTurn;
    if (!turn) return;
    dispatchChain = dispatchChain
      .then(() => handleTurnEvent(turn, event))
      .catch((error) => { dbg('event dispatch failed', error?.message || String(error)); });
  }

  async function handleTurnEvent(turn, event) {
    if (turn.settled) return;
    turn.armStall?.();
    let actions = [];
    try {
      actions = turn.normalizer.normalize(event);
    } catch (error) {
      dbg('normalize failed', String(event?.type || ''), error?.message || String(error));
      return;
    }
    for (const action of actions) {
      if (action.channel === 'result') {
        turn.result = action.payload;
        turn.settle();
        return;
      }
      await dispatchAction(turn.message, action, turn.state);
    }
  }

  function buildSessionConfig(model, relayMode) {
    return {
      // The relay session id IS the SDK session id, so the runtime's own state
      // under ~/.copilot/session-state/<id> is addressable by conversation and
      // survives worker restarts without a side table.
      sessionId: sdkSessionId,
      ...(model ? { model } : {}),
      // Not a default: without this the SDK emits no deltas at all and the
      // transcript only updates when the whole message lands.
      streaming: true,
      workingDirectory: cwd,
      clientName,
      onEvent: routeEvent,
      // Permission policy follows the conversation's relay mode, mirroring
      // what `permissionModeForRelayMode` enforces in the Claude worker: plan
      // and ask modes may read but must not act. The handler reads the mode
      // from the LIVE turn rather than closing over the mode the session was
      // built with, because one session serves every turn of a conversation
      // and the user can switch modes between them.
      onPermissionRequest: (request) => copilotPermissionDecision(
        activeTurn?.message?.relayMode || relayMode,
        request,
      ),
      // Stubs that settle rather than hang: the runtime blocks the turn on
      // these handlers, so a missing implementation has to answer, not throw.
      // `wasFreeform` is required by `UserInputResponse` and the runtime's
      // deserializer is strict — omitting it fails the tool call silently.
      onUserInputRequest: async () => ({ answer: USER_INPUT_UNSUPPORTED_ANSWER, wasFreeform: true }),
      onElicitationRequest: () => ({ action: 'decline' }),
    };
  }

  /**
   * The runtime process died under us. Nothing the SDK is waiting on will ever
   * resolve, so the active turn is failed terminally-but-retryably rather than
   * left to hold its queue row open behind a heartbeat that keeps renewing the
   * processing lease.
   */
  function handleRuntimeExit(detail) {
    dbg('copilot runtime exited', detail);
    const turn = activeTurn;
    if (turn && !turn.settled) {
      // handlePendingPayload's catch tears the runtime down and publishes the
      // failure record.
      turn.fail(new Error(`the Copilot runtime exited before the turn completed (${detail})`));
      return;
    }
    // No turn to fail: drop the dead handles so the next delivery rebuilds
    // instead of sending into a corpse.
    void stopRuntime('runtime-exit').catch(() => {});
  }

  async function ensureClient() {
    if (client) return client;
    if (starting) return starting;
    starting = (async () => {
      sdkPaths = resolvePathsImpl({ env });
      const started = await startClientImpl({ paths: sdkPaths, cwd, clientName, logLevel, dbg });
      client = started.client;
      detachRuntimeExit = observeRuntimeExit(client, handleRuntimeExit);
      // Diagnostics only, and deliberately not awaited — see startCopilotClient.
      Promise.resolve(started.versionReady)
        .then((info) => {
          if (info?.versionSkewWarning) dbg(info.versionSkewWarning);
          else dbg(`copilot runtime ready (version ${info?.runtimeVersion || sdkPaths.version || 'unknown'})`);
        })
        .catch(() => {});
      startLifecycleTimer();
      return client;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  /**
   * Best-effort model switch: a rejected switch must not fail the turn, it
   * just runs on the session's current model (and says so in the log).
   */
  async function applyModel(model) {
    if (!model || typeof session?.setModel !== 'function') return;
    try {
      await session.setModel(model);
      appliedModel = model;
    } catch (error) {
      dbg('copilot setModel failed', model, error?.message || String(error));
    }
  }

  async function ensureSession(model, relayMode) {
    await ensureClient();
    if (!session) {
      const config = buildSessionConfig(model, relayMode);
      // Resume first, always. On a brand-new conversation this costs one
      // failed RPC; on every other path (worker restart, idle shutdown,
      // relay restart) it is the difference between continuing the
      // conversation and silently starting a fresh one. A negative result is
      // deliberately not cached: once `createSession` succeeds, the state
      // exists and the NEXT reconnect must resume it.
      let resumed = false;
      try {
        session = await client.resumeSession(sdkSessionId, config);
        resumed = true;
        dbg(`resumed copilot session ${sdkSessionId.slice(0, 8)}`);
      } catch (error) {
        // ONLY a definitive "no such session" may fall through to creating a
        // blank one. A dropped connection or an unrecognised failure is
        // transient, and starting fresh over live state would silently throw
        // the conversation's whole history away — so it fails the turn
        // instead, which is retryable and loses nothing.
        if (!isSessionNotFoundError(error)) {
          dbg('copilot session resume failed transiently', error?.message || String(error));
          throw error;
        }
        dbg('copilot session state not found, creating', error?.message || String(error));
        session = await client.createSession(config);
        dbg(`created copilot session ${sdkSessionId.slice(0, 8)}`);
      }
      if (resumed) {
        // A resumed session keeps whatever model it was created with —
        // `config.model` is not guaranteed to be honoured on resume — so the
        // requested model is applied explicitly rather than assumed. Assuming
        // it is what made a mismatch permanent: `appliedModel` would already
        // equal the request, so the per-turn switch below could never fire.
        appliedModel = '';
        await applyModel(model);
      } else {
        appliedModel = model || '';
      }
      return session;
    }
    if (model && model !== appliedModel) await applyModel(model);
    return session;
  }

  async function stopRuntime(reason) {
    stopLifecycleTimer();
    try { detachRuntimeExit(); } catch { /* the observer is best-effort */ }
    detachRuntimeExit = () => {};
    const closingSession = session;
    const closingClient = client;
    session = null;
    client = null;
    appliedModel = '';
    if (!closingSession && !closingClient) return;
    dbg(`stopping the copilot runtime (${reason})`);
    try { await closingSession?.disconnect?.(); } catch (error) {
      dbg('session disconnect failed', error?.message || String(error));
    }
    try { await closingClient?.stop?.(); } catch (error) {
      dbg('client stop failed', error?.message || String(error));
    }
  }

  // -------------------------------------------------------------- lifecycle --

  function evaluateLifecycle() {
    if (disposed || activeTurn || !client) return;
    if (!(idleShutdownMs > 0)) return;
    if (Date.now() - lastActivityAt < idleShutdownMs) return;
    void stopRuntime('idle').catch(() => {});
  }

  function startLifecycleTimer() {
    if (lifecycleTimer || !(idleShutdownMs > 0)) return;
    lifecycleTimer = setInterval(evaluateLifecycle, lifecyclePollMs);
    lifecycleTimer.unref?.();
  }

  function stopLifecycleTimer() {
    if (!lifecycleTimer) return;
    clearInterval(lifecycleTimer);
    lifecycleTimer = null;
  }

  // ------------------------------------------------------------------- turn --

  function resolvePerTurnModel(message) {
    const requested = String(message?.model || '').trim();
    if (requested && requested.toLowerCase() !== 'auto') return requested;
    return String(message?.providerModel || '').trim() || defaultModel;
  }

  function createTurn(message) {
    const turn = {
      message,
      normalizer: createNormalizerImpl(),
      state: { lastStreamedText: '' },
      result: null,
      settled: false,
      aborted: false,
      stallTimer: null,
    };
    turn.done = new Promise((resolve, reject) => {
      turn.resolveDone = resolve;
      turn.rejectDone = reject;
    });
    // The stall watchdog and the runtime-exit observer can reject `turn.done`
    // before `runTurn` reaches its `await` — an unhandled rejection that the
    // worker crash guard would escalate into a whole-worker failure. This
    // handler exists only to mark the promise as handled; the real await path
    // still sees the rejection.
    turn.done.catch(() => {});
    turn.settle = () => {
      if (turn.settled) return;
      turn.settled = true;
      turn.disarmStall();
      turn.resolveDone();
    };
    turn.fail = (error) => {
      if (turn.settled) return;
      turn.settled = true;
      turn.disarmStall();
      turn.rejectDone(error);
    };
    turn.disarmStall = () => {
      if (!turn.stallTimer) return;
      clearTimeout(turn.stallTimer);
      turn.stallTimer = null;
    };
    turn.armStall = () => {
      if (!(turnStallTimeoutMs > 0) || turn.settled) return;
      turn.disarmStall();
      turn.stallTimer = setTimeout(() => {
        turn.fail(new Error(
          `copilot worker watchdog: the runtime produced no events for ${Math.round(turnStallTimeoutMs / 1000)}s; `
          + 'the row is failed — resend the message to retry',
        ));
      }, turnStallTimeoutMs);
      turn.stallTimer.unref?.();
    };
    return turn;
  }

  async function runTurn(message) {
    const model = resolvePerTurnModel(message);
    const relayMode = message?.relayMode || 'agent';
    const turn = createTurn(message);
    // Set before the session is touched: the heartbeat's owner-recovery guard
    // reads the active ids, so a cold-start delivery must already own its row.
    activeTurn = turn;

    const controlState = controlPoller?.start?.({
      queueMessageId: message.id,
      onAbortTurn: async () => {
        turn.aborted = true;
        // While `ensureSession` is still connecting there is no session to
        // abort and this would be a silent no-op; `runTurn` re-checks
        // `turn.aborted` once the session exists and settles there instead.
        if (!session) return;
        // The runtime answers an abort with `abort` → `agent.interrupted` →
        // `assistant.turn_end` → `session.idle{aborted:true}`, which settles
        // the turn through the normal terminator; this only asks for it.
        await session.abort?.();
      },
    });

    try {
      await ensureSession(model, relayMode);
      if (turn.aborted) {
        // The abort landed while the session was still being built. Nothing
        // was sent, so there is no runtime turn to interrupt — ask anyway (a
        // queued prompt from a previous delivery could still be running) and
        // settle locally rather than sending a prompt the user just cancelled.
        dbg('turn aborted before send', message.id);
        try { await session?.abort?.(); } catch (error) {
          dbg('abort during session setup failed', error?.message || String(error));
        }
        turn.settle();
      } else {
        turn.armStall();
        const sendMode = String(resolveSendModeImpl(message) || '').trim();
        const { prompt, attachments } = buildMessageOptionsImpl(message);
        // `mode` and `attachments` are FIELDS of the single MessageOptions
        // argument — `send()` takes no second parameter, so passing options
        // positionally drops them silently.
        await session.send({
          prompt,
          ...(attachments?.length ? { attachments } : {}),
          ...(sendMode ? { mode: sendMode } : {}),
          agentMode: copilotAgentModeForRelayMode(relayMode),
        });
        // `send()` resolves once the runtime accepted the prompt — it is NOT
        // the turn's completion; the event stream is.
        await turn.done;
      }
    } finally {
      controlPoller?.stop?.(controlState);
      turn.disarmStall();
      // Drain in-flight dispatches before the turn's state is read, so a
      // stream POST cannot land after the response.
      await dispatchChain.catch(() => {});
    }

    const result = turn.result;
    const responseModel = result?.model || turn.normalizer.model || model || null;
    captureTurnUsage(message, result);

    // A user-initiated abort publishes the partial text and nothing else: the
    // queue row's fate belongs to the server-side abort control, exactly as in
    // the Claude and Cursor workers. Publishing a response here would
    // double-settle the row.
    if (turn.aborted) {
      dbg('turn aborted', message.id);
      await publishFinalStream(message, result?.text || turn.state.lastStreamedText);
      return true;
    }

    // The runtime aborted on its own (`result.aborted` with no relay-side
    // abort control in flight). Nothing server-side is waiting to settle this
    // row, so returning here would leave it pending until the delivery
    // watchdog fails it with a misleading "Relay timeout" — the row has to be
    // settled with a record that says what actually happened.
    if (result?.aborted) {
      dbg('turn interrupted by the runtime', message.id);
      const partial = String(result?.text || turn.state.lastStreamedText || '').trim();
      const text = partial ? `${partial}\n\n${RUNTIME_INTERRUPTED_NOTE}` : RUNTIME_INTERRUPTED_NOTE;
      await publishFinalStream(message, text);
      await publishResponse(message, { text, model: responseModel });
      return true;
    }

    if (result?.isError) {
      const classified = classifyCopilotSessionError(result.errorData || { message: result.errorMessage });
      dbg('turn failed', message.id, classified.stableCode);
      await publishFinalStream(message, turn.state.lastStreamedText);
      await publishResponse(message, {
        text: classified.text,
        model: responseModel,
        terminalError: terminalErrorRecord(message, classified),
      });
      return true;
    }

    // A terminal, non-error turn with no prose is COMPLETE, not a failed
    // delivery — requeuing re-runs deterministically empty work until the
    // retry cap fails the row with a misleading "Relay timeout".
    const finalText = String(result?.text || turn.state.lastStreamedText || '').trim();
    const publishedText = finalText || EMPTY_TURN_COMPLETION_NOTE;
    await publishFinalStream(message, publishedText);
    await publishResponse(message, { text: publishedText, model: responseModel });
    return true;
  }

  async function handlePendingPayload(pending) {
    const message = pending?.message || null;
    if (!message) return false;
    try {
      return await runTurn(message);
    } catch (error) {
      const classified = classifyCopilotTurnException(error);
      dbg('copilot turn failed', message.id, classified.detail);
      // A failure that killed the session (or came from starting it) leaves a
      // handle nothing else can use; drop it so the next delivery rebuilds and
      // resumes rather than sending into a dead runtime.
      await stopRuntime('turn-failure').catch(() => {});
      await publishResponse(message, {
        text: classified.text,
        model: null,
        terminalError: terminalErrorRecord(message, classified),
      });
      return true;
    } finally {
      // Cleared only once every publish for this row has landed. A heartbeat
      // that fired during the publish window with no active ids would tell the
      // relay this worker owns nothing, and the still-processing row would be
      // recovered (`owner-heartbeat-idle`) and re-delivered — a duplicate
      // execution racing the response that was already on its way.
      activeTurn = null;
      touch();
    }
  }

  // --------------------------------------------------------------- teardown --

  function getActiveQueueMessageId() {
    return activeTurn ? String(activeTurn.message?.id || '') : '';
  }

  function getActiveQueueMessageIds() {
    const id = getActiveQueueMessageId();
    return id ? [id] : [];
  }

  async function dispose() {
    disposed = true;
    stopLifecycleTimer();
    await stopRuntime('worker-shutdown');
  }

  return {
    handlePendingPayload,
    getActiveQueueMessageId,
    getActiveQueueMessageIds,
    isTurnActive: () => !!activeTurn,
    dispose,
    // The turn's tokens/cost/TTFT, held for the ingest wiring phase 2 adds.
    getLastTurnUsage: () => lastTurnUsage,
    // Test seams / observability.
    _getState: () => ({
      hasClient: !!client,
      hasSession: !!session,
      appliedModel,
      lastActivityAt,
    }),
    _evaluateLifecycle: evaluateLifecycle,
  };
}
