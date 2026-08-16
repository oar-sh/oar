import { buildClaudeUserContent } from './claude-attachments.mjs';
import { createSdkMessageNormalizer } from './sdk-message-normalizer.mjs';
import {
  startClaudeSession,
  createCanUseTool,
  readContextUsage,
  readPlanUsage,
  normalizeClaudeEffort,
  permissionModeForRelayMode,
} from './claude-sdk-adapter.mjs';
import { relocateClaudeTranscriptForCwd } from './claude-transcript-relocator.mjs';
import { createClaudeTurnPublisher } from './claude-turn-publisher.mjs';
import { createAskUserBridge } from '../../shared/ask-user-bridge.mjs';

/**
 * Which system-prompt append a relay mode gets (claude-sdk-adapter's
 * MODE_SYSTEM_PROMPT_APPEND). The append is fixed at process spawn, so a mode
 * change across turns only forces a process recycle when the append class
 * differs AND nothing (background tasks, queued continuations) would die with
 * the process; otherwise the turn runs with the previous append and the
 * functionally important switch (permission mode) is applied live.
 */
function modeAppendClass(relayMode) {
  const mode = String(relayMode || 'agent').trim().toLowerCase();
  return mode === 'ask' || mode === 'autopilot' ? mode : 'none';
}

/** The text a user content payload streams as — the replay-matching key. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text || ''))
    .join('\n');
}

/**
 * A turn-opening user message in the SDK stream: top-level (not a subagent's),
 * carrying prompt text rather than tool_result blocks. Both our own pushed
 * messages and the CLI's task-notification continuations replay this way.
 */
function turnOpeningUserText(sdkMessage) {
  if (sdkMessage?.type !== 'user' || sdkMessage?.parent_tool_use_id) return null;
  const content = sdkMessage?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((block) => block?.type === 'tool_result')) return null;
  const text = contentText(content);
  return text || null;
}

/**
 * The bookkeeping result a resumed session emits after replaying an
 * orphaned-task notification: zero API work, nothing to publish. Detected at
 * the process level (in addition to the normalizer's own skip) so it can never
 * open or close a turn context.
 */
function isPhantomResult(sdkMessage) {
  return sdkMessage?.type === 'result'
    && sdkMessage.subtype === 'success'
    && sdkMessage.is_error !== true
    && Number(sdkMessage.num_turns) === 0
    && Number(sdkMessage.duration_api_ms) === 0;
}

/**
 * Run a relay conversation against ONE persistent Claude CLI process.
 *
 * The pre-existing runner spawned a CLI per turn and held its stdin open
 * ("input gate linger") while background subagents ran — which meant
 * backgrounded Bash/Monitor tasks died seconds after each reply and their
 * "you will be notified" continuations never happened (incident conv
 * `2353a9eb`). Here the process outlives turns: delivered relay messages are
 * pushed into the same streaming-input query, background tasks keep running
 * between turns, and the continuation turns the CLI dequeues when a task
 * settles are published as their own relay turns (synthetic queue rows via
 * POST /api/continuation-turn).
 *
 * Lifecycle: the process stays alive while a turn is active or queued, any
 * background task is live, a settled task's continuation is still due, or a
 * canUseTool round-trip (question / permission) is pending. With none of
 * those it idles out after `idleShutdownMs` and the CLI exits; the next
 * delivered message respawns it with `resume`. `getBackgroundTaskTimeoutMs`
 * (0 = unlimited) caps how long tasks alone may hold the process — on expiry
 * every live task is stopped via the SDK and the wind-down proceeds through
 * the normal notification/continuation path.
 */
