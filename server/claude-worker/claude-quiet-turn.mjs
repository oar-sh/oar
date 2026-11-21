// A running Claude turn that went quiet, and an interrupt the CLI does not
// act on: what the session process (claude-session-process.mjs) does about
// both. That module owns the process and its contexts; this one keeps the
// clocks and decides. Everything it touches of the process is passed in or
// read off `getProc()`, the current CLI process record.
//
// Like the other workers, this one ends a turn whose runtime has been silent
// for too long (shared/worker-runtime/turn-liveness.mjs). What the CLI sends
// is known (SDK 0.3.283, measured 2026-09-28): a `tool_progress` heartbeat
// every 30 s while a tool runs in silence, for the Agent call as a whole when
// the tool runs inside a subagent; a `thinking_tokens` or stream frame about
// every second while the model works; an `api_retry` before each backoff.
//
// From 2026-09-29 the worker only logged a turn that outlasted its window,
// to learn how long the CLI's silent stretches get in real sessions. Seven
// weeks of those logs on two relays (about 380,000 worker lines) hold nine
// such lines. Seven were the host waking from sleep with a turn open: the
// silence was the sleep, and the CLI spoke within two seconds. Two were
// turns that never spoke again. One of them (2026-11-18, Windows): the CLI's
// fifth request after a wake sat on a socket that never connected, no
// timeout of the CLI covered that, and the turn, with three messages
// steered into it, stayed open until a person pressed Stop 48 minutes
// later. No turn was silent past its window on a host that was awake and
// then went on.
//
// So silence past the window ends the turn, in two steps, because ending it
// must not cost more than it has to. First the CLI is asked to interrupt the
// turn: a CLI that still works ends it with a result, and keeps its process
// and its background tasks. A CLI that does not end the turn within
// `interruptGraceMs` is stopped (reapUnendedInterrupt), and the next message
// starts a new one on the same session. Silence with a known reason is not
// counted (quietHoldReason), and neither is the time the host slept
// (noteClockJump).

import {
  createTurnLiveness,
  createTurnStalledError,
  resolveTurnStallWindows,
} from '../../shared/worker-runtime/turn-liveness.mjs';
import { attemptFields, isStaleAttemptError } from './claude-turn-publisher.mjs';

// The longest wait an `api_retry` may hold the quiet-turn clock for.
export const MAX_API_RETRY_HOLD_MS = 60 * 60_000;

// How many rows handed back from a silent CLI are remembered, so that the
// second time one of them meets a silent CLI it fails instead of going round
// again (handBackSilentDeliveries).
const SILENT_HAND_BACKS_KEPT = 200;

/**
 * `getProc()` is the session's current CLI process record (or null);
 * `isCompacting`, `syncDeliveryReadiness`, `hardAbortProcess` and
 * `closeContext(ctx, handled)` are the session process's own.
 *
 * `quietTurnWindowsMs`: how long a RUNNING turn may go without a message from
 * the CLI before it is ended, `{ model, tool }` in ms; 0 for either turns it
 * off. `interruptGraceMs`: how long the CLI has to end a turn it was asked to
 * interrupt (the user's Stop, or this watchdog) before it is stopped; an
 * interrupted turn normally ends within a second; 0 = never. `clockJumpMs`: a
 * gap between two lifecycle ticks above this is the host having slept (or the
 * worker having been blocked); default four ticks, at least 30 s.
 */
