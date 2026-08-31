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
  createCopilotPermissionHandler,
  isReadOnlyPermissionRequest,
  isSessionNotFoundError,
  observeRuntimeExit,
  resolveCopilotSdkPaths,
  startCopilotClient,
} from './copilot-sdk-adapter.mjs';
import { buildCopilotMessageOptions } from './copilot-attachments.mjs';
import { resolveCopilotProviderConfig } from './copilot-byok-provider.mjs';
import { createCopilotEventNormalizer } from './copilot-sdk-event-normalizer.mjs';
import { createCopilotQuestionBridge } from './copilot-question-bridge.mjs';
import {
  EXIT_PLAN_BOARD_POSTED_FEEDBACK,
  EXIT_PLAN_NO_BOARD_FEEDBACK,
  buildCopilotPlanReadyBoardPayload,
  planTextFromExitRequest,
  shouldPostPlanBoard,
} from './copilot-plan-board.mjs';
import {
  createCopilotPromptContextBuilder,
  createPreviewInstructionsProvider,
  loadDefaultRelayToolInstructions,
  withRelayContext,
} from './copilot-prompt-context.mjs';
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

/**
 * Published to a steered queue row whose prompt the runtime accepted but never
 * opened work on before the interaction ended. The prompt is still queued
 * INSIDE the runtime, so it will be answered at the start of the next turn —
 * requeuing the row would run it twice. Mirrors the Claude worker's
 * handed-off-context note, which exists for the same reason.
 */
export const STEERED_ROW_MERGED_NOTE =
  '_(This message was delivered while the previous turn was still running; the reply continues in '
  + 'the next turn.)_';

/**
 * Compaction / infinite-session policy.
 *
 * These are the runtime's OWN documented defaults for `InfiniteSessionConfig`
 * (enabled, background compaction at 0.80 of the context window, blocking
 * compaction at 0.95) — they are set explicitly rather than left unset so a
 * future change to the runtime's defaults cannot silently move the point at
 * which a long relay conversation starts compacting. Compaction is what makes
 * a resumable, long-lived relay conversation possible at all: the alternative
 * is a turn that fails on context overflow with the whole history intact and
 * no way forward.
 */
export const DEFAULT_INFINITE_SESSION_CONFIG = Object.freeze({
  enabled: true,
  backgroundCompactionThreshold: 0.8,
  bufferExhaustionThreshold: 0.95,
});

