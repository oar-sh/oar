import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { buildClaudeUserContent } from './claude-attachments.mjs';
import {
  compactBoundaryActivityAction,
  createSdkMessageNormalizer,
  formatApiRetryNotice,
  isSubagentToolName,
} from './sdk-message-normalizer.mjs';
import { digestFromRunRecord, digestFromJournal } from './workflow-progress-digest.mjs';
import { createClaudeSessionRootResolver } from '../services/claude-session-root-service.mjs';
import {
  startClaudeSession,
  createCanUseTool,
  readContextUsage,
  readPlanUsage,
  normalizeClaudeEffort,
  claudeUltracodeFlagSettings,
  claudeAutoCompactFlagSettings,
  normalizeAutoCompactWindow,
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

/** Task types that run a model of their own (vs. bash/monitor/workflow). */
const AGENT_TASK_TYPES = new Set(['local_agent', 'agent', 'subagent']);

// ---------------------------------------------------------------------------
// Workflow progress sources (CLI 2.1.226 on-disk formats)
//
// A `local_workflow` task's tree lives under the native session's project
// directory: `<sessionDir>/subagents/workflows/<runId>/journal.jsonl` is
// appended live while the run executes, and `<sessionDir>/workflows/
// <runId>.json` (the run record, the only place carrying `taskId`) is written
// only at completion. The poller reads the journal mid-run and switches to the
// run record the moment it exists.

/** Run ids and agent ids are joined into paths, so both are validated first. */
const WORKFLOW_FS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * Mid-run nothing on disk maps runId→taskId, so run directories are matched
 * to the task by time instead: the task's startedAt is worker wall clock while
 * dir mtimes come from the filesystem, and this slack absorbs the skew.
 */
const WORKFLOW_RUN_MATCH_SLACK_MS = 15_000;
const MAX_WORKFLOW_RECORDS_SCANNED = 25;
const MAX_WORKFLOW_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_WORKFLOW_RECORD_BYTES = 8 * 1024 * 1024;
const AGENT_LABEL_READ_BYTES = 8_192;

function workflowMtimeMs(candidate) {
  try {
    return Number(nodeFs.statSync(candidate).mtimeMs) || 0;
  } catch {
    return 0;
  }
}

/** Up to `maxBytes` of a file as utf8, or null when it cannot be read. */
function readBoundedUtf8(filePath, maxBytes) {
  let fd = null;
  try {
    fd = nodeFs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const bytes = nodeFs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString('utf8', 0, bytes);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { nodeFs.closeSync(fd); } catch {}
    }
  }
}

/** Parse `<sessionDir>/workflows/<runId>.json`, or null. */
function readWorkflowRunRecord(sessionDir, runId) {
  if (!WORKFLOW_FS_NAME_PATTERN.test(runId)) return null;
  const text = readBoundedUtf8(nodePath.join(sessionDir, 'workflows', `${runId}.json`), MAX_WORKFLOW_RECORD_BYTES);
  if (!text) return null;
  try {
    const record = JSON.parse(text);
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

/**
 * Find the run record whose `taskId` matches — the only authoritative
 * runId↔taskId join, available once the record is written (completion). Only
 * records touched since the task started (minus slack) are parsed, so a
 * session's pile of past run records costs one stat each, not a parse.
 */
function scanWorkflowRunRecords({ sessionDir, taskId, startedAt }) {
  const workflowsDir = nodePath.join(sessionDir, 'workflows');
  let entries = [];
  try {
    entries = nodeFs.readdirSync(workflowsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const runId = entry.name.slice(0, -'.json'.length);
    if (!WORKFLOW_FS_NAME_PATTERN.test(runId)) continue;
    const modifiedAt = workflowMtimeMs(nodePath.join(workflowsDir, entry.name));
    if (startedAt && modifiedAt < startedAt - WORKFLOW_RUN_MATCH_SLACK_MS) continue;
    candidates.push({ runId, modifiedAt });
  }
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  for (const candidate of candidates.slice(0, MAX_WORKFLOW_RECORDS_SCANNED)) {
    const record = readWorkflowRunRecord(sessionDir, candidate.runId);
    if (record && String(record.taskId || '').trim() === taskId) return record;
  }
  return null;
}

/**
 * Locate the LIVE run directory for a task, heuristically: among the run
 * directories under `<sessionDir>/subagents/workflows/`, keep those whose own
 * mtime or journal mtime is at or after the task's startedAt minus the slack,
 * and pick the newest. The caller caches the match per taskId; a later run record
 * whose taskId disagrees clears that cache (concurrent workflows can tie the
 * newest-dir pick to the wrong task until their records land).
 */
function findLiveWorkflowRunId({ sessionDir, startedAt }) {
  const runsDir = nodePath.join(sessionDir, 'subagents', 'workflows');
  let entries = [];
  try {
    entries = nodeFs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return '';
  }
  let bestRunId = '';
  let bestModifiedAt = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKFLOW_FS_NAME_PATTERN.test(entry.name)) continue;
    const runDir = nodePath.join(runsDir, entry.name);
    const modifiedAt = Math.max(
      workflowMtimeMs(runDir),
      workflowMtimeMs(nodePath.join(runDir, 'journal.jsonl')),
    );
    if (startedAt && modifiedAt < startedAt - WORKFLOW_RUN_MATCH_SLACK_MS) continue;
    if (modifiedAt > bestModifiedAt) {
      bestModifiedAt = modifiedAt;
      bestRunId = entry.name;
    }
  }
  return bestRunId;
}

/** Parsed lines of a run directory's journal.jsonl, or null when unreadable. */
function readWorkflowJournal(runDir) {
  const text = readBoundedUtf8(nodePath.join(runDir, 'journal.jsonl'), MAX_WORKFLOW_JOURNAL_BYTES);
  if (text === null) return null;
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // A half-appended (or truncated-by-cap) line parses on a later poll.
    }
  }
  return entries;
}

/** JSON string body → text, tolerating a fragment cut mid-escape-sequence. */
function unescapeJsonStringFragment(fragment) {
  for (let cut = 0; cut < 6 && cut < fragment.length; cut += 1) {
    try {
      return JSON.parse(`"${fragment.slice(0, fragment.length - cut)}"`);
    } catch {
      // The tail may be a split escape sequence; trim one char and retry.
    }
  }
  return '';
}

/**
 * The live label for one workflow agent: the first line of its
 * `agent-<agentId>.jsonl` is `{"type":"user","message":{role,content},...}`
 * where `message.content` is the agent's prompt — its first ~160 chars are
 * the best mid-run label (the run record's `label` only exists at
 * completion). Only the first ~8KB is read; a first line longer than that is
 * recovered via a raw `"content":"…"` match on the chunk.
 */
function readWorkflowAgentLabel(runDir, agentId) {
  if (!WORKFLOW_FS_NAME_PATTERN.test(agentId)) return '';
  const chunk = readBoundedUtf8(nodePath.join(runDir, `agent-${agentId}.jsonl`), AGENT_LABEL_READ_BYTES);
  if (!chunk) return '';
  const newlineIndex = chunk.indexOf('\n');
  const firstLine = newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex);
  let content = null;
  try {
    content = JSON.parse(firstLine)?.message?.content;
  } catch {
    const match = /"content"\s*:\s*"((?:[^"\\]|\\.){1,400})/.exec(firstLine);
    if (match) content = unescapeJsonStringFragment(match[1]);
  }
  if (Array.isArray(content)) {
    content = content.find((block) => block?.type === 'text')?.text;
  }
  if (typeof content !== 'string') return '';
  return content.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Default session-dir resolution for the workflow poller: the same
 * `<configRoot>/projects/<slug(cwd)>/<nativeSessionId>/` derivation the
 * transcript relocator uses, via the shared session-root resolver (which owns
 * the cwd slug, the CLAUDE_CONFIG_DIR/~/.claude root order, the scan fallback,
 * and caching). Injectable so tests can point the poller at a temp dir.
 */
function createDefaultWorkflowSessionDirResolver() {
  let resolver = null;
  return ({ nativeSessionId, cwd }) => {
    if (!resolver) resolver = createClaudeSessionRootResolver();
    const resolved = resolver.resolveClaudeSessionRoot({
      claudeNativeSessionId: nativeSessionId,
      workspaceRootPath: cwd,
    });
    return resolved?.sessionRootPath || '';
  };
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
function turnOpeningUserSignature(sdkMessage) {
  if (sdkMessage?.type !== 'user' || sdkMessage?.parent_tool_use_id) return null;
  const content = sdkMessage?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((block) => block?.type === 'tool_result')) return null;
  // Unlike turnOpeningUserText this keeps '' — an attachment-only message
  // replays with an empty text block, and the absorbed-steering match must
  // still recognize it (expectedText is '' for those too).
  return contentText(content);
}