export function createClaudeSessionRunner({
  api,
  sdkSessionId,
  cwd,
  defaultModel = '',
  controlPoller,
  pathToClaudeCodeExecutable = '',
  startClaudeSessionImpl = startClaudeSession,
  readContextUsageImpl = readContextUsage,
  readPlanUsageImpl = readPlanUsage,
  relocateTranscriptImpl = relocateClaudeTranscriptForCwd,
  idleShutdownMs = 10 * 60_000,
  getBackgroundTaskTimeoutMs = () => 0,
  lifecyclePollMs = 5_000,
  // A settled task's continuation normally begins within ~1s; when nothing
  // arrives inside this window the notification was silent (skip_transcript)
  // and must stop pinning the process.
  notificationGraceMs = 60_000,
  continuationRetryDelayMs = 500,
  askUserBridgeOptions = {},
  dbg = () => {},
} = {}) {
  const publisher = createClaudeTurnPublisher({ api, dbg });
  let claudeNativeSessionId = '';
  let proc = null;

  async function persistNativeSessionId(conversationId, sessionId) {
    const normalized = String(sessionId || '').trim();
    if (!normalized || normalized === claudeNativeSessionId) return;
    try {
      await api('POST', '/api/claude-native-session', {
        conversationId,
        claudeNativeSessionId: normalized,
      });
      // Only cache after the server accepted it, so a failed persist is
      // retried on the next init — resume across worker restarts depends on
      // the server-side copy.
      claudeNativeSessionId = normalized;
    } catch (error) {
      dbg('claude native session persist failed', error?.message || String(error));
    }
  }

  function resolvePerTurnModel(message) {
    // Per-message model wins so the composer can switch Claude models between
    // turns; the conversation's provider model and worker default are fallbacks.
    const requestedModel = String(message.model || '').trim();
    const perTurnModel = requestedModel.toLowerCase() !== 'auto' && requestedModel.toLowerCase().startsWith('claude-')
      ? requestedModel
      : '';
    return perTurnModel
      || String(message.providerModel || '').trim()
      || defaultModel;
  }

  function getActiveQueueMessageId() {
    if (!proc) return '';
    return String(proc.activeCtx?.message?.id || proc.pendingDelivered[0]?.ctx.message?.id || '');
  }

  // Every queue row this worker currently owes work for: the running turn
  // (delivered or continuation) plus any delivered message queued behind it.
  // The heartbeat reports all of them so the server's owner-recovery never
  // replays a row the process still holds.
  function getActiveQueueMessageIds() {
    if (!proc) return [];
    return [
      proc.activeCtx?.message?.id,
      ...proc.pendingDelivered.map((entry) => entry.ctx.message?.id),
    ].map((id) => String(id || '').trim()).filter(Boolean);
  }

  function isTurnActive() {
    return Boolean(proc && (proc.activeCtx || proc.pendingDelivered.length));
  }

  // ---------------------------------------------------------------------------
  // Turn contexts

  function createContext(kind, message) {
    return {
      kind, // 'delivered' | 'continuation'
      message,
      normalizer: createSdkMessageNormalizer(),
      state: {
        result: null,
        resultTexts: [],
        lastStreamedText: '',
        responseModel: '',
        contextUsage: null,
        planUsage: null,
        modelUsage: null,
      },
      planBoardPosted: false,
      interrupted: false,
      discarded: false,
      registered: kind === 'delivered',
      bufferedActions: [],
      controlState: null,
      finalized: false,
      resolveDone: null,
      rejectDone: null,
      done: null,
    };
  }

  function createDeliveredContext(message) {
    const ctx = createContext('delivered', message);
    ctx.done = new Promise((resolve, reject) => {
      ctx.resolveDone = resolve;
      ctx.rejectDone = reject;
    });
    return ctx;
  }

  function activateContext(ctx) {
    proc.activeCtx = ctx;
    proc.lastBoundary = null;
    proc.notificationPendingAt = 0;
    ctx.controlState = controlPoller?.start?.({
      queueMessageId: ctx.message?.id || '',
      onAbortTurn: () => interruptActiveTurn(ctx),
    }) || null;
    // Orphan/settled-task notification lines that arrived between turns belong
    // to the turn they triggered.
    const carried = proc.pendingActivities.splice(0);
    if (carried.length) {
      const actions = carried.map((text) => ({ channel: 'activity', payload: { text, subagentRunId: null } }));
      if (ctx.registered) {
        (async () => {
          for (const action of actions) await publisher.dispatchAction(ctx.message, action, ctx.state);
        })().catch(() => {});
      } else {
        ctx.bufferedActions.push(...actions);
      }
    }
  }

  function attachDeliveredContext() {
    const entry = proc.pendingDelivered.shift();
    activateContext(entry.ctx);
    return entry.ctx;
  }

  /**
   * The CLI started a turn on its own (a background task's notification).
   * Register a synthetic relay turn for it; actions buffer until the server
   * hands back a message id, then flush in order. A failed registration
   * discards the turn's relay output (it still lands in the native
   * transcript) rather than failing the process.
   */
  function openContinuationContext() {
    const ctx = createContext('continuation', {
      id: null,
      conversationId: sdkSessionId,
      relayMode: proc.relayMode,
      model: '',
    });
    ctx.registered = false;
    activateContext(ctx);
    (async () => {
      let response = null;
      for (let attempt = 0; attempt < 3 && !response; attempt += 1) {
        response = await api('POST', '/api/continuation-turn', {
          conversationId: sdkSessionId,
          sdkSessionId,
          relayMode: ctx.message.relayMode,
          trigger: 'background_task',
        }).catch((error) => {
          dbg('continuation turn registration failed', error?.message || String(error));
          return null;
        });
        if (!response) await new Promise((resolve) => setTimeout(resolve, continuationRetryDelayMs));
      }
      if (!response?.messageId) {
        ctx.discarded = true;
        ctx.bufferedActions = [];
        controlPoller?.stop?.(ctx.controlState);
        ctx.controlState = null;
        dbg('continuation turn discarded (no relay message id)');
        return;
      }
      ctx.message.id = String(response.messageId);
      // Restart the control poller now that the turn has its real queue id.
      controlPoller?.stop?.(ctx.controlState);
      ctx.controlState = controlPoller?.start?.({
        queueMessageId: ctx.message.id,
        onAbortTurn: () => interruptActiveTurn(ctx),
      }) || null;
      // Drain in arrival order; anything the consumer adds while a batch is in
      // flight keeps buffering (registered is still false) so a later action
      // can never overtake an earlier one.
      while (ctx.bufferedActions.length) {
        const batch = ctx.bufferedActions.splice(0);
        for (const action of batch) {
          await publisher.dispatchAction(ctx.message, action, ctx.state);
          if (action.channel === 'result') await finalizeContext(ctx);
        }
      }
      ctx.registered = true;
    })().catch((error) => {
      dbg('continuation flush failed', error?.message || String(error));
    });
    return ctx;
  }

  /** Wait until a continuation context has its relay queue row (or gave up). */
  async function waitForContextRegistration(ctx, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!ctx.registered && !ctx.discarded && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Decide which turn context an SDK message belongs to, opening or attaching
   * one when the message begins a turn. Delivered turns attach on their user
   * replay (matched by text) or, when no replay precedes assistant traffic, on
   * that traffic; anything the CLI starts by itself becomes a continuation.
   */
  function resolveContext(sdkMessage) {
    if (proc.activeCtx) return proc.activeCtx;
    const type = String(sdkMessage?.type || '');

    const openingText = turnOpeningUserText(sdkMessage);
    if (openingText !== null) {
      const expected = proc.pendingDelivered[0]?.expectedText;
      if (expected !== undefined && openingText === expected) return attachDeliveredContext();
      // A turn the CLI opened on its own (task-notification replay). The
      // context opens lazily on its first real traffic so a bookkeeping
      // replay that ends in a phantom result never creates a relay turn.
      proc.lastBoundary = 'self-opened';
      return null;
    }

    if (type === 'assistant' || type === 'stream_event' || type === 'user') {
      if (proc.lastBoundary !== 'self-opened') {
        if (proc.pendingDelivered.length) return attachDeliveredContext();
        // Between-turn chatter — a background subagent's stream, a stray
        // top-level tool_result — is not a turn of its own. Only traffic that
        // follows a self-opened boundary (the CLI's task-notification replay)
        // may open a continuation; without that boundary there is no top-level
        // result coming to ever close the context, and an open context wedges
        // the process. The dropped frames still land in the native transcript.
        return null;
      }
      return openContinuationContext();
    }

    if (type === 'result') {
      if (isPhantomResult(sdkMessage)) {
        proc.lastBoundary = null;
        return null;
      }
      if (proc.lastBoundary !== 'self-opened' && proc.pendingDelivered.length) return attachDeliveredContext();
      if (proc.lastBoundary === 'self-opened') return openContinuationContext();
      return null;
    }

    return null;
  }

  async function dispatchToContext(ctx, action) {
    // Background-task membership is process state, observed from the raw
    // stream; the normalizer's mirror actions must not reach the relay APIs.
    if (action.channel === 'background_tasks' || action.channel === 'background_task_settled') return;
    if (ctx.discarded) {
      // The turn's relay output is deliberately dropped, but the turn still
      // ends: its result must release the active slot, or every later message
      // routes into this dead context and the process can never idle out.
      if (action.channel === 'result') closeContext(ctx, false);
      return;
    }
    if (!ctx.registered) {
      ctx.bufferedActions.push(action);
      return;
    }
    await publisher.dispatchAction(ctx.message, action, ctx.state);
    if (action.channel === 'result') await finalizeContext(ctx);
  }

  async function finalizeContext(ctx) {
    if (ctx.finalized) return;
    ctx.finalized = true;
    controlPoller?.stop?.(ctx.controlState);
    // A late continuation flush can land after the process died; usage reads
    // and model fallbacks must survive that.
    const turnRef = proc?.turn || null;
    const procModel = proc?.model || null;
    // The control transport is alive for the process's whole life now, but
    // the snapshot still belongs to this turn's finalize so the composer
    // indicator updates with each reply.
    const [contextUsage, planUsage] = await Promise.all([
      readContextUsageImpl(turnRef, dbg),
      readPlanUsageImpl(turnRef, dbg),
    ]);
    ctx.state.contextUsage = contextUsage;
    ctx.state.planUsage = planUsage;
    const responseModel = ctx.state.responseModel || procModel || null;
    await publisher.publishContextUsage({ message: ctx.message, state: ctx.state, model: procModel, sdkSessionId });
    await publisher.publishPlanUsage({ message: ctx.message, state: ctx.state, sdkSessionId });

    if (ctx.interrupted || proc?.aborted) {
      // Same shape as the per-turn runner's abort path: surface what streamed,
      // let the server-side abort control own the queue row's fate.
      await publisher.publishFinalStream(ctx.message, ctx.state.lastStreamedText);
    } else if (ctx.state.result?.isError) {
      await publisher.publishErrorResult({ message: ctx.message, state: ctx.state, responseModel });
    } else {
      await publisher.publishCompletedTurn({
        message: ctx.message,
        state: ctx.state,
        responseModel,
        planBoardPosted: ctx.planBoardPosted,
      });
    }
    closeContext(ctx, true);
  }

  /** The SDK stream ended while this turn was still open (no result seen). */
  async function finalizeContextOnStreamEnd(ctx, { aborted = false, model = null } = {}) {
    if (ctx.finalized) return;
    ctx.finalized = true;
    controlPoller?.stop?.(ctx.controlState);
    if (ctx.discarded) {
      closeContext(ctx, true);
      return;
    }
    if (ctx.interrupted || aborted) {
      await publisher.publishFinalStream(ctx.message, ctx.state.lastStreamedText);
      closeContext(ctx, true);
      return;
    }
    const fallbackText = String(ctx.state.lastStreamedText || ctx.normalizer.finalStreamText() || '').trim();
    if (fallbackText) {
      await publisher.publishFinalStream(ctx.message, fallbackText);
      await publisher.publishResponse(ctx.message, {
        text: fallbackText,
        model: ctx.state.responseModel || model || null,
      });
    } else if (ctx.message?.id) {
      await api('POST', '/api/requeue', { messageId: ctx.message.id }).catch(() => {});
    }
    closeContext(ctx, true);
  }

  function closeContext(ctx, handled) {
    if (proc && proc.activeCtx === ctx) {
      proc.activeCtx = null;
      proc.lastBoundary = null;
    }
    ctx.resolveDone?.(handled);
    evaluateLifecycle();
  }

  async function interruptActiveTurn(ctx) {
    ctx.interrupted = true;
    try {
      await proc.turn.interrupt();
    } catch (error) {
      // No interrupt support (or a dead transport): fall back to killing the
      // process, which is exactly the pre-persistent abort behavior.
      dbg('interrupt failed, aborting process', error?.message || String(error));
      hardAbortProcess();
    }
  }

  function hardAbortProcess() {
    if (!proc) return;
    proc.aborted = true;
    proc.abortController.abort();
  }

  // ---------------------------------------------------------------------------
  // Process-level stream observation

  /**
   * Ship the live task set (enriched with per-task progress) to the relay,
   * which renders it as the composer's background-tasks panel. Membership
   * changes post immediately; chatty progress updates are trailing-edge
   * throttled. Advisory: failures must never disturb the stream consumer.
   */
  function publishBackgroundTasks({ throttled = false } = {}) {
    const processRef = proc;
    if (!processRef) return;
    const send = () => {
      processRef.taskPublishTimer = null;
      const tasks = [...processRef.liveTasks.entries()].map(([taskId, task]) => ({
        taskId,
        taskType: task.taskType,
        description: task.description,
        startedAt: task.startedAt || null,
        summary: task.summary || null,
        lastToolName: task.lastToolName || null,
        totalTokens: task.totalTokens ?? null,
      }));
      api('POST', '/api/background-tasks', { conversationId: sdkSessionId, tasks }).catch((error) => {
        dbg('background task publish failed', error?.message || String(error));
      });
    };
    if (!throttled) {
      if (processRef.taskPublishTimer) {
        clearTimeout(processRef.taskPublishTimer);
        processRef.taskPublishTimer = null;
      }
      send();
      return;
    }
    if (processRef.taskPublishTimer) return;
    processRef.taskPublishTimer = setTimeout(send, 2_000);
    processRef.taskPublishTimer.unref?.();
  }

  function observeProcessLevel(sdkMessage) {
    const type = String(sdkMessage?.type || '');
    if (type !== 'system') return;
    const subtype = String(sdkMessage.subtype || '');
    if (subtype === 'init') {
      persistNativeSessionId(sdkSessionId, sdkMessage.session_id).catch(() => {});
      return;
    }
    if (subtype === 'background_tasks_changed') {
      const tasks = Array.isArray(sdkMessage.tasks) ? sdkMessage.tasks : [];
      const previous = proc.liveTasks;
      proc.liveTasks = new Map(tasks
        .filter((task) => String(task?.task_id || '').trim())
        .map((task) => {
          const taskId = String(task.task_id).trim();
          const known = previous.get(taskId) || {};
          return [taskId, {
            ...known,
            taskType: String(task?.task_type || '').trim() || known.taskType || '',
            description: String(task?.description || '').trim() || known.description || '',
            startedAt: known.startedAt || Date.now(),
          }];
        }));
      for (const taskId of proc.liveTasks.keys()) proc.knownTasks.add(taskId);
      publishBackgroundTasks();
      evaluateLifecycle();
      return;
    }
    if (subtype === 'task_started') {
      const taskId = String(sdkMessage.task_id || '').trim();
      if (!taskId) return;
      const known = proc.liveTasks.get(taskId);
      if (known) {
        known.description = String(sdkMessage.description || '').trim() || known.description;
        known.taskType = String(sdkMessage.task_type || '').trim() || known.taskType;
        publishBackgroundTasks({ throttled: true });
      }
      return;
    }
    if (subtype === 'task_progress') {
      const taskId = String(sdkMessage.task_id || '').trim();
      const known = taskId ? proc.liveTasks.get(taskId) : null;
      if (known) {
        known.summary = String(sdkMessage.summary || '').trim() || known.summary;
        known.lastToolName = String(sdkMessage.last_tool_name || '').trim() || known.lastToolName;
        const totalTokens = Number(sdkMessage.usage?.total_tokens);
        if (Number.isFinite(totalTokens)) known.totalTokens = totalTokens;
        publishBackgroundTasks({ throttled: true });
      }
      return;
    }
    if (subtype === 'task_notification') {
      const taskId = String(sdkMessage.task_id || '').trim();
      // A settled session-level task means the CLI is about to dequeue a
      // continuation turn — the process must not idle out under it.
      if (taskId && proc.knownTasks.has(taskId)) proc.notificationPendingAt = Date.now();
      if (!proc.activeCtx) {
        const status = String(sdkMessage.status || '').trim() || 'unknown';
        const summary = String(sdkMessage.summary || '').trim();
        proc.pendingActivities.push(`Background task ${taskId || 'unknown'} ${status}: ${summary}`.slice(0, 2000));
      }
      return;
    }
    if (subtype === 'session_state_changed') {
      evaluateLifecycle();
    }
  }

  async function onSdkMessage(processRef, sdkMessage) {
    // A superseded process (push-race respawn, mode-recycle timeout) may still
    // be draining its stream; its late messages must not mutate the state of
    // the process that replaced it. Its own open contexts are settled by
    // cleanupProcess when the old stream ends.
    if (!proc || proc !== processRef) return;
    proc.lastEventAt = Date.now();
    observeProcessLevel(sdkMessage);
    const ctx = resolveContext(sdkMessage);
    if (!ctx) return;
    const actions = ctx.normalizer.normalize(sdkMessage);
    for (const action of actions) {
      await dispatchToContext(ctx, action);
    }
  }

  // ---------------------------------------------------------------------------
  // Process lifecycle

  function hasLiveWork() {
    if (!proc) return false;
    const notificationFresh = proc.notificationPendingAt
      && Date.now() - proc.notificationPendingAt < notificationGraceMs;
    return Boolean(
      proc.activeCtx
      || proc.pendingDelivered.length
      || proc.liveTasks.size
      || notificationFresh
      || proc.pendingControlRequests > 0,
    );
  }

  function evaluateLifecycle() {
    if (!proc || proc.closing) return;
    const now = Date.now();
    if (hasLiveWork()) {
      // Track how long background tasks alone have held the process, for the
      // user-configurable timeout (0 = unlimited).
      const heldByTasksOnly = !proc.activeCtx && !proc.pendingDelivered.length && proc.liveTasks.size > 0;
      if (heldByTasksOnly) {
        if (!proc.heldForTasksSince) proc.heldForTasksSince = now;
        const timeoutMs = Number(getBackgroundTaskTimeoutMs()) || 0;
        if (timeoutMs > 0 && now - proc.heldForTasksSince >= timeoutMs) {
          expireBackgroundTasks(timeoutMs).catch(() => {});
        }
      } else {
        proc.heldForTasksSince = 0;
      }
      return;
    }
    proc.heldForTasksSince = 0;
    if (now - proc.lastEventAt >= idleShutdownMs) {
      dbg('claude session process idling out', sdkSessionId.slice(0, 8));
      gracefulShutdown('idle');
    }
  }

  async function expireBackgroundTasks(timeoutMs) {
    if (!proc || proc.tasksExpired) return;
    proc.tasksExpired = true;
    dbg('background task timeout reached', `${Math.round(timeoutMs / 60000)}min`, [...proc.liveTasks.keys()].join(','));
    for (const taskId of proc.liveTasks.keys()) {
      // Each stop emits a task_notification (status 'stopped') — the CLI's own
      // continuation turn is what tells the user, through the normal path.
      await Promise.resolve(proc.turn.stopTask?.(taskId)).catch((error) => {
        dbg('stopTask failed', taskId, error?.message || String(error));
      });
    }
  }

  function gracefulShutdown(reason) {
    if (!proc || proc.closing) return;
    proc.closing = true;
    dbg('releasing claude session process', reason);
    try {
      proc.turn.endInput?.();
    } catch {}
  }

  function stopLifecycleTimer(processRef) {
    if (processRef.lifecycleTimer) {
      clearInterval(processRef.lifecycleTimer);
      processRef.lifecycleTimer = null;
    }
  }

  async function cleanupProcess(processRef, streamError) {
    const wasCurrent = proc === processRef;
    stopLifecycleTimer(processRef);
    if (processRef.taskPublishTimer) {
      clearTimeout(processRef.taskPublishTimer);
      processRef.taskPublishTimer = null;
    }
    // The process took its background tasks with it; clear the panel — but
    // only when this process still owns it. A superseded process clearing the
    // panel would blank the replacement's live task set.
    if (processRef.liveTasks.size) {
      processRef.liveTasks = new Map();
      if (wasCurrent) {
        api('POST', '/api/background-tasks', { conversationId: sdkSessionId, tasks: [] }).catch(() => {});
      }
    }
    const openContexts = [
      ...(processRef.activeCtx ? [processRef.activeCtx] : []),
      ...processRef.pendingDelivered.map((entry) => entry.ctx),
    ];
    processRef.pendingDelivered = [];
    processRef.activeCtx = null;
    if (proc === processRef) proc = null;
    for (const ctx of openContexts) {
      if (ctx.finalized) continue;
      if (streamError && !processRef.aborted && !ctx.interrupted) {
        controlPoller?.stop?.(ctx.controlState);
        ctx.finalized = true;
        if (ctx.kind === 'delivered') {
          // handlePendingPayload's catch publishes the turn-failed response,
          // preserving the per-turn runner's error contract.
          ctx.rejectDone?.(streamError);
        } else if (ctx.registered && ctx.message?.id) {
          await publisher.publishTurnException({
            message: ctx.message,
            errorText: String(streamError?.message || streamError || 'unknown error'),
          }).catch(() => {});
        }
        continue;
      }
      await finalizeContextOnStreamEnd(ctx, {
        aborted: processRef.aborted,
        model: processRef.model,
      }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Spawn / adapt

  function spawnProcess(message) {
    const relayMode = message.relayMode || 'agent';
    const model = resolvePerTurnModel(message);
    const effort = normalizeClaudeEffort(message.reasoningEffort);
    const abortController = new AbortController();
    const processRef = {
      turn: null,
      abortController,
      model,
      relayMode,
      effort,
      appendClass: modeAppendClass(relayMode),
      permissionMode: permissionModeForRelayMode(relayMode),
      liveTasks: new Map(),
      knownTasks: new Set(),
      notificationPendingAt: 0,
      pendingActivities: [],
      activeCtx: null,
      pendingDelivered: [],
      lastBoundary: null,
      pendingControlRequests: 0,
      lastEventAt: Date.now(),
      heldForTasksSince: 0,
      tasksExpired: false,
      aborted: false,
      closing: false,
      lifecycleTimer: null,
      taskPublishTimer: null,
      consumer: null,
    };

    const askUserBridge = createAskUserBridge({
      api,
      sdkSessionId,
      getActiveMessage: () => processRef.activeCtx?.message || processRef.pendingDelivered[0]?.ctx.message || null,
      dbg,
      ...askUserBridgeOptions,
    });
    const baseCanUseTool = createCanUseTool({
      askUserBridge,
      dbg,
      onExitPlanMode: async (input) => {
        const ctx = processRef.activeCtx || processRef.pendingDelivered[0]?.ctx || null;
        if (!ctx?.message?.id) return false;
        const posted = await publisher.publishPlanBoard(ctx.message, input);
        if (posted) ctx.planBoardPosted = true;
        return posted;
      },
    });
    const canUseTool = async (toolName, input, options) => {
      // In-flight canUseTool round-trips (AskUserQuestion, permission prompts)
      // pin the process: a pending question produces no stream traffic while
      // the human thinks, and an idle shutdown under it would reject the
      // request with "Tool permission stream closed".
      processRef.pendingControlRequests += 1;
      try {
        // A question from a background agent between turns has no active turn
        // to attach to, and /api/relay-question requires a processing queue
        // row — without one the bridge 409s and the question is silently
        // denied. Register a continuation turn first: it is born processing,
        // gives the card a real queue row, and the flow's eventual top-level
        // result (or stream end) closes it like any other continuation.
        if (
          toolName === 'AskUserQuestion'
          && proc === processRef
          && !processRef.activeCtx
          && !processRef.pendingDelivered.length
        ) {
          const ctx = openContinuationContext();
          await waitForContextRegistration(ctx);
        }
        return await baseCanUseTool(toolName, input, options);
      } finally {
        processRef.pendingControlRequests -= 1;
        processRef.lastEventAt = Date.now();
      }
    };

    const resume = String(message.claudeNativeSessionId || claudeNativeSessionId || '').trim();
    // The CLI resolves `resume` inside the project directory for *this* CWD, so
    // a session whose workspace root changed has to bring its transcript along
    // or every turn from here on fails with "No conversation found".
    if (resume) relocateTranscriptImpl({ nativeSessionId: resume, cwd, dbg });

    processRef.turn = startClaudeSessionImpl({
      content: null,
      cwd,
      model,
      resume,
      relayMode,
      reasoningEffort: effort,
      abortController,
      canUseTool,
      pathToClaudeCodeExecutable,
      dbg,
    });
    processRef.lifecycleTimer = setInterval(() => evaluateLifecycle(), lifecyclePollMs);
    processRef.lifecycleTimer.unref?.();
    processRef.consumer = (async () => {
      let streamError = null;
      try {
        for await (const sdkMessage of processRef.turn) {
          await onSdkMessage(processRef, sdkMessage);
        }
      } catch (error) {
        if (!processRef.aborted && !abortController.signal.aborted) streamError = error;
      } finally {
        try {
          processRef.turn.endInput?.();
        } catch {}
        await cleanupProcess(processRef, streamError);
      }
    })();
    proc = processRef;
    return processRef;
  }

  async function adaptProcess(message) {
    const relayMode = message.relayMode || 'agent';
    const model = resolvePerTurnModel(message);
    const effort = normalizeClaudeEffort(message.reasoningEffort);

    // A mode change that would alter the spawn-time system prompt append gets
    // a fresh process — but only when nothing lives in the old one.
    if (modeAppendClass(relayMode) !== proc.appendClass && !hasLiveWork() && !proc.liveTasks.size) {
      const previous = proc;
      gracefulShutdown('mode-change');
      await Promise.race([
        previous.consumer,
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      if (proc === previous) {
        // The drain timed out: force the old CLI down so it cannot keep
        // streaming next to the replacement the caller is about to spawn.
        try { previous.turn.close?.(); } catch {}
        proc = null;
      }
      return null;
    }

    const permissionMode = permissionModeForRelayMode(relayMode);
    if (permissionMode !== proc.permissionMode) {
      await Promise.resolve(proc.turn.setPermissionMode?.(permissionMode)).catch((error) => {
        dbg('setPermissionMode failed', error?.message || String(error));
      });
      proc.permissionMode = permissionMode;
    }
    if (model && model !== proc.model) {
      await Promise.resolve(proc.turn.setModel?.(model)).catch((error) => {
        dbg('setModel failed', error?.message || String(error));
      });
      proc.model = model;
    }
    if (effort && effort !== proc.effort) {
      await Promise.resolve(proc.turn.applyFlagSettings?.({ effortLevel: effort })).catch((error) => {
        dbg('applyFlagSettings effort failed', error?.message || String(error));
      });
      proc.effort = effort;
    }
    proc.relayMode = relayMode;
    return proc;
  }

  // ---------------------------------------------------------------------------
  // Relay contract

  async function handlePendingPayload(pending) {
    const message = pending?.message || null;
    if (!message) return false;
    try {
      if (proc && !proc.closing && !proc.aborted) {
        await adaptProcess(message);
      }
      if (!proc || proc.closing || proc.aborted) {
        // A closing process drains on its own; wait so two CLIs never share
        // the native session transcript.
        const previous = proc;
        if (previous) {
          await Promise.race([
            previous.consumer,
            new Promise((resolve) => setTimeout(resolve, 15_000)),
          ]);
          if (proc === previous) {
            try { previous.turn.close?.(); } catch {}
            proc = null;
          }
        }
        spawnProcess(message);
      }
      const content = buildClaudeUserContent(message);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const procRef = proc;
        const ctx = createDeliveredContext(message);
        procRef.pendingDelivered.push({ ctx, expectedText: contentText(content) });
        try {
          procRef.turn.pushUserMessage(content);
        } catch (pushError) {
          // The stream ended under us (process wound down between the
          // liveness check and the push): retire this context and respawn.
          procRef.pendingDelivered = procRef.pendingDelivered.filter((entry) => entry.ctx !== ctx);
          dbg('push raced process teardown', pushError?.message || String(pushError));
          if (proc === procRef) proc = null;
          // Belt and braces: the stream was already ending, but make sure the
          // superseded CLI cannot linger next to its replacement.
          try { procRef.turn.close?.(); } catch {}
          spawnProcess(message);
          continue;
        }
        return await ctx.done;
      }
      throw new Error('claude session process closed while accepting the message');
    } catch (error) {
      const errorText = String(error?.message || error || 'unknown error');
      dbg('claude turn failed', message.id, errorText);
      await publisher.publishTurnException({ message, errorText });
      return true;
    }
  }

  async function shutdown({ graceful = true } = {}) {
    const processRef = proc;
    if (!processRef) return;
    if (graceful && !hasLiveWork()) {
      gracefulShutdown('worker-shutdown');
      await Promise.race([
        processRef.consumer,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    try { processRef.turn.close?.(); } catch {}
    try { processRef.abortController.abort(); } catch {}
  }

  /** Stop one live background task (the panel's per-task Stop button). */
  async function stopBackgroundTask(taskId) {
    const normalized = String(taskId || '').trim();
    if (!normalized || !proc?.turn?.stopTask) return false;
    try {
      await proc.turn.stopTask(normalized);
      return true;
    } catch (error) {
      dbg('stopTask failed', normalized, error?.message || String(error));
      return false;
    }
  }

  return {
    handlePendingPayload,
    getActiveQueueMessageId,
    getActiveQueueMessageIds,
    isTurnActive,
    stopBackgroundTask,
    shutdown,
    // Test seams / observability.
    _getProcess: () => proc,
  };
}
