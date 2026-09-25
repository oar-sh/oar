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
//
// ## Self-initiated turns
//
// The runtime does not only answer prompts. A detached background shell
// (`bash{mode:"async", detach:true}`) settles on its own clock, and the runtime
// then re-invokes the model with NO prompt behind it — a `system.notification`
// followed by a fresh `assistant.turn_start`, tool calls and a durable
// `assistant.message`. Live burn-in (session `10a1a9ad`, 2026-08-31: "set a
// timer to 1 minute") caught the whole of that second turn being dropped
// because no relay row was open to publish it into, and the user never saw the
// answer they had been promised.
//
// So a turn here is one of two kinds:
//
//  - `delivered`     — a queue row arrived, `runTurn` sends its prompt;
//  - `continuation`  — the runtime started work by itself. The worker mints a
//    synthetic queue row (`POST /api/continuation-turn`) and runs the SAME
//    state machine over the events, so the turn gets the full relay surface:
//    stream, thoughts, activity, questions, usage and a response of its own.
//    Actions produced before the row exists are buffered and flushed in order.
//
// Three rules keep that safe, and each is enforced in `routeEvent`:
//
//  1. **Replay is not new work.** `session.resume` can replay persisted history
//     through the same callback; `createReplayGate` drops it (see that module
//     for why `resumeTime` and `eventCount` are used together).
//  2. **Liveness pins the runtime.** Idle shutdown must not stop a runtime that
//     has a detached shell running or a settled shell's continuation still due
//     — stopping it kills the shell. `createBackgroundShellTracker` supplies
//     the set; `backgroundTaskTimeoutMs` caps how long it may pin.
//  3. **A continuation is a turn like any other.** It ends on `session.idle`,
//     its usage is captured and posted, and a user message delivered while it
//     runs is steered into it (answered from its own prompt segment) rather
//     than cross-published into the continuation's row.
import { randomUUID } from 'crypto';

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
import {
  createBackgroundShellTracker,
  createReplayGate,
  describeSettledShell,
  isContinuationOpeningEvent,
} from './copilot-continuation-signals.mjs';
import { createCopilotEventNormalizer } from './copilot-sdk-event-normalizer.mjs';
import {
  DEFAULT_MODEL_SWITCH_TIMEOUT_MS,
  createCopilotModelSwitcher,
  isModelSwitchUnconfirmedError,
  normalizeRelayEffort,
} from './copilot-model-switch.mjs';
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
import { buildModelSnapshotFields, extractModelDescriptors } from '../../shared/model-descriptors.mjs';
import { STEER_FOLDED_TEXT, STEER_STOPPED_TEXT } from '../../shared/steer-settle-markers.mjs';
import { buildSteerSettleFailure } from '../../shared/steer-settle-failure.mjs';
import { shouldEmitStreamUpdate } from '../../shared/stream-emit-gating.mjs';

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
 * How long live background shells ALONE may keep the runtime up (0 = no limit).
 *
 * Deliberately not the relay's `background_task_timeout_minutes` slider, whose
 * default is 0/unlimited: that slider governs Claude's background tasks, which
 * have ids, a composer panel and a stop button, so "no limit" there is a choice
 * the user can see and undo. A Copilot detached shell has none of that — the
 * runtime exposes no RPC to stop one and the relay has no surface listing them
 * — so an unlimited default would let a single forgotten `sleep 99999` pin a
 * runtime subprocess for the life of the relay with nothing to point at. 30
 * minutes is well past any timer a user would sit and wait for, and the cap
 * only ever costs the shell, never a turn.
 */
const DEFAULT_BACKGROUND_TASK_TIMEOUT_MS = 30 * 60_000;
/**
 * How long after a shell settles the runtime is held up waiting for the
 * continuation it should trigger.
 *
 * The live capture had 3ms between the `system.notification` and the
 * `assistant.turn_start`. This window only has to survive a runtime that
 * notifies and then decides there is nothing to say — mirrors the Claude
 * worker's `notificationGraceMs`, same value.
 */
const DEFAULT_CONTINUATION_GRACE_MS = 60_000;
/** Retry spacing for the synthetic-row registration (3 attempts). */
const DEFAULT_CONTINUATION_RETRY_DELAY_MS = 500;
/** How long a continuation's actions may buffer before its row is abandoned. */
const CONTINUATION_REGISTRATION_TIMEOUT_MS = 10_000;
/** Cap on activity lines carried between turns, so a chatty runtime cannot grow them. */
const MAX_PENDING_ACTIVITIES = 20;
/**
 * Backstop for the compaction hold: `session.compaction_start` without a
 * matching `_complete` (a runtime that died mid-compaction and was resumed)
 * must not hold steering forever. Sized far above any plausible compaction,
 * like the Claude worker's `compactionStaleMs`.
 */
const DEFAULT_COMPACTION_STALE_MS = 10 * 60_000;
/**
 * Backoff between attempts to save a consumed steer's settle marker (~31 s in
 * all); after the last one the row fails terminally instead. Same ladder as
 * the Claude worker, because it protects the same invariant: a prompt the
 * runtime already consumed is never re-run.
 */
const DEFAULT_SETTLE_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
const DEFAULT_MAX_TERMINAL_SETTLE_ATTEMPTS = 5;
/** Debounce for re-reading the runtime's queued lane after `pending_messages.modified`. */
const DEFAULT_QUEUE_LANE_REFRESH_MS = 150;
/**
 * How long a pushed prompt the runtime had not started when the turn's idle
 * arrived is kept unsettled, waiting for the runtime to open its run. The
 * drain's idle can race a send that resolved a moment earlier; the runtime
 * then starts the prompt right away (`immediate` when idle) and its
 * `user.message` adopts the row as a turn of its own. Same value as the
 * Claude worker's fold grace, for the same reason.
 */
const DEFAULT_ORPHAN_GRACE_MS = 2_000;

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
 * opened work on before the interaction ended normally. The prompt is still
 * queued INSIDE the runtime, so it will be answered at the start of the next
 * turn — requeuing the row would run it twice. With `mode: "immediate"` the
 * runtime drains every pushed prompt before it idles, so this is a defensive
 * fallback rather than a routine outcome.
 */
export const STEERED_ROW_MERGED_NOTE =
  '_(This message was delivered while the previous turn was still running; the reply continues in '
  + 'the next turn.)_';

/** The provider name in the at-most-once settle failure wording. */
const SETTLE_AGENT_LABEL = 'Copilot';

/**
 * The `trigger` reported to `POST /api/continuation-turn`, matching the value
 * the Claude worker sends so the relay's `CONTINUATION … trigger=` log line and
 * any future per-trigger handling read the same for both engines.
 */
export const CONTINUATION_TRIGGER = 'background_task';

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

/**
 * The attempt-fencing echo for a row's write bodies. Every publish that names
 * a `messageId` also names the attempt it belongs to, so the relay can refuse
 * writes from a superseded attempt (a requeued row re-delivered elsewhere).
 * Omitted entirely when the row carries no attempt id (a pre-fencing relay).
 */
function attemptFields(message) {
  return message?.attemptId ? { attemptId: message.attemptId } : {};
}