function turnOpeningUserText(sdkMessage) {
  const text = turnOpeningUserSignature(sdkMessage);
  return text || null;
}

/**
 * The CLI synthesizes a user-role message when a background task settles. The
 * SDK stamps its provenance structurally: `SDKUserMessage.origin` is an
 * `SDKMessageOrigin`, and a settled task's continuation carries
 * `{ kind: 'task-notification' }` (sdk.d.ts). The compaction's own summary
 * replay carries no `origin` at all (incident transcript row 1514).
 *
 * The `<task-notification>` opening tag — which the CLI documents to the model
 * as the way to recognize these ("they look like user messages but are not") —
 * is kept as a fallback for emitters that predate the field. It can only push
 * the answer toward "not the compaction's replay", which is the safe
 * direction: not adopting merely restores the pre-fix behaviour, while a wrong
 * adoption closes the user's row with another turn's answer.
 */
const TASK_NOTIFICATION_TAG_PREFIX = '<task-notification';

/**
 * The first text block's raw text, or null when there is none to read. Real
 * notification rows carry `content` as a plain string (242 of them on disk),
 * not a block array, so both spellings are read.
 */
function firstTextBlock(sdkMessage) {
  const content = sdkMessage?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const first = content[0];
  return first?.type === 'text' ? String(first.text || '') : null;
}

/** A settled background task's continuation, by origin or by leading tag. */
function isTaskNotificationReplay(sdkMessage) {
  if (String(sdkMessage?.origin?.kind || '') === 'task-notification') return true;
  const text = firstTextBlock(sdkMessage);
  return text !== null && text.trimStart().startsWith(TASK_NOTIFICATION_TAG_PREFIX);
}

/**
 * Whether a turn the CLI opened by itself may be the compaction re-opening a
 * delivered turn, rather than something else the CLI decided to say.
 *
 * Tested POSITIVELY, and it has to be: `SDKMessageOrigin` is a nine-member
 * union (`human`, `channel`, `peer`, `task-notification`, `coordinator`,
 * `unclassified`, `observer`, …), so "not a task notification" is fail-OPEN —
 * a cross-session `peer` message or an `auto-continuation` would be read as
 * the compaction's summary and would permanently steal the delivered row. The
 * compact summary is the CLI's own synthesized replay and carries NO `origin`
 * at all (incident transcript row 1514: `origin=None`), so any stamped
 * provenance disqualifies it. The `<task-notification>` tag stays as a second
 * disqualifier for emitters that predate `origin`.
 *
 * Failing closed costs only the pre-fix behaviour (the row waits for its own
 * replay); failing open closes a user's row with another turn's answer.
 */
