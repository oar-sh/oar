// Pure mapping from Copilot SDK `SessionEvent`s onto the relay's channel
// actions — the same six channels the Claude and Cursor workers publish on
// (init / stream / thought / activity / subagent / result), so the transcript,
// reasoning bubbles and activity rows render identically whichever engine ran
// the turn. No I/O, no SDK import: one instance per turn, fed every event the
// session emits while that turn is in flight.
//
// Shapes are taken from the phase-0 spike dumps, which are checked in under
// ./fixtures and replayed by the tests. Four findings drive most of the design
// decisions below and are worth stating up front:
//
//  1. `assistant.turn_end` fires once per MODEL CALL, not once per user
//     request — a tool-using turn emits turn_start/turn_end, runs the tool,
//     then opens a second turn. Only `session.idle` ends the interaction.
//  2. A quota-failed turn never reaches `session.idle` at all (the spike's
//     event-dump has 2 idles for 3 turns), so `session.error` has to be a
//     terminator in its own right or the worker hangs on every quota failure.
//  3. `turnId` is the string "0" in every event of every dump. It is not an
//     identifier; `interactionId` is.
//  4. Subagent events are tagged with `agentId` on the event ENVELOPE (not on
//     `data`), and it is absent for the root agent. See `isSubagentEvent`.
import { sanitizeSubagentRunId } from '../../shared/subagent-run-id.mjs';
import { capThought } from '../../shared/thought-cap.mjs';
import { shouldEmitStreamUpdate } from '../../shared/stream-emit-gating.mjs';

const MAX_TOOL_DETAIL_LENGTH = 140;

function truncate(text, maxLength = MAX_TOOL_DETAIL_LENGTH) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** The arguments most worth showing in an activity row, in preference order. */
const TOOL_SUMMARY_KEYS = [
  'command',
  'fullCommandText',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'description',
  'url',
  'query',
  'question',
  'prompt',
];

function renderScalar(value) {
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === 'object') return '{…}';
  return '';
}

export function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = String(input[key] ?? '').trim();
    if (value) return value;
  }
  // Fallback for tools with no recognised argument. Bounded on purpose: the
  // result is truncated to 140 characters anyway, and a tool called with a
  // megabyte of file contents must not be serialized in full to produce it.
  const parts = [];
  let budget = MAX_TOOL_DETAIL_LENGTH;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || typeof value === 'function') continue;
    const rendered = renderScalar(value);
    if (!rendered) continue;
    parts.push(`${key}=${rendered}`);
    budget -= key.length + rendered.length + 2;
    if (budget <= 0) break;
  }
  return parts.join(' ');
}

export function formatToolActivityText(toolName, input) {
  const name = String(toolName || '').trim() || 'tool';
  const summary = summarizeToolInput(input);
  return truncate(summary ? `Tool (${name}): ${summary}` : `Tool (${name})`);
}

/**
 * True when an event belongs to a SUBAGENT rather than the root agent.
 *
 * Every event interface in the SDK's generated schema carries the same
 * optional envelope field: "Sub-agent instance identifier. Absent for events
 * from the root/main agent and session-level events." Note it is on the
 * envelope, NOT on `data`.
 *
 * The runtime forwards subagent streaming by default
 * (`includeSubAgentStreamingEvents`, default true), and turning that flag off
 * is not an option: a live probe against runtime 1.0.82 showed it also
 * collapses the PARENT's tool-call argument streaming (`streaming_delta`
 * 33→2, `tool_call_delta` 32→1), gutting main-transcript streaming. So the
 * routing lives here instead: phase 1 dropped these events, phase 2 routes
 * them to the subagent lane keyed on `agentId`.
 */
export function isSubagentEvent(event) {
  return !!String(event?.agentId || '').trim();
}

/**
 * The run id for a subagent event.
 *
 * Lifecycle events (`subagent.started` / `completed` / `failed`) carry
 * `data.toolCallId` — the spawning tool call — while the tagged
 * `assistant.message` that holds the subagent's actual reply carries only the
 * envelope `agentId`. Whichever of the two is present is registered as an
 * ALIAS of one canonical run id (see `resolveSubagentRun`), so the lane still
 * assembles if a runtime version populates only one of them.
 */
export function subagentEventKeys(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  return {
    agentId: sanitizeSubagentRunId(event?.agentId),
    toolCallId: sanitizeSubagentRunId(data.toolCallId),
  };
}

