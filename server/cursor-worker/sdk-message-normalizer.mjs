const MAX_TOOL_DETAIL_LENGTH = 140;
// Matches the Copilot reasoning-stream bridge's per-thought cap.
const MAX_THOUGHT_CHARS = 16 * 1024;
const SUBAGENT_TOOL_NAMES = new Set(['task', 'agent']);

function truncate(text, maxLength = MAX_TOOL_DETAIL_LENGTH) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function capThought(text) {
  const value = String(text || '');
  return value.length <= MAX_THOUGHT_CHARS ? value : value.slice(0, MAX_THOUGHT_CHARS);
}

export function isSubagentToolName(name) {
  return SUBAGENT_TOOL_NAMES.has(String(name || '').trim().toLowerCase());
}

export function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  const candidates = [
    input.command,
    input.file_path,
    input.path,
    input.pattern,
    input.description,
    input.url,
    input.query,
    input.prompt,
  ];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }
  try {
    const serialized = JSON.stringify(input);
    return serialized === '{}' ? '' : serialized;
  } catch {
    return '';
  }
}

export function formatToolActivityText(toolName, input) {
  const summary = summarizeToolInput(toolName, input);
  return truncate(summary ? `Tool (${toolName}): ${summary}` : `Tool (${toolName})`);
}

// Mirrors the emit gating used by the Copilot extension's stream publisher so
// relay_stream traffic stays comparable across providers.
export function shouldEmitStreamUpdate(nextText, previousText) {
  const next = String(nextText || '');
  const prev = String(previousText || '');
  if (!next) return false;
  if (!prev) return true;
  if (next === prev) return false;
  const delta = next.length - prev.length;
  if (delta >= 24) return true;
  if (delta > 0 && /[\n.!?:)]$/.test(next)) return true;
  if (delta <= 0) return true;
  return false;
}

/**
 * Stateful normalizer mapping the Cursor adapter's merged event stream onto
 * relay channel actions. One instance per turn.
 *
 * `normalize(event)` consumes `{ source: 'delta', update }` (InteractionUpdate
 * from send's onDelta) and `{ source: 'stream', message }` (SDKMessage from
 * run.stream()) and returns `{ channel, payload }` actions on the same six
 * channels as the Claude worker.
 *
 * Both surfaces can describe the same text/thinking. Ownership latches decide
 * once per turn: the first `text-delta` (resp. `thinking-delta`) makes the
 * delta surface authoritative, and stream-surface `assistant` text blocks
 * (resp. `thinking` messages) are then only kept as a final-text fallback.
 * Without deltas (degraded mode) the stream messages are the emission path.
 * Tool lifecycle is owned by stream `tool_call` messages; the delta surface's
 * tool-call updates are ignored.
 *
 * Limitation: the Cursor SDK does not attribute text, thinking, or tool frames
 * to subagent threads, so stream/thought/activity payloads always carry
 * `subagentRunId: null`; subagent rows exist only for the agent/task tool
 * lifecycle, keyed by `call_id`.
 */