function isCompactionReplayCandidate(sdkMessage) {
  if (firstTextBlock(sdkMessage) === null) return false;
  if (sdkMessage?.origin !== undefined && sdkMessage?.origin !== null) return false;
  return !isTaskNotificationReplay(sdkMessage);
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
  // The per-conversation auto-compact window (token count, null = Auto). Read
  // per turn rather than captured, so a slider change picked up on the next
  // delivery reaches a process that is already running.
  getAutoCompactWindow = () => null,
  lifecyclePollMs = 5_000,
  // A settled task's continuation normally begins within ~1s; when nothing
  // arrives inside this window the notification was silent (skip_transcript)
  // and must stop pinning the process.
  notificationGraceMs = 60_000,
  // How long a delivered entry may sit unattached (no active turn, no live
  // tasks, quiet stream) before the watchdog fails its row over. Must exceed
  // the slowest cold start observed; the primary absorbed-steering fix in
  // resolveContext should make this fire only for unknown variants.
  pendingDeliveredTimeoutMs = 5 * 60_000,
  // Backstop for the compaction hold. A compaction is announced ONCE by
  // `status: 'compacting'` (the CLI's periodic re-emit is gated on the
  // remote-control client's activity callback, which the plain SDK `query()`
  // never registers) and is released by the boundary, by a terminating status,
  // or by the process dying — this cap only matters when none of those ever
  // arrives. It gates the pending-delivered watchdog, idle shutdown and the
  // mode-change recycle, so it is sized far above any plausible compaction
  // (measured: 133 s for 614k tokens) rather than tightly: releasing late
  // leaves an idle CLI up a few minutes longer, releasing early kills a live
  // compaction mid-flight.
  compactionStaleMs = 10 * 60_000,
  // How long after a compaction signal a delivered message may still adopt the
  // turn the CLI opens by itself. The replay follows the boundary within
  // milliseconds; this only has to outlast that gap, and the window is spent
  // by the first turn to open regardless.
  compactReplayAdoptionMs = 60_000,
  continuationRetryDelayMs = 500,
  workflowPollMs = 2_000,
  resolveWorkflowSessionDirImpl = null,
  askUserBridgeOptions = {},
  dbg = () => {},
} = {}) {
  const publisher = createClaudeTurnPublisher({
    api,
    dbg,
    takeWorkflowRuns: () => drainSettledWorkflowRuns(),
  });
  const resolveWorkflowSessionDir = resolveWorkflowSessionDirImpl || createDefaultWorkflowSessionDirResolver();
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
      // Set only on a context attached by post-compaction adoption, and only
      // until that turn produces output — see handBackAdoptedContext.
      adoptedFromCompaction: false,
      // The pendingDelivered entry this context was attached from, kept so a
      // handed-back adoption can restore it verbatim.
      deliveredEntry: null,
      // When the provisional adoption's quiet clock started (see
      // reapSilentProvisionalAdoption).
      provisionalSince: 0,
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
    proc.continuationInitPending = false;
    proc.notificationPendingAt = 0;
    proc.taskSettledAt = 0;
    if (proc.initModel && !ctx.state.responseModel) ctx.state.responseModel = proc.initModel;
    ctx.controlState = controlPoller?.start?.({
      queueMessageId: ctx.message?.id || '',
      onAbortTurn: () => interruptActiveTurn(ctx),
    }) || null;
    // One-shot: a compaction's replay window is spent by the turn that
    // consumes it, and a turn that opened for any other reason retires it too
    // — a boundary must never be able to adopt a second turn (see
    // resolveContext).
    proc.compactReplayUntil = 0;
    // Orphan/settled-task notification lines that arrived between turns belong
    // to the turn they triggered.
    const carried = proc.pendingActivities.splice(0);
    if (carried.length) {
      const actions = carried.map((entry) => (typeof entry === 'string'
        ? { channel: 'activity', payload: { text: entry, subagentRunId: null } }
        : entry));
      if (ctx.registered) {
        (async () => {
          for (const action of actions) await publisher.dispatchAction(ctx.message, action, ctx.state);
        })().catch(() => {});
      } else {
        ctx.bufferedActions.push(...actions);
      }
    }
  }

  /**
   * Attach the delivered entry at `index` — the head unless a replay matched a
   * later one. The CLI normally dequeues in order, but two messages pushed
   * back to back can replay out of order, and pairing by position alone would
   * answer each with the other's turn.
   */
  function attachDeliveredContext(index = 0) {
    const [entry] = proc.pendingDelivered.splice(index, 1);
    entry.ctx.deliveredEntry = entry;
    activateContext(entry.ctx);
    return entry.ctx;
  }

  /**
   * Undo a post-compaction adoption: this turn was never the delivered
   * message's, and nothing has published on it (the provisional flag is
   * cleared by the turn's first real output, so every caller runs strictly
   * before that).
   *
   * The entry goes back to the HEAD of the queue — it is still the next thing
   * the CLI owes a replay for, and anything queued behind it must stay behind
   * it — with its unattached clock reset, exactly as `armCompactReplayAdoption`
   * leaves it. The control poller is stopped because `activateContext` started
   * one and will start another when the entry attaches for real.
   *
   * The adoption window is deliberately NOT re-armed: the replay to come
   * carries the message's own text and attaches by the ordinary match, so
   * re-arming would only widen the chance of adopting yet another turn.
   */
  function restoreAdoptedContext(ctx) {
    // A context that has begun settling must never go back on the queue:
    // `finalizeContext` marks `finalized` before its awaited publishes, and a
    // finalized entry re-attached by a later turn returns from `finalizeContext`
    // immediately — so `closeContext` never runs and `activeCtx` is pinned to a
    // corpse for the life of the process (the 2026-08-18 deadlock shape).
    if (ctx.finalized) return;
    detachActiveContext(ctx);
    ctx.adoptedFromCompaction = false;
    ctx.provisionalSince = 0;
    // `activateContext` started a control poller keyed on this row, so the
    // provisional window is the one moment a still-QUEUED message is
    // Stoppable. An abort taken there belongs to the turn that was running,
    // not to the row: left set, `finalizeContext` would take its interrupted
    // branch when the row finally runs for real and publish no response at all.
    ctx.interrupted = false;
    controlPoller?.stop?.(ctx.controlState);
    ctx.controlState = null;
    const entry = ctx.deliveredEntry;
    if (!entry) return;
    entry.unattachedSince = 0;
    proc.pendingDelivered.unshift(entry);
  }

  /**
   * The adopted turn turned out to belong to a settled task's continuation,
   * which replayed its notification into the same turn after the compaction
   * summary opened it. Give the row back and register the continuation the
   * turn actually is.
   */
  function handBackAdoptedContext(ctx) {
    restoreAdoptedContext(ctx);
    dbg('post-compaction adoption handed back to a task continuation', ctx.message?.id || '(no id)');
    return openContinuationContext();
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
      // Retry on any registration that produced no message id — a truthy but
      // empty response body must not end the loop early.
      for (let attempt = 0; attempt < 3 && !response?.messageId; attempt += 1) {
        // Handed off / settled before a row was created: stop before making one.
        if (ctx.finalized || ctx.discarded) return;
        response = await api('POST', '/api/continuation-turn', {
          conversationId: sdkSessionId,
          sdkSessionId,
          relayMode: ctx.message.relayMode,
          trigger: 'background_task',
        }).catch((error) => {
          dbg('continuation turn registration failed', error?.message || String(error));
          return null;
        });
        if (!response?.messageId) await new Promise((resolve) => setTimeout(resolve, continuationRetryDelayMs));
      }
      if (!response?.messageId) {
        ctx.discarded = true;
        ctx.bufferedActions = [];
        controlPoller?.stop?.(ctx.controlState);
        ctx.controlState = null;
        dbg('continuation turn discarded (no relay message id)');
        return;
      }
      if (ctx.discarded || ctx.finalized) {
        // The context was handed off or settled while registration was in
        // flight; drop the just-created server row (requeue fails a
        // processing continuation quietly) instead of leaving it orphaned.
        await api('POST', '/api/requeue', { messageId: String(response.messageId) }).catch(() => {});
        controlPoller?.stop?.(ctx.controlState);
        ctx.controlState = null;
        dbg('continuation turn dropped (handed off during registration)');
        return;
      }
      ctx.message.id = String(response.messageId);
      // The route reports which conversation the synthetic row landed on;
      // trusting it beats assuming worker session id === conversation id.
      if (String(response.conversationId || '').trim()) {
        ctx.message.conversationId = String(response.conversationId).trim();
      }
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
    if (proc.activeCtx) {
      // The CLI dequeues a message pushed mid-turn INTO the running turn
      // (steering) instead of opening a new turn after it: the replay arrives
      // while another context is active, so the turn's single result would
      // land on that context and the delivered row would stay `processing`
      // forever while its lease renews (conv f93135ac row 962c36b1,
      // 2026-08-18). Detect the absorbed replay and hand the turn off — the
      // active context settles with what it already streamed, and everything
      // from the replay on, including the result, belongs to the delivered
      // message it answers.
      if (proc.pendingDelivered.length) {
        const signature = turnOpeningUserSignature(sdkMessage);
        const absorbed = signature === null
          ? -1
          : proc.pendingDelivered.findIndex((entry) => entry.expectedText === signature);
        if (absorbed >= 0) {
          const outgoing = proc.activeCtx;
          const restored = outgoing.adoptedFromCompaction;
          if (restored) {
            // The outgoing context was only PROVISIONALLY adopted and has
            // published nothing. Settling it as an absorbed turn would tell
            // the user their message was "merged into the next reply" and
            // refuse to requeue it — but the CLI never consumed that prompt,
            // so it is still owed a replay. Unwind the adoption instead; the
            // row goes back to the queue and attaches for real later.
            restoreAdoptedContext(outgoing);
          } else {
            // onSdkMessage awaits this before dispatching the new context's
            // actions, so the handed-off row's publishes stay ordered ahead
            // of the absorbed turn's.
            proc.handoffSettling = handoffAbsorbedTurn(outgoing);
          }
          const ctx = attachDeliveredContext(
            proc.pendingDelivered.findIndex((entry) => entry.expectedText === signature),
          );
          // Continuity: open thinking blocks and tool_use/tool_result pairing
          // must survive the boundary — the stream did not restart. Only for a
          // genuine hand-off, where the outgoing context is settled and never
          // used again: a RESTORED one goes back on the queue and will run its
          // own turn later, and a shared normalizer would then publish this
          // turn's streamed text as that row's answer (its `streamText` is only
          // reset by a `message_start`, so it outlives the result).
          if (!restored) ctx.normalizer = outgoing.normalizer;
          return ctx;
        }
      }
      // The turn was adopted for a delivered message on the strength of an
      // untagged post-compaction replay — and now a task notification replays
      // into the same turn. The compaction happened INSIDE a continuation the
      // CLI had already opened for a settled task, so the summary row was
      // never the delivered message's: the turn belongs to the task. Hand it
      // back before anything publishes (see handBackAdoptedContext).
      if (proc.activeCtx.adoptedFromCompaction) {
        const signature = turnOpeningUserSignature(sdkMessage);
        // The adopted message's OWN replay: the CLI has now proved it dequeued
        // exactly this prompt, so the guess is confirmed and the turn is the
        // row's for good. Every unwind path rests on "the CLI never consumed
        // this prompt" — after this replay that premise is false, and putting
        // the row back would fail or re-run a message the CLI already took.
        if (signature !== null && signature === proc.activeCtx.deliveredEntry?.expectedText) {
          proc.activeCtx.adoptedFromCompaction = false;
          return proc.activeCtx;
        }
        if (signature !== null && isTaskNotificationReplay(sdkMessage)) {
          return handBackAdoptedContext(proc.activeCtx);
        }
        // A phantom result closes the turn with nothing published. Committed,
        // it would leave the adopted context active forever — no result to
        // finalize it, no queue entry left for the watchdog to fail over, and
        // `handlePendingPayload` never resolving. Give the row back and let
        // the ordinary phantom skip run.
        if (isPhantomResult(sdkMessage)) {
          restoreAdoptedContext(proc.activeCtx);
          proc.lastBoundary = null;
          return null;
        }
        // The adoption commits on the turn's first real OUTPUT, and only
        // that. `system` frames publish nothing, and the compaction's own
        // `compact_result` status routinely lands between the summary row and
        // a notification replay. Nor does a background subagent's stream
        // count: it arrives at top level carrying `parent_tool_use_id`, it is
        // a LIVE task's chatter rather than this turn's answer, and a task
        // running while the user's message is queued is the ordinary state of
        // the conversation this bug came from — committing on it would leave
        // the hand-back unreachable in exactly the order it exists for.
        const type = String(sdkMessage?.type || '');
        // A `result` counts too. It is not "output" in the streaming sense —
        // it is the turn ENDING — but leaving the flag set through
        // `finalizeContext`'s several awaited relay round-trips gives the
        // lifecycle timer a window to reap a context that is already settling.
        if (!sdkMessage?.parent_tool_use_id
          && (type === 'assistant' || type === 'stream_event' || type === 'result')) {
          proc.activeCtx.adoptedFromCompaction = false;
        }
      }
      return proc.activeCtx;
    }
    const type = String(sdkMessage?.type || '');

    const openingText = turnOpeningUserText(sdkMessage);
    if (openingText !== null) {
      const matched = proc.pendingDelivered.findIndex((entry) => entry.expectedText === openingText);
      if (matched >= 0) return attachDeliveredContext(matched);
      // A compaction just replayed the conversation: the CLI re-opens the turn
      // with its own summary message ("This session is being continued…"),
      // whose text matches no delivered entry, and then answers the delivered
      // message on that turn. Without adoption the answer publishes as a
      // synthetic continuation and the real row orphans until the watchdog
      // fails it — the user loses the message on a turn that succeeded (conv
      // 563e252e, 2026-08-20). The turn is identified directly rather than by
      // bookkeeping about what the CLI might owe: a settled task's
      // continuation announces itself through `origin.kind` (see
      // isTaskNotificationReplay), and everything else inside the window is
      // the compaction's own replay. Only the no-active-context path adopts (a
      // compaction mid-turn must leave the running turn alone), and the window
      // is one-shot — attachDeliveredContext clears it through
      // activateContext, so one boundary can never adopt two turns.
      //
      // `lastBoundary === 'self-opened'` is the turn-level half of the same
      // question: the CLI had already begun a turn of its own (a task
      // continuation, or a resumed init) and merely had not produced traffic
      // yet, so a compaction inside THAT turn emits its untagged summary row
      // into a turn that was never the delivered message's. The tag says which
      // MESSAGE this is; the boundary says which TURN it belongs to, and
      // adoption needs both.
      if (
        proc.pendingDelivered.length
        && proc.lastBoundary !== 'self-opened'
        && !proc.continuationInitPending
        && Date.now() < proc.compactReplayUntil
        && isCompactionReplayCandidate(sdkMessage)
      ) {
        const ctx = attachDeliveredContext();
        // Provisional: the summary row alone cannot rule out a continuation
        // whose notification replays after it (see the hand-back above).
        ctx.adoptedFromCompaction = true;
        return ctx;
      }
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
    // The transport is gone, so nothing new can be read — but usage already
    // captured on this context (a result seen before the stream died) still
    // reaches the relay. Best-effort by definition of this path.
    if (ctx.state.contextUsage || ctx.state.planUsage) {
      await publisher.publishContextUsage({ message: ctx.message, state: ctx.state, model, sdkSessionId }).catch(() => {});
      await publisher.publishPlanUsage({ message: ctx.message, state: ctx.state, sdkSessionId }).catch(() => {});
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

  function detachActiveContext(ctx) {
    if (proc && proc.activeCtx === ctx) {
      proc.activeCtx = null;
      proc.lastBoundary = null;
    }
  }

  function closeContext(ctx, handled) {
    detachActiveContext(ctx);
    ctx.resolveDone?.(handled);
    evaluateLifecycle();
  }

  /**
   * The active turn absorbed a delivered message (steering): settle the
   * active context NOW. The caller attaches the delivered context
   * synchronously; onSdkMessage awaits the returned promise before
   * dispatching the new context's actions so the two rows' publishes stay
   * ordered.
   */
  function handoffAbsorbedTurn(ctx) {
    detachActiveContext(ctx);
    if (ctx.kind === 'continuation' && !ctx.registered) {
      // Registration (or its buffered-action drain) is still in flight:
      // discard, and empty the buffer so the drain loop halts instead of
      // writing to a row that is about to be dropped. The registration path
      // drops the server row itself when the id arrives after this.
      ctx.discarded = true;
      ctx.bufferedActions = [];
    }
    // Captured synchronously: the incoming context inherits this normalizer,
    // so reading it later would see the absorbed turn's text too.
    const fallbackText = String(ctx.state.lastStreamedText || ctx.normalizer.finalStreamText() || '').trim();
    dbg('active turn absorbed a delivered message; handing off', ctx.message?.id || '(unregistered continuation)');
    return settleHandedOffContext(ctx, fallbackText).catch((error) => {
      dbg('absorbed-turn handoff settle failed', error?.message || String(error));
    });
  }

  async function settleHandedOffContext(ctx, fallbackText) {
    if (ctx.finalized) return;
    ctx.finalized = true;
    controlPoller?.stop?.(ctx.controlState);
    if (ctx.discarded) {
      // A discarded continuation that already has its server row must still
      // drop it (requeue fails a processing continuation quietly).
      if (ctx.message?.id) {
        await api('POST', '/api/requeue', { messageId: ctx.message.id }).catch(() => {});
      }
      closeContext(ctx, true);
      return;
    }
    const model = ctx.state.responseModel || proc?.model || null;
    if (ctx.kind === 'delivered') {
      // NEVER requeue an absorbed delivered row: the CLI already consumed
      // the prompt into the running turn — re-delivery would execute it a
      // second time (and the requeue route marks the healthy worker errored).
      const text = fallbackText
        ? `${fallbackText}\n\n_(This turn was merged into the next message — the reply continues there.)_`
        : '_(This turn was merged into the next message — see the following reply.)_';
      await publisher.publishFinalStream(ctx.message, text);
      await publisher.publishResponse(ctx.message, { text, model });
    } else if (fallbackText) {
      await publisher.publishFinalStream(ctx.message, fallbackText);
      await publisher.publishResponse(ctx.message, { text: fallbackText, model });
    } else if (ctx.message?.id) {
      await api('POST', '/api/requeue', { messageId: ctx.message.id }).catch(() => {});
    }
    closeContext(ctx, true);
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
      const tasks = [...processRef.liveTasks.entries()].map(([taskId, task]) => {
        // The SDK's task events never carry a model (verified against
        // 0.3.226): a pinned one lives on the spawning tool_use block
        // (subagentSpawns, keyed by the task's tool_use_id); without a pin an
        // agent-like task runs on the session model. Resolved at publish
        // time so the spawn block landing after task_started still heals on
        // the next publish. Bash & co. get no model at all.
        const agentLike = AGENT_TASK_TYPES.has(String(task.taskType || ''));
        const pinnedModel = (task.toolUseId && processRef.subagentSpawns.get(task.toolUseId)) || '';
        const model = agentLike ? (pinnedModel || processRef.initModel || null) : null;
        return {
          taskId,
          taskType: task.taskType,
          description: task.description,
          startedAt: task.startedAt || null,
          summary: task.summary || null,
          lastToolName: task.lastToolName || null,
          totalTokens: task.totalTokens ?? null,
          toolUseId: task.toolUseId || null,
          subagentType: task.subagentType || null,
          model,
          modelInherited: Boolean(model && !pinnedModel),
          // The workflow digest (poller below) rides the same row; the relay
          // sanitizer whitelists and re-clamps it before storing.
          ...(task.workflowProgress ? { workflowProgress: task.workflowProgress } : {}),
        };
      });
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

  // ---------------------------------------------------------------------------
  // Workflow progress poller
  //
  // A `local_workflow` task is ONE opaque row on the task-events path; its
  // per-agent tree lives on disk (see the module-level readers above). While
  // such a task is live, an interval polls the tree, digests it, and attaches
  // the digest to the task's published row as `workflowProgress` — publishing
  // only when the digest actually changed. Same lifecycle discipline as
  // taskPublishTimer: unref'd, cleared on settle and in cleanupProcess.

  function workflowSessionDirFor(processRef) {
    const nativeSessionId = String(processRef.nativeSessionId || claudeNativeSessionId || '').trim();
    if (!nativeSessionId) return '';
    try {
      return String(resolveWorkflowSessionDir({ nativeSessionId, cwd }) || '');
    } catch {
      return '';
    }
  }

  function getWorkflowState(processRef, taskId) {
    let state = processRef.workflowStates.get(taskId);
    if (!state) {
      state = { runId: '', labels: new Map(), digestJson: '' };
      processRef.workflowStates.set(taskId, state);
    }
    return state;
  }

  /**
   * The freshest digest for one workflow task, or null. The run record wins
   * whenever it exists (it is written at completion and carries the full
   * tree); until then the live journal is the source. `recordOnly` is the
   * settle-time final read, where a journal re-read could only regress.
   */
  function buildWorkflowDigest(processRef, sessionDir, taskId, task, { recordOnly = false } = {}) {
    const state = getWorkflowState(processRef, taskId);
    const startedAt = Number(task.startedAt) || 0;

    if (state.runId) {
      const record = readWorkflowRunRecord(sessionDir, state.runId);
      if (record) {
        const recordTaskId = String(record.taskId || '').trim();
        if (recordTaskId && recordTaskId !== taskId) {
          // The mtime heuristic bound this task to another task's run; the
          // record's taskId is authoritative, so drop the binding and let the
          // taskId scan re-match on a later poll.
          state.runId = '';
        } else {
          const digest = digestFromRunRecord(record);
          if (digest) return digest;
        }
      }
    }
    if (!state.runId) {
      const record = scanWorkflowRunRecords({ sessionDir, taskId, startedAt });
      const digest = record ? digestFromRunRecord(record) : null;
      if (digest) {
        state.runId = digest.runId;
        return digest;
      }
    }
    if (recordOnly) return null;

    if (!state.runId) state.runId = findLiveWorkflowRunId({ sessionDir, startedAt });
    if (!state.runId) return null;
    const runDir = nodePath.join(sessionDir, 'subagents', 'workflows', state.runId);
    const entries = readWorkflowJournal(runDir);
    if (!entries) return null;
    for (const entry of entries) {
      const agentId = String(entry?.agentId || '').trim();
      if (!agentId || state.labels.has(agentId)) continue;
      // Cache label hits only: a miss may just be a first line still being
      // flushed, and re-reading 8KB per poll until it lands is cheap.
      const label = readWorkflowAgentLabel(runDir, agentId);
      if (label) state.labels.set(agentId, label);
    }
    return digestFromJournal({
      entries,
      labelsByAgentId: state.labels,
      workflowName: null,
      runId: state.runId,
    });
  }

  function stopWorkflowPoller(processRef) {
    if (processRef.workflowPollTimer) {
      clearInterval(processRef.workflowPollTimer);
      processRef.workflowPollTimer = null;
    }
  }

  function pollWorkflowProgress(processRef) {
    if (processRef !== proc || processRef.closing) {
      stopWorkflowPoller(processRef);
      return;
    }
    const workflowTasks = [...processRef.liveTasks.entries()]
      .filter(([, task]) => String(task.taskType || '') === 'local_workflow');
    if (!workflowTasks.length) {
      stopWorkflowPoller(processRef);
      return;
    }
    const sessionDir = workflowSessionDirFor(processRef);
    if (!sessionDir) return;
    let changed = false;
    for (const [taskId, task] of workflowTasks) {
      let digest = null;
      try {
        digest = buildWorkflowDigest(processRef, sessionDir, taskId, task);
      } catch {
        // Advisory by contract: a digest failure must never disturb the turn.
      }
      if (!digest) continue;
      const digestJson = JSON.stringify(digest);
      const state = getWorkflowState(processRef, taskId);
      if (state.digestJson === digestJson) continue;
      state.digestJson = digestJson;
      task.workflowProgress = digest;
      changed = true;
    }
    if (changed) publishBackgroundTasks();
  }

  /** Start/stop the poller to match the live task set; prune settled state. */
  function syncWorkflowPoller(processRef) {
    for (const taskId of [...processRef.workflowStates.keys()]) {
      if (!processRef.liveTasks.has(taskId)) processRef.workflowStates.delete(taskId);
    }
    const hasWorkflowTask = [...processRef.liveTasks.values()]
      .some((task) => String(task.taskType || '') === 'local_workflow');
    if (!hasWorkflowTask) {
      stopWorkflowPoller(processRef);
      return;
    }
    if (processRef.workflowPollTimer || processRef.closing) return;
    processRef.workflowPollTimer = setInterval(() => pollWorkflowProgress(processRef), workflowPollMs);
    processRef.workflowPollTimer.unref?.();
  }

  // How many settled workflows can wait for their summarizing response at
  // once — matches the relay-side cap on `workflowRuns` per message.
  const MAX_SETTLED_WORKFLOW_RUNS = 5;

  /** True for any status that names an outcome (not in-flight, not absent). */
  function isSettledWorkflowStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    return Boolean(status) && status !== 'running';
  }

  /**
   * Remember a settled workflow's final digest for the next /api/response
   * publish (the "Finished background task" card on the summarizing turn).
   * The run record's digest is authoritative; a run that never wrote one
   * (stopped early) settles with its last live digest, whose stale 'running'
   * status is replaced by the settle notification's ('stopped', 'failed').
   * Both settle signals may call this for the same task in either order —
   * a terminal status, once seen, is never downgraded.
   */
  function bufferSettledWorkflowRun(taskId, task, notificationStatus = '') {
    if (!proc || !task || String(task.taskType || '') !== 'local_workflow') return;
    try {
      const sessionDir = workflowSessionDirFor(proc);
      const recordDigest = sessionDir
        ? buildWorkflowDigest(proc, sessionDir, taskId, task, { recordOnly: true })
        : null;
      const digest = recordDigest
        || (task.workflowProgress && typeof task.workflowProgress === 'object' ? task.workflowProgress : null);
      if (!digest) return;
      const previous = proc.settledWorkflowDigests.get(taskId) || null;
      const status = [digest.status, notificationStatus, previous?.digest?.status]
        .find(isSettledWorkflowStatus) || digest.status || null;
      proc.settledWorkflowDigests.delete(taskId);
      proc.settledWorkflowDigests.set(taskId, {
        digest: { ...digest, status },
        // A journal-snapshot digest gets one more record-read attempt at
        // drain time (the CLI can flush the run record moments after the
        // settle signals); startedAt is what the taskId scan needs then.
        fromRecord: Boolean(recordDigest),
        startedAt: Number(task.startedAt) || 0,
      });
      while (proc.settledWorkflowDigests.size > MAX_SETTLED_WORKFLOW_RUNS) {
        proc.settledWorkflowDigests.delete(proc.settledWorkflowDigests.keys().next().value);
      }
    } catch {
      // Advisory by contract: buffering must never disturb the settle path.
    }
  }

  /**
   * Removal-first settle order: the digest was already buffered when the task
   * left the live set, but only the late task_notification knows how it ended.
   */
  function refineSettledWorkflowStatus(taskId, notificationStatus) {
    const status = String(notificationStatus || '').trim();
    const buffered = proc?.settledWorkflowDigests.get(taskId);
    if (!buffered || !status) return;
    if (!isSettledWorkflowStatus(buffered.digest.status)) buffered.digest.status = status;
  }

  /**
   * Hand the buffered digests to the response publish and clear the buffer.
   * Entries that settled on a journal snapshot (record not on disk yet — the
   * CLI flushes it moments after the settle signals, observed live as a card
   * frozen with a "running" verify agent) retry the authoritative record read
   * here: the summarizing response publishes seconds later, when the record
   * exists.
   */
  function drainSettledWorkflowRuns() {
    if (!proc || !proc.settledWorkflowDigests.size) return null;
    const entries = [...proc.settledWorkflowDigests.entries()];
    proc.settledWorkflowDigests.clear();
    const sessionDir = workflowSessionDirFor(proc);
    return entries.map(([taskId, entry]) => {
      if (!entry.fromRecord && sessionDir) {
        try {
          const record = buildWorkflowDigest(
            proc,
            sessionDir,
            taskId,
            { startedAt: entry.startedAt },
            { recordOnly: true },
          );
          if (record) {
            return isSettledWorkflowStatus(record.status)
              ? record
              : { ...record, status: entry.digest.status };
          }
        } catch {
          // Advisory: the snapshot digest below is still a valid card.
        }
      }
      return entry.digest;
    });
  }

  /**
   * Settle-time final read: the run record lands at completion, so the
   * task_notification is the one moment the completed tree (final states,
   * tokens, logs) can still ride the row before it clears.
   */
  function publishFinalWorkflowDigest(taskId, notificationStatus = '') {
    const task = proc?.liveTasks.get(taskId);
    if (!task || String(task.taskType || '') !== 'local_workflow') {
      refineSettledWorkflowStatus(taskId, notificationStatus);
      return;
    }
    bufferSettledWorkflowRun(taskId, task, notificationStatus);
    try {
      const sessionDir = workflowSessionDirFor(proc);
      if (!sessionDir) return;
      const digest = buildWorkflowDigest(proc, sessionDir, taskId, task, { recordOnly: true });
      if (!digest) return;
      const digestJson = JSON.stringify(digest);
      const state = getWorkflowState(proc, taskId);
      if (state.digestJson === digestJson) return;
      state.digestJson = digestJson;
      task.workflowProgress = digest;
      publishBackgroundTasks();
    } catch {
      // Advisory: a failed final read leaves the last live digest standing.
    }
  }

  // Remember the model each subagent spawn pinned explicitly: only the
  // spawning Agent/Task tool_use block carries it (input.model), and
  // task_started.tool_use_id links that block to its task. Capped so a
  // long-lived process holding many spawns can't grow the map unbounded.
  function recordSubagentSpawns(sdkMessage) {
    const blocks = Array.isArray(sdkMessage?.message?.content) ? sdkMessage.message.content : [];
    for (const block of blocks) {
      if (block?.type !== 'tool_use' || !isSubagentToolName(block.name)) continue;
      const toolUseId = String(block.id || '').trim();
      const model = String(block.input?.model || '').trim();
      if (!toolUseId || !model) continue;
      proc.subagentSpawns.set(toolUseId, model);
      while (proc.subagentSpawns.size > 100) {
        proc.subagentSpawns.delete(proc.subagentSpawns.keys().next().value);
      }
    }
  }

  // Between-turn notices carried into the next activated context, as either a
  // plain line or a prepared publisher action (a compaction boundary has to
  // keep the structured metadata the transcript's break row is built from —
  // as prose it would render as an ordinary tool-activity line). Capped —
  // api_retry made this the only accumulator a retry storm could grow
  // unboundedly (subagentSpawns and settledWorkflowDigests already cap).
  const MAX_PENDING_ACTIVITIES = 50;
  function carryPendingActivity(entry) {
    const carried = entry && typeof entry === 'object'
      ? entry
      : String(entry || '').trim().slice(0, 2000);
    if (!carried) return;
    proc.pendingActivities.push(carried);
    // Drop the OLDEST PROSE line first, and a structured entry only when
    // nothing else is left: the cap exists to bound a retry storm's chatter,
    // while a structured entry carries transcript geometry no later line can
    // restore (a compaction boundary buffered between turns, then 50 task
    // notifications, used to lose its break row silently). The client's
    // capRelayActivityEntries protects structured rows too, but head-caps the
    // prose it keeps; here the newest lines are the informative ones.
    while (proc.pendingActivities.length > MAX_PENDING_ACTIVITIES) {
      const proseIndex = proc.pendingActivities.findIndex((carried) => typeof carried === 'string');
      proc.pendingActivities.splice(proseIndex === -1 ? 0 : proseIndex, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Compaction
  //
  // Compaction is a long, completely silent stretch of CLI work — 133 s on a
  // 614k-token session resumed against a 100k window (conv 563e252e,
  // 2026-08-20) — that produces no turn context of its own. Two things must
  // survive it: the process (nothing else is "live" while it runs) and the
  // delivered message that triggered it (the CLI answers it AFTER the
  // boundary, on a stream the runner would otherwise read as self-opened).

  function isCompacting() {
    return Boolean(proc?.compactingSince) && Date.now() - proc.compactingSince < compactionStaleMs;
  }

  /**
   * Whether a between-turn notice can reach the relay through the active
   * context, or has to be buffered for the next one. A discarded context is
   * active but publishes nothing (dispatchToContext drops it), so it counts as
   * no context at all.
   */
  function activeContextPublishes() {
    return Boolean(proc.activeCtx) && !proc.activeCtx.discarded;
  }

  /**
   * The CLI is compacting, or just did: a delivered turn is still coming.
   * Armed only while a delivered entry is actually waiting; which turn the
   * window may then be spent on is decided when that turn opens, by reading
   * the message itself (isCompactionReplayCandidate).
   */
  function armCompactReplayAdoption() {
    if (!proc.pendingDelivered.length) return;
    proc.compactReplayUntil = Date.now() + compactReplayAdoptionMs;
    // Whatever the entries waited through, they were not idle: the CLI is
    // about to replay the turn they belong to.
    for (const entry of proc.pendingDelivered) entry.unattachedSince = 0;
  }

  function observeProcessLevel(sdkMessage) {
    const type = String(sdkMessage?.type || '');
    if (type === 'assistant') {
      recordSubagentSpawns(sdkMessage);
      return;
    }
    if (type !== 'system') return;
    const subtype = String(sdkMessage.subtype || '');
    if (subtype === 'init') {
      // The FIRST init of a process is the spawn's, and a spawn is always
      // driven by a delivered message; a LATER one is the CLI opening a turn
      // by itself.
      const firstInit = !proc.sawInit;
      proc.sawInit = true;
      persistNativeSessionId(sdkSessionId, sdkMessage.session_id).catch(() => {});
      // Tracked on the process too (not only through the persist round-trip):
      // the workflow poller needs the native id to find the session dir even
      // when the persist call is still in flight or failed.
      proc.nativeSessionId = String(sdkMessage.session_id || '').trim() || proc.nativeSessionId;
      // Init always lands before any context is active, so the per-context
      // normalizer never sees it — capture the CLI's actual model here and
      // seed it into every context at activation. Without this, a composer
      // set to `auto` published responses with model: null.
      proc.initModel = String(sdkMessage.model || '').trim() || proc.initModel;
      // A fresh init with no active turn AND nothing queued to deliver is the CLI
      // opening a turn on its own — a background-task continuation ("you will be
      // notified"). The real SDK does NOT emit a user-message replay for these
      // (verified against the live SDK: the settle is background_tasks_changed +
      // task_notification, then a bare init, then assistant/result), so without
      // marking the boundary here resolveContext() drops the continuation's
      // assistant frames as between-turn chatter and nothing publishes. A
      // delivered turn always has its row in pendingDelivered before its init is
      // processed (spawnProcess + pendingDelivered.push run synchronously ahead
      // of the async stream consumer), so it is correctly excluded here.
      //
      if (!proc.activeCtx && !proc.pendingDelivered.length) {
        proc.lastBoundary = 'self-opened';
      } else if (!proc.activeCtx && !firstInit) {
        // A LATER init, with a delivered row waiting, is the CLI opening a turn
        // of its own — the live-verified continuation shape is a bare init with
        // no user replay at all. A delivered turn cannot produce one: the
        // process is already running, and only a spawn inits (which is
        // `firstInit`, and always has its row queued before the stream is
        // read). A compaction inside such a turn would otherwise see no
        // turn-level boundary and adopt the queued row — and in this shape
        // nothing later replays to correct it.
        //
        // Structural, not a clock. Gating this on "a task settled recently"
        // fails twice over: the grace (60 s) is shorter than a compaction
        // (133 s measured), and `activateContext` zeroes the settle timestamps,
        // so any turn attaching in between erases the signal for good. Every
        // freshness-clock design in this fix's history failed the same way.
        //
        // Deliberately NOT `lastBoundary`: that flag also diverts assistant
        // traffic away from a waiting delivered row, and a settle timestamp is
        // far too weak to justify that (it stays fresh for the whole
        // notification grace after ANY task settles, compaction or not, and
        // would fail the row over while publishing its answer on a synthetic
        // continuation). This suppresses adoption and nothing else; if the turn
        // really is the delivered message's, it attaches exactly as before.
        proc.continuationInitPending = true;
      }
      return;
    }
    if (subtype === 'status') {
      // The status line is the compaction hold's only in-progress signal, so
      // every spelling that is NOT a permission-mode notice releases it:
      // `{status:null, compact_result}` is the normal terminator, a BARE
      // `{status:null}` is what an early-compact-start that produced no
      // compaction emits (no result, no boundary — the hold would otherwise
      // stand until the staleness cap, delaying the watchdog and blocking the
      // mode-change recycle), and 'requesting' comes from the main loop's
      // stream_request_start, which by definition means the CLI is past
      // compacting (the compaction fork reports progress as `stream_mode`,
      // which the SDK drops). `{status:null, permissionMode}` is a mode-change
      // notice that says nothing about compaction and is ignored.
      if (String(sdkMessage.status || '') === 'compacting') {
        proc.compactingSince = Date.now();
        armCompactReplayAdoption();
      } else if (sdkMessage.permissionMode === undefined) {
        proc.compactingSince = 0;
        // A compaction that failed produces no boundary and no replay: the
        // turn just carries on uncompacted and attaches the normal way, so
        // leaving the adoption window open would only widen the chance of a
        // later self-opened turn being adopted.
        if (String(sdkMessage.compact_result || '') === 'failed' || sdkMessage.compact_error !== undefined) {
          proc.compactReplayUntil = 0;
        }
      }
      evaluateLifecycle();
      return;
    }
    if (subtype === 'compact_boundary') {
      proc.compactingSince = 0;
      armCompactReplayAdoption();
      // The boundary is a per-turn normalizer action, but a compaction at
      // resume — exactly what lowering the window causes — lands with no
      // context to publish onto and would be dropped. Buffer it for the next
      // one; with a turn active the normalizer publishes it (resolveContext
      // routes system messages to the active context and nowhere else), so
      // the two paths can never both fire. An already-discarded context is
      // routed here too: it is still `activeCtx`, but dispatchToContext drops
      // everything it is handed. That does not cover every way a boundary can
      // still be lost — a context discarded AFTER buffering it (a continuation
      // whose registration fails all three attempts) drops the whole turn's
      // output, boundary included — but those paths lose the turn itself, so
      // the break row is the least of what is missing.
      if (!activeContextPublishes()) {
        carryPendingActivity(compactBoundaryActivityAction(sdkMessage));
      }
      return;
    }
    if (subtype === 'model_refusal_fallback') {
      // The CLI retried a safeguards-refused request on a fallback model
      // (Fable 5 → Opus 4.8 in conv 3366b9d3). Track it at process level:
      // later contexts must seed the model that is actually running, and a
      // session-scoped switch must be undone on the next delivered turn when
      // the composer pinned a model (adaptProcess repins via setModel). An
      // `auto` composer keeps the CLI's own behavior — only the recorded
      // model follows the switch.
      const fallbackModel = String(sdkMessage.fallbackModel || '').trim();
      if (fallbackModel) {
        proc.initModel = fallbackModel;
        if (String(sdkMessage.scope || '').trim().toLowerCase() === 'session') {
          proc.modelFallback = fallbackModel;
        }
      }
      // With a turn active the normalizer surfaces the CLI's notice (and the
      // attribution update); between turns the notice carries to the next one.
      if (!proc.activeCtx) {
        const notice = String(sdkMessage.content || '').trim()
          || `Model switched to ${fallbackModel || 'a fallback model'} after a refusal.`;
        carryPendingActivity(notice);
      }
      return;
    }
    if (subtype === 'api_retry') {
      // With a turn active the normalizer surfaces this as an activity on
      // that turn. Otherwise: a delivered row waiting on this very request
      // gets the notice NOW — buffering it until attach would publish the
      // explanation only after the stall is over (silent 529 retries read
      // as relay freezes on 2026-08-18). With no addressable row, carry it,
      // collapsing consecutive retry lines — only the latest matters.
      if (!proc.activeCtx) {
        const notice = formatApiRetryNotice(sdkMessage);
        const waiting = proc.pendingDelivered[0]?.ctx.message;
        if (waiting?.id) {
          publisher.postActivity(waiting, notice);
        } else {
          const last = proc.pendingActivities[proc.pendingActivities.length - 1];
          if (typeof last === 'string' && last.startsWith('Anthropic API')) proc.pendingActivities.pop();
          carryPendingActivity(notice);
        }
      }
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
      for (const taskId of proc.liveTasks.keys()) {
        // A task started after an expiry deserves its own timeout budget —
        // the one-shot latch would otherwise never cap it.
        if (!previous.has(taskId)) {
          proc.tasksExpired = false;
          proc.tasksExpiredAt = 0;
          proc.heldForTasksSince = 0;
        }
        proc.knownTasks.add(taskId);
      }
      // A task the process knew about just left the live set: it settled, and
      // the CLI is likely about to dequeue its continuation turn ("you will be
      // notified"). Pin the process for the grace window so it can't idle out in
      // the gap before that continuation's first traffic arrives. This is the
      // reliable "continuation imminent" signal and does not depend on the
      // settling task_notification (which may be silent — skip_transcript — or
      // arrive after this message); the notification-based pin is secondary.
      for (const taskId of previous.keys()) {
        if (!proc.liveTasks.has(taskId)) {
          proc.taskSettledAt = Date.now();
          break;
        }
      }
      // The live SDK usually drops a settled task's row BEFORE its
      // task_notification arrives, so this removal is the reliable moment to
      // capture a settling workflow's final digest for the transcript card
      // (the notification then refines the status when it lands).
      for (const [taskId, task] of previous) {
        if (!proc.liveTasks.has(taskId)) bufferSettledWorkflowRun(taskId, task);
      }
      syncWorkflowPoller(proc);
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
        known.subagentType = String(sdkMessage.subagent_type || '').trim() || known.subagentType || '';
        // The task's spawning tool_use id is the same identity the subagent
        // bubbles key on — recorded so the panel and the bubbles can be
        // correlated (and a targeted stop can find its task).
        known.toolUseId = String(sdkMessage.tool_use_id || '').trim() || known.toolUseId || '';
        // task_started can be the first event carrying the task_type; a
        // workflow revealed here must start its poller too.
        syncWorkflowPoller(proc);
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
        known.subagentType = String(sdkMessage.subagent_type || '').trim() || known.subagentType || '';
        known.toolUseId = String(sdkMessage.tool_use_id || '').trim() || known.toolUseId || '';
        const totalTokens = Number(sdkMessage.usage?.total_tokens);
        if (Number.isFinite(totalTokens)) known.totalTokens = totalTokens;
        publishBackgroundTasks({ throttled: true });
      }
      return;
    }
    if (subtype === 'task_notification') {
      const taskId = String(sdkMessage.task_id || '').trim();
      // A settling workflow gets one final run-record read so the completed
      // tree publishes before the row clears (best-effort: the CLI may have
      // already removed the task via background_tasks_changed).
      if (taskId) publishFinalWorkflowDigest(taskId, String(sdkMessage.status || '').trim());
      // A settled session-level task means the CLI is about to dequeue a
      // continuation turn — the process must not idle out under it. The SDK
      // flags silent notifications explicitly: skip_transcript means no
      // continuation is coming, so nothing should pin the process for one.
      if (taskId && proc.knownTasks.has(taskId) && sdkMessage.skip_transcript !== true) {
        proc.notificationPendingAt = Date.now();
      }
      if (!activeContextPublishes()) {
        const status = String(sdkMessage.status || '').trim() || 'unknown';
        const summary = String(sdkMessage.summary || '').trim();
        carryPendingActivity(`Background task ${taskId || 'unknown'} ${status}: ${summary}`);
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
    if (proc.handoffSettling) {
      // An absorbed-steering handoff just settled the previous context;
      // publishes for the incoming context must not overtake it.
      const settling = proc.handoffSettling;
      proc.handoffSettling = null;
      await settling;
    }
    if (!ctx) return;
    const actions = ctx.normalizer.normalize(sdkMessage);
    for (const action of actions) {
      await dispatchToContext(ctx, action);
    }
  }

  // ---------------------------------------------------------------------------
  // Process lifecycle

  /**
   * A background task settled and the CLI is about to dequeue a turn of its
   * own ("you will be notified"). Both signals are used: the task leaving the
   * live set (reliable, see background_tasks_changed) and the settling
   * task_notification (secondary — it may be silent or late).
   */
  function isContinuationImminent() {
    if (!proc) return false;
    const fresh = (at) => Boolean(at) && Date.now() - at < notificationGraceMs;
    return fresh(proc.notificationPendingAt) || fresh(proc.taskSettledAt);
  }

  function hasLiveWork() {
    if (!proc) return false;
    return Boolean(
      proc.activeCtx
      || proc.pendingDelivered.length
      || proc.liveTasks.size
      || isContinuationImminent()
      // A compaction produces no stream traffic for minutes; an idle shutdown
      // under it would kill the CLI mid-flight.
      || isCompacting()
      || proc.pendingControlRequests > 0,
    );
  }

  /**
   * Watchdog: a delivered entry whose replay never attached — the CLI
   * absorbed the message into a turn that already ended, or dropped it —
   * would renew its queue row's lease forever while blocking every later
   * message (the 2026-08-18 deadlock's failure mode). With no active turn,
   * no live tasks, no control round-trip in flight, and a quiet stream,
   * nothing can attach it anymore: reject its ctx.done so
   * handlePendingPayload's catch publishes a terminal error and the row
   * fails over instead of wedging the conversation.
   */
  /**
   * Adoption splices a delivered entry out of `pendingDelivered` on an
   * inference, which also takes it out of the watchdog's reach: if the turn
   * the CLI opened then produces nothing at all (a retry storm, a dropped
   * turn), `activeCtx` pins the process, nothing can fail the row over, and
   * the queue row renews its lease forever — the 2026-08-18 deadlock shape.
   * The three ways an adoption unwinds all need the CLI to say *something*,
   * so silence gets its own: a provisional adoption that never produces
   * output puts the row back, and the ordinary watchdog takes it from there.
   */
  function reapSilentProvisionalAdoption(now) {
    const ctx = proc?.activeCtx;
    if (!ctx?.adoptedFromCompaction) return;
    if (!(pendingDeliveredTimeoutMs > 0)) return;
    if (isCompacting() || proc.liveTasks.size || proc.pendingControlRequests > 0) {
      ctx.provisionalSince = now;
      return;
    }
    if (!ctx.provisionalSince) {
      ctx.provisionalSince = now;
      return;
    }
    if (now - ctx.provisionalSince < pendingDeliveredTimeoutMs) return;
    dbg('provisional adoption produced nothing; returning the row to the queue', ctx.message?.id || '(no id)');
    restoreAdoptedContext(ctx);
  }

  function reapStalePendingDelivered(now) {
    if (!proc || !proc.pendingDelivered.length) return;
    if (!(pendingDeliveredTimeoutMs > 0)) return; // 0 = watchdog disabled
    // A silent cold boot (no init yet) is slow, not wedged: a CLI that never
    // inits dies on its own and cleanupProcess rejects the contexts then.
    if (!proc.sawInit) return;
    if (proc.activeCtx || proc.liveTasks.size || proc.pendingControlRequests > 0 || isCompacting()) {
      // A turn, task, control round-trip, or compaction may still attach these
      // entries — the unattached clock starts over once the process actually
      // goes quiet. A compaction is silent work, not idleness: the CLI replays
      // the turn these entries belong to once it finishes.
      for (const entry of proc.pendingDelivered) entry.unattachedSince = 0;
      return;
    }
    const stale = [];
    proc.pendingDelivered = proc.pendingDelivered.filter((entry) => {
      if (!entry.unattachedSince) {
        entry.unattachedSince = now;
        return true;
      }
      if (now - entry.unattachedSince < pendingDeliveredTimeoutMs) return true;
      stale.push(entry);
      return false;
    });
    for (const entry of stale) {
      dbg('pending delivered watchdog fired', entry.ctx.message?.id || '(no id)');
      entry.ctx.finalized = true;
      entry.ctx.rejectDone?.(new Error(
        `claude worker watchdog: the CLI never opened a turn for this message within ${Math.round(pendingDeliveredTimeoutMs / 1000)}s of going idle (absorbed or dropped); the row is failed — resend the message to retry`,
      ));
    }
  }

  function evaluateLifecycle() {
    if (!proc || proc.closing) return;
    const now = Date.now();
    reapSilentProvisionalAdoption(now);
    reapStalePendingDelivered(now);
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
        // Hard backstop: stopTask only *requests* the stops. If the CLI
        // still reports the tasks live well past the expiry, drop them from
        // the local set so the hold releases and the normal idle wind-down
        // (endInput → CLI exit) enforces the timeout for real.
        if (proc.tasksExpired && proc.tasksExpiredAt && now - proc.tasksExpiredAt >= 60_000) {
          dbg('background tasks still live after expiry; forcing the hold release', [...proc.liveTasks.keys()].join(','));
          proc.liveTasks = new Map();
          publishBackgroundTasks();
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
    proc.tasksExpiredAt = Date.now();
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
    stopWorkflowPoller(processRef);
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
    const autoCompactWindow = normalizeAutoCompactWindow(getAutoCompactWindow());
    const abortController = new AbortController();
    const processRef = {
      turn: null,
      abortController,
      model,
      relayMode,
      effort,
      autoCompactWindow,
      appendClass: modeAppendClass(relayMode),
      permissionMode: permissionModeForRelayMode(relayMode),
      liveTasks: new Map(),
      knownTasks: new Set(),
      // taskId → { runId, labels, digestJson } for live local_workflow tasks;
      // pruned by syncWorkflowPoller when a task leaves the live set.
      workflowStates: new Map(),
      // taskId → final digest of a workflow that settled, waiting to ride the
      // next /api/response publish as `workflowRuns` (the transcript's
      // "Finished background task" card). Capped at 5, drained on attach; if
      // the process dies before a response publishes, these are lost (v1).
      settledWorkflowDigests: new Map(),
      // The freshest native session id the process itself has seen (seeded
      // from `resume`, updated on init) — the workflow poller's key into
      // `~/.claude/projects`.
      nativeSessionId: '',
      // tool_use id → explicitly pinned model of a subagent spawn block; the
      // task panel's model column resolves through this at publish time.
      subagentSpawns: new Map(),
      initModel: '',
      // Set when the CLI reported a session-scoped refusal fallback; the next
      // delivered turn repins the composer's model instead of trusting
      // `model !== proc.model` (the relay's request never changed — the CLI
      // drifted underneath it).
      modelFallback: '',
      notificationPendingAt: 0,
      // When the CLI last said it was compacting (0 = not) and how long a
      // delivered entry may still adopt the turn the CLI re-opens afterwards.
      compactingSince: 0,
      compactReplayUntil: 0,
      // A non-spawn init that opened a turn while a delivered row waited: the
      // turn is the CLI's own, so no compaction inside it may adopt that row.
      continuationInitPending: false,
      pendingActivities: [],
      sawInit: false,
      handoffSettling: null,
      activeCtx: null,
      pendingDelivered: [],
      lastBoundary: null,
      pendingControlRequests: 0,
      lastEventAt: Date.now(),
      heldForTasksSince: 0,
      taskSettledAt: 0,
      tasksExpired: false,
      tasksExpiredAt: 0,
      aborted: false,
      closing: false,
      lifecycleTimer: null,
      taskPublishTimer: null,
      workflowPollTimer: null,
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
    processRef.nativeSessionId = resume;
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
      autoCompactWindow,
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
    // A falsy model/effort is a real setting too: switching the composer back
    // to `auto` (model '') or effort `none` must reset the live process to the
    // SDK default — setModel(undefined) and effortLevel null exist for exactly
    // that. The old truthiness gate left the previous pin in place forever.
    // A session-scoped refusal fallback moved the CLI off the pinned model
    // without the relay's request ever changing, so `model !== proc.model`
    // alone can never see the drift — a pinned (non-auto) model is re-asserted
    // on the next delivered turn. The flagged request itself stays on the
    // fallback (that retry already happened, by API policy); this only stops
    // the whole session from silently staying there. An `auto` composer
    // (model '') keeps whatever the CLI chose.
    const repinAfterFallback = Boolean(proc.modelFallback) && Boolean(model);
    if (model !== proc.model || repinAfterFallback) {
      await Promise.resolve(proc.turn.setModel?.(model || undefined)).catch((error) => {
        dbg('setModel failed', error?.message || String(error));
      });
      proc.model = model;
      if (model) proc.modelFallback = '';
    }
    if (effort !== proc.effort) {
      // 'ultracode' is not an effortLevel the CLI accepts — it maps to the
      // session-scoped ultracode/enableWorkflows flags (with the effort pinned
      // to the xhigh the flag implies); every other change clears those flags
      // alongside the new effortLevel.
      await Promise.resolve(proc.turn.applyFlagSettings?.(claudeUltracodeFlagSettings(effort))).catch((error) => {
        dbg('applyFlagSettings effort failed', error?.message || String(error));
      });
      proc.effort = effort;
    }
    // The window is a delivery-scoped setting, not a per-message one: it only
    // reaches a live process through the flag layer, and `null` (Auto) has to
    // be pushed too or clearing the slider would never take effect.
    const autoCompactWindow = normalizeAutoCompactWindow(getAutoCompactWindow());
    if (autoCompactWindow !== proc.autoCompactWindow) {
      await Promise.resolve(proc.turn.applyFlagSettings?.(claudeAutoCompactFlagSettings(autoCompactWindow))).catch((error) => {
        dbg('applyFlagSettings autoCompactWindow failed', error?.message || String(error));
      });
      proc.autoCompactWindow = autoCompactWindow;
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
        // A cold start is the one moment a turn can sit silent for many
        // seconds (transcript load + first request); say so instead of
        // showing bare dots. Posted once here — not in spawnProcess — so a
        // push-race respawn cannot duplicate the line.
        publisher.postActivity(message, (message.claudeNativeSessionId || claudeNativeSessionId)
          ? 'Starting the Claude CLI (cold start — resuming the session transcript)…'
          : 'Starting the Claude CLI (cold start)…');
      }
      const content = buildClaudeUserContent(message);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const procRef = proc;
        const ctx = createDeliveredContext(message);
        procRef.pendingDelivered.push({ ctx, expectedText: contentText(content), pushedAt: Date.now() });
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

  /**
   * Targeted subagent stop: the relay's subagentRunId IS the spawning
   * tool_use id, and task_started/task_progress report the same id per task —
   * so a BACKGROUNDED subagent maps to a stoppable SDK task. In-turn
   * subagents have no task id and remain full-turn-Stop only.
   */
  async function stopBackgroundTaskByToolUseId(toolUseId) {
    const normalized = String(toolUseId || '').trim();
    if (!normalized || !proc) return false;
    for (const [taskId, task] of proc.liveTasks.entries()) {
      if (String(task?.toolUseId || '').trim() === normalized) {
        return stopBackgroundTask(taskId);
      }
    }
    return false;
  }

  return {
    handlePendingPayload,
    getActiveQueueMessageId,
    getActiveQueueMessageIds,
    isTurnActive,
    stopBackgroundTask,
    stopBackgroundTaskByToolUseId,
    shutdown,
    // Test seams / observability.
    _getProcess: () => proc,
  };
}