/** A short, human-readable label for a subagent, for the lane header. */
export function subagentDisplayName(data) {
  return String(data?.agentDisplayName || data?.agentName || '').trim() || 'Subagent';
}

/** "12.3k tokens · 4 tool calls · 8.1s" — whichever parts the runtime reported. */
export function formatSubagentStats(data) {
  const parts = [];
  const tokens = Number(data?.totalTokens);
  if (Number.isFinite(tokens) && tokens > 0) parts.push(`${tokens} tokens`);
  const toolCalls = Number(data?.totalToolCalls);
  if (Number.isFinite(toolCalls) && toolCalls > 0) parts.push(`${toolCalls} tool calls`);
  const durationMs = Number(data?.durationMs);
  if (Number.isFinite(durationMs) && durationMs > 0) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  return parts.join(' · ');
}

/**
 * Per-turn token/cost accounting. `assistant.usage` fires once per model call,
 * so a tool-using turn reports several — they are summed, while latency
 * figures keep the FIRST call's time-to-first-token (that is the number a user
 * experiences as "did it start answering").
 */
function createUsageAccumulator() {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    // `cost` is the PREMIUM MULTIPLIER, not money — the field name is
    // misleading and there is no `premiumRequests` field at all. Real spend is
    // `copilotUsage.totalNanoAiu`, summed separately below, which is what a
    // usage card must report.
    cost: 0,
    totalNanoAiu: 0,
    modelCalls: 0,
    subagentModelCalls: 0,
    durationMs: 0,
    timeToFirstTokenMs: null,
    model: '',
    isByok: null,
    quotaSnapshots: null,
  };
  function add(data, { allowModel = true } = {}) {
    if (!data || typeof data !== 'object') return;
    totals.modelCalls += 1;
    if (!allowModel) totals.subagentModelCalls += 1;
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'cost']) {
      const value = Number(data[key]);
      if (Number.isFinite(value)) totals[key] += value;
    }
    const nanoAiu = Number(data.copilotUsage?.totalNanoAiu);
    if (Number.isFinite(nanoAiu)) totals.totalNanoAiu += nanoAiu;
    const duration = Number(data.duration);
    if (Number.isFinite(duration)) totals.durationMs += duration;
    const ttft = Number(data.timeToFirstTokenMs);
    if (totals.timeToFirstTokenMs === null && Number.isFinite(ttft)) totals.timeToFirstTokenMs = ttft;
    // A subagent's usage counts toward spend but must not rename the turn's
    // model: `task` can override the model per subagent.
    const model = allowModel ? String(data.model || '').trim() : '';
    if (model) totals.model = model;
    if (typeof data.isByok === 'boolean') totals.isByok = data.isByok;
    // Usually `{}` on a healthy call; a populated snapshot (the quota path)
    // must not be overwritten by a later empty one.
    if (data.quotaSnapshots && Object.keys(data.quotaSnapshots).length) {
      totals.quotaSnapshots = data.quotaSnapshots;
    }
  }
  return {
    add,
    setQuotaSnapshots(snapshots) {
      if (snapshots && typeof snapshots === 'object' && Object.keys(snapshots).length) {
        totals.quotaSnapshots = snapshots;
      }
    },
    snapshot() {
      return totals.modelCalls ? { ...totals } : (totals.quotaSnapshots ? { ...totals } : null);
    },
  };
}

/**
 * Stateful per-turn normalizer. `normalize(event)` returns zero or more
 * `{ channel, payload }` actions; the session process dispatches them to the
 * relay and treats the first `result` action as the turn's terminator.
 */