export function createSdkMessageNormalizer() {
  let initModel = '';
  let streamText = ''; // text-delta accumulator
  let fallbackText = ''; // assistant-message text accumulator
  let lastEmittedStreamText = '';
  let deltaOwnsText = false;
  let deltaOwnsThinking = false;
  let openThought = null; // { reasoningId, text }
  let stepIndex = 0;
  let thoughtIndex = 0; // monotonic across the turn, so ids never collide
  let lastUsage = null;
  const knownSubagentRuns = new Map(); // call_id -> displayName
  const seenToolFrames = new Set(); // `${call_id}\u0000${status}` de-dupe

  function allocateThoughtId() {
    const id = `cursor-thought-main-${stepIndex}-${thoughtIndex}`;
    thoughtIndex += 1;
    return id;
  }

  function closeOpenThought(actions) {
    if (!openThought) return;
    if (openThought.text.trim()) {
      actions.push({
        channel: 'thought',
        payload: {
          reasoningId: openThought.reasoningId,
          text: openThought.text,
          done: true,
          subagentRunId: null,
        },
      });
    }
    openThought = null;
  }

  function normalizeDelta(update) {
    const actions = [];
    const type = String(update?.type || '');

    if (type === 'text-delta') {
      deltaOwnsText = true;
      streamText += String(update?.text || '');
      if (shouldEmitStreamUpdate(streamText, lastEmittedStreamText)) {
        lastEmittedStreamText = streamText;
        actions.push({
          channel: 'stream',
          payload: { text: streamText, done: false, subagentRunId: null },
        });
      }
      return actions;
    }

    if (type === 'thinking-delta') {
      deltaOwnsThinking = true;
      if (!openThought) openThought = { reasoningId: allocateThoughtId(), text: '' };
      openThought.text = capThought(openThought.text + String(update?.text || ''));
      actions.push({
        channel: 'thought',
        payload: {
          reasoningId: openThought.reasoningId,
          text: openThought.text,
          done: false,
          subagentRunId: null,
        },
      });
      return actions;
    }

    if (type === 'thinking-completed') {
      closeOpenThought(actions);
      return actions;
    }

    if (type === 'step-started') {
      stepIndex += 1;
      return actions;
    }

    if (type === 'step-completed') {
      // Steps can end without an explicit thinking-completed; never leave a
      // thought dangling in "streaming" state across a step boundary.
      closeOpenThought(actions);
      return actions;
    }

    if (type === 'turn-ended') {
      if (update?.usage && typeof update.usage === 'object') lastUsage = update.usage;
      return actions;
    }

    // tool-call-started/-completed/-delta, partial-tool-call, token-delta,
    // summary*, user-message-appended, shell-output-delta: intentionally ignored.
    return actions;
  }

  function actionsForToolCall(message) {
    const actions = [];
    const callId = String(message?.call_id || '').trim();
    const status = String(message?.status || '').trim();
    if (!callId || !status) return actions;
    const frameKey = `${callId}\u0000${status}`;
    if (seenToolFrames.has(frameKey)) return actions;
    seenToolFrames.add(frameKey);

    const toolName = String(message?.name || '').trim() || 'unknown';
    const args = message?.args && typeof message.args === 'object' ? message.args : {};

    if (status === 'running') {
      if (isSubagentToolName(toolName)) {
        const displayName = String(
          args.description
          || args.name
          || args.subagent_type
          || 'Subagent',
        ).trim() || 'Subagent';
        knownSubagentRuns.set(callId, displayName);
        actions.push({
          channel: 'subagent',
          payload: {
            subagentRunId: callId,
            parentSubagentId: null,
            displayName,
            status: 'running',
          },
        });
      }
      actions.push({
        channel: 'activity',
        payload: { text: formatToolActivityText(toolName, args), subagentRunId: null },
      });
      return actions;
    }

    if (status === 'completed') {
      if (knownSubagentRuns.has(callId)) {
        actions.push({
          channel: 'subagent',
          payload: {
            subagentRunId: callId,
            parentSubagentId: null,
            displayName: knownSubagentRuns.get(callId),
            status: 'completed',
          },
        });
      }
      return actions;
    }

    if (status === 'error') {
      if (knownSubagentRuns.has(callId)) {
        actions.push({
          channel: 'subagent',
          payload: {
            subagentRunId: callId,
            parentSubagentId: null,
            displayName: knownSubagentRuns.get(callId),
            status: 'failed',
          },
        });
      }
      const resultText = typeof message?.result === 'string'
        ? message.result
        : String(message?.result?.text ?? '');
      actions.push({
        channel: 'activity',
        payload: {
          text: truncate(`Tool failed: ${resultText.trim() || 'unknown error'}`),
          subagentRunId: null,
        },
      });
      return actions;
    }

    return actions;
  }

  function normalizeMessage(message) {
    const actions = [];
    const type = String(message?.type || '');

    if (type === 'system' && message?.subtype === 'init') {
      initModel = String(message.model || '').trim();
      actions.push({
        channel: 'init',
        payload: {
          sessionId: String(message.session_id ?? message.sessionId ?? '').trim(),
          model: initModel,
        },
      });
      return actions;
    }

    if (type === 'assistant') {
      const content = Array.isArray(message?.message?.content) ? message.message.content : [];
      for (const block of content) {
        if (block?.type !== 'text') continue; // tool_use lifecycle is owned by tool_call messages
        const text = String(block?.text || '');
        if (!text) continue;
        fallbackText += text;
        if (!deltaOwnsText && shouldEmitStreamUpdate(fallbackText, lastEmittedStreamText)) {
          lastEmittedStreamText = fallbackText;
          actions.push({
            channel: 'stream',
            payload: { text: fallbackText, done: false, subagentRunId: null },
          });
        }
      }
      return actions;
    }

    if (type === 'thinking') {
      if (deltaOwnsThinking) return actions;
      const text = capThought(String(message?.text || ''));
      if (!text.trim()) return actions;
      actions.push({
        channel: 'thought',
        payload: {
          reasoningId: allocateThoughtId(),
          text,
          done: true,
          subagentRunId: null,
        },
      });
      return actions;
    }

    if (type === 'tool_call') {
      return actionsForToolCall(message);
    }

    if (type === 'task') {
      const status = String(message?.status || '').trim() || 'unknown';
      return [{
        channel: 'activity',
        payload: {
          text: truncate(`Background task ${status}: ${String(message?.text || '').trim()}`),
          subagentRunId: null,
        },
      }];
    }

    if (type === 'usage') {
      if (message?.usage && typeof message.usage === 'object') lastUsage = message.usage;
      return actions;
    }

    if (type === 'status') {
      const status = String(message?.status || '').trim().toUpperCase();
      const terminal = {
        FINISHED: { isError: false, subtype: 'finished' },
        ERROR: { isError: true, subtype: 'error' },
        EXPIRED: { isError: true, subtype: 'expired' },
        CANCELLED: { isError: false, subtype: 'cancelled' },
      }[status];
      if (!terminal) return actions; // CREATING / RUNNING
      // Errored turns may end before any text streamed; the status message is
      // then the only human-readable explanation, so surface it as the result.
      const errorMessage = terminal.isError ? String(message?.message || '').trim() : '';
      const text = finalStreamText() || errorMessage;
      actions.push({
        channel: 'result',
        payload: {
          text,
          isError: terminal.isError,
          subtype: terminal.subtype,
          // Kept separate from text (which streamed prose can shadow) so the
          // runner can classify the failure from the status message itself.
          errorMessage: errorMessage || null,
          usage: lastUsage,
          totalCostUsd: null,
        },
      });
      return actions;
    }

    // user, request: intentionally ignored.
    return actions;
  }

  function normalize(event) {
    if (!event || typeof event !== 'object') return [];
    if (event.source === 'delta') return normalizeDelta(event.update);
    if (event.source === 'stream') return normalizeMessage(event.message);
    return [];
  }

  function finalStreamText() {
    return streamText || fallbackText;
  }

  return {
    normalize,
    finalStreamText,
    get model() { return initModel; },
  };
}