/** `steerIntoActiveTurn` could not adopt the row; run it as a normal turn. */
const NOT_STEERED = Symbol('not-steered');

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
  // BYOK: `COPILOT_PROVIDER_*` in this worker's env become
  // `SessionConfig.provider`. Injected so tests can drive the branch without
  // mutating process.env.
  resolveProviderConfigImpl = resolveCopilotProviderConfig,
  // Threading seam for `MessageOptions.mode` ("enqueue" | "immediate").
  //
  // A BYOK probe against runtime 1.0.82 ran a mid-turn send three ways —
  // "enqueue", "immediate" and unset — and all three behaved IDENTICALLY: the
  // send resolves in ~2ms with a message id, the prompt is queued
  // (`pending_messages.modified`), the in-flight model call runs to completion
  // untouched, and the prompt is picked up at the NEXT model-call boundary with
  // its own `user.message`. Neither mode interrupts anything. "enqueue" is the
  // documented default and preserves FIFO order, which is what the relay queue
  // contract wants, so it is what this sends. See §5 of the plan doc.
  resolveSendModeImpl = () => 'enqueue',
  // Interactive surfaces. Tests inject a fake bridge; nothing here reaches the
  // relay without one.
  createQuestionBridgeImpl = createCopilotQuestionBridge,
  questionPollMs = undefined,
  questionTimeoutMs = undefined,
  // Preview-lane guidance. Advisory — a failure costs the block, not the turn.
  relayToolInstructions = undefined,
  getPreviewInstructionsImpl = undefined,
  infiniteSessionConfig = DEFAULT_INFINITE_SESSION_CONFIG,
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
  // The snapshot object already handed to the ingest. Identity, not a flag, so
  // a turn that captured nothing new cannot re-post the previous turn's numbers
  // (every settle path runs `postTurnUsage`, including the ones that publish no
  // fresh usage at all).
  let postedTurnUsage = null;
  // The in-flight ingest POST, exposed only as a test seam. Never awaited by
  // the turn path — that is the entire point of it.
  let usagePostChain = Promise.resolve();
  let starting = null;
  let disposed = false;
  let detachRuntimeExit = () => {};
  // Prompts this worker sent that the runtime accepted but had not started work
  // on when the interaction ended. They stay in the runtime's pending queue and
  // are picked up FIRST in the next interaction, ahead of that turn's own
  // prompt — so the next turn's segments are shifted by this many, and without
  // it the primary row would be answered with a leftover prompt's reply.
  let carriedPrompts = 0;
  // Blocking handlers currently waiting on a human (`ask_user`, an ask-mode
  // tool approval). The runtime emits NO events while blocked in one, and the
  // question timeout is 8 hours against a 120s stall ceiling — so without this
  // every unanswered card would fail its row after two minutes and then hand
  // the human's eventual answer to a runtime whose row is already settled.
  // Same guard the Cursor worker's `hasPendingClientWork` provides.
  let pendingHumanRequests = 0;
  // The `SessionConfig.provider` block this session was BUILT with, or null for
  // a hosted (`github`) session. Set by `buildSessionConfig` rather than by a
  // second throwaway resolve here, so "is this BYOK?" and "what did the runtime
  // actually get?" can never disagree — which matters because the block's token
  // ceilings are model-specific and the session is rebuilt when the model
  // changes.
  let byokProvider = null;

  async function whileAwaitingHuman(run) {
    pendingHumanRequests += 1;
    try {
      return await run();
    } finally {
      pendingHumanRequests -= 1;
      // The clock restarts from the answer, not from before the wait.
      touch();
      activeTurn?.armStall?.();
    }
  }

  // The relay question bridge serves `ask_user` and (in ask mode) tool
  // approvals. `getActiveMessage` must resolve to the row that is CURRENTLY
  // `processing`, because `/api/relay-question` 409s otherwise.
  const questionBridge = createQuestionBridgeImpl({
    api,
    sdkSessionId,
    getActiveMessage: () => activeTurn?.message || null,
    ...(questionPollMs === undefined ? {} : { questionPollMs }),
    ...(questionTimeoutMs === undefined ? {} : { questionTimeoutMs }),
    dbg,
  });

  const buildRelayContextPrefix = createCopilotPromptContextBuilder({
    toolInstructions: relayToolInstructions === undefined
      ? loadDefaultRelayToolInstructions({ env })
      : relayToolInstructions,
    getPreviewInstructions: getPreviewInstructionsImpl === undefined
      ? createPreviewInstructionsProvider({ api })
      : getPreviewInstructionsImpl,
  });
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
      return;
    }
    if (channel === 'subagent') {
      // Same body as every sibling worker's, so the lane bubbles, the
      // `subagent_status` broadcast and the UI's grouping behave identically
      // whichever provider produced the run.
      await api('POST', '/api/subagent-run', {
        messageId: message.id,
        conversationId: message.conversationId,
        subagentRunId: payload.subagentRunId,
        ...(payload.parentSubagentId ? { parentSubagentId: payload.parentSubagentId } : {}),
        ...(payload.displayName ? { displayName: payload.displayName } : {}),
        status: payload.status,
      }).catch(() => {});
    }
  }

  /**
   * Force-close any subagent still marked running.
   *
   * The normalizer closes strays when it builds a terminal `result`, but the
   * paths that kill a turn WITHOUT one — a user abort, the runtime exiting, a
   * thrown exception — never get there. The relay only reconciles open runs
   * when the queue row is FAILED, so on the abort path (where the row is
   * settled server-side) an un-closed run would render as a bubble spinning
   * forever.
   */
  async function closeStraySubagentRuns(turn) {
    const runs = turn?.normalizer?.activeSubagentRuns?.() || [];
    for (const run of runs) {
      await dispatchAction(turn.message, {
        channel: 'subagent',
        payload: {
          subagentRunId: run.subagentRunId,
          parentSubagentId: null,
          displayName: run.displayName,
          status: 'failed',
        },
      }, turn.state);
    }
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
   * Per-turn usage capture, recorded on the runner.
   *
   * Synchronous and side-effect-only: it decides WHAT to report, never when.
   * The POST is `postTurnUsage`'s job and runs after the row is published.
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
      // The premium MULTIPLIER, not money.
      cost: usage?.cost ?? null,
      // Real spend, and the field a usage card should show.
      totalNanoAiu: usage?.totalNanoAiu ?? null,
      modelCalls: usage?.modelCalls ?? null,
      subagentModelCalls: usage?.subagentModelCalls ?? null,
      timeToFirstTokenMs: usage?.timeToFirstTokenMs ?? null,
      contextTokens: contextUsage?.currentTokens ?? null,
      // Overage lives at `quotaSnapshots.cfi_overage`; `account.getQuota()`
      // reads a stale cache and will not show it.
      hasQuotaSnapshots: !!usage?.quotaSnapshots,
      cfiOverage: usage?.quotaSnapshots?.cfi_overage ?? null,
    }));
  }

  /**
   * Report the captured turn usage to the relay's `/api/copilot-plan-usage`
   * ingest. Fire-and-forget, deliberately, and always AFTER the row has been
   * published.
   *
   * The plan card's meters come from the account-level quota API the relay
   * fetches itself, and those already cover SDK sessions. What only the worker
   * can see is the per-turn detail: `totalNanoAiu` (real spend — the event's
   * `cost` is the premium multiplier, not money) and
   * `quotaSnapshots.cfi_overage` (overage, invisible to `account.getQuota()`'s
   * cached read). None of that is worth one millisecond of a finished reply.
   *
   * Awaiting it was actively dangerous: by this point the stall watchdog is
   * disarmed and the relay client has no request timeout, so an unresponsive
   * relay could hold a COMPLETED turn — its text already generated, its queue
   * row still open — for as long as the socket stayed up. The result is unused
   * and the failure is already swallowed, so there was nothing to wait for.
   *
   * BYOK sessions do not post at all: they spend the user's own OpenAI key
   * rather than Copilot quota, and their usage events report `cost: 0`, so
   * their numbers would only mislead on a card about the Copilot plan.
   */
  function postTurnUsage() {
    if (byokProvider || !lastTurnUsage || lastTurnUsage === postedTurnUsage) return;
    postedTurnUsage = lastTurnUsage;
    // Held so a test (and only a test) can await the settle; nothing in the
    // turn path ever reads it.
    usagePostChain = api('POST', '/api/copilot-plan-usage', lastTurnUsage)
      .catch((error) => { dbg('usage ingest failed', error?.message || String(error)); });
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
    // Built once per session, not per request. Reads the mode off the LIVE turn
    // rather than closing over the one the session was built with, because one
    // session serves every turn and the user can switch modes between them.
    const decidePermission = createCopilotPermissionHandler({
      // Only the ask-mode branch actually blocks on a human; wrapping it keeps
      // the stall watchdog off a turn where someone is deciding.
      bridge: {
        askToolApproval: (permissionRequest, options) => whileAwaitingHuman(
          () => questionBridge.askToolApproval(permissionRequest, options),
        ),
      },
      getRelayMode: () => activeTurn?.message?.relayMode || relayMode,
      // An aborted turn must not leave the human staring at a card whose answer
      // nothing will read; the bridge times the card out instead.
      getSignal: () => activeTurn?.abortController?.signal || null,
      dbg,
    });
    // BYOK sessions must carry their provider IN the session config: the
    // runtime's `COPILOT_PROVIDER_*` startup layer does not run for
    // SDK-created sessions, so without this an OpenAI-provider conversation
    // would silently run on hosted Copilot models instead. Null for every
    // hosted (`github`) session, which is the common case.
    //
    // The resolved block is remembered: its token ceilings describe THIS model,
    // and `session.setModel()` cannot update them (see `applyModel`).
    const provider = resolveProviderConfigImpl({ env, model: model || defaultModel, dbg });
    byokProvider = provider;
    return {
      // The relay session id IS the SDK session id, so the runtime's own state
      // under ~/.copilot/session-state/<id> is addressable by conversation and
      // survives worker restarts without a side table.
      sessionId: sdkSessionId,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      // Not a default: without this the SDK emits no deltas at all and the
      // transcript only updates when the whole message lands.
      streaming: true,
      workingDirectory: cwd,
      clientName,
      // The runtime's own defaults, pinned. See DEFAULT_INFINITE_SESSION_CONFIG.
      ...(infiniteSessionConfig ? { infiniteSessions: { ...infiniteSessionConfig } } : {}),
      onEvent: routeEvent,
      // Permission policy follows the conversation's relay mode: agent and
      // autopilot auto-approve, plan denies non-read tools with feedback, and
      // ask asks the human through a relay question card. The handler reads the
      // mode from the LIVE turn rather than closing over the mode the session
      // was built with, because one session serves every turn of a conversation
      // and the user can switch modes between them.
      onPermissionRequest: async (request) => {
        const decision = await decidePermission(request);
        // Remember that this turn actually changed something: it is what tells
        // a described plan apart from work already done, which is the
        // difference between a useful handoff board and a nonsensical one.
        if (decision?.kind === 'approve-once' && !isReadOnlyPermissionRequest(request) && activeTurn) {
          activeTurn.acted = true;
        }
        return decision;
      },
      // `ask_user` → a relay question card. The runtime BLOCKS the turn on this
      // handler, so it must always settle: a throw would fail the tool call
      // silently, and a hang would hold the queue row until the delivery
      // watchdog gives up. `wasFreeform` is required by `UserInputResponse` and
      // the deserializer is strict, so it is always a real boolean.
      onUserInputRequest: async (request) => {
        try {
          const { answer, wasFreeform } = await whileAwaitingHuman(() => questionBridge.askUserInput(request, {
            signal: activeTurn?.abortController?.signal || null,
          }));
          return { answer, wasFreeform };
        } catch (error) {
          dbg('user input question failed', error?.message || String(error));
          return { answer: USER_INPUT_UNSUPPORTED_ANSWER, wasFreeform: true };
        }
      },
      // The agent finished planning. Post the board and REFUSE the exit:
      // approving it tells the runtime the plan was accepted and the same turn
      // rolls straight into implementing while the board sits unanswered.
      onExitPlanModeRequest: async (request) => {
        const posted = await publishPlanBoard(activeTurn, planTextFromExitRequest(request), 'exit_plan_mode');
        return {
          approved: false,
          feedback: posted ? EXIT_PLAN_BOARD_POSTED_FEEDBACK : EXIT_PLAN_NO_BOARD_FEEDBACK,
        };
      },
      // Structured elicitation has no relay card type of its own; declining is
      // in-band and lets the model continue, which a hang would not.
      onElicitationRequest: () => ({ action: 'decline' }),
    };
  }

  /**
   * Post the `plan_ready` board for a turn. Returns whether a board went out,
   * which the exit-plan handler turns into the feedback the agent sees.
   *
   * Marks the turn so the completion path's text-shape fallback does not post a
   * second board — the relay would dedupe it (`UNIQUE(message_id, board_type)`)
   * but only after a pointless round trip.
   */
  async function publishPlanBoard(turn, planText, source) {
    if (!turn?.message?.id) return false;
    const payload = buildCopilotPlanReadyBoardPayload({ message: turn.message, planText, source });
    if (!payload) return false;
    // The failure is swallowed (a relay that refused the board must not fail a
    // turn that otherwise succeeded) but it is REPORTED: telling the agent the
    // plan is "shown to the user for review" when it is not would end the turn
    // with the plan visible nowhere, and would also latch off the text-shape
    // fallback that could still have posted it.
    try {
      await api('POST', '/api/relay-board', payload);
    } catch (error) {
      dbg('plan board publish failed', error?.message || String(error));
      return false;
    }
    turn.planBoardPosted = true;
    return true;
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
   *
   * This is the HOSTED path only. A BYOK session cannot switch this way — see
   * `switchModel`.
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

  /**
   * Switch a live session onto a different model.
   *
   * Hosted sessions just call `setModel()`. BYOK sessions cannot: their token
   * ceilings live in `SessionConfig.provider`, which is fixed at session
   * creation. Runtime 1.0.82 exposes **no** way to update it — `setModel()`
   * takes reasoning/context options but no provider, there is no
   * `setProvider`, and the one runtime registry-add RPC belongs to the
   * experimental named-`providers`/`models` surface, which the runtime
   * explicitly REJECTS when combined with the singular whole-session
   * `provider` this worker uses.
   *
   * So a bare `setModel()` on a BYOK session leaves the previous model's
   * ceilings in place, and both directions of that are harmful: ceilings too
   * high turn compaction into hard API rejections, ceilings too low compact a
   * conversation that had plenty of room left.
   *
   * The session is therefore disposed and rebuilt with freshly resolved
   * ceilings. Nothing is lost: the relay session id IS the SDK session id, the
   * runtime's state persists under it, and the rebuild takes the ordinary
   * resume path — the same one every worker restart already uses.
   */
  async function switchModel(model, relayMode) {
    if (!byokProvider) {
      await applyModel(model);
      return session;
    }
    dbg('rebuilding the copilot session for a BYOK model switch', model);
    const closing = session;
    session = null;
    appliedModel = '';
    // Disconnect first so the runtime is not holding two handles on one
    // session id while the resume runs.
    try { await closing?.disconnect?.(); } catch (error) {
      dbg('session disconnect before model switch failed', error?.message || String(error));
    }
    return ensureSession(model, relayMode);
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
    if (model && model !== appliedModel) return switchModel(model, relayMode);
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
    // A pending question card means a human is mid-answer; tearing the runtime
    // down under them would discard the session the answer belongs to.
    if (disposed || activeTurn || pendingHumanRequests > 0 || !client) return;
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
      planBoardPosted: false,
      // Set when a mutating tool was actually approved and run this turn.
      acted: false,
      // How many prompts have been SENT into this interaction. The runtime
      // consumes queued prompts in order, and opens one `user.message` segment
      // per prompt as it picks each up, so send order IS segment order.
      //
      // Deliberately not derived from the normalizer's live segment count: at
      // the moment a steering send happens the runtime may not have opened the
      // previous prompt's segment yet, and the steered row would then be
      // attributed the PREVIOUS prompt's answer.
      //
      // Starts at 1, not 0: this turn's own prompt is always its first, and
      // counting it here rather than after `send()` resolves closes the race
      // where a steering delivery lands between the two.
      promptsSent: 1,
      // The segment this turn's OWN prompt will be answered in. Non-zero when a
      // previous interaction left prompts queued inside the runtime: those are
      // consumed first and open the earlier segments.
      baseSegment: carriedPrompts,
      // Cancels any relay question card this turn is blocked on, so an aborted
      // turn does not leave a human answering into the void.
      abortController: new AbortController(),
      // Queue rows delivered mid-turn and steered into this interaction. Each
      // one is owed a response by THIS turn — the runtime answers them all
      // under a single `session.idle`, so nothing else will settle them.
      steeredRows: [],
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
        // A human staring at a question card is not a stalled runtime. Re-arm
        // rather than fail: the card has its own (much longer) timeout, and
        // failing the row here would settle it while the answer is still coming.
        if (pendingHumanRequests > 0) {
          turn.armStall();
          return;
        }
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
        const { prompt: body, attachments } = buildMessageOptionsImpl(message);
        // Relay mode marker + (on a mode change) the standing mode instructions,
        // the relay tool guidance and the live preview-lane block.
        const prefix = await buildRelayContextPrefix(message).catch(() => '');
        const prompt = withRelayContext(prefix, body);
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
      // Release anything blocked on a question card before the turn's state is
      // read: the card's answer can no longer reach the runtime.
      turn.abortController.abort();
      // Drain in-flight dispatches before the turn's state is read, so a
      // stream POST cannot land after the response.
      await dispatchChain.catch(() => {});
      // Any subagent still open at this point never will be. The normalizer
      // closes strays when it produces a terminal result; these are the paths
      // that never produced one.
      await closeStraySubagentRuns(turn).catch(() => {});
    }

    const result = turn.result;
    const responseModel = result?.model || turn.normalizer.model || model || null;
    // Capture only. The POST fires from `handlePendingPayload`'s `finally`,
    // after this row has been published.
    captureTurnUsage(message, result);

    // Whatever this interaction did not get to stays queued in the runtime and
    // shifts the NEXT interaction's segments.
    const segmentsOpened = turn.normalizer.promptCount();
    carriedPrompts = Math.max(0, (turn.baseSegment + turn.promptsSent) - segmentsOpened);

    // This row's own reply. Falls back to the whole composed text when the
    // runtime opened no segment at all (an empty or immediately-failed turn),
    // which is strictly better than publishing nothing.
    const ownText = String(
      turn.normalizer.segmentText(turn.baseSegment) || result?.text || turn.state.lastStreamedText || '',
    ).trim();

    // A user-initiated abort publishes the partial text and nothing else: the
    // queue row's fate belongs to the server-side abort control, exactly as in
    // the Claude and Cursor workers. Publishing a response here would
    // double-settle the row.
    if (turn.aborted) {
      dbg('turn aborted', message.id);
      // This row's segment only: the steered rows publish their own, and
      // publishing the composed text here would show their replies twice.
      await publishFinalStream(message, ownText);
      // A steered row is NOT covered by the abort control (which knows only
      // about the row the user aborted), so it still has to be settled here or
      // it holds `processing` forever behind a renewing lease.
      await settleSteeredRows(turn, result, responseModel);
      return true;
    }

    // The runtime aborted on its own (`result.aborted` with no relay-side
    // abort control in flight). Nothing server-side is waiting to settle this
    // row, so returning here would leave it pending until the delivery
    // watchdog fails it with a misleading "Relay timeout" — the row has to be
    // settled with a record that says what actually happened.
    if (result?.aborted) {
      dbg('turn interrupted by the runtime', message.id);
      const text = ownText ? `${ownText}\n\n${RUNTIME_INTERRUPTED_NOTE}` : RUNTIME_INTERRUPTED_NOTE;
      await publishFinalStream(message, text);
      await publishResponse(message, { text, model: responseModel });
      await settleSteeredRows(turn, result, responseModel);
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
      // The steered rows failed with it — they were being answered by the same
      // interaction. They get the same terminal record so each row says why.
      await settleSteeredRows(turn, result, responseModel, classified);
      return true;
    }

    // The turn produced a plan but never called exit-plan-mode (or the runtime
    // build has no such hook). Same text-shape fallback the siblings use, and
    // it must go out BEFORE the response: `/api/relay-board` 409s once the
    // queue row leaves `processing`.
    if (shouldPostPlanBoard({
      relayMode: message.relayMode,
      finalText: ownText,
      alreadyPosted: turn.planBoardPosted,
      acted: turn.acted === true,
    })) {
      await publishPlanBoard(turn, ownText, 'plan-mode-fallback');
    }

    // A terminal, non-error turn with no prose is COMPLETE, not a failed
    // delivery — requeuing re-runs deterministically empty work until the
    // retry cap fails the row with a misleading "Relay timeout".
    const publishedText = ownText || EMPTY_TURN_COMPLETION_NOTE;
    await publishFinalStream(message, publishedText);
    await publishResponse(message, { text: publishedText, model: responseModel });
    await settleSteeredRows(turn, result, responseModel);
    return true;
  }

  /**
   * Settle every queue row that was steered into this interaction.
   *
   * The runtime answers the original prompt AND every prompt queued behind it
   * under ONE `session.idle` (live-verified — see the plan doc §5), so no
   * second turn will ever settle these rows. Each one is answered with the text
   * of ITS OWN prompt segment, which the normalizer separates using the
   * `user.message` events that mark where the runtime picked each prompt up.
   *
   * A row whose prompt the runtime accepted but never started work on has no
   * segment. It is NOT requeued: the prompt is still sitting in the runtime's
   * pending queue and will be answered at the start of the next turn, so
   * redelivering it would run the same prompt twice. It gets a note instead —
   * the same trade the Claude worker makes for a handed-off context.
   */
  async function settleSteeredRows(turn, result, responseModel, classified = null) {
    if (!turn.steeredRows.length) return;
    for (const steered of turn.steeredRows) {
      const { message: steeredMessage, segmentIndex } = steered;
      let text = String(turn.normalizer.segmentText(segmentIndex) || '').trim();
      if (classified) {
        text = classified.text;
      } else if (!text) {
        text = STEERED_ROW_MERGED_NOTE;
      }
      await publishFinalStream(steeredMessage, text);
      await publishResponse(steeredMessage, {
        text,
        model: responseModel,
        ...(classified ? { terminalError: terminalErrorRecord(steeredMessage, classified) } : {}),
      });
      steered.settle?.();
    }
    turn.steeredRows.length = 0;
  }

  /**
   * A delivery arrived while a turn was already running.
   *
   * The relay's worker socket is single-flight — it will not deliver a second
   * row until `onDeliver` resolves — so this is not the normal path. It is
   * reachable on a socket reconnect that redelivers, and it is the path a
   * future relay change would take, so it steers rather than corrupting the
   * turn: the prompt is queued into the SAME interaction (which is all
   * `mode: "enqueue"` can do — it cannot interrupt an in-flight model call),
   * and the row is adopted so the interaction's terminator settles it too.
   *
   * The row is registered BEFORE the send so a failure between the two cannot
   * leave a row nobody owns.
   */
  async function steerIntoActiveTurn(turn, message) {
    const { prompt: body, attachments } = buildMessageOptionsImpl(message);
    // A real relay round trip on the first turn of a mode — long enough for the
    // turn to finish underneath us.
    const prefix = await buildRelayContextPrefix(message).catch(() => '');
    const prompt = withRelayContext(prefix, body);
    // Re-checked AFTER the awaits and before anything is sent or registered.
    // `settleSteeredRows` has already run if the turn settled during them, so a
    // row pushed now would never be settled and its caller would wait forever —
    // wedging the single-flight delivery socket. Nothing has been sent yet, so
    // handing the row back to the normal path is free.
    if (turn.settled) {
      dbg('turn settled while steering was preparing; running it as a fresh turn', message.id);
      return NOT_STEERED;
    }
    // Prompts are consumed in the order they were sent, and each opens its own
    // `user.message` segment as it is picked up, so this prompt's send position
    // (after any prompts carried over from a previous interaction) is its
    // segment index.
    const segmentIndex = turn.baseSegment + turn.promptsSent;
    turn.promptsSent += 1;
    const steered = { message, segmentIndex };
    steered.done = new Promise((resolve) => { steered.settle = resolve; });
    turn.steeredRows.push(steered);
    dbg('steering a mid-turn delivery into the running turn', message.id, `segment=${segmentIndex}`);
    try {
      await session.send({
        prompt,
        ...(attachments?.length ? { attachments } : {}),
        mode: 'enqueue',
        agentMode: copilotAgentModeForRelayMode(message?.relayMode || 'agent'),
      });
    } catch (error) {
      // The prompt never reached the runtime, so nothing will answer it and the
      // row is safe to requeue — unlike an accepted one.
      turn.steeredRows = turn.steeredRows.filter((entry) => entry !== steered);
      dbg('steering send failed, requeuing the row', message.id, error?.message || String(error));
      await api('POST', '/api/requeue', { messageId: message.id }).catch(() => {});
      return true;
    }
    // Resolves when the interaction settles this row in `settleSteeredRows`.
    await steered.done;
    return true;
  }

  async function handlePendingPayload(pending) {
    const message = pending?.message || null;
    if (!message) return false;
    // A delivery that lands while a turn is running is steered into it rather
    // than starting a second one: the runtime has a single conversation and a
    // concurrent `send` would interleave into the same interaction anyway —
    // this way the row is owned and settled instead of orphaned.
    //
    // Deliberately OUTSIDE the try/finally below: that `finally` clears
    // `activeTurn`, and a steered call returns while the turn it was steered
    // into is still publishing. Clearing there would tell the heartbeat this
    // worker owns nothing and the relay would recover the live row.
    if (activeTurn && !activeTurn.settled && session) {
      const turn = activeTurn;
      try {
        const outcome = await steerIntoActiveTurn(turn, message);
        if (outcome !== NOT_STEERED) return outcome;
      } catch (error) {
        dbg('steering failed', message.id, error?.message || String(error));
        const classified = classifyCopilotTurnException(error);
        await publishResponse(message, {
          text: classified.text,
          model: null,
          terminalError: terminalErrorRecord(message, classified),
        });
        return true;
      }
    }
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
      // Rows steered into the turn that just threw are owed a response too —
      // and, more urgently, `steerIntoActiveTurn` is still awaiting their
      // settle. Skipping this would wedge that caller (and its queue row)
      // forever behind a heartbeat that keeps renewing the lease.
      if (activeTurn) {
        await settleSteeredRows(activeTurn, null, null, classified).catch(() => {});
        await closeStraySubagentRuns(activeTurn).catch(() => {});
      }
      return true;
    } finally {
      // Cleared only once every publish for this row has landed. A heartbeat
      // that fired during the publish window with no active ids would tell the
      // relay this worker owns nothing, and the still-processing row would be
      // recovered (`owner-heartbeat-idle`) and re-delivered — a duplicate
      // execution racing the response that was already on its way.
      activeTurn = null;
      touch();
      // Every path through the turn — published, failed, aborted, threw — has
      // finished by here, which is the only safe place for the ingest: it is
      // advisory, it is not awaited, and it must never be able to delay a reply
      // that is already written.
      postTurnUsage();
    }
  }

  // --------------------------------------------------------------- teardown --

  function getActiveQueueMessageId() {
    return activeTurn ? String(activeTurn.message?.id || '') : '';
  }

  /**
   * Every row this worker owns — the turn's own, plus any steered into it.
   *
   * Both the heartbeat (lease renewal) and the crash guard (requeue-on-exit)
   * read this. A steered row missing from it would be recovered mid-flight as
   * `owner-heartbeat-mismatch` and re-delivered while the runtime was still
   * answering it.
   */
  function getActiveQueueMessageIds() {
    if (!activeTurn) return [];
    const ids = [];
    const primary = String(activeTurn.message?.id || '');
    if (primary) ids.push(primary);
    for (const steered of activeTurn.steeredRows || []) {
      const id = String(steered.message?.id || '');
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  async function dispose() {
    disposed = true;
    stopLifecycleTimer();
    // A question card left `pending` would sit in the UI inviting an answer
    // that nothing is left to read. Time them out before the socket goes.
    await questionBridge.cancelPendingQuestions?.().catch?.(() => {});
    await stopRuntime('worker-shutdown');
  }

  return {
    handlePendingPayload,
    getActiveQueueMessageId,
    getActiveQueueMessageIds,
    isTurnActive: () => !!activeTurn,
    dispose,
    // The turn's tokens/cost/TTFT, as posted to `/api/copilot-plan-usage`.
    getLastTurnUsage: () => lastTurnUsage,
    // The in-flight usage ingest. A test seam ONLY: the turn path deliberately
    // never awaits this, which is what keeps a slow relay from holding a
    // finished reply.
    whenUsagePosted: () => usagePostChain,
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