export function createClaudeQuietTurnWatch({
  getProc,
  api,
  publisher,
  controlPoller = null,
  dbg = () => {},
  env = process.env,
  quietTurnWindowsMs = undefined,
  interruptGraceMs = 60_000,
  clockJumpMs = undefined,
  lifecyclePollMs = 5_000,
  isCompacting = () => false,
  syncDeliveryReadiness = () => {},
  hardAbortProcess,
  closeContext,
} = {}) {
  const windows = (() => {
    const resolved = resolveTurnStallWindows({
      // The CLI gives up on a silent model stream by itself after 300 s and
      // says so (`api_retry`); a window of the same length would race it.
      modelMs: quietTurnWindowsMs?.model ?? env?.OAR_TURN_STALL_MODEL_MS ?? 600_000,
      toolMs: quietTurnWindowsMs?.tool,
      env,
    });
    return { idle: 0, model: resolved.model, tool: resolved.tool };
  })();

  const clockJumpThresholdMs = Number(clockJumpMs) > 0
    ? Number(clockJumpMs)
    : Math.max(lifecyclePollMs * 4, 30_000);

  // Rows on their way back to the queue (handBack), reported to the heartbeat
  // until the relay has them: unreported, a heartbeat in the gap would take
  // the row for abandoned.
  const handingBack = new Map();
  // Ids of rows handed back because the CLI was silent since their push.
  const silentHandBacks = new Set();

  /**
   * What a new CLI process record carries for this module: what the CLI has
   * in flight, when its silence was logged, until when an `api_retry` said it
   * waits, relay tool calls in flight in this worker, the last lifecycle tick
   * (noteClockJump), whether the CLI is replaced once idle (a turn of it was
   * ended quiet), and how many messages the CLI has sent (a pushed entry
   * notes the count as `cliMessagesAtPush`: handBackSilentDeliveries).
   */
  function newProcessState() {
    return {
      liveness: createTurnLiveness({ windows }),
      cliMessages: 0,
      quietLoggedAt: 0,
      quietHoldUntil: 0,
      relayToolCalls: 0,
      lifecycleTickAt: 0,
      recycleWhenIdle: false,
    };
  }

  /** Every message of the CLI: a sign of life, and what it has in flight. */
  function observe(sdkMessage) {
    const proc = getProc();
    const liveness = proc?.liveness;
    if (!liveness) return;
    proc.cliMessages += 1;
    const type = String(sdkMessage?.type || '');
    const agent = String(sdkMessage?.parent_tool_use_id || '').trim() || 'root';
    if (proc.quietLoggedAt) {
      dbg(`the CLI spoke again after ${Math.round(liveness.quietMs() / 1000)}s of silence`, type);
      proc.quietLoggedAt = 0;
    }
    liveness.traffic(type === 'system' ? `system/${sdkMessage?.subtype || ''}` : type);
    // The main agent is at work under a context that was opened for a card
    // (canUseTool): from here it is a turn like any other.
    if (proc.activeCtx?.openedForCard && !sdkMessage?.parent_tool_use_id
      && (type === 'assistant' || type === 'stream_event' || type === 'user')) {
      proc.activeCtx.openedForCard = false;
    }
    // A retry says how long the CLI waits before it asks again: silent until
    // then by its own announcement, so the window counts from the end of it.
    if (type === 'system' && sdkMessage?.subtype === 'api_retry') {
      const waitMs = Math.min(Math.max(0, Number(sdkMessage.retry_delay_ms) || 0), MAX_API_RETRY_HOLD_MS);
      proc.quietHoldUntil = Math.max(proc.quietHoldUntil, Date.now() + waitMs);
    }
    const blocks = Array.isArray(sdkMessage?.message?.content) ? sdkMessage.message.content : [];
    if (type === 'assistant') {
      for (const block of blocks) {
        if (block?.type === 'tool_use' && block.id) liveness.begin('tool', `${agent}:${block.id}`, block.name);
      }
    } else if (type === 'user') {
      for (const block of blocks) {
        if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
        liveness.end('tool', `${agent}:${block.tool_use_id}`);
        // The result of an Agent call: whatever that agent had open ended with it.
        liveness.endAgent(String(block.tool_use_id));
      }
    } else if (type === 'stream_event') {
      const event = String(sdkMessage?.event?.type || '');
      if (event === 'message_start') liveness.begin('model', agent);
      else if (event === 'message_stop') liveness.end('model', agent);
    } else if (type === 'result') {
      liveness.reset();
    }
  }

  /**
   * The relay's tools run inside this worker (claude-sdk-adapter.mjs hands
   * them this helper). While one of their requests is open (a `relay_tool`
   * wait, an approval card) the CLI has nothing to say, and the quiet-turn
   * check counts that as this worker's wait (quietHoldReason).
   */
  function relayToolApi(processRef) {
    if (typeof api !== 'function') return api;
    return async (...args) => {
      processRef.relayToolCalls += 1;
      try {
        return await api(...args);
      } finally {
        processRef.relayToolCalls -= 1;
        processRef.liveness.traffic('relay-tool');
      }
    };
  }

  /**
   * Why the CLI's silence does not count right now ('' when it does): a human
   * is deciding (a question or permission card), a compaction is running, a
   * relay tool call is waiting on the relay inside this worker (a
   * `relay_tool` wait, an approval card), the relay is slow to take a publish
   * (the stream is not read meanwhile), or the CLI said it waits before its
   * next API attempt.
   */
  function quietHoldReason(proc, now) {
    if (proc.pendingControlRequests > 0) return 'question';
    if (isCompacting()) return 'compaction';
    if (proc.relayToolCalls > 0) return 'relay-tool';
    if (proc.dispatching > 0) return 'publish';
    if (now < proc.quietHoldUntil) return 'api-retry';
    return '';
  }

  /**
   * End a running turn the CLI has said nothing in for longer than its phase
   * allows, unless the silence has a known reason.
   */
  function checkQuietTurn(proc, now) {
    const liveness = proc.liveness;
    const ctx = proc.activeCtx;
    if (!liveness || !ctx || ctx.finalized || proc.closing || proc.aborted) return;
    // Being stopped already, by the user or by this check: what bounds that
    // is reapUnendedInterrupt.
    if (ctx.interrupted) return;
    // A provisional adoption has its own way out of silence
    // (reapSilentProvisionalAdoption), and a context opened for a question
    // card between turns has no turn of the CLI behind it yet: an interrupt
    // would end nothing, and the grace would then stop an idle, healthy CLI.
    if (ctx.adoptedFromCompaction || ctx.openedForCard) return;
    const held = quietHoldReason(proc, now);
    if (held) {
      liveness.traffic(`held:${held}`);
      return;
    }
    // Inside a turn the CLI is waiting for the model unless a tool is open.
    const phase = liveness.phase() === 'tool' ? 'tool' : 'model';
    const limitMs = windows[phase];
    const quietMs = liveness.quietMs();
    if (!(limitMs > 0) || quietMs < limitMs) return;
    proc.quietLoggedAt = now;
    dbg(
      `running turn quiet for ${Math.round(quietMs / 1000)}s; ending it`,
      ctx.message?.id || '(continuation)',
      liveness.describe(),
    );
    endQuietTurn(proc, ctx, createTurnStalledError({
      agentLabel: 'Claude',
      quietMs,
      phase: liveness.phase(),
      tools: liveness.toolsInFlight(),
    }));
  }

  /**
   * What was steered into a turn the quiet-turn watchdog ends got no answer
   * from it. If the CLI opens no turn afterwards (activateContext takes the
   * mark away again), these messages go back to the queue (handBack) instead
   * of settling as answered.
   */
  function markStalledSteers(processRef) {
    for (const entry of processRef.pendingDelivered) {
      if (entry.steered && !entry.stoppedWithTurn) entry.stalledWithTurn = true;
    }
  }

  /**
   * The first step: ask the CLI to interrupt the turn. Its result then closes
   * the context as a stalled turn (finalizeStalled); without one, the grace
   * runs out and the CLI is stopped (reapUnendedInterrupt). No Stop guard is
   * armed: a turn the CLI opens afterwards for messages steered into this one
   * is wanted.
   */
  function endQuietTurn(processRef, ctx, error) {
    ctx.stalled = error;
    markStalledSteers(processRef);
    ctx.interrupted = true;
    ctx.interruptedAt = Date.now();
    syncDeliveryReadiness();
    ctx.interruptDone = Promise.resolve()
      .then(() => processRef.turn.interrupt())
      .catch((interruptError) => {
        // The interrupt of a CLI this worker has stopped meanwhile ends as
        // aborted: the stop's own echo, not a second failure.
        if (processRef.aborted) return;
        dbg('interrupt of the quiet turn failed, aborting process', interruptError?.message || String(interruptError));
        if (getProc() === processRef) hardAbortProcess();
      });
  }

  /**
   * An interrupted turn the CLI has not ended. The CLI acknowledges an
   * interrupt at once, but only the turn's result closes the context, and a
   * CLI whose turn is stuck sends none (2026-11-18: 0.4 s after the Stop
   * one `system` message, then nothing; its transcript shows neither the
   * interrupt nor a dequeue of the three messages it still held). Until then
   * the context holds the session: no delivery is taken, and what was steered
   * into the turn stays `processing`. So past the grace the CLI is stopped.
   * cleanupProcess settles the turn (stopped, or stalled), and the next
   * delivery starts a new CLI on the same session.
   */
  function reapUnendedInterrupt(proc, now) {
    if (!(interruptGraceMs > 0) || proc.aborted) return;
    const ctx = proc.activeCtx;
    const turnOpen = Boolean(ctx?.interrupted && ctx.interruptedAt && !ctx.finalized);
    // The follow-up turn the Stop guard interrupted at its init has no
    // context, and holds the session the same way until its result.
    const followUpOpen = proc.suppressingTurn && proc.suppressingSince > 0;
    if (!turnOpen && !followUpOpen) return;
    // The result may be waiting behind a publish of this worker.
    if (proc.dispatching > 0) {
      if (turnOpen) ctx.interruptedAt = now;
      if (followUpOpen) proc.suppressingSince = now;
      return;
    }
    const since = turnOpen ? ctx.interruptedAt : proc.suppressingSince;
    if (now - since < interruptGraceMs) return;
    dbg(
      `the CLI did not end the interrupted turn within ${Math.round(interruptGraceMs / 1000)}s; stopping it`,
      turnOpen ? (ctx.message?.id || '(continuation)') : '(follow-up of stopped steers)',
      proc.liveTasks.size ? `background tasks lost: ${proc.liveTasks.size}` : '',
    );
    hardAbortProcess();
  }

  /**
   * The lifecycle timer did not run for much longer than its interval: the
   * host slept, or this process was blocked. The CLI could not speak either,
   * so every clock that counts its silence starts over, and it gets the whole
   * window to show that it still works (on a wake the seven healthy turns of
   * the header spoke within two seconds). A wall clock set back is the same
   * case with a negative gap.
   */
  function noteClockJump(proc, gapMs, now) {
    dbg(gapMs < 0
      ? `the wall clock went back ${Math.round(-gapMs / 1000)}s between two lifecycle ticks; the quiet clocks start over`
      : `${Math.round(gapMs / 1000)}s passed between two lifecycle ticks (the host slept, or the worker was blocked); the quiet clocks start over`);
    proc.liveness.traffic('clock-jump');
    // An announced retry wait is never longer than its cap from now.
    proc.quietHoldUntil = Math.min(proc.quietHoldUntil, now + MAX_API_RETRY_HOLD_MS);
    const ctx = proc.activeCtx;
    if (ctx?.interruptedAt && !ctx.finalized) ctx.interruptedAt = now;
    if (proc.suppressingSince) proc.suppressingSince = now;
    for (const entry of proc.pendingDelivered) {
      entry.unattachedSince = 0;
      entry.foldSince = 0;
    }
  }

  /**
   * One lifecycle tick of the session process: the clock-jump check first
   * (backwards counts as well: every clock measured from the old time would
   * otherwise run late by that much), then the two checks that may stop the
   * CLI. The caller looks at `proc.aborted` afterwards.
   */
  function tick(now = Date.now()) {
    const proc = getProc();
    if (!proc) return;
    const gapMs = proc.lifecycleTickAt ? now - proc.lifecycleTickAt : 0;
    proc.lifecycleTickAt = now;
    if (gapMs > clockJumpThresholdMs || gapMs < 0) noteClockJump(proc, gapMs, now);
    checkQuietTurn(proc, now);
    reapUnendedInterrupt(proc, now);
  }

  /**
   * The quiet-turn watchdog had asked the CLI to end the `outgoing` turn when
   * the CLI took a steer into it (an absorbed-steering hand-off). It is one
   * turn: the interrupt on its way ends it under the steer's context `ctx`,
   * which fails as stalled in the outgoing one's place and stays bound by the
   * same grace.
   */
  function carryStall(outgoing, ctx) {
    if (!outgoing.stalled) return;
    ctx.stalled = outgoing.stalled;
    ctx.interrupted = true;
    ctx.interruptedAt = outgoing.interruptedAt;
    markStalledSteers(getProc());
  }

  /**
   * Settle a turn the watchdog ended: its failure on the turn's own row,
   * above what it had written (a continuation that never got a row has
   * nowhere to say it), then the context closes. No usage reads: that is a
   * control request to a CLI that just hung. `streamEnded`: the CLI went with
   * the turn, stopped by the worker when it did not end it (`cliStopped`) or
   * gone by itself; otherwise this is the interrupt's result, and a CLI that
   * went quiet once is replaced when nothing is left in it.
   */
  async function finalizeStalled(ctx, { model = null, streamEnded = false, cliStopped = false, lostTasks = 0 } = {}) {
    if (!ctx.discarded && ctx.message?.id) {
      const written = String(ctx.state.lastStreamedText || ctx.normalizer.finalStreamText() || '').trim();
      await publisher.publishFinalStream(ctx.message, written);
      await publisher.publishTurnStalled({
        message: ctx.message,
        error: ctx.stalled,
        partialText: written,
        model: model || null,
        cliStopped,
        lostTasks,
      });
    }
    const proc = getProc();
    if (!streamEnded && proc) proc.recycleWhenIdle = true;
    closeContext(ctx, true);
  }

  /**
   * A steered message past the fold grace: '' when it is not one the watchdog
   * marked (the ordinary fold applies). Marked, the turn it was steered into
   * answered nothing, so "merged into it" would be a lie:
   *
   *  - 'hand-back': the CLI is to be stopped and the message handed back
   *    (stopForUnansweredSteers; cleanupProcess does the hand-back);
   *  - 'stopped': background tasks live in this CLI, and it obeyed the
   *    interrupt. Stopping it for a message it did not pick up would cost
   *    them, and the quiet turn's note already said the CLI stays. The
   *    message settles as stopped with the turn, unanswered, and the client
   *    offers to send it again.
   */
  function unansweredSteer(entry) {
    if (!entry.stalledWithTurn || entry.stoppedWithTurn) return '';
    const proc = getProc();
    if (!proc.liveTasks.size) return 'hand-back';
    dbg(
      'the CLI opened no turn for a message steered into the quiet turn; settling it as stopped',
      entry.ctx.message?.id || '(no id)',
      `background tasks kept: ${proc.liveTasks.size}`,
    );
    entry.stalledWithTurn = false;
    entry.stoppedWithTurn = true;
    return 'stopped';
  }

  /**
   * The CLI ended the quiet turn when asked, but opened no turn for what was
   * steered into it, and still holds those messages in its own queue.
   * Delivered again into this process they could run twice, so it is stopped;
   * cleanupProcess hands them back, and they run on a new one. Nothing else
   * lives in it (unansweredSteer).
   */
  function stopForUnansweredSteers() {
    if (getProc()?.aborted) return;
    dbg('the CLI opened no turn for the messages steered into the quiet turn; stopping it');
    hardAbortProcess();
  }

  /**
   * At the end of a CLI process: the pending entries that go back to the
   * queue, claimed for the heartbeat at once. Those the watchdog marked, and
   * everything that waited unattached behind a turn it ended (a continuation
   * that went quiet: the CLI never opened a turn for them). Not the steers the
   * user stopped with the turn.
   */
  function takeUnanswered(processRef, stoppedSteers = []) {
    const quietEnd = Boolean(processRef.activeCtx?.stalled);
    const entries = processRef.pendingDelivered
      .filter((entry) => (entry.stalledWithTurn || quietEnd) && !entry.ctx.finalized && !stoppedSteers.includes(entry));
    for (const entry of entries) claim(entry);
    return entries;
  }

  function claim(entry) {
    const id = String(entry.ctx.message?.id || '').trim();
    if (id) handingBack.set(id, entry.ctx.message);
  }

  /**
   * A message the CLI will not answer, through no decision of anyone: steered
   * into a turn the watchdog ended, or pushed to a CLI that never spoke
   * again. Back to the queue with no retry penalty (the class a held steer
   * goes back with): the relay delivers it again, to a new CLI on the same
   * session. Unlike a steer the user stopped with the turn, nobody decided
   * that this message should not run.
   */
  async function handBack(entry) {
    const ctx = entry.ctx;
    const id = String(ctx.message?.id || '').trim();
    if (ctx.finalized) {
      handingBack.delete(id);
      return;
    }
    ctx.finalized = true;
    controlPoller?.stop?.(ctx.controlState);
    dbg('the CLI will not answer this message; handing it back to the queue', id || '(no id)');
    if (id) {
      handingBack.set(id, ctx.message);
      await api('POST', '/api/requeue', {
        messageId: id,
        class: 'steering-held',
        ...attemptFields(ctx.message),
      }).catch((error) => {
        if (isStaleAttemptError(error)) dbg('quiet-turn hand-back refused as stale_attempt', id);
        else dbg('quiet-turn hand-back failed', id, error?.message || String(error));
      });
      handingBack.delete(id);
    }
    closeContext(ctx, false);
  }

  /** In push order, after the quiet turn's own failure. */
  async function handBackAll(entries) {
    for (const entry of entries) {
      await handBack(entry).catch((error) => {
        dbg('quiet-turn hand-back failed', error?.message || String(error));
      });
    }
  }

  /**
   * The pending-delivered watchdog fired for `stale` entries: the CLI opened
   * no turn for them in time. When it has also said nothing at all since such
   * a message was pushed, it is not a CLI that dropped a message but one that
   * hangs between turns (live: a suspended CLI). Failing the row and keeping
   * that CLI made every later message wait out the same timeout and fail the
   * same way. So the CLI is stopped and the row goes back to the queue, to
   * run on a new one, together with everything else still pending in it.
   *
   * Once per row: a row that meets a silent CLI a second time fails as it
   * always did (the CLI is still stopped). Returns the entries the caller
   * fails.
   */
  function handBackSilentDeliveries(stale) {
    const proc = getProc();
    // Counted, not timed: a message in the push's own millisecond is a sign of life.
    const silent = stale.filter((entry) => entry.cliMessagesAtPush === proc.cliMessages);
    if (!silent.length || proc.aborted) return stale;
    const idOf = (entry) => String(entry.ctx.message?.id || '').trim();
    const first = silent.filter((entry) => idOf(entry) && !silentHandBacks.has(idOf(entry)));
    dbg(
      'the CLI has said nothing since a message was pushed; stopping it',
      silent.map((entry) => idOf(entry) || '(no id)').join(','),
      first.length < silent.length ? 'not handed back a second time' : '',
    );
    for (const entry of first) {
      silentHandBacks.add(idOf(entry));
      if (silentHandBacks.size > SILENT_HAND_BACKS_KEPT) silentHandBacks.delete(silentHandBacks.values().next().value);
      claim(entry);
    }
    // What else waits in this CLI was not answered either (takeUnanswered).
    for (const entry of proc.pendingDelivered) entry.stalledWithTurn = true;
    hardAbortProcess();
    void handBackAll(first);
    return stale.filter((entry) => !first.includes(entry));
  }

  return {
    windows,
    newProcessState,
    observe,
    relayToolApi,
    tick,
    carryStall,
    finalizeStalled,
    unansweredSteer,
    stopForUnansweredSteers,
    takeUnanswered,
    handBackAll,
    handBackSilentDeliveries,
    /** The rows on their way back to the queue, for the heartbeat. */
    handingBackMessages: () => [...handingBack.values()],
  };
}