/** A 409 whose detail names `stale_attempt`: this attempt was superseded. */
function isStaleAttemptError(error) {
  if (Number(error?.status) !== 409) return false;
  const detail = typeof error?.detail === 'string' ? error.detail : JSON.stringify(error?.detail || '');
  return detail.includes('stale_attempt');
}

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
  // "immediate", always (fake-provider probe against runtime 1.0.88,
  // 2026-09-25). Mid-turn it is a real steer: injected at the next tool
  // boundary as `user.message{delivery:"steering"}` (or, when the model is
  // mid-stream, moved to the FRONT of the queue and run right after as
  // `delivery:"queued"`). When the main loop is idle both modes start a run at
  // once — except that an "enqueue" message sent while a background agent or
  // an attached shell keeps `session.idle` deferred sits FROZEN until that
  // work ends, while an "immediate" one runs immediately. So immediate is the
  // only mode that never strands a message behind background work.
  resolveSendModeImpl = () => 'immediate',
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
  // How long a `deferred: true` model switch may wait for its
  // `session.model_change` drain before the explicit selection counts as
  // unconfirmed and fails the row (`COPILOT_SDK_RELAY_MODEL_SWITCH_TIMEOUT_MS`).
  modelSwitchTimeoutMs = DEFAULT_MODEL_SWITCH_TIMEOUT_MS,
  // How long live detached shells alone may keep the runtime up (0 = no
  // limit). Read through a getter, like the Claude worker's
  // `getBackgroundTaskTimeoutMs`, so a future settings push can move it without
  // a worker restart.
  getBackgroundTaskTimeoutMs = () => DEFAULT_BACKGROUND_TASK_TIMEOUT_MS,
  continuationGraceMs = DEFAULT_CONTINUATION_GRACE_MS,
  continuationRetryDelayMs = DEFAULT_CONTINUATION_RETRY_DELAY_MS,
  // How long a settled continuation waits for its row before giving up on it.
  // Must outlast the registration's own retries; a test shortens it.
  continuationRegistrationTimeoutMs = CONTINUATION_REGISTRATION_TIMEOUT_MS,
  compactionStaleMs = DEFAULT_COMPACTION_STALE_MS,
  settleRetryDelaysMs = DEFAULT_SETTLE_RETRY_DELAYS_MS,
  maxTerminalSettleAttempts = DEFAULT_MAX_TERMINAL_SETTLE_ATTEMPTS,
  queueLaneRefreshMs = DEFAULT_QUEUE_LANE_REFRESH_MS,
  orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS,
  // Called with `true`/`false` whenever the runner flips between accepting
  // deliveries and holding them (see isDeliveryHeld). The worker wires it to
  // the socket link: a hold withdraws the relay's readiness, and its end
  // re-arms it at once so a held message steers into the resumed turn.
  onDeliveryReadinessChange = () => {},
  // False while the connected relay does not understand the `steering-held`
  // hand-back (a worker updated on disk before the relay restarted): a held
  // delivery is then pushed the legacy way instead of being handed back into
  // a retry-and-backoff requeue.
  canHandBackHeldDelivery = () => true,
  dbg = () => {},
} = {}) {
  let client = null;
  let session = null;
  let sdkPaths = null;
  // The single owner of "what model/effort is the live session CONFIRMED to be
  // on" (audit #9/#13): tracks the last confirmed pair, caches the per-session
  // model catalog for effort validation, and observes `session.model_change`
  // drains for deferred switches. `appliedModel()` is the runner-side read.
  const modelSwitch = createCopilotModelSwitcher({ switchTimeoutMs: modelSwitchTimeoutMs, dbg });
  const appliedModel = () => modelSwitch.current().model;
  let activeTurn = null;
  // Turns that have SETTLED but whose relay publishes have not all landed yet.
  // Ownership of a turn is split in two: `activeTurn` is runtime-EVENT
  // ownership (which turn the session callback feeds), this set is QUEUE-ROW
  // ownership (which rows the heartbeat must keep claiming and the crash guard
  // must requeue). The split exists because the runtime does not wait for the
  // relay: a fast follow-on continuation can open, run and terminate while the
  // previous turn's `/api/response` is still in flight, and holding the event
  // stream hostage to that POST is exactly how a whole continuation vanished
  // (audit #5). A Set, not a slot: the follow-on turn's own publish can block
  // too, so several turns can be publishing at once.
  const publishingTurns = new Set();
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
  // The last catalog content this worker POSTed to `/api/models/snapshot`,
  // as a serialized signature. Identity of CONTENT, not of session: an idle
  // shutdown and resume onto the same catalog must not re-publish it.
  let lastModelSnapshotSignature = '';
  // The in-flight snapshot POST — a chain like `usagePostChain`, and equally a
  // test seam only: the turn path never awaits a snapshot.
  let modelSnapshotChain = Promise.resolve();
  let starting = null;
  let disposed = false;
  let detachRuntimeExit = () => {};
  // A compaction in progress (`session.compaction_start` seen, no `_complete`
  // yet). Holds steering: a message pushed now would land inside the
  // compaction's replay. `compactingSince` backs the stale cap.
  let compactingSince = 0;
  // The last readiness value reported to `onDeliveryReadinessChange`, so the
  // link only hears about flips.
  let lastReportedDeliveryReady = null;
  // Rows whose prompt the runtime consumed and whose settle marker is being
  // saved (id → { message, variant }). Reported by the heartbeat WITH a
  // terminal error until the publish lands, so recovery can never re-run them
  // (see publishSettleMarker).
  const settlingMessages = new Map();
  // Settle markers that could not be posted even terminally; the heartbeat
  // hands them to the relay to fail (id → terminalError).
  const settleFailedTerminals = new Map();
  // Per-row chains of `/api/queue-consumed` POSTs, so a mark and a later
  // un-mark for the same row reach the relay in order.
  const consumedMarkChains = new Map();
  // The runtime's queued lane as last read from `rpc.queue.pendingItems`:
  // runtime message id → stable queue item id. What un-steer needs, and what
  // decides which pushed rows the client may still cancel.
  let queuedLane = new Map();
  let queueLaneTimer = null;
  let queueLaneRefreshChain = Promise.resolve();
  // Whether the session's `rpc.queue` / `rpc.interruptMainTurn` are present.
  // Probed per session (the runtime auto-updates under the relay and every
  // one of these is @experimental); a missing surface degrades to today's
  // behaviour, never to an error.
  let sessionRpc = { queue: false, interruptMainTurn: false };
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
  // Drops the history a `session.resume` replays through the live callback, so
  // a two-day-old `assistant.message` can never mint a continuation row.
  const replayGate = createReplayGate();
  // The detached shells this session has running. The lifecycle's pin, and the
  // reason a settled one is worth waiting for.
  const backgroundShells = createBackgroundShellTracker();
  // When a shell settled and the continuation it should trigger has not opened
  // yet. Holds the runtime for `continuationGraceMs`; cleared by the
  // continuation opening, or by the grace expiring on a runtime that decided it
  // had nothing to say.
  let continuationDueSince = 0;
  // Transcript lines produced between turns (a settled shell's notification).
  // They belong to the turn they trigger, so they are carried into it rather
  // than dropped — the same trade the Claude worker's `pendingActivities`
  // makes.
  let pendingActivities = [];
  // The relay mode of the last delivered turn. A self-initiated turn has no
  // delivery to read a mode off, and it is a continuation OF that turn's work,
  // so it inherits it — which is what keeps the permission handler and the
  // plan-board gating behaving the same either side of a background wait.
  let lastRelayMode = 'agent';

  async function whileAwaitingHuman(run) {
    pendingHumanRequests += 1;
    // An open card holds steering: the relay's readiness is withdrawn at once.
    syncDeliveryReadiness();
    try {
      return await run();
    } finally {
      pendingHumanRequests -= 1;
      // The clock restarts from the answer, not from before the wait.
      touch();
      activeTurn?.armStall?.();
      // The answer re-arms the relay immediately, so a message queued while
      // the card was open steers into the resumed turn within one round trip.
      syncDeliveryReadiness();
    }
  }

  /**
   * Hold an interactive callback until the active turn's queue row exists.
   *
   * A continuation becomes the active turn synchronously but gets its row
   * asynchronously, and the runtime can block on `user_input.requested` (or an
   * ask-mode approval) in that gap — the question bridge would then see no
   * active message and degrade to an unsupported answer / local rejection for
   * a card that was milliseconds from having a real row id. Bounded by the
   * registration timeout (the registration itself can hang on a dead relay);
   * on expiry — or on a registration that gave up (`rowReady` → false) — the
   * caller proceeds and degrades exactly as before. Delivered turns are
   * registered from birth and skip straight through.
   */
  async function awaitInteractiveRow() {
    const turn = activeTurn;
    if (!turn || turn.registered || !turn.rowReady) return;
    let timer = null;
    await Promise.race([
      turn.rowReady,
      new Promise((resolve) => {
        timer = setTimeout(resolve, continuationRegistrationTimeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  // The relay question bridge serves `ask_user` and (in ask mode) tool
  // approvals. `getActiveMessage` must resolve to the row that is CURRENTLY
  // `processing`, because `/api/relay-question` 409s otherwise.
  const questionBridge = createQuestionBridgeImpl({
    api,
    sdkSessionId,
    // A continuation's message has no `id` until its synthetic row is
    // registered; posting a card against a null id would 409. Reporting "no
    // active message" instead lets the bridge take its own degraded path.
    getActiveMessage: () => (activeTurn?.message?.id ? activeTurn.message : null),
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

  /**
   * A turn's terminal event ends its runtime-event ownership IMMEDIATELY, while
   * queue-row ownership persists until every publish has landed.
   *
   * Called from `settle`/`fail`, so it runs the instant the terminator is
   * dispatched: from here on `routeEvent` sees no active turn and a genuinely
   * new event can open the next continuation — it must not wait out a blocked
   * `/api/response`. The row itself stays owned (heartbeat lease, crash-guard
   * requeue) via `publishingTurns` until `releaseTurnOwnership`.
   */
  function beginPublishing(turn) {
    publishingTurns.add(turn);
    if (activeTurn === turn) activeTurn = null;
  }

  /**
   * Every publish for the turn has landed (or terminally failed); nothing owns
   * its rows any more. Guarded on identity: by the time a publish window
   * closes, `activeTurn` may already belong to a NEWER turn, and clearing it
   * unconditionally would strip that turn's heartbeat ownership mid-flight.
   */
  function releaseTurnOwnership(turn) {
    publishingTurns.delete(turn);
    if (activeTurn === turn) activeTurn = null;
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
      ...attemptFields(message),
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
        ...attemptFields(message),
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
      await emitAction(turn, {
        channel: 'subagent',
        payload: {
          subagentRunId: run.subagentRunId,
          parentSubagentId: null,
          displayName: run.displayName,
          status: 'failed',
        },
      });
    }
  }

  /**
   * Publish an action onto the row that owns the runtime's current run, or
   * hold it if the turn has no queue row yet.
   *
   * The single gate every producer goes through. A continuation's row is
   * created asynchronously, and a POST carrying `messageId: null` is not merely
   * useless — the relay's activity/stream routes key on it, so it would be
   * attributed to nothing at all.
   *
   * One turn can answer several rows in sequence (the primary, then a message
   * pushed mid-turn that the runtime ran as its own `delivery:"queued"` run).
   * Root-level traffic — stream, thoughts, activity, subagent lanes — goes to
   * whichever row owns the run in progress (`turn.currentOwner`); the stream
   * text is re-cut to that row's own segments so a second run's prose never
   * appears under the first row.
   */
  async function emitAction(turn, action) {
    if (!turn.registered) {
      turn.bufferedActions.push(action);
      return;
    }
    await dispatchOwned(turn, action);
  }

  async function dispatchOwned(turn, action) {
    const owner = turn.currentOwner || turn.primaryEntry;
    if (!owner || owner.settled) {
      // Nothing left to publish into (every row this turn owned has settled);
      // the text still lands in the runtime's own transcript.
      return;
    }
    if (action.channel === 'stream' && !action.payload?.subagentRunId) {
      // Re-cut to the owner's own segments, and gated against what THAT row
      // last received (the normalizer gated against the whole interaction).
      const text = textFor(turn, owner);
      if (!shouldEmitStreamUpdate(text, owner.state.lastStreamedText)) return;
      await dispatchAction(owner.message, { channel: 'stream', payload: { ...action.payload, text } }, owner.state);
      return;
    }
    await dispatchAction(owner.message, action, owner.state);
  }

  /**
   * Which row a normalizer segment's text belongs to. A segment nobody
   * claimed (text produced before any prompt boundary — the answer to a
   * prompt carried over from a previous interaction, or a turn the runtime
   * answered without echoing a `user.message` at all) belongs to the next
   * claimed segment's row, failing that to the turn's own row.
   */
  function segmentOwner(turn, index) {
    const owners = turn.segmentOwners;
    if (owners[index]) return owners[index];
    for (let j = index + 1; j < owners.length; j += 1) {
      if (owners[j]) return owners[j];
    }
    return turn.primaryEntry;
  }

  function textFor(turn, entry, segmentTexts = null) {
    const count = Math.max(turn.normalizer.promptCount(), turn.segmentOwners.length);
    const parts = [];
    for (let index = 0; index < count; index += 1) {
      if (segmentOwner(turn, index) !== entry) continue;
      const text = String(segmentTexts?.[index] ?? turn.normalizer.segmentText(index) ?? '');
      if (text.trim()) parts.push(text);
    }
    return parts.join('\n\n');
  }

  /**
   * The final reply text for `entry`: its segments, with the task-completion
   * summary taking precedence on the last one (the normalizer's
   * `result.segmentTexts` already applies that rule; before this the runner
   * read `segmentText` directly and lost the summary — the "Cha…" fragment
   * case of 2026-09-12). A turn that opened no segment at all falls back to
   * the whole composed text for its own row, which is strictly better than
   * publishing nothing.
   */
  function finalTextFor(turn, entry, result) {
    const segmentTexts = Array.isArray(result?.segmentTexts) ? result.segmentTexts : null;
    const text = textFor(turn, entry, segmentTexts).trim();
    if (text || entry !== turn.primaryEntry) return text;
    return String(result?.text || entry.state.lastStreamedText || '').trim();
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
   * Publish a row's outcome. Returns 'published' | 'stale' | 'failed' |
   * 'requeued' so the settle paths can tell a landed marker from a lost one.
   *
   * `kind` ('folded' | 'stopped') stamps the settle stubs of a steered row the
   * runtime consumed without answering on its own row; `consumedSteerIds`
   * names the steers folded into the turn this response finishes, so the
   * relay marks them consumed in the same fenced write. A response carrying a
   * kind is never requeued on failure (the prompt was consumed — re-running it
   * is the one thing that must not happen); `requeueOnFailure: false` opts an
   * ordinary response out of the requeue too.
   */
  async function publishResponse(message, {
    text, model, terminalError = null, modelOrigin, kind = null, consumedSteerIds = null,
    requeueOnFailure = true,
  }) {
    const consumed = Array.isArray(consumedSteerIds)
      ? consumedSteerIds
        .map((entry) => ({ id: String(entry?.id || '').trim(), attemptId: entry?.attemptId || null }))
        .filter((entry) => entry.id)
      : [];
    try {
      await api('POST', '/api/response', {
        messageId: message.id,
        conversationId: message.conversationId,
        text: String(text || ''),
        model: model || null,
        modelOrigin: modelOrigin
          || (String(message?.model || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual'),
        ...(terminalError ? { terminalError } : {}),
        ...(kind ? { kind } : {}),
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
      if (kind || !requeueOnFailure) return 'failed';
      const requeued = await api('POST', '/api/requeue', { messageId: message.id, ...attemptFields(message) })
        .then(() => true, () => false);
      return requeued ? 'requeued' : 'failed';
    }
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

  // ------------------------------------------------- at-most-once settling --

  /**
   * Claim a consumed row as settling — synchronously, BEFORE anything stops
   * reporting it as live, so no heartbeat can see it unowned. `variant` picks
   * the terminal wording should its settle never land.
   */
  function claimSettling(message, variant = 'folded') {
    const id = String(message?.id || '').trim();
    if (id && !settlingMessages.has(id)) settlingMessages.set(id, { message, variant });
  }

  /** Release a settled row — unless it was handed to the relay to fail. */
  function releaseSettling(id) {
    const key = String(id || '').trim();
    if (!settleFailedTerminals.has(key)) settlingMessages.delete(key);
  }

  /**
   * Mark rows whose prompt the runtime has folded into a running turn as
   * consumed on the relay (the moment `user.message{delivery:"steering"}`
   * confirms it). Best-effort: the worker's own settle still owns these rows
   * while it lives; the mark only protects them when it does not — a crash
   * before the settle marker lands must fail the row, never re-run it.
   */
  function markConsumed(conversationId, entries = [], { consumed = true } = {}) {
    const rows = entries
      .map((entry) => ({ id: String(entry?.id || '').trim(), attemptId: entry?.attemptId || null }))
      .filter((entry) => entry.id);
    if (!rows.length) return Promise.resolve();
    const previous = Promise.allSettled(rows.map((row) => consumedMarkChains.get(row.id)).filter(Boolean));
    const post = previous.then(() => api('POST', '/api/queue-consumed', {
      conversationId: String(conversationId || sdkSessionId || ''),
      entries: rows,
      ...(consumed ? {} : { consumed: false }),
    })).catch((error) => {
      dbg('consumed mark failed', rows.map((entry) => entry.id).join(','), error?.message || String(error));
    });
    for (const row of rows) consumedMarkChains.set(row.id, post);
    post.then(() => {
      for (const row of rows) if (consumedMarkChains.get(row.id) === post) consumedMarkChains.delete(row.id);
    });
    return post;
  }

  /** Heartbeat payload: rows whose terminal failure the relay must post. */
  function getSettleFailed() {
    return [...settleFailedTerminals.entries()].map(([id, terminalError]) => ({
      id,
      attemptId: settlingMessages.get(id)?.message?.attemptId || null,
      terminalError,
    }));
  }

  function acknowledgeSettleFailed(ids = []) {
    for (const id of ids) {
      const key = String(id || '').trim();
      if (!settleFailedTerminals.delete(key)) continue;
      settlingMessages.delete(key);
    }
  }

  const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

  /**
   * Save the settle marker of a steered message the runtime already consumed
   * — at most once. The row stays in `settlingMessages`, and so in every
   * heartbeat, until the relay commits the marker. A marker that cannot be
   * saved within the retry budget ends as a terminal failure — never a
   * requeue — and if even that cannot be posted, the heartbeat hands the row
   * to the relay to fail. Ported from the Claude worker; same guarantees.
   */
  async function publishSettleMarker(message, { text, model, kind, variant = 'folded' }) {
    const id = String(message?.id || '').trim();
    if (!id) return;
    claimSettling(message, variant);
    try {
      for (let attempt = 0; ; attempt += 1) {
        const outcome = await publishResponse(message, { text, model, kind });
        if (outcome !== 'failed') return;
        if (attempt >= settleRetryDelaysMs.length) break;
        await sleep(settleRetryDelaysMs[attempt]);
      }
      dbg('settle marker could not be saved; failing the row terminally', id);
      const terminalError = buildSteerSettleFailure(message, { variant, agentLabel: SETTLE_AGENT_LABEL });
      const retryMs = Math.max(100, Number(settleRetryDelaysMs.at(-1)) || 0);
      for (let attempt = 0; attempt < Math.max(1, maxTerminalSettleAttempts); attempt += 1) {
        if (attempt) await sleep(retryMs);
        const outcome = await publishResponse(message, {
          text: terminalError.message,
          model,
          terminalError,
          requeueOnFailure: false,
        });
        if (outcome !== 'failed') return;
        // Second channel: the requeue route fails a row outright when handed
        // a terminal error.
        const failedViaRequeue = await api('POST', '/api/requeue', {
          messageId: id,
          terminalError,
          ...attemptFields(message),
        }).then(() => true, (error) => isStaleAttemptError(error));
        if (failedViaRequeue) return;
      }
      dbg('terminal settle could not be posted; handing it to the heartbeat', id);
      settleFailedTerminals.set(id, terminalError);
    } finally {
      releaseSettling(id);
    }
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
      model: result?.model || appliedModel() || defaultModel || '',
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

  /**
   * Publish the session's model catalog to `/api/models/snapshot` (Phase 5A:
   * with the extension retired, worker snapshots and the server-side discovery
   * service are what keep the relay's catalog populated).
   *
   * Fire-and-forget on a chain, exactly like `postTurnUsage`: a catalog is
   * never worth a millisecond of a turn, and the failure mode is "the relay
   * keeps its previous catalog" — swallowed after a debug line. The entries
   * come from the switcher's cached per-session `rpc.model.list()`, so the
   * common case adds zero RPCs; an unchanged catalog is deduped by content
   * signature rather than re-POSTed on every resume.
   *
   * BYOK sessions never publish: their list is the OpenAI-compatible
   * endpoint's per-key lineup, not the Copilot catalog, and a snapshot from
   * one would overwrite the relay-wide picker with it.
   */
  function publishModelSnapshot(reason) {
    if (byokProvider || !session) return;
    const target = session;
    modelSnapshotChain = modelSnapshotChain
      .then(async () => {
        const entries = await modelSwitch.catalogEntries(target);
        const descriptors = extractModelDescriptors(entries);
        // An empty list is the runtime refusing to answer, not an empty
        // catalog — publishing it would only blank the pickers' metadata.
        if (!descriptors.length) return;
        // The shared builder decides every per-model metadata field (vendor,
        // picker category, real context window, the runtime's own effort
        // list, ...) so this raw-CAPI list and the discovery service's typed
        // list publish identical metadata for the same model.
        const { models, contextLimitsByModel, modelMetadataByModel } = buildModelSnapshotFields(descriptors);
        const currentModel = appliedModel() || defaultModel || null;
        const payload = {
          // Same field set the extension and the standalone relay publish;
          // the route reads exactly these seven keys and nothing else.
          source: `copilot-sdk-worker:${reason}`,
          models,
          contextLimitsByModel,
          modelMetadataByModel,
          currentModel,
          defaultModel: currentModel || models[0] || null,
          error: null,
        };
        const signature = JSON.stringify([models, contextLimitsByModel, modelMetadataByModel, currentModel]);
        if (signature === lastModelSnapshotSignature) return;
        await api('POST', '/api/models/snapshot', payload);
        // Recorded only after the POST lands, so a transient relay failure
        // retries on the next trigger instead of being deduped away.
        lastModelSnapshotSignature = signature;
        dbg('model snapshot published', reason, `models=${models.length}`, `current=${currentModel || 'unknown'}`);
      })
      .catch((error) => { dbg('model snapshot publish failed', reason, error?.message || String(error)); });
  }

  // ---------------------------------------------------------------- session --

  function routeEvent(event) {
    // A replayed event is history the relay already has. It must not touch the
    // idle clock, the shell set, an active turn's normalizer, or — the reason
    // this gate exists at all — open a continuation row for work that finished
    // days ago.
    if (replayGate.isReplay(event)) {
      dbg('dropping a replayed event', String(event?.type || ''), String(event?.timestamp || ''));
      return;
    }
    touch();
    observeBackgroundShells(event);
    observeCompaction(event);
    observeQueueLane(event);
    // A background subagent's spawn emits a SESSION-level
    // `session.model_change{source:"agent"}` for the subagent's own model
    // (live-probed on 1.0.88). It is not the main thread's model: feeding it
    // to the switcher would confirm a pending switch with the wrong model and
    // move the catalog's currentModel.
    const agentModelChange = event?.type === 'session.model_change'
      && String(event?.data?.source || '').trim().toLowerCase() === 'agent';
    if (!agentModelChange) {
      // Keeps the confirmed-model tracking truthful for switches this worker
      // did not ask for, and resolves the bounded wait on a deferred switch's
      // drain. Behind the replay gate on purpose: a historical
      // `session.model_change` must not confirm a pending switch.
      modelSwitch.observeEvent(event);
      // A LIVE model change moves the catalog's currentModel; replays cannot
      // get here (the gate above), so this cannot re-publish days-old state.
      if (event?.type === 'session.model_change') publishModelSnapshot('model-change');
    }
    let turn = activeTurn;
    if (!turn) {
      // A prompt this worker pushed whose run the runtime opened after its
      // turn had already settled is that row's own turn, not a continuation.
      turn = adoptOrphanedRun(event);
    }
    if (!turn) {
      // The runtime started work with no row open. Anything that is not the
      // START of work (terminators, connection bookkeeping) stays a no-op:
      // opening a row for one would leave a synthetic turn in the transcript
      // that only the stall watchdog could close.
      if (!isContinuationOpeningEvent(event)) return;
      turn = openContinuationTurn();
    }
    // The owner is captured HERE, synchronously, but settlement happens later
    // on the dispatch chain — so an event can be captured to a turn that is
    // settled by the time its link runs. `handleTurnEvent`'s settled guard
    // re-routes such an event (in arrival order, on the same chain) to
    // whatever now owns the stream, opening a continuation if the event is an
    // opener. A settled turn that is still publishing holds only its QUEUE
    // rows (`publishingTurns`); it never holds the event stream.
    dispatchChain = dispatchChain
      .then(() => handleTurnEvent(turn, event))
      .catch((error) => { dbg('event dispatch failed', error?.message || String(error)); });
  }

  /**
   * Keep the detached-shell set current and note when one settles.
   *
   * Runs for every live event, in or out of a turn: shells are OPENED inside a
   * delivered turn (that is where the model calls `bash`) and SETTLE outside
   * one, which is the whole asymmetry this fix exists for.
   */
  /**
   * Mirror the live detached-shell set into the relay's background-tasks
   * panel (REPLACE semantics, the same route the Claude worker publishes on),
   * so a runaway `npm test` in a detached shell is visible as a card instead
   * of only as tool rows. `stoppable: false` because the runtime exposes no
   * host-side shell stop (`stop_bash` is a tool the MODEL calls) — see
   * backgroundWorkHoldsRuntime. Advisory: a failed post never disturbs events.
   */
  function publishBackgroundShellTasks() {
    const tasks = backgroundShells.live().map((shell) => ({
      taskId: shell.shellId,
      taskType: 'local_bash',
      description: shell.description || 'Detached shell',
      startedAt: shell.startedAt || null,
      stoppable: false,
    }));
    api('POST', '/api/background-tasks', { conversationId: sdkSessionId, tasks })
      .catch((error) => dbg('background task publish failed', error?.message || String(error)));
  }

  /**
   * The compaction hold. A message pushed while the runtime is compacting
   * would be injected into the compaction's replay, so steering is held from
   * `session.compaction_start` to `_complete` (the runtime queues messages
   * sent during a compaction itself, but holding them relay-side keeps the
   * bubble cancellable and the composer truthful — the Claude rule).
   */
  function observeCompaction(event) {
    const type = String(event?.type || '');
    if (event?.agentId) return;
    if (type === 'session.compaction_start') {
      compactingSince = Date.now();
      syncDeliveryReadiness();
    } else if (type === 'session.compaction_complete') {
      compactingSince = 0;
      syncDeliveryReadiness();
    }
  }

  function isCompacting() {
    if (!compactingSince) return false;
    if (Date.now() - compactingSince < compactionStaleMs) return true;
    dbg('compaction hold went stale; releasing it');
    compactingSince = 0;
    return false;
  }

  /**
   * Keep `queuedLane` current. `pending_messages.modified` carries no payload
   * (it only says "the queue changed"), so it schedules a debounced
   * `rpc.queue.pendingItems()` read. What matters here is which pushed rows
   * are still in the QUEUED lane: those the runtime has not consumed and the
   * client may still cancel (`cancellableIds` on the steering snapshot).
   */
  function observeQueueLane(event) {
    if (String(event?.type || '') !== 'pending_messages.modified') return;
    scheduleQueueLaneRefresh();
  }

  function scheduleQueueLaneRefresh() {
    if (!sessionRpc.queue || queueLaneTimer) return;
    queueLaneTimer = setTimeout(() => {
      queueLaneTimer = null;
      queueLaneRefreshChain = queueLaneRefreshChain.then(() => refreshQueueLane()).catch(() => {});
    }, queueLaneRefreshMs);
    queueLaneTimer.unref?.();
  }

  async function refreshQueueLane() {
    const target = session;
    if (!target || !sessionRpc.queue) return;
    try {
      const snapshot = await target.rpc.queue.pendingItems();
      const next = new Map();
      for (const item of Array.isArray(snapshot?.items) ? snapshot.items : []) {
        const runtimeId = String(item?.messageId || '').trim();
        const itemId = String(item?.id || '').trim();
        if (runtimeId && itemId) next.set(runtimeId, itemId);
      }
      if (session !== target) return;
      queuedLane = next;
    } catch (error) {
      dbg('queue.pendingItems failed', error?.message || String(error));
    }
  }

  /** Probe the experimental RPC surfaces once per session. */
  function probeSessionRpc(target) {
    sessionRpc = {
      queue: typeof target?.rpc?.queue?.pendingItems === 'function'
        && typeof target?.rpc?.queue?.removeAt === 'function',
      interruptMainTurn: typeof target?.rpc?.interruptMainTurn === 'function',
    };
    dbg(`copilot session rpc surfaces: queue=${sessionRpc.queue} interruptMainTurn=${sessionRpc.interruptMainTurn}`);
  }

  function observeBackgroundShells(event) {
    let changed;
    try {
      changed = backgroundShells.observe(event);
    } catch (error) {
      dbg('background shell tracking failed', String(event?.type || ''), error?.message || String(error));
      return;
    }
    if (changed.opened.length || changed.settled.length) publishBackgroundShellTasks();
    for (const shell of changed.opened) {
      dbg('detached shell started', shell.shellId, shell.description || '(no description)');
    }
    for (const shell of changed.settled) {
      dbg('detached shell settled', shell.shellId);
      const note = describeSettledShell(shell);
      // Only carried when there is no turn to publish into: inside a turn the
      // normalizer already narrates the `read_bash` that reads the output. A
      // settled turn mid-publish does NOT count as a turn here — its row is
      // closed to new lines, so the note belongs to the continuation this
      // notification is about to trigger.
      if (note && !activeTurn && pendingActivities.length < MAX_PENDING_ACTIVITIES) {
        pendingActivities.push(note);
      }
    }
    // Only the runtime's own `system.notification` heralds a continuation. A
    // `read_bash` that reports an exit code closes the same shell, but it
    // happens inside a turn that already knows — pinning on it would hold the
    // runtime for the grace window after every ordinary background command.
    //
    // Set even when a turn is active: the gap that matters is the one AFTER
    // that turn closes.
    if (changed.heralded) continuationDueSince = Date.now();
  }

  /**
   * A live event was captured to a turn that settled before its chain link
   * ran. It is NOT history — it belongs to whatever the runtime is doing now:
   * an already-open successor turn, or a continuation this very event should
   * open. Runs on the dispatch chain, so re-routed events keep arrival order
   * relative to everything captured after them.
   */
  async function redispatchSettledEvent(event) {
    let turn = activeTurn;
    // A settled `activeTurn` cannot happen — `settle`/`fail` release the slot
    // — but it is guarded anyway: re-routing INTO a settled turn would recurse
    // through this function forever, so it is treated as "no owner".
    if (!turn || turn.settled) {
      // Same rules as `routeEvent`: a pushed prompt's late run is its own
      // turn; otherwise only the start of work opens a row.
      turn = adoptOrphanedRun(event);
      if (!turn) {
        if (!isContinuationOpeningEvent(event)) return;
        turn = openContinuationTurn();
      }
    }
    await handleTurnEvent(turn, event);
  }

  async function handleTurnEvent(turn, event) {
    if (turn.settled) {
      await redispatchSettledEvent(event);
      return;
    }
    turn.armStall?.();
    let actions = [];
    try {
      actions = turn.normalizer.normalize(event);
    } catch (error) {
      dbg('normalize failed', String(event?.type || ''), error?.message || String(error));
      return;
    }
    // The prompt boundary: the runtime has started work on a prompt. Decides
    // which row owns the segment the normalizer just opened, and settles the
    // previous run's row when this one is a new run (see noteUserMessage).
    if (String(event?.type || '') === 'user.message' && !event?.agentId) {
      await noteUserMessage(turn, event);
    }
    for (const action of actions) {
      if (action.channel === 'result') {
        turn.result = action.payload;
        turn.settle();
        return;
      }
      // A continuation's actions buffer until its synthetic row exists; the
      // registration drains them in arrival order and only then flips
      // `registered`, so a later action can never overtake an earlier one.
      // Delivered turns are registered from birth and take the direct path.
      await emitAction(turn, action);
    }
  }

  /** Publish everything a not-yet-registered turn buffered, in order. */
  async function flushBufferedActions(turn) {
    while (turn.bufferedActions.length) {
      const batch = turn.bufferedActions.splice(0);
      for (const action of batch) {
        await dispatchOwned(turn, action).catch(() => {});
      }
    }
  }

  function buildSessionConfig(model, relayMode, reasoningEffort = null) {
    // Built once per session, not per request. Reads the mode off the LIVE turn
    // rather than closing over the one the session was built with, because one
    // session serves every turn and the user can switch modes between them.
    const decidePermission = createCopilotPermissionHandler({
      // Only the ask-mode branch actually blocks on a human; wrapping it keeps
      // the stall watchdog off a turn where someone is deciding.
      bridge: {
        askToolApproval: (permissionRequest, options) => whileAwaitingHuman(async () => {
          // An ask-mode approval raised the moment a continuation opens must
          // wait for the row its card will hang off — see `awaitInteractiveRow`.
          await awaitInteractiveRow();
          return questionBridge.askToolApproval(permissionRequest, options);
        }),
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
    // and no model-switch RPC can update them (see `applySelection`).
    const provider = resolveProviderConfigImpl({ env, model: model || defaultModel, dbg });
    byokProvider = provider;
    const effort = normalizeRelayEffort(reasoningEffort);
    return {
      // The relay session id IS the SDK session id, so the runtime's own state
      // under ~/.copilot/session-state/<id> is addressable by conversation and
      // survives worker restarts without a side table.
      sessionId: sdkSessionId,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      // BYOK only: the rebuilt config is the switch mechanism for these
      // sessions, so the effort must ride in it or a dispose+resume model
      // switch silently drops it. Hosted sessions apply effort through the
      // validated RPC path instead (`SessionConfigBase.reasoningEffort` is
      // only valid for models that support it, which cannot be checked before
      // the session exists).
      ...(provider && effort ? { reasoningEffort: effort } : {}),
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
          const { answer, wasFreeform } = await whileAwaitingHuman(async () => {
            // Same gate as the approval path: an `ask_user` fired straight
            // after a continuation opened must get the row, not a null id.
            await awaitInteractiveRow();
            return questionBridge.askUserInput(request, {
              signal: activeTurn?.abortController?.signal || null,
            });
          });
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
      // Structured elicitation (audit #17): a form-mode request with a schema
      // becomes a relay question card carrying `requestedSchema`; the relay's
      // answer route validates the submission and stores `structuredAnswer`,
      // which maps 1:1 onto the SDK's `ElicitationResult.content`. Everything
      // that cannot round-trip — url mode (a browser redirect), a missing or
      // non-object schema, a bridge without the structured surface, a timeout,
      // a closing bridge, an answer the relay could not validate — declines
      // in-band exactly as before, which lets the model continue where a hang
      // or a throw would fail the tool call silently.
      onElicitationRequest: (request) => handleElicitationRequest(request),
    };
  }

  /**
   * `onElicitationRequest` → a schema-carrying relay question card →
   * `{ action: 'accept', content }` with the validated structured answer, or
   * `{ action: 'decline' }` for everything that cannot round-trip.
   *
   * Runs under the same human-gating as `ask_user`: the stall watchdog is held
   * off while the card waits, and an elicitation raised the moment a
   * continuation opens waits for the row its card will hang off (`rowReady`)
   * instead of minting a card against a null message id.
   */
  async function handleElicitationRequest(request) {
    try {
      const mode = String(request?.mode || 'form').trim().toLowerCase();
      const schema = request?.requestedSchema;
      const hasSchema = !!schema && typeof schema === 'object' && !Array.isArray(schema)
        && !!schema.properties && typeof schema.properties === 'object';
      if (mode === 'url' || !hasSchema || typeof questionBridge.askStructured !== 'function') {
        return { action: 'decline' };
      }
      const source = String(request?.elicitationSource || '').trim();
      const message = String(request?.message || '').trim()
        || 'Copilot needs structured input to continue this turn.';
      const result = await whileAwaitingHuman(async () => {
        await awaitInteractiveRow();
        return questionBridge.askStructured({
          prompt: source ? `${message}\n\n(Requested by ${source}.)` : message,
          requestedSchema: schema,
        }, { signal: activeTurn?.abortController?.signal || null });
      });
      const content = result?.structuredAnswer;
      if (result?.timedOut || !content || typeof content !== 'object' || Array.isArray(content)) {
        return { action: 'decline' };
      }
      return { action: 'accept', content };
    } catch (error) {
      dbg('elicitation bridging failed, declining', error?.message || String(error));
      return { action: 'decline' };
    }
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
      // driveTurn tears the runtime down and publishes the failure record
      // onto every row the turn owns.
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
   * Bring the live session onto the dequeued row's (model, effort) selection.
   *
   * Hosted sessions go through `modelSwitch.apply` and its OBSERVED RPCs
   * (audit #9/#13): a selection the runtime does not confirm — a thrown
   * switchTo, a confirmation-required result, a deferred switch that never
   * drains, an unsupported effort level — THROWS the unconfirmed error, which
   * fails the row terminally before the prompt is ever sent. The common path
   * (same model, same effort) costs zero RPCs.
   *
   * BYOK sessions try the same RPCs first, but only when the freshly resolved
   * `SessionConfig.provider` block for the target model matches the one the
   * session was built with: the block carries MODEL-SPECIFIC token ceilings
   * that no RPC can update (runtime 1.0.82 has no setProvider, and the
   * registry surface is rejected alongside the singular whole-session
   * `provider`), so an in-place switch is only sufficient when the ceilings do
   * not move. A block that differs — or an RPC the runtime rejects — falls
   * back to the dispose+resume rebuild, which carries the effort in the
   * rebuilt config. Nothing is lost either way: the relay session id IS the
   * SDK session id, so the rebuild takes the ordinary resume path.
   */
  async function applySelection(model, effort, relayMode) {
    if (!byokProvider) {
      await modelSwitch.apply(session, { model, effort, byok: false });
      return session;
    }
    const nextProvider = resolveProviderConfigImpl({ env, model: model || defaultModel, dbg });
    const ceilingsMatch = JSON.stringify(nextProvider) === JSON.stringify(byokProvider);
    if (ceilingsMatch) {
      const attempt = await modelSwitch.apply(session, { model, effort, byok: true });
      if (attempt.ok) return session;
      dbg('BYOK model RPC not honoured, rebuilding the session', model, attempt.detail || '');
    } else {
      dbg('BYOK ceilings differ for the target model; rebuilding the session', model);
    }
    return rebuildByokSession(model, effort, relayMode);
  }

  /**
   * Dispose the BYOK session and rebuild it with freshly resolved ceilings —
   * the switch mechanism of last resort for a session whose
   * `SessionConfig.provider` is immutable. The rebuilt config carries the
   * requested model AND effort, and the resumed session is trusted to be on
   * them by construction (`ProviderConfig.modelId` falls back to
   * `SessionConfig.model`), so this path never re-enters the RPC attempt —
   * which is also what makes it terminate: RPC refusal → rebuild → done.
   */
  async function rebuildByokSession(model, effort, relayMode) {
    dbg('rebuilding the copilot session for a BYOK model/effort switch', model);
    const closing = session;
    session = null;
    modelSwitch.reset();
    // Disconnect first so the runtime is not holding two handles on one
    // session id while the resume runs.
    try { await closing?.disconnect?.(); } catch (error) {
      dbg('session disconnect before model switch failed', error?.message || String(error));
    }
    return ensureSession(model, effort, relayMode);
  }

  async function ensureSession(model, effort, relayMode) {
    await ensureClient();
    if (!session) {
      const config = buildSessionConfig(model, relayMode, effort);
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
      // Which experimental surfaces THIS runtime has (it auto-updates under
      // the relay): decides un-steer and the targeted Stop for the session.
      probeSessionRpc(session);
      scheduleQueueLaneRefresh();
      if (resumed && !byokProvider) {
        // A resumed HOSTED session keeps whatever model it was created with —
        // `config.model` is not guaranteed to be honoured on resume — so the
        // selection is applied explicitly (and observably) rather than
        // assumed. Assuming it is what made a mismatch permanent: the tracked
        // model would already equal the request, so the per-turn switch below
        // could never fire.
        modelSwitch.reset();
        await modelSwitch.apply(session, { model, effort, byok: false });
      } else {
        // A created session is on `config.model` by construction; a resumed
        // BYOK session is trusted the same way because `config.model` feeds
        // `ProviderConfig.modelId` — and an RPC attempt here would recurse
        // through the rebuild path that just built this config.
        modelSwitch.noteApplied(model || '', byokProvider ? effort : null);
        if (!byokProvider) {
          // A hosted CREATE carries no effort in the config (the field is only
          // valid for models that support it, unknowable pre-session), so an
          // explicit level on the conversation's first turn still goes through
          // the validated effort-only RPC. `null` effort is a no-op here.
          await modelSwitch.apply(session, { model, effort, byok: false });
        }
      }
      // The freshly (re)built session is the first chance to see the runtime's
      // catalog — publish it so a restarted relay repopulates without waiting
      // for a model switch. Off the turn's critical path (fire-and-forget) and
      // deduped, so an unchanged catalog on every resume costs one list() and
      // no POST.
      publishModelSnapshot(resumed ? 'session-resume' : 'session-start');
      return session;
    }
    return applySelection(model, effort, relayMode);
  }

  async function stopRuntime(reason) {
    stopLifecycleTimer();
    try { detachRuntimeExit(); } catch { /* the observer is best-effort */ }
    detachRuntimeExit = () => {};
    const closingSession = session;
    const closingClient = client;
    session = null;
    client = null;
    modelSwitch.reset();
    // Detached shells are children of the runtime process, so stopping it ends
    // them: the tracked set is state about a process that no longer exists and
    // must not pin the next one. The replay gate is reset for the same reason —
    // the next connection resumes and arms its own window.
    if (backgroundShells.size()) {
      backgroundShells.reset();
      // The shells died with the runtime; clear their panel cards too.
      publishBackgroundShellTasks();
    }
    replayGate.reset();
    continuationDueSince = 0;
    pendingActivities = [];
    compactingSince = 0;
    queuedLane = new Map();
    sessionRpc = { queue: false, interruptMainTurn: false };
    syncDeliveryReadiness();
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

  /**
   * Whether background work is holding the runtime open.
   *
   * `stopRuntime` ends the CLI runtime process, and a detached shell is a child
   * of it — so stopping while one is live does not merely postpone the
   * continuation, it KILLS the command. The live capture's 1-minute timer
   * survived only because it was shorter than the 10-minute idle window; a
   * 15-minute one would have been silently destroyed.
   *
   * Two holds, both bounded:
   *
   *  - a settled shell whose continuation has not opened yet
   *    (`continuationGraceMs`), because the runtime is about to re-invoke the
   *    model and closing it in that gap loses the reply;
   *  - live shells, until `getBackgroundTaskTimeoutMs()` (0 = no limit). On
   *    expiry the shells are FORGOTTEN rather than stopped: unlike the Claude
   *    SDK, runtime 1.0.82 exposes no way to stop a shell from the host side
   *    (`stop_bash` is a tool the *model* calls), so the honest choice is to
   *    stop pretending they will report back and let the runtime — and with it
   *    the shells — go. Logged, because it means a command was cut short.
   */
  function backgroundWorkHoldsRuntime() {
    const now = Date.now();
    if (continuationDueSince) {
      if (now - continuationDueSince < continuationGraceMs) return true;
      // The runtime notified and then decided it had nothing to say. Stop
      // pinning; this is the Claude worker's `notificationGraceMs` backstop.
      dbg('continuation grace expired with no continuation turn');
      continuationDueSince = 0;
    }
    if (!backgroundShells.size()) return false;
    const capMs = Number(getBackgroundTaskTimeoutMs()) || 0;
    let expiredAny = false;
    for (const shell of backgroundShells.expireOlderThan(capMs)) {
      expiredAny = true;
      dbg(
        'background shell cap reached; it no longer holds the runtime open',
        shell.shellId,
        shell.description || '(no description)',
      );
    }
    if (expiredAny) publishBackgroundShellTasks();
    return backgroundShells.size() > 0;
  }

  function evaluateLifecycle() {
    // A pending question card means a human is mid-answer; tearing the runtime
    // down under them would discard the session the answer belongs to. A turn
    // that is still publishing counts too: it settled, but its rows are live.
    if (disposed || activeTurn || publishingTurns.size > 0 || pendingHumanRequests > 0 || !client) return;
    if (!(idleShutdownMs > 0)) return;
    // Evaluated before the idle clock so the caps still expire on a runtime
    // that has been quiet far longer than the idle window.
    if (backgroundWorkHoldsRuntime()) return;
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

  /**
   * A queue row this turn owes an answer.
   *
   * `role`: 'primary' (the delivered row that opened the turn), 'steer' (a row
   * delivered mid-turn and pushed into the same runtime interaction) or
   * 'self' (the synthetic row of a self-initiated turn). An entry is owned —
   * heartbeat-claimed, crash-guard-requeued — from creation until `released`.
   */
  function createEntry(turn, message, role) {
    const entry = {
      turn,
      message,
      role,
      // The id `send()` resolved; the key `user.message.messageId` matches.
      runtimeId: null,
      // A root `user.message` named this entry: the runtime has taken the
      // prompt. `delivery` is the runtime's own word for how.
      consumed: false,
      delivery: null,
      interactionId: null,
      // The entry whose run absorbed this one (`delivery:"steering"`).
      foldedInto: null,
      consumedMarked: false,
      // Its outcome was decided and its publishes started / it landed.
      settled: false,
      released: false,
      cancelled: false,
      // `lastStreamedText` is what this row last received on /api/stream —
      // the stream gate and the abort/error fallback text both read it.
      state: { lastStreamedText: '' },
    };
    entry.done = new Promise((resolve) => { entry.resolveDone = resolve; });
    turn.entries.push(entry);
    return entry;
  }

  function assignRuntimeId(turn, entry, runtimeId) {
    const id = String(runtimeId || '').trim();
    entry.runtimeId = id || null;
    if (!id) return;
    turn.pushed.set(id, entry);
    // The runtime can start work on a prompt before the send() that pushed it
    // has resolved with its id. The boundary was remembered; reconcile it now,
    // on the dispatch chain so it orders after the events already captured.
    const unclaimed = turn.unclaimedUserMessages.get(id);
    if (!unclaimed) return;
    turn.unclaimedUserMessages.delete(id);
    dispatchChain = dispatchChain
      .then(() => adoptSegment(turn, entry, unclaimed))
      .catch((error) => { dbg('late prompt-boundary reconcile failed', error?.message || String(error)); });
  }

  function createTurn(message, { kind = 'delivered', adoptEntry = null } = {}) {
    const continuation = kind === 'continuation';
    const turn = {
      // 'delivered' (a queue row arrived) | 'continuation' (the runtime started
      // work by itself and this worker minted a synthetic row for it).
      kind,
      message,
      model: '',
      normalizer: createNormalizerImpl(),
      result: null,
      failure: null,
      settled: false,
      aborted: false,
      // The row the user pressed Stop on (from the abort control), when known.
      abortedRowId: null,
      stallTimer: null,
      planBoardPosted: false,
      // Set when a mutating tool was actually approved and run this turn.
      acted: false,
      // A delivered row exists before the turn does, so its actions publish
      // straight away. A continuation's row is created asynchronously, so its
      // actions buffer here until it has an id.
      registered: !continuation,
      bufferedActions: [],
      // Set when the synthetic row could not be created; the turn's relay
      // output is dropped (it still lands in the runtime's own transcript)
      // rather than failing the worker.
      discarded: false,
      controlState: null,
      // Cancels any relay question card this turn is blocked on, so an aborted
      // turn does not leave a human answering into the void.
      abortController: new AbortController(),
      // Every row this turn owes an answer, in push order.
      entries: [],
      // runtime message id → entry, for the `user.message` acknowledgement.
      pushed: new Map(),
      // Normalizer segment index → the entry whose row the segment's text
      // belongs to. A `delivery:"steering"` prompt's segment belongs to the
      // run it was folded into; a `queued`/`idle` one starts its own run.
      segmentOwners: [],
      // The entry whose run the runtime is working on right now.
      currentOwner: null,
      primaryEntry: null,
      // Early settles (a previous run's row, published when the next run
      // opened) run off the event dispatch chain; driveTurn awaits them
      // before releasing ownership.
      settlePromises: [],
      // False until the turn-opening send() has resolved: the delivery hold.
      primarySent: continuation,
      // Root `user.message`s whose id no pushed entry knew yet (the event beat
      // the send() resolution): runtime id → boundary, reconciled by
      // assignRuntimeId.
      unclaimedUserMessages: new Map(),
    };
    if (adoptEntry) {
      // A pushed row whose run the runtime opened after the turn it was pushed
      // into had already settled: it becomes the primary of a turn of its own.
      adoptEntry.turn = turn;
      turn.entries.push(adoptEntry);
      turn.primaryEntry = adoptEntry;
      if (adoptEntry.runtimeId) turn.pushed.set(adoptEntry.runtimeId, adoptEntry);
      turn.primarySent = true;
    } else {
      turn.primaryEntry = createEntry(turn, message, continuation ? 'self' : 'primary');
    }
    turn.currentOwner = turn.primaryEntry;
    if (continuation) turn.segmentOwners[0] = turn.primaryEntry;
    turn.primaryReady = new Promise((resolve) => { turn.resolvePrimaryReady = resolve; });
    if (turn.primarySent) turn.resolvePrimaryReady();
    if (continuation) {
      // The single in-flight registration for this turn's synthetic row, and
      // the signal that abandons it. One promise, stored ON the turn, so the
      // drive path and a late HTTP response reason about the SAME attempt —
      // registration and abandonment used to run blind of each other, and a
      // registration resolving after the local deadline would adopt a row into
      // a turn already torn down (audit #6).
      turn.registration = null;
      turn.registrationAbort = new AbortController();
      // Resolves `true` once the row exists, `false` once registration gave up
      // or was abandoned. Interactive handlers gate question creation on it: a
      // `user_input.requested` in the gap between "continuation opened" and
      // "row registered" would otherwise mint its card against no row id and
      // degrade to an unsupported answer (audit #7).
      turn.rowReady = new Promise((resolve) => { turn.resolveRowReady = resolve; });
    }
    turn.done = new Promise((resolve, reject) => {
      turn.resolveDone = resolve;
      turn.rejectDone = reject;
    });
    // The stall watchdog and the runtime-exit observer can reject `turn.done`
    // before anything awaits it — an unhandled rejection that the worker crash
    // guard would escalate into a whole-worker failure. This handler exists
    // only to mark the promise as handled; driveTurn still sees the rejection.
    turn.done.catch(() => {});
    turn.settle = () => {
      if (turn.settled) return;
      turn.settled = true;
      turn.disarmStall();
      // The terminal event releases the event stream at once — see
      // `beginPublishing`. The queue rows stay owned until the publishes land.
      beginPublishing(turn);
      turn.resolvePrimaryReady();
      syncDeliveryReadiness();
      turn.resolveDone();
    };
    turn.fail = (error) => {
      if (turn.settled) return;
      turn.settled = true;
      turn.disarmStall();
      beginPublishing(turn);
      turn.resolvePrimaryReady();
      syncDeliveryReadiness();
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

  // ----------------------------------------------------- prompt boundaries --

  function claimSegment(turn, index, owner) {
    // Leading unowned segments (text the runtime produced before any prompt
    // boundary, e.g. the answer to a prompt carried over from a previous
    // interaction) go to the first owner: that is where the merged note sent
    // the reader.
    for (let j = 0; j <= index; j += 1) {
      if (!turn.segmentOwners[j]) turn.segmentOwners[j] = owner;
    }
  }

  /**
   * A root `user.message` arrived: the runtime started work on a prompt. Called
   * on the dispatch chain right after the normalizer opened the prompt's
   * segment, so `promptCount() - 1` is that segment.
   */
  async function noteUserMessage(turn, event) {
    const data = event?.data && typeof event.data === 'object' ? event.data : {};
    const index = Math.max(0, turn.normalizer.promptCount() - 1);
    const runtimeId = String(data.messageId || '').trim();
    const boundary = {
      index,
      delivery: String(data.delivery || '').trim().toLowerCase(),
      interactionId: String(data.interactionId || '').trim(),
    };
    const entry = runtimeId ? turn.pushed.get(runtimeId) : null;
    if (entry) {
      await adoptSegment(turn, entry, boundary);
      return;
    }
    // Not one of ours (yet): a prompt the runtime injected itself (an autopilot
    // nudge, a carried-over prompt from a previous interaction), or a pushed
    // prompt whose send() has not resolved with its id. Its text belongs to
    // the run in progress until proven otherwise.
    if (runtimeId && !turn.unclaimedUserMessages.has(runtimeId)) turn.unclaimedUserMessages.set(runtimeId, boundary);
    claimSegment(turn, index, turn.currentOwner || turn.primaryEntry);
  }

  /**
   * Bind a prompt boundary to the entry it names.
   *
   * `delivery:"steering"`: the runtime folded the prompt into the run already
   * in progress — the reply that follows belongs to that run's row, and this
   * row will settle with the fold marker (Claude's `folded`). The relay is
   * told the prompt is consumed at once, so a crash between now and the
   * marker fails the row instead of re-running it.
   *
   * Anything else (`queued`, `idle`, unknown): the prompt starts its own run
   * on the same interaction. The previous run is over — nothing more will be
   * produced for its row, so it is settled right away rather than at the
   * drain's end, exactly as a Claude context finalizes when the CLI opens the
   * next one.
   */
  async function adoptSegment(turn, entry, { index, delivery, interactionId }) {
    entry.consumed = true;
    entry.delivery = delivery || null;
    entry.interactionId = interactionId || null;
    const running = turn.currentOwner || turn.primaryEntry;
    if (delivery === 'steering' && running && running !== entry && !running.settled) {
      entry.foldedInto = running;
      turn.segmentOwners[index] = running;
      claimSegment(turn, index, running);
      if (entry.role === 'steer' && !entry.consumedMarked) {
        entry.consumedMarked = true;
        void markConsumed(entry.message.conversationId, [entry.message]);
      }
      dbg('steered prompt folded into the running turn', entry.message.id, `→ ${running.message.id || '(continuation)'}`);
      return;
    }
    turn.segmentOwners[index] = entry;
    claimSegment(turn, index, entry);
    if (running === entry) return;
    turn.currentOwner = entry;
    if (running && !running.settled) {
      dbg('pushed prompt runs as its own turn; settling the previous run', entry.message.id, `after ${running.message.id || '(continuation)'}`);
      // Off the dispatch chain: a slow relay must not stall the events of
      // the run that just opened (or its terminator) behind this publish.
      turn.settlePromises.push(settleEntry(turn, running, { type: 'completed' }));
    }
  }

  // -------------------------------------------------------------- settling --

  /**
   * Decide and publish one row's outcome. Idempotent per entry. A run owner's
   * settle also settles the steers folded into its run (they were answered by
   * its reply), in push order, after the reply itself.
   */
  async function settleEntry(turn, entry, outcome) {
    if (entry.settled) return;
    entry.settled = true;
    const model = turn.result?.model || turn.normalizer.model || turn.model || null;
    const folded = turn.entries.filter((other) => other !== entry && !other.settled && other.foldedInto === entry);
    try {
      switch (outcome.type) {
        case 'completed': {
          const text = finalTextFor(turn, entry, turn.result);
          const published = text || EMPTY_TURN_COMPLETION_NOTE;
          if (entry.role !== 'steer' && shouldPostPlanBoard({
            relayMode: entry.message.relayMode,
            finalText: text,
            alreadyPosted: turn.planBoardPosted,
            acted: turn.acted === true,
          })) {
            await publishPlanBoard(turn, text, 'plan-mode-fallback');
          }
          await publishFinalStream(entry.message, published);
          await publishResponse(entry.message, {
            text: published,
            model,
            consumedSteerIds: folded.map((other) => other.message),
          });
          break;
        }
        case 'aborted-by-user': {
          // The queue row's fate belongs to the server-side abort control,
          // exactly as in the Claude and Cursor workers. Publishing a response
          // here would double-settle the row.
          await publishFinalStream(entry.message, finalTextFor(turn, entry, turn.result));
          break;
        }
        case 'runtime-interrupted': {
          const own = finalTextFor(turn, entry, turn.result);
          const text = own ? `${own}\n\n${RUNTIME_INTERRUPTED_NOTE}` : RUNTIME_INTERRUPTED_NOTE;
          await publishFinalStream(entry.message, text);
          await publishResponse(entry.message, { text, model, consumedSteerIds: folded.map((other) => other.message) });
          break;
        }
        case 'error': {
          const { classified } = outcome;
          await publishFinalStream(entry.message, entry.state.lastStreamedText);
          await publishResponse(entry.message, {
            text: classified.text,
            model,
            terminalError: terminalErrorRecord(entry.message, classified),
            consumedSteerIds: folded.map((other) => other.message),
          });
          break;
        }
        case 'folded':
          await publishSettleMarker(entry.message, { text: STEER_FOLDED_TEXT, model, kind: 'folded', variant: 'folded' });
          break;
        case 'stopped':
          await publishSettleMarker(entry.message, { text: STEER_STOPPED_TEXT, model, kind: 'stopped', variant: 'stopped' });
          break;
        case 'merged-note':
          // Accepted by the runtime, never started: still queued inside it, so
          // it will be answered at the start of the next interaction — a
          // requeue would run it twice.
          await publishFinalStream(entry.message, STEERED_ROW_MERGED_NOTE);
          await publishResponse(entry.message, { text: STEERED_ROW_MERGED_NOTE, model });
          break;
        case 'cancelled':
        case 'discarded':
        default:
          break;
      }
    } catch (error) {
      dbg('settle publish failed', entry.message?.id || '(no id)', outcome.type, error?.message || String(error));
    } finally {
      entry.released = true;
      entry.resolveDone(true);
    }
    for (const other of folded) {
      const foldOutcome = outcome.type === 'completed' || outcome.type === 'merged-note'
        ? { type: 'folded' }
        : outcome.type === 'error' ? outcome : { type: 'stopped' };
      await settleEntry(turn, other, foldOutcome);
    }
  }

  /** Remove our unconsumed prompts from the runtime's queued lane (best effort). */
  async function clearOwnedQueuedItems(entries) {
    if (!entries.length || !session || !sessionRpc.queue) return;
    await refreshQueueLane();
    for (const entry of entries) {
      const itemId = queuedLane.get(entry.runtimeId);
      if (!itemId) continue;
      try {
        await session.rpc.queue.removeAt({ id: itemId });
        dbg('removed a stopped prompt from the runtime queue', entry.message.id);
      } catch (error) {
        dbg('queue.removeAt after Stop failed', entry.message.id, error?.message || String(error));
      }
    }
  }

  /**
   * Hold pushed-but-unstarted prompts for the orphan grace, then return the
   * ones the runtime still did not open (an opened one was adopted meanwhile
   * and belongs to a turn of its own now).
   */
  async function settleAfterOrphanGrace(turn, orphans) {
    if (!orphans.length) return [];
    if (orphanGraceMs > 0) {
      dbg('pushed prompts not started at idle; waiting for the runtime to open them', orphans.map((entry) => entry.message.id).join(','));
      await sleep(orphanGraceMs);
    }
    return orphans.filter((entry) => entry.turn === turn && !entry.settled);
  }

  /**
   * Publish everything a finished turn still owes, per row.
   *
   * Shared by both turn kinds: the runtime does not distinguish a turn it
   * started from one it was asked for, so neither does the reporting.
   */
  async function finishTurn(turn) {
    const result = turn.result;
    const failure = turn.failure;
    // Capture only. The POST fires from driveTurn's `finally`, after the rows
    // have been published.
    captureTurnUsage(turn.primaryEntry.message, result);

    const pending = turn.entries.filter((entry) => !entry.settled && entry.turn === turn);
    if (!pending.length) return;

    if (failure) {
      const classified = classifyCopilotTurnException(failure);
      dbg('copilot turn failed', turn.message?.id || '(continuation)', classified.detail);
      for (const entry of pending) {
        if (entry.settled) continue;
        await settleEntry(turn, entry, { type: 'error', classified });
      }
      return;
    }
    if (result?.isError) {
      const classified = classifyCopilotSessionError(result.errorData || { message: result.errorMessage });
      dbg('turn failed', turn.message?.id || '(continuation)', classified.stableCode);
      for (const entry of pending) {
        if (entry.settled) continue;
        await settleEntry(turn, entry, { type: 'error', classified });
      }
      return;
    }

    const live = turn.currentOwner || turn.primaryEntry;
    // The row the user pressed Stop on. Normally the live one; the relay's
    // live-turn picker can also land on another row this turn owns, in which
    // case THAT row is left to the relay's abort control and the live row
    // keeps its partial reply.
    const stopped = turn.aborted
      ? (turn.abortedRowId && pending.find((entry) => String(entry.message?.id || '') === turn.abortedRowId)) || live
      : null;
    const settleOne = async (entry) => {
      // A row that moved to a turn of its own (adoptOrphanedRun) is not ours.
      if (entry.turn !== turn || entry.settled) return;
      const ownsRun = entry === live || (!entry.foldedInto && entry.consumed);
      if (turn.aborted) {
        // A user Stop. The stopped row is settled server-side; every other
        // row pushed into the interaction went unanswered — the runtime
        // clears both its lanes on an interrupt — and says so, with Resend.
        if (entry === stopped) {
          dbg('turn aborted', entry.message.id);
          await settleEntry(turn, entry, { type: 'aborted-by-user' });
        } else if (ownsRun) {
          await settleEntry(turn, entry, { type: 'completed' });
        } else {
          await settleEntry(turn, entry, { type: 'stopped' });
        }
        return;
      }
      if (result?.aborted) {
        // The runtime interrupted the turn on its own. Nothing server-side is
        // waiting to settle these rows.
        if (entry === live) {
          dbg('turn interrupted by the runtime', entry.message.id);
          await settleEntry(turn, entry, { type: 'runtime-interrupted' });
        } else if (ownsRun) {
          await settleEntry(turn, entry, { type: 'completed' });
        } else {
          await settleEntry(turn, entry, { type: 'stopped' });
        }
        return;
      }
      if (ownsRun) {
        await settleEntry(turn, entry, { type: 'completed' });
      } else if (entry.foldedInto) {
        await settleEntry(turn, entry, { type: 'folded' });
      } else {
        await settleEntry(turn, entry, { type: 'merged-note' });
      }
    };
    // A normal end with pushed prompts the runtime never started: the runtime
    // gets a moment to open their runs (adoptOrphanedRun takes them) before
    // they are noted as carried over — AFTER the rows whose replies are
    // complete have been published, so a finished answer never waits on the
    // grace. Not on a Stop (the runtime cleared them) and not on an error.
    const orphans = (!turn.aborted && !result?.aborted)
      ? pending.filter((entry) => entry.role === 'steer' && !entry.consumed && !entry.foldedInto)
      : [];
    if (turn.aborted || result?.aborted) {
      // Belt and braces for the targeted interrupt: any prompt of ours still
      // sitting in the runtime's queued lane is pulled out before its row is
      // marked stopped, so the runtime cannot run a prompt whose row says it
      // was not answered.
      await clearOwnedQueuedItems(pending.filter((entry) => !entry.consumed && entry.runtimeId));
    }
    // The stopped row first: settling it before the live row's cascade means
    // the cascade (which settles the steers folded into a run) cannot touch
    // the row the relay's abort control owns.
    const ordered = stopped ? [stopped, ...pending.filter((entry) => entry !== stopped)] : pending;
    for (const entry of ordered) {
      if (!orphans.includes(entry)) await settleOne(entry);
    }
    for (const entry of await settleAfterOrphanGrace(turn, orphans)) {
      await settleOne(entry);
    }
  }

  // ------------------------------------------------------------ lifecycle --

  /**
   * Interrupt the turn the user stopped. `interruptMainTurn` (when the
   * runtime has it) stops the main agent loop and nothing else: background
   * agents and promoted shells keep running under their own Stop, exactly
   * like the Claude worker's targeted interrupt. `session.abort()` — the
   * fallback — also cancels every background agent and clears both message
   * lanes. Either way the runtime answers with an aborted idle event, which
   * settles the turn through the normal terminator.
   */
  async function interruptTurn(turn, control) {
    turn.aborted = true;
    turn.abortedRowId = String(control?.queueMessageId || '').trim() || null;
    // While `ensureSession` is still connecting there is no session to abort
    // and this would be a silent no-op; `runTurn` re-checks `turn.aborted`
    // once the session exists and settles there instead.
    if (!session) return;
    if (sessionRpc.interruptMainTurn) {
      try {
        const outcome = await session.rpc.interruptMainTurn({ flushQueued: false });
        if (outcome?.interrupted === false) {
          // Nothing was processing: no aborted idle will come. The turn is
          // over as far as the runtime is concerned.
          dbg('interruptMainTurn found no main turn in flight; settling locally', turn.message?.id || '');
          turn.settle();
        }
        return;
      } catch (error) {
        dbg('interruptMainTurn failed; falling back to abort()', error?.message || String(error));
      }
    }
    await session.abort?.();
  }

  /**
   * Start a delivered turn: bring the session up, send the prompt, and hand
   * the turn's lifecycle to `driveTurn`. Resolves when THIS row has settled —
   * which can be before the turn ends, when a message pushed later ran as its
   * own run and this one's reply was already complete.
   */
  async function runTurn(turn) {
    const { message } = turn;
    const entry = turn.primaryEntry;
    const model = resolvePerTurnModel(message);
    // The dequeued row's reasoning effort (audit #9). Normalisation happens in
    // the switcher: `none`/absent mean "the model's default".
    const effort = message?.reasoningEffort ?? null;
    const relayMode = message?.relayMode || 'agent';
    lastRelayMode = relayMode;
    turn.model = model;
    // Set before the session is touched: the heartbeat's owner-recovery guard
    // reads the active ids, so a cold-start delivery must already own its row.
    activeTurn = turn;
    // The delivery hold begins: nothing steers in until the prompt is sent.
    syncDeliveryReadiness();
    // Session-wide, not per row: the client's Stop targets whichever of this
    // turn's rows is live, and the relay only hands out controls for rows
    // this worker owns.
    turn.controlState = controlPoller?.start?.({
      queueMessageId: '',
      onAbortTurn: (control) => interruptTurn(turn, control),
    }) || null;
    turn.drive = driveTurn(turn);
    try {
      await ensureSession(model, effort, relayMode);
      if (turn.aborted) {
        // The abort landed while the session was still being built. Nothing
        // was sent, so there is no runtime turn to interrupt — settle locally
        // rather than sending a prompt the user just cancelled.
        dbg('turn aborted before send', message.id);
        turn.settle();
      } else {
        turn.armStall();
        const sendMode = String(resolveSendModeImpl(message) || '').trim();
        const { prompt: body, attachments } = buildMessageOptionsImpl(message);
        // Relay mode marker + (on a mode change) the standing mode instructions,
        // the relay tool guidance and the live preview-lane block.
        const context = await buildRelayContextPrefix(message).catch(() => null);
        const prompt = withRelayContext(context?.prefix, body);
        // `mode` and `attachments` are FIELDS of the single MessageOptions
        // argument — `send()` takes no second parameter, so passing options
        // positionally drops them silently.
        const sending = session.send({
          prompt,
          ...(attachments?.length ? { attachments } : {}),
          ...(sendMode ? { mode: sendMode } : {}),
          agentMode: copilotAgentModeForRelayMode(relayMode),
        });
        // A send that never resolves (a wedged runtime) must not hold this
        // delivery hostage once the watchdog has failed the turn: the id is
        // still recorded if it ever arrives, but the wait ends with the turn.
        const settledFirst = Symbol('turn-settled');
        const runtimeId = await Promise.race([
          sending,
          turn.done.then(() => settledFirst, () => settledFirst),
        ]);
        if (runtimeId === settledFirst) {
          sending.then((id) => assignRuntimeId(turn, entry, id)).catch(() => {});
        } else {
          assignRuntimeId(turn, entry, runtimeId);
          // Committed only now that `send()` accepted the prompt (audit #32): a
          // failed send means the runtime never READ the mode guidance, and
          // committing before it would make the same-mode retry omit it.
          context?.commit();
          // The runtime has the prompt: the delivery hold ends and later
          // deliveries steer into this turn.
          turn.primarySent = true;
          turn.resolvePrimaryReady();
          syncDeliveryReadiness();
        }
      }
    } catch (error) {
      // A failure that killed the session (or came from starting it) leaves a
      // handle nothing else can use; drop it so the next delivery rebuilds and
      // resumes rather than sending into a dead runtime. An UNCONFIRMED MODEL
      // SWITCH is the exception: the session is healthy and merely still on
      // its previous model, and tearing the runtime down over it would kill
      // any live background work for a selection problem the user fixes by
      // picking another model.
      if (!isModelSwitchUnconfirmedError(error)) {
        await stopRuntime('turn-failure').catch(() => {});
      }
      turn.fail(error);
    }
    // `send()` resolving is NOT the turn's completion; the event stream is.
    await awaitEntry(turn, entry);
    return true;
  }

  /**
   * Wait for a row's settle. A row's settle is not necessarily the turn's
   * end: a prompt pushed later may still be running on the same interaction,
   * and this delivery must not wait for it. But when the turn IS over, wait
   * for its wrap-up too (ownership release, usage ingest), so a caller that
   * awaited the delivery sees a quiescent runner — the contract every test
   * and the crash guard rely on. `driveTurn` never rejects.
   */
  async function awaitEntry(turn, entry) {
    await entry.done;
    if (turn.settled && turn.drive) await turn.drive.catch(() => {});
  }

  /**
   * Run a turn from its first event to its last publish.
   *
   * Row ownership is released only after every publish has landed: a
   * heartbeat firing inside the publish window with no active ids would tell
   * the relay this worker owns nothing, and the still-`processing` rows would
   * be recovered underneath it. (The EVENT stream was already released at the
   * terminator — see `beginPublishing` — so the runtime's next self-initiated
   * turn can open while this one is still writing.)
   */
  async function driveTurn(turn) {
    try {
      await turn.done;
    } catch (error) {
      turn.failure = turn.failure || error;
    }
    try {
      await quiesceTurn(turn);
      if (turn.failure && turn.kind === 'delivered' && !isModelSwitchUnconfirmedError(turn.failure) && session) {
        // A stall or a runtime death mid-turn (a setup failure already tore
        // the runtime down in runTurn).
        await stopRuntime('turn-failure').catch(() => {});
      }
      if (turn.kind === 'continuation') {
        // Nothing can be published before the row exists. The buffer is
        // drained by the registration itself; this only covers actions that
        // arrived during the drain.
        await awaitContinuationRow(turn);
        // The invariant is the id, not the flag: registration can also give up
        // by throwing, or by taking longer than `awaitContinuationRow` waits,
        // and publishing against `messageId: null` would attribute the whole
        // turn to nothing at all.
        if (!turn.message.id) {
          if (!turn.discarded) abandonContinuationRegistration(turn, 'no relay row at publish time');
          dbg('continuation output dropped (no relay row)');
          const classified = classifyCopilotTurnException(
            turn.failure || new Error('the relay refused a continuation row for this turn'),
          );
          for (const entry of turn.entries) {
            if (entry.settled || entry.turn !== turn) continue;
            // The steering path is still waiting on any row it handed us, and
            // it has no row of its own to fall back to.
            await settleEntry(turn, entry, entry.role === 'self' ? { type: 'discarded' } : { type: 'error', classified });
          }
          return;
        }
        await flushBufferedActions(turn);
      }
      await finishTurn(turn);
    } catch (error) {
      dbg('turn publish failed', error?.message || String(error));
    } finally {
      // Early settles still in flight must land before the rows stop being
      // reported (settleEntry never rejects, but this is the ordering guard).
      await Promise.allSettled(turn.settlePromises);
      controlPoller?.stop?.(turn.controlState);
      turn.controlState = null;
      // Every path through the turn — published, failed, aborted, threw — has
      // finished by here. Anything still unresolved is released so no caller
      // waits forever; its row is left to the relay's recovery.
      for (const entry of turn.entries) {
        if (entry.turn !== turn || entry.released) continue;
        entry.settled = true;
        entry.released = true;
        entry.resolveDone(true);
      }
      // Released only once every publish for this turn's rows has landed.
      releaseTurnOwnership(turn);
      touch();
      syncDeliveryReadiness();
      // The ingest is advisory, never awaited, and must never be able to
      // delay a reply that is already written.
      postTurnUsage();
    }
  }

  /**
   * Everything that must happen between "the turn stopped producing events" and
   * "its state may be read": stop the watchdog, release anything blocked on a
   * question card, drain in-flight relay POSTs, and close subagent runs the
   * normalizer never got to close.
   */
  async function quiesceTurn(turn) {
    turn.disarmStall();
    // The card's answer can no longer reach the runtime.
    turn.abortController.abort();
    // Drain in-flight dispatches before the turn's state is read, so a stream
    // POST cannot land after the response.
    await dispatchChain.catch(() => {});
    // Any subagent still open at this point never will be. The normalizer
    // closes strays when it produces a terminal result; these are the paths
    // that never produced one.
    await closeStraySubagentRuns(turn).catch(() => {});
  }

  // ----------------------------------------------------------- continuation --

  /**
   * The runtime started a turn nobody asked for. Give it a relay row.
   *
   * Called synchronously from `routeEvent`, so `activeTurn` is set before the
   * triggering event is dispatched — which is what stops a second opener in the
   * same batch from minting a second row for the same turn, and what makes idle
   * shutdown and the heartbeat see the work immediately.
   *
   * The row itself is created asynchronously (`POST /api/continuation-turn`);
   * everything the turn produces meanwhile buffers on the turn and flushes in
   * order once the row has an id.
   */
  function openContinuationTurn() {
    const turn = createTurn({
      id: null,
      conversationId: sdkSessionId,
      // A self-initiated turn has no delivery to read a mode off, so it runs in
      // the mode the conversation was last driven in — the permission handler
      // and the plan-board gating both read the live turn's mode.
      relayMode: lastRelayMode,
      model: '',
    }, { kind: 'continuation' });
    activeTurn = turn;
    // The gap this pin covers has closed.
    continuationDueSince = 0;
    turn.armStall();
    // Lines produced between turns (a settled shell's notification) belong to
    // the turn they triggered.
    if (pendingActivities.length) {
      for (const text of pendingActivities.splice(0)) {
        turn.bufferedActions.push({ channel: 'activity', payload: { text, subagentRunId: null } });
      }
    }
    dbg('opening a continuation turn for runtime-initiated work');
    syncDeliveryReadiness();
    // Both are fire-and-forget by design (the SDK's event callback is
    // synchronous and cannot await a turn), so both must swallow: an unhandled
    // rejection here would reach the worker crash guard and take the whole
    // process down over one lost continuation. The caught chain is what lives
    // on the turn, so `awaitContinuationRow` can race it without re-handling.
    turn.registration = registerContinuationRow(turn).catch((error) => {
      dbg('continuation registration threw', error?.message || String(error));
      if (turn.message.id) {
        // The row was created and only the bookkeeping after it failed. Release
        // the buffer to the drive path rather than throwing away a turn that
        // has somewhere to go.
        turn.registered = true;
        turn.resolveRowReady?.(true);
        return;
      }
      abandonContinuationRegistration(turn, 'registration threw');
    });
    turn.drive = driveTurn(turn);
    turn.drive.catch((error) => {
      dbg('continuation driver threw', error?.message || String(error));
    });
    return turn;
  }

  /**
   * A pushed row whose run the runtime opened AFTER the turn it was pushed
   * into had settled (the drain's idle raced the send). It is not a
   * self-initiated turn — it is that row's own turn, and its reply belongs on
   * that row. Returns the new turn, or null when the id is not one of ours.
   */
  function adoptOrphanedRun(event) {
    if (String(event?.type || '') !== 'user.message' || event?.agentId) return null;
    const runtimeId = String(event?.data?.messageId || '').trim();
    if (!runtimeId) return null;
    for (const previous of publishingTurns) {
      const entry = previous.pushed.get(runtimeId);
      if (!entry || entry.consumed || entry.settled) continue;
      previous.entries = previous.entries.filter((other) => other !== entry);
      previous.pushed.delete(runtimeId);
      // From here the entry belongs to the new turn (`entry.turn`); the old
      // turn's settle passes skip rows that moved away.
      const turn = createTurn(entry.message, { kind: 'delivered', adoptEntry: entry });
      turn.model = resolvePerTurnModel(entry.message);
      activeTurn = turn;
      turn.armStall();
      turn.controlState = controlPoller?.start?.({
        queueMessageId: '',
        onAbortTurn: (control) => interruptTurn(turn, control),
      }) || null;
      dbg('a pushed prompt opened its own run after its turn settled; adopting it', entry.message.id);
      syncDeliveryReadiness();
      turn.drive = driveTurn(turn);
      turn.drive.catch((error) => {
        dbg('adopted turn driver threw', error?.message || String(error));
      });
      return turn;
    }
    return null;
  }

  /**
   * Give up on a continuation's synthetic row: nothing buffered will ever
   * publish, and a registration still in flight must not adopt a row into this
   * turn when it finally answers. The one place all three abandonment paths
   * (retries exhausted, local deadline expired, registration threw) converge,
   * so none of them can forget the abort signal or leave `rowReady` hanging.
   */
  function abandonContinuationRegistration(turn, reason) {
    turn.discarded = true;
    turn.bufferedActions = [];
    turn.registrationAbort?.abort?.();
    // Interactive handlers stop waiting and take their degraded path.
    turn.resolveRowReady?.(false);
    dbg('continuation registration abandoned:', reason);
  }

  /**
   * Create the synthetic queue row and release the turn's buffered output.
   *
   * Retries on any response that produced no message id — a truthy but empty
   * body must not end the loop early. Giving up discards the turn's relay
   * output (it still lands in the runtime's own transcript) rather than failing
   * the worker: a continuation nobody can see is a lost message, not a broken
   * session.
   */
  async function registerContinuationRow(turn) {
    // One idempotency key for the whole loop: a retry whose predecessor was
    // created server-side but whose response was lost must get the SAME row
    // back, not mint a sibling nobody will ever settle.
    const operationId = randomUUID();
    // Abandonment is decided elsewhere (the drive path's deadline) while this
    // loop is parked on an HTTP await, so the state is RE-checked after every
    // await — the transport has no abort plumbing, which makes these recheck
    // points the only cancellation this request has.
    const signal = turn.registrationAbort?.signal || null;
    const abandoned = () => turn.discarded || signal?.aborted === true;
    let response = null;
    for (let attempt = 0; attempt < 3 && !response?.messageId; attempt += 1) {
      if (abandoned()) return;
      response = await api('POST', '/api/continuation-turn', {
        conversationId: sdkSessionId,
        sdkSessionId,
        relayMode: turn.message.relayMode,
        trigger: CONTINUATION_TRIGGER,
        operationId,
      }).catch((error) => {
        dbg('continuation turn registration failed', error?.message || String(error));
        return null;
      });
      if (!response?.messageId) {
        if (abandoned()) return;
        await new Promise((resolve) => { setTimeout(resolve, continuationRetryDelayMs); });
      }
    }
    if (!response?.messageId) {
      abandonContinuationRegistration(turn, 'no relay message id after 3 attempts');
      return;
    }
    const messageId = String(response.messageId);
    const attemptId = String(response.attemptId || '') || null;
    if (abandoned()) {
      // The drive path gave up on this turn while the request was in flight,
      // and the server has just created a row nobody will publish into.
      // Starting controls or flushing output here would resurrect an abandoned
      // turn; instead the orphan row is settled explicitly — the requeue
      // route's continuation branch tears a processing continuation down as
      // `dropped: 'continuation'` (the same teardown the Claude worker uses
      // for a registration that outlived its hand-off).
      dbg('late continuation registration; tearing the orphan row down', messageId);
      await api('POST', '/api/requeue', {
        messageId,
        ...(attemptId ? { attemptId } : {}),
      }).catch(() => {});
      return;
    }
    turn.message.id = messageId;
    // The attempt the row was minted under; every publish echoes it, exactly
    // as a delivered row echoes the attempt id its delivery carried.
    turn.message.attemptId = attemptId;
    // The route reports which conversation the synthetic row landed on;
    // trusting it beats assuming worker session id === conversation id.
    const conversationId = String(response.conversationId || '').trim();
    if (conversationId) turn.message.conversationId = conversationId;
    // Only now is there a row to abort, so this is where the control poller can
    // start.
    turn.controlState = controlPoller?.start?.({
      queueMessageId: '',
      onAbortTurn: (control) => interruptTurn(turn, control),
    }) || null;
    await flushBufferedActions(turn);
    turn.registered = true;
    turn.resolveRowReady?.(true);
  }

  /**
   * Resolve once the continuation's row exists, its registration gave up, or
   * the local deadline expires — in which case the turn is ABANDONED, so the
   * registration cannot later adopt a row into it (it tears the row down
   * instead; see `registerContinuationRow`'s late-response branch).
   */
  async function awaitContinuationRow(turn, timeoutMs = continuationRegistrationTimeoutMs) {
    if (turn.registered || turn.discarded) return;
    let timer = null;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve('expired'), timeoutMs);
      timer.unref?.();
    });
    // `turn.registration` is the caught chain and never rejects.
    const outcome = await Promise.race([turn.registration || Promise.resolve(), expired]);
    clearTimeout(timer);
    if (outcome === 'expired' && !turn.registered && !turn.message.id) {
      abandonContinuationRegistration(turn, 'registration outlived the local deadline');
    }
  }

  // --------------------------------------------------------------- steering --

  /**
   * A delivery arrived while a turn was already running: push it into the
   * same runtime interaction as a steer.
   *
   * `mode: "immediate"` makes it a real steer — injected at the next tool
   * boundary (`delivery:"steering"`, folded into the running reply), or run
   * as its own turn right after when the model is mid-stream
   * (`delivery:"queued"`). Either way the row is owned by this turn and
   * settled by it (see adoptSegment / finishTurn); nothing else will.
   *
   * The entry is registered BEFORE the send so a failure between the two
   * cannot leave a row nobody owns.
   */
  async function steerIntoActiveTurn(turn, message) {
    const { prompt: body, attachments } = buildMessageOptionsImpl(message);
    // A real relay round trip on the first turn of a mode — long enough for the
    // turn to finish underneath us.
    const context = await buildRelayContextPrefix(message).catch(() => null);
    const prompt = withRelayContext(context?.prefix, body);
    // Re-checked AFTER the awaits and before anything is sent or registered.
    // Nothing has been sent yet, so handing the row back to the normal path is
    // free.
    if (turn.settled) {
      dbg('turn settled while steering was preparing; running it as a fresh turn', message.id);
      return NOT_STEERED;
    }
    const entry = createEntry(turn, message, 'steer');
    dbg('steering a mid-turn delivery into the running turn', message.id);
    let runtimeId;
    try {
      runtimeId = await session.send({
        prompt,
        ...(attachments?.length ? { attachments } : {}),
        mode: 'immediate',
        agentMode: copilotAgentModeForRelayMode(message?.relayMode || 'agent'),
      });
    } catch (error) {
      // The prompt never reached the runtime, so nothing will answer it and the
      // row is safe to requeue — unlike an accepted one.
      turn.entries = turn.entries.filter((other) => other !== entry);
      entry.settled = true;
      entry.released = true;
      entry.resolveDone(true);
      dbg('steering send failed, requeuing the row', message.id, error?.message || String(error));
      await api('POST', '/api/requeue', { messageId: message.id, ...attemptFields(message) }).catch(() => {});
      return true;
    }
    assignRuntimeId(turn, entry, runtimeId);
    // Same commit-after-send rule as `runTurn` (audit #32): a steered prompt
    // whose send failed never delivered its guidance, so the retry must
    // include it again.
    context?.commit();
    scheduleQueueLaneRefresh();
    // Resolves when the interaction settles this row.
    await awaitEntry(turn, entry);
    return true;
  }

  // ------------------------------------------------------------------ gate --

  /**
   * Whether a message delivered now would steer into the live turn. False
   * while: no session / no live turn; the turn-opening prompt has not been
   * sent yet (the delivery hold — a second send before the first would invert
   * the runs); a question card, ask-mode approval or elicitation is open (the
   * relay must not push past a card); a compaction is running.
   */
  function canAcceptSteering() {
    if (disposed || !session) return false;
    const turn = activeTurn;
    if (!turn || turn.settled || turn.aborted) return false;
    if (!turn.primarySent) return false;
    if (pendingHumanRequests > 0) return false;
    if (isCompacting()) return false;
    return true;
  }

  /**
   * The one steering gate. A delivery arriving now is held — handed back to
   * the queue instead of pushed — when a turn is live (or a human request /
   * compaction is open) and it cannot accept a steer. The socket link consults
   * this for its readiness too, idle or mid-delivery.
   */
  function isDeliveryHeld() {
    if (disposed) return false;
    const turn = activeTurn;
    const live = Boolean(turn && !turn.settled);
    if (!live && pendingHumanRequests === 0 && !isCompacting()) return false;
    return !canAcceptSteering();
  }

  function syncDeliveryReadiness() {
    const ready = !isDeliveryHeld();
    if (ready === lastReportedDeliveryReady) return;
    lastReportedDeliveryReady = ready;
    try {
      onDeliveryReadinessChange(ready);
    } catch (error) {
      dbg('delivery readiness listener failed', error?.message || String(error));
    }
  }

  /**
   * Give a held delivery back to the queue with no retry penalty. The relay
   * re-delivers it once this worker signals ready again, i.e. when the hold
   * ends — the message then steers into the resumed turn. Pushing it into the
   * hold instead would bypass the question card or land inside a compaction.
   */
  async function handBackHeldDelivery(message) {
    dbg('steering held; handing the delivery back to the queue', message.id || '(no id)');
    if (!message.id) return false;
    await api('POST', '/api/requeue', {
      messageId: message.id,
      class: 'steering-held',
      ...attemptFields(message),
    }).catch((error) => {
      if (isStaleAttemptError(error)) {
        dbg('steering-held hand-back refused as stale_attempt', message.id);
        return;
      }
      dbg('steering-held hand-back failed', message.id, error?.message || String(error));
    });
    return false;
  }

  function* ownedEntries() {
    if (activeTurn) yield* activeTurn.entries;
    for (const turn of publishingTurns) yield* turn.entries;
  }

  /** Pushed rows the client may still cancel: unconsumed, in the runtime's queued lane. */
  function cancellableIds() {
    const ids = [];
    for (const entry of ownedEntries()) {
      if (entry.role !== 'steer' || entry.consumed || entry.settled) continue;
      if (!entry.runtimeId || !queuedLane.has(entry.runtimeId)) continue;
      const id = String(entry.message?.id || '').trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * Composer-facing steering snapshot, published on the heartbeat: whether a
   * turn is live, whether a message typed now would steer into it, and — when
   * it would not — why. `supported` is how the client learns this Copilot
   * conversation steers at all (its provider type alone cannot tell an SDK
   * worker from the extension engine); `cancellableIds` are the pushed rows
   * that may still be pulled back out of the runtime (decision 8).
   */
  function steeringState() {
    const turn = activeTurn;
    const turnActive = Boolean(turn && !turn.settled);
    const canSteer = canAcceptSteering();
    let holdReason = null;
    if (turnActive && !canSteer) {
      if (pendingHumanRequests > 0) holdReason = 'question';
      else if (isCompacting()) holdReason = 'compaction';
      else if (!turn.primarySent) holdReason = 'delivery';
      else holdReason = 'other';
    }
    const messageId = String(turn?.currentOwner?.message?.id || turn?.message?.id || '').trim() || null;
    return { turnActive, canSteer, holdReason, messageId, supported: true, cancellableIds: cancellableIds() };
  }

  /**
   * Un-steer (decision 8): pull a pushed-but-unconsumed row back out of the
   * runtime's queued lane and cancel it. A prompt the runtime already took
   * (`consumed`) cannot be recalled; the control is then a no-op and the row
   * settles through its normal path.
   */
  async function cancelPushedMessage(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return false;
    let entry = null;
    for (const candidate of ownedEntries()) {
      if (String(candidate.message?.id || '') === id) { entry = candidate; break; }
    }
    if (!entry || entry.consumed || entry.settled || !entry.runtimeId) {
      dbg('un-steer refused: row not cancellable', id, entry ? `consumed=${entry.consumed} settled=${entry.settled}` : 'unknown row');
      return false;
    }
    if (!session || !sessionRpc.queue) return false;
    await refreshQueueLane();
    const itemId = queuedLane.get(entry.runtimeId);
    if (!itemId) {
      dbg('un-steer refused: prompt no longer in the queued lane', id);
      return false;
    }
    let removed = false;
    try {
      removed = (await session.rpc.queue.removeAt({ id: itemId }))?.removed === true;
    } catch (error) {
      dbg('queue.removeAt failed', id, error?.message || String(error));
    }
    if (!removed) return false;
    entry.cancelled = true;
    entry.settled = true;
    dbg('un-steered a pushed prompt', id);
    // The prompt is gone from the runtime; the row must end cancelled and
    // never be re-delivered. It stays owned (settling, with the terminal
    // wording the crash guard would send) until the relay acknowledges the
    // cancel; if the relay never does, the heartbeat hands it over to fail.
    claimSettling(entry.message, 'cancelled');
    const cancelBody = {
      conversationId: entry.message.conversationId,
      messageId: id,
      ...attemptFields(entry.message),
    };
    let acknowledged = false;
    for (let attempt = 0; ; attempt += 1) {
      acknowledged = await api('POST', '/api/queue-cancelled', cancelBody).then(() => true, (error) => {
        dbg('queue-cancelled publish failed', id, error?.message || String(error));
        // The row already left `processing` (answered, recovered, or already
        // cancelled): nothing left for this worker to do.
        return Number(error?.status) === 404 || Number(error?.status) === 409;
      });
      if (acknowledged || attempt >= settleRetryDelaysMs.length) break;
      await sleep(settleRetryDelaysMs[attempt]);
    }
    if (!acknowledged) {
      dbg('queue-cancelled could not be posted; handing the row to the heartbeat', id);
      settleFailedTerminals.set(id, buildSteerSettleFailure(entry.message, { variant: 'cancelled', agentLabel: SETTLE_AGENT_LABEL }));
    }
    releaseSettling(id);
    entry.released = true;
    entry.resolveDone(true);
    const turn = entry.turn;
    if (turn) {
      turn.entries = turn.entries.filter((other) => other !== entry);
      turn.pushed.delete(entry.runtimeId);
    }
    scheduleQueueLaneRefresh();
    return true;
  }

  async function handlePendingPayload(pending) {
    const message = pending?.message || null;
    if (!message) return false;
    // Held (a card is open, a compaction is running, the turn-opening prompt
    // is not sent yet): hand the row back with no retry penalty; the relay
    // re-delivers it when the hold ends. An older relay (the worker updated on
    // disk before the relay restarted) treats the hand-back as a failed
    // delivery — retry, backoff, worker marked errored — so against one the
    // message is pushed the legacy way.
    if (isDeliveryHeld() && canHandBackHeldDelivery() !== false) return handBackHeldDelivery(message);
    // Legacy path only: never send a second prompt before the turn-opening one
    // (it would invert the runs), and never start a second turn beside one
    // that is still connecting.
    if (activeTurn && !activeTurn.settled && !activeTurn.primarySent) {
      await activeTurn.primaryReady;
    }
    // A delivery that lands while a turn is running is steered into it rather
    // than starting a second one: the runtime has a single conversation and a
    // concurrent `send` would interleave into the same interaction anyway —
    // this way the row is owned and settled instead of orphaned.
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
    const turn = createTurn(message);
    return runTurn(turn);
  }

  // --------------------------------------------------------------- teardown --

  function getActiveQueueMessageId() {
    const live = activeTurn?.currentOwner;
    if (live && !live.released && live.message?.id) return String(live.message.id);
    for (const entry of ownedEntries()) {
      const id = String(entry.message?.id || '');
      if (id && !entry.released) return id;
    }
    return '';
  }

  /**
   * Every row this worker owns — the running turn's rows and the same for
   * every settled turn still publishing — as `{ id, attemptId }` entries; a
   * consumed row whose settle marker is still being saved carries the
   * terminal failure the crash guard must send instead of a requeue, because
   * its prompt must never run twice. A row missing from this list would be
   * recovered mid-flight and re-delivered while the runtime was still
   * answering it.
   *
   * Both the heartbeat (lease renewal) and the crash guard (requeue-on-exit)
   * read this: the crash guard takes the entries whole so its requeues stay
   * fenced to this attempt, while the worker's heartbeat call site unwraps the
   * ids (the claim payload is id-only).
   */
  function getActiveQueueMessageIds() {
    const entries = [];
    const byId = new Map();
    const push = (message, terminalError = null) => {
      const id = String(message?.id || '').trim();
      if (!id) return;
      const existing = byId.get(id);
      if (existing) {
        if (terminalError && !existing.terminalError) existing.terminalError = terminalError;
        return;
      }
      const entry = { id, attemptId: message?.attemptId || null, ...(terminalError ? { terminalError } : {}) };
      byId.set(id, entry);
      entries.push(entry);
    };
    for (const entry of ownedEntries()) {
      if (entry.released) continue;
      push(entry.message);
    }
    for (const { message, variant } of settlingMessages.values()) {
      push(message, buildSteerSettleFailure(message, { variant, agentLabel: SETTLE_AGENT_LABEL }));
    }
    return entries;
  }

  async function dispose() {
    disposed = true;
    stopLifecycleTimer();
    if (queueLaneTimer) {
      clearTimeout(queueLaneTimer);
      queueLaneTimer = null;
    }
    // A question card left `pending` would sit in the UI inviting an answer
    // that nothing is left to read. Time them out before the socket goes.
    await questionBridge.cancelPendingQuestions?.().catch?.(() => {});
    await stopRuntime('worker-shutdown');
  }

  return {
    handlePendingPayload,
    getActiveQueueMessageId,
    getActiveQueueMessageIds,
    // The delivery gate (the socket link's probes) and the composer snapshot
    // (the heartbeat's).
    canAcceptSteering,
    isDeliveryHeld,
    steeringState,
    getSettleFailed,
    acknowledgeSettleFailed,
    cancelPushedMessage,
    // "Active" spans both ownerships: a settled turn still publishing must
    // keep the worker's idle/shutdown gates closed just like a running one.
    isTurnActive: () => !!activeTurn || publishingTurns.size > 0,
    dispose,
    // The turn's tokens/cost/TTFT, as posted to `/api/copilot-plan-usage`.
    getLastTurnUsage: () => lastTurnUsage,
    // The in-flight usage ingest. A test seam ONLY: the turn path deliberately
    // never awaits this, which is what keeps a slow relay from holding a
    // finished reply.
    whenUsagePosted: () => usagePostChain,
    // The in-flight model-catalog snapshot POST — the same kind of seam.
    whenModelSnapshotPosted: () => modelSnapshotChain,
    // The in-flight queued-lane read — same kind of seam.
    whenQueueLaneRefreshed: () => queueLaneRefreshChain,
    // Test seams / observability.
    _getState: () => ({
      hasClient: !!client,
      hasSession: !!session,
      appliedModel: appliedModel(),
      // The confirmed reasoning effort (null = the model's default).
      appliedEffort: modelSwitch.current().effort,
      lastActivityAt,
      // 'delivered' | 'continuation' | '' — which kind of turn, if any, owns
      // the runtime-event stream right now.
      activeTurnKind: activeTurn?.kind || '',
      // Settled turns whose relay publishes have not all landed yet.
      publishingTurnCount: publishingTurns.size,
      backgroundShells: backgroundShells.live(),
      continuationDueSince,
      compacting: isCompacting(),
      pendingHumanRequests,
      sessionRpc: { ...sessionRpc },
      activeEntries: activeTurn
        ? activeTurn.entries.map((entry) => ({
            id: entry.message?.id || null,
            role: entry.role,
            runtimeId: entry.runtimeId,
            consumed: entry.consumed,
            delivery: entry.delivery,
            settled: entry.settled,
            foldedInto: entry.foldedInto?.message?.id || null,
          }))
        : [],
    }),
    _evaluateLifecycle: evaluateLifecycle,
  };
}
