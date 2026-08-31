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
 * Phase 1 uses this only to keep subagent prose out of the main reply and the
 * main reasoning bubble — the runtime forwards subagent streaming by default
 * (`includeSubAgentStreamingEvents`, default true), and turning that flag off
 * is not an option: a live probe against runtime 1.0.82 showed it also
 * collapses the PARENT's tool-call argument streaming (`streaming_delta`
 * 33→2, `tool_call_delta` 32→1), gutting main-transcript streaming. So the
 * filter lives here instead. Phase 2 gives subagents their own lane and starts
 * publishing this text under a `subagentRunId`.
 */
export function isSubagentEvent(event) {
  return !!String(event?.agentId || '').trim();
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
    cost: 0,
    modelCalls: 0,
    durationMs: 0,
    timeToFirstTokenMs: null,
    model: '',
    isByok: null,
    quotaSnapshots: null,
  };
  function add(data) {
    if (!data || typeof data !== 'object') return;
    totals.modelCalls += 1;
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'cost']) {
      const value = Number(data[key]);
      if (Number.isFinite(value)) totals[key] += value;
    }
    const duration = Number(data.duration);
    if (Number.isFinite(duration)) totals.durationMs += duration;
    const ttft = Number(data.timeToFirstTokenMs);
    if (totals.timeToFirstTokenMs === null && Number.isFinite(ttft)) totals.timeToFirstTokenMs = ttft;
    const model = String(data.model || '').trim();
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

  function noteMessage(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return '';
    if (!messageTexts.has(id)) {
      messageTexts.set(id, '');
      messageOrder.push(id);
      // The message that was newest is now part of the prefix.
      cachedPrefix = null;
    }
    return id;
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

  function activityAction(text) {
    return { channel: 'activity', payload: { text, subagentRunId: null } };
  }

  /**
   * Build the single terminal `result` action for this turn. Guarded so a
   * `session.error` arriving after a `session.idle` (or a second error) cannot
   * publish a second response for the same queue row.
   */
  function terminalAction({ isError = false, subtype = 'completed', errorMessage = null, errorData = null } = {}) {
    if (terminalEmitted) return [];
    terminalEmitted = true;
    return [{
      channel: 'result',
      payload: {
        text: composeText(),
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

    // Belt and braces against subagent prose merging into the main reply or
    // the main thinking bubble. The runtime forwards subagent streaming by
    // default and the flag that suppresses it also breaks parent streaming
    // (see `isSubagentEvent`), so the assistant/reasoning channels drop
    // agentId-tagged events outright. Everything else — tools, permissions,
    // usage, terminators — is session-scoped and stays.
    if (isSubagentEvent(event) && type.startsWith('assistant.')) return [];

    switch (type) {
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
        // Phase 1 answers these in-band with a "not supported" note (see
        // copilot-sdk-adapter.mjs); the activity row makes that visible in the
        // transcript instead of the model silently reporting it was blocked.
        const question = String(data.question || '').trim();
        return [activityAction(truncate(
          `Copilot asked a question the SDK worker cannot forward yet: ${question || '(no question text)'}`,
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
    finalStreamText: composeText,
    // Copilot's subagent lane is visible (`agentId` on the event envelope,
    // plus `subagent.started` / `subagent.configured` / `subagent.completed`
    // lifecycle events), but phase 1 only FILTERS it — see `isSubagentEvent`.
    // Publishing it under real run ids is phase 2's job, and this stays empty
    // until then rather than reporting runs the relay was never told about.
    activeSubagentRuns: () => [],
    get model() { return sessionModel; },
  };
}