export function createCopilotEventNormalizer() {
  let sessionModel = '';
  let sessionId = '';
  let lastEmittedStreamText = '';
  let aborted = false;
  let terminalEmitted = false;
  let contextUsage = null;
  let interactionId = '';
  const usage = createUsageAccumulator();

  // Assistant text is assembled per `messageId`. A tool-using request produces
  // several assistant messages (the first typically empty with `toolRequests`,
  // a later one carrying the prose), so the reply is the ordered join of the
  // non-empty ones rather than "the last message wins".
  //
  // `cachedPrefix` is the joined text of every message EXCEPT the newest one.
  // Deltas only ever touch the newest, so composing the reply per delta is an
  // append rather than a re-join of the whole conversation — the difference
  // between O(n) and O(n²) work across a long streamed answer. It is dropped
  // (rebuilt lazily) whenever a new message opens or an older one is rewritten.
  const messageOrder = [];
  const messageTexts = new Map();
  let cachedPrefix = null;
  const openThoughts = new Map(); // reasoningId -> accumulated text
  const emittedThoughts = new Map(); // reasoningId -> last published text
  const toolNames = new Map(); // toolCallId -> toolName
  const permissionRequests = new Map(); // requestId -> summary

  // ---- prompt segments (steering attribution) -------------------------------
  //
  // One interaction can answer SEVERAL prompts: a message sent mid-turn is
  // queued by the runtime and picked up at the next model-call boundary, and
  // the whole thing closes with a single `session.idle` (live-verified, see
  // §4b/§5 of the plan). Each prompt the runtime actually starts work on opens
  // with its own `user.message` event, so those events are the prompt
  // boundaries — and they are what lets a steered queue row be answered with
  // ITS OWN text instead of the whole interaction's transcript.
  const segments = []; // array of arrays of messageIds, one per user.message

  function currentSegment() {
    if (!segments.length) segments.push([]);
    return segments[segments.length - 1];
  }

  function noteMessage(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return '';
    if (!messageTexts.has(id)) {
      messageTexts.set(id, '');
      messageOrder.push(id);
      currentSegment().push(id);
      // The message that was newest is now part of the prefix.
      cachedPrefix = null;
    }
    return id;
  }

  /** The reply text for prompt `index` (0 = the prompt the turn opened with). */
  function segmentText(index) {
    const ids = segments[index];
    if (!Array.isArray(ids) || !ids.length) return '';
    const parts = [];
    for (const id of ids) {
      const text = String(messageTexts.get(id) || '');
      if (text.trim()) parts.push(text);
    }
    return parts.join('\n\n');
  }

  // ---- subagent lane --------------------------------------------------------
  //
  // Keyed on the envelope `agentId`, which a live BYOK probe confirmed is
  // present on the lifecycle events AND on the tagged `assistant.message`
  // carrying the reply (and is NOT equal to `data.toolCallId`). `toolCallId` is
  // registered as an alias anyway so the lane still assembles if a future
  // runtime tags only one of them.
  const subagentRuns = new Map(); // runId -> { displayName, status, opened }
  const subagentAliases = new Map(); // agentId|toolCallId -> runId

  /**
   * `useToolCallId` is true only for `subagent.*` lifecycle events, where
   * `data.toolCallId` names the tool call that SPAWNED this subagent.
   *
   * On any other event `toolCallId` names a tool call the subagent is MAKING,
   * which is a different thing entirely — aliasing it would mean that if a
   * subagent ever spawned a nested one, the child's `subagent.started` (whose
   * `toolCallId` is that same inner call) would resolve to the PARENT's run:
   * the child's text would merge into the parent's lane and the child's
   * `completed` would close the parent's bubble while it was still running.
   */
  function resolveSubagentRun(event, { useToolCallId = false } = {}) {
    const { agentId, toolCallId } = subagentEventKeys(event);
    const alias = useToolCallId ? toolCallId : null;
    const runId = (agentId && subagentAliases.get(agentId))
      || (alias && subagentAliases.get(alias))
      || agentId
      || alias
      || null;
    if (!runId) return null;
    if (agentId) subagentAliases.set(agentId, runId);
    if (alias) subagentAliases.set(alias, runId);
    return runId;
  }

  /**
   * Open a lane the moment anything references the run, even if
   * `subagent.started` was missed or arrives out of order — a lane that only
   * ever appears on a perfectly ordered event stream is a lane that silently
   * vanishes on the day the stream is not perfectly ordered.
   */
  function ensureSubagentRun(runId, displayName) {
    let run = subagentRuns.get(runId);
    if (!run) {
      run = { displayName: displayName || 'Subagent', status: 'running', opened: false };
      subagentRuns.set(runId, run);
    } else if (displayName && run.displayName === 'Subagent') {
      run.displayName = displayName;
    }
    if (run.opened) return [];
    run.opened = true;
    return [{
      channel: 'subagent',
      payload: {
        subagentRunId: runId,
        // Copilot reports one flat level: `subagent.started` names the parent
        // TOOL CALL, not a parent agent, so there is no id to nest under. Same
        // choice the Cursor worker makes.
        parentSubagentId: null,
        displayName: run.displayName,
        status: 'running',
      },
    }];
  }

  function closeSubagentRun(runId, status, displayName) {
    const actions = ensureSubagentRun(runId, displayName);
    const run = subagentRuns.get(runId);
    if (run) run.status = status;
    actions.push({
      channel: 'subagent',
      payload: {
        subagentRunId: runId,
        parentSubagentId: null,
        displayName: run?.displayName || displayName || 'Subagent',
        status,
      },
    });
    return actions;
  }

  // The agent's explicit closing message, delivered via session.task_complete.
  // In autopilot agent mode the model can finish with BOTH durable
  // assistant.messages empty — the whole answer lives in the task summary
  // (live burn-in, 2026-08-31: "echo CWD" produced 145 output tokens and an
  // empty reply). The extension already treats task_complete({ summary }) as
  // "the agent's explicit closing message — highest priority"
  // (runtime/session-io.mjs); the same precedence applies here.
  let taskCompleteSummary = '';

  /** What the user should read: the task summary outranks composed text. */
  function finalText() {
    return taskCompleteSummary || composeText();
  }

  function composeText() {
    if (!messageOrder.length) return '';
    if (cachedPrefix === null) {
      const parts = [];
      for (let index = 0; index < messageOrder.length - 1; index += 1) {
        const text = String(messageTexts.get(messageOrder[index]) || '');
        if (text.trim()) parts.push(text);
      }
      cachedPrefix = parts.join('\n\n');
    }
    const newest = String(messageTexts.get(messageOrder[messageOrder.length - 1]) || '');
    if (!newest.trim()) return cachedPrefix;
    return cachedPrefix ? `${cachedPrefix}\n\n${newest}` : newest;
  }

  function streamActions() {
    const text = composeText();
    if (!shouldEmitStreamUpdate(text, lastEmittedStreamText)) return [];
    lastEmittedStreamText = text;
    return [{ channel: 'stream', payload: { text, done: false, subagentRunId: null } }];
  }

  function thoughtAction(reasoningId, text, done) {
    return {
      channel: 'thought',
      payload: {
        // Namespaced so a reasoning id can never collide with another
        // provider's ids in the relay's thought rows.
        reasoningId: `copilot-thought-${sanitizeSubagentRunId(reasoningId) || 'main'}`,
        text,
        done,
        subagentRunId: null,
      },
    };
  }

  function activityAction(text, subagentRunId = null) {
    return { channel: 'activity', payload: { text, subagentRunId } };
  }

  /**
   * Build the single terminal `result` action for this turn. Guarded so a
   * `session.error` arriving after a `session.idle` (or a second error) cannot
   * publish a second response for the same queue row.
   */
  function terminalAction({ isError = false, subtype = 'completed', errorMessage = null, errorData = null } = {}) {
    if (terminalEmitted) return [];
    terminalEmitted = true;
    // A subagent still marked running when the interaction ends would render as
    // a bubble spinning forever: the relay only reconciles open runs when the
    // queue row FAILS, so a successful turn has to close its own. Cursor learnt
    // the same lesson (`activeSubagentRuns` on handle recreation).
    const strays = [];
    for (const [runId, run] of subagentRuns) {
      if (run.status !== 'running') continue;
      run.status = 'failed';
      strays.push({
        channel: 'subagent',
        payload: {
          subagentRunId: runId,
          parentSubagentId: null,
          displayName: run.displayName,
          status: 'failed',
        },
      });
    }
    return [...strays, {
      channel: 'result',
      payload: {
        text: finalText(),
        // Per-prompt texts, so an interaction that absorbed a steered message
        // can answer each queue row with the reply that belongs to it. The
        // task summary closes the LAST prompt — earlier segments keep their
        // own streamed replies.
        segmentTexts: segments.map((_, index) => (
          taskCompleteSummary && index === segments.length - 1
            ? taskCompleteSummary
            : segmentText(index)
        )),
        promptCount: segments.length,
        isError,
        aborted,
        subtype,
        errorMessage,
        // The raw payload travels with the result so the session process can
        // run it through the shared terminal-error classifier without the
        // normalizer needing to know about failure taxonomies.
        errorData,
        usage: usage.snapshot(),
        contextUsage,
        model: sessionModel,
        interactionId,
      },
    }];
  }

  function normalize(event) {
    if (!event || typeof event !== 'object') return [];
    const type = String(event.type || '');
    const data = event.data && typeof event.data === 'object' ? event.data : {};

    // ---- subagent lifecycle (session-scoped, tagged with the subagent's id) --
    switch (type) {
      case 'subagent.started': {
        const runId = resolveSubagentRun(event, { useToolCallId: true });
        if (!runId) return [];
        return ensureSubagentRun(runId, subagentDisplayName(data));
      }
      case 'subagent.configured':
      case 'subagent.selected': {
        // `subagent.configured` is UNDOCUMENTED — it appears in no published
        // schema and a live probe found it between started and completed,
        // carrying `agentId` but neither `toolCallId` nor a display name. It is
        // handled rather than ignored so the lane still opens if it ever
        // arrives first, and it must never clobber the roster's display name
        // with its own absent one (hence the `||` in ensureSubagentRun).
        const runId = resolveSubagentRun(event, { useToolCallId: true });
        if (!runId) return [];
        return ensureSubagentRun(runId, subagentDisplayName(data));
      }
      case 'subagent.completed': {
        const runId = resolveSubagentRun(event, { useToolCallId: true });
        if (!runId) return [];
        const actions = closeSubagentRun(runId, 'completed', subagentDisplayName(data));
        const stats = formatSubagentStats(data);
        if (stats) actions.push(activityAction(truncate(`Finished · ${stats}`), runId));
        return actions;
      }
      case 'subagent.failed': {
        const runId = resolveSubagentRun(event, { useToolCallId: true });
        if (!runId) return [];
        const name = subagentDisplayName(data);
        const reason = String(data.error || '').trim() || 'unknown error';
        const actions = closeSubagentRun(runId, 'failed', name);
        actions.push(activityAction(truncate(`Subagent failed: ${reason}`), runId));
        // ALSO on the main thread. The parent agent recovers from a failed
        // subagent silently — it just carries on — so a failure reported only
        // inside a collapsed lane bubble is a failure the user never learns
        // about. This is the line that makes it visible.
        actions.push(activityAction(truncate(`Subagent failed (${name}): ${reason}`)));
        return actions;
      }
      case 'subagent.deselected':
        return [];
      default:
        break;
    }

    // ---- subagent-tagged events → the lane -----------------------------------
    //
    // The runtime forwards subagent streaming by default and the flag that
    // suppresses it also breaks PARENT streaming (see `isSubagentEvent`), so
    // these are routed here rather than suppressed at the source. Hosted
    // subagents emit no deltas at all: the whole reply arrives as one tagged
    // `assistant.message` (live-verified), which is why this publishes it as a
    // completed stream rather than accumulating.
    if (isSubagentEvent(event)) {
      const runId = resolveSubagentRun(event);
      if (!runId) return [];
      if (type === 'assistant.message') {
        const content = String(data.content || '');
        if (!content.trim()) return [];
        const actions = ensureSubagentRun(runId);
        actions.push({
          channel: 'stream',
          payload: { text: content, done: true, subagentRunId: runId },
        });
        return actions;
      }
      if (type === 'tool.execution_start') {
        const toolName = String(data.toolName || '').trim() || 'tool';
        const actions = ensureSubagentRun(runId);
        actions.push(activityAction(formatToolActivityText(toolName, data.arguments), runId));
        return actions;
      }
      if (type === 'assistant.usage') {
        // Counted toward the turn's spend — a subagent's model call costs real
        // money — but it must not set the turn's REPORTED model, which is the
        // main thread's. Subagents can run a different model entirely
        // (`task`'s `model` override).
        usage.add(data, { allowModel: false });
        return [];
      }
      // Everything else the subagent emits (deltas, turn_start/end, reasoning,
      // its own user/system messages) is deliberately dropped: it would
      // otherwise merge into the main reply or the main thinking bubble.
      return [];
    }

    switch (type) {
      // ---- prompt boundary --------------------------------------------------
      case 'user.message': {
        // The runtime has started work on a prompt. Opens a new segment so a
        // message that was steered into this interaction gets its own reply
        // text. Deliberately NOT gated on segment emptiness: two prompts in a
        // row with no assistant output between them are still two prompts.
        segments.push([]);
        cachedPrefix = null;
        return [];
      }
      // ---- session identity -------------------------------------------------
      case 'session.start':
      case 'session.resume': {
        sessionId = String(data.sessionId || sessionId || '').trim();
        const model = String(data.selectedModel || '').trim();
        if (model) sessionModel = model;
        return [{
          channel: 'init',
          payload: {
            sessionId,
            model: sessionModel,
            resumed: type === 'session.resume',
            eventCount: Number(data.eventCount) || 0,
          },
        }];
      }
      case 'session.model_change': {
        const model = String(data.newModel || '').trim();
        if (model) sessionModel = model;
        return [{ channel: 'init', payload: { sessionId, model: sessionModel, resumed: false, eventCount: 0 } }];
      }

      // ---- assistant text ---------------------------------------------------
      case 'assistant.message_start': {
        noteMessage(data.messageId);
        return [];
      }
      case 'assistant.message_delta': {
        const id = noteMessage(data.messageId);
        if (!id) return [];
        messageTexts.set(id, messageTexts.get(id) + String(data.deltaContent || ''));
        if (id !== messageOrder[messageOrder.length - 1]) cachedPrefix = null;
        return streamActions();
      }
      case 'assistant.message': {
        const id = noteMessage(data.messageId);
        const model = String(data.model || '').trim();
        if (model) sessionModel = model;
        interactionId = String(data.interactionId || interactionId || '').trim();
        // The durable message is authoritative over whatever the deltas
        // accumulated — but ONLY when it actually carries content. The
        // tool-request message is documented to arrive with empty content, and
        // letting that overwrite the accumulated deltas would blank an answer
        // the user already watched stream in.
        const content = String(data.content || '');
        if (id && content) {
          messageTexts.set(id, content);
          if (id !== messageOrder[messageOrder.length - 1]) cachedPrefix = null;
        }
        return streamActions();
      }

      // ---- reasoning --------------------------------------------------------
      case 'assistant.reasoning_delta': {
        const id = String(data.reasoningId || '').trim();
        if (!id) return [];
        const next = capThought((openThoughts.get(id) || '') + String(data.deltaContent || ''));
        openThoughts.set(id, next);
        // Same gating as the stream channel, per reasoning block. Without it a
        // long thought publishes a POST per token, and once the 16 KiB cap is
        // reached every further delta would re-publish identical text forever.
        // It also drops the empty-content case: hosted models return encrypted
        // reasoning, whose events carry no text at all.
        if (!shouldEmitStreamUpdate(next, emittedThoughts.get(id) || '')) return [];
        emittedThoughts.set(id, next);
        return [thoughtAction(id, next, false)];
      }
      case 'assistant.reasoning': {
        const id = String(data.reasoningId || '').trim();
        if (!id) return [];
        const text = capThought(String(data.content || openThoughts.get(id) || ''));
        openThoughts.delete(id);
        emittedThoughts.delete(id);
        // Hosted models emit this ephemerally with EMPTY content (the
        // reasoning is encrypted; only `reasoningTokens` survives), so an
        // empty thought must close nothing rather than publish a blank bubble.
        if (!text.trim()) return [];
        return [thoughtAction(id, text, true)];
      }

      // ---- turn lifecycle ---------------------------------------------------
      case 'assistant.turn_start': {
        interactionId = String(data.interactionId || interactionId || '').trim();
        return [];
      }
      case 'assistant.turn_end':
        // Deliberately inert: one per model call, not one per user request.
        return [];
      case 'assistant.usage': {
        usage.add(data);
        return [];
      }
      case 'session.usage_info': {
        const tokenLimit = Number(data.tokenLimit);
        const currentTokens = Number(data.currentTokens);
        if (!Number.isFinite(tokenLimit) || !Number.isFinite(currentTokens)) return [];
        contextUsage = {
          tokenLimit,
          currentTokens,
          systemTokens: Number(data.systemTokens) || 0,
          conversationTokens: Number(data.conversationTokens) || 0,
          toolDefinitionsTokens: Number(data.toolDefinitionsTokens) || 0,
        };
        return [];
      }

      // ---- tools ------------------------------------------------------------
      case 'tool.execution_start': {
        const toolCallId = String(data.toolCallId || '').trim();
        const toolName = String(data.toolName || '').trim() || 'tool';
        if (toolCallId) toolNames.set(toolCallId, toolName);
        return [activityAction(formatToolActivityText(toolName, data.arguments))];
      }
      case 'tool.execution_complete': {
        // There is no `tool.*_failed` event type — failure is `success: false`
        // with `error` in place of `result`.
        if (data.success !== false) return [];
        const toolCallId = String(data.toolCallId || '').trim();
        const toolName = toolNames.get(toolCallId) || 'tool';
        const reason = String(data.error?.message || data.error?.code || 'unknown error').trim();
        return [activityAction(truncate(`Tool failed (${toolName}): ${reason}`))];
      }

      // ---- permission / questions ------------------------------------------
      case 'permission.requested': {
        const requestId = String(data.requestId || '').trim();
        const request = data.permissionRequest || data.promptRequest || {};
        const summary = String(request.fullCommandText || request.intention || request.kind || '').trim();
        if (requestId) permissionRequests.set(requestId, summary);
        return [];
      }
      case 'permission.completed': {
        const requestId = String(data.requestId || '').trim();
        const summary = permissionRequests.get(requestId) || '';
        permissionRequests.delete(requestId);
        const kind = String(data.result?.kind || 'unknown').trim();
        return [activityAction(truncate(summary
          ? `Permission ${kind}: ${summary}`
          : `Permission ${kind}`))];
      }
      case 'user_input.requested': {
        // The question is forwarded to the relay as a question card; this row
        // records it in the transcript so the conversation still reads as a
        // conversation once the card has been answered and dismissed.
        const question = String(data.question || '').trim();
        return [activityAction(truncate(
          `Copilot asked: ${question || '(no question text)'}`,
        ))];
      }

      // ---- failure / abort --------------------------------------------------
      case 'abort': {
        aborted = true;
        return [];
      }
      case 'model.call_failure': {
        // Carries the quota snapshots the usage card wants; the terminal
        // classification itself rides `session.error`.
        usage.setQuotaSnapshots(data.quotaSnapshots);
        return [];
      }
      case 'session.error': {
        return terminalAction({
          isError: true,
          subtype: String(data.errorType || data.errorCode || 'session_error').trim() || 'session_error',
          errorMessage: String(data.message || '').trim() || null,
          errorData: data,
        });
      }
      // ---- explicit closing message ----------------------------------------
      case 'session.task_complete': {
        // Root-agent only by construction: an agentId-tagged task_complete
        // (a subagent finishing its own autopilot loop) was already consumed
        // by the subagent block above and never reaches this switch.
        const summary = String(data.summary || '').trim();
        if (!summary) return [];
        taskCompleteSummary = summary;
        // Stream it so the reply is visible before the terminal result lands —
        // in the empty-assistant-text case nothing has streamed yet.
        const text = finalText();
        if (!shouldEmitStreamUpdate(text, lastEmittedStreamText)) return [];
        lastEmittedStreamText = text;
        return [{ channel: 'stream', payload: { text, done: false, subagentRunId: null } }];
      }
      // ---- the one true terminator -----------------------------------------
      case 'session.idle': {
        if (data.aborted === true) aborted = true;
        return terminalAction({ subtype: aborted ? 'aborted' : 'completed' });
      }

      default:
        // Everything else is deliberately ignored, silently — the event set
        // grows between CLI releases (the live probe found an undocumented
        // `subagent.configured` that is in no published schema), so an unknown
        // type is normal and must never warn or throw. The high-volume
        // offenders: `assistant.streaming_delta` is a byte counter (not
        // content), `pending_messages.modified` and
        // `session.background_tasks_changed` always carry an empty `data` (23
        // of the latter fire during a single bash call), and the whole
        // `model.*` family duplicates information already taken from the
        // `assistant.*` events. `session.shutdown` is NOT treated as a
        // failure — the resume fixture shows it arriving from a graceful
        // disconnect immediately before a perfectly healthy turn. A runtime
        // that dies under a live turn is detected from the client instead
        // (`observeRuntimeExit`).
        return [];
    }
  }

  return {
    normalize,
    finalStreamText: finalText,
    segmentText,
    promptCount: () => segments.length,
    /**
     * Runs still marked `running`. The turn runner force-closes these when a
     * turn dies without reaching its terminator (abort, runtime exit, thrown
     * exception) — those paths never build a `result`, so the stray-closing in
     * `terminalAction` cannot run and the bubbles would spin forever.
     */
    activeSubagentRuns: () => [...subagentRuns.entries()]
      .filter(([, run]) => run.status === 'running')
      .map(([subagentRunId, run]) => ({ subagentRunId, displayName: run.displayName })),
    get model() { return sessionModel; },
  };
}
