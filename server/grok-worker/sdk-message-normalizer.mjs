/**
 * Map ACP session/update payloads onto the six relay channels used by
 * Claude/Cursor workers: init, stream, thought, activity, subagent, result.
 */
const MAX_TOOL_DETAIL_LENGTH = 140;
const MAX_THOUGHT_CHARS = 16 * 1024;
const SUBAGENT_TOOL_NAMES = new Set(['task', 'agent', 'subagent']);

function truncate(text, maxLength = MAX_TOOL_DETAIL_LENGTH) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function capThought(text) {
  const value = String(text || '');
  return value.length <= MAX_THOUGHT_CHARS ? value : value.slice(0, MAX_THOUGHT_CHARS);
}

export function extractTextContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (content.content && typeof content.content === 'object' && typeof content.content.text === 'string') {
      return content.content.text;
    }
  }
  return '';
}

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

export function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') {
    if (typeof input === 'string') return truncate(input);
    return '';
  }
  const candidates = [
    input.command,
    input.file_path,
    input.path,
    input.pattern,
    input.description,
    input.url,
    input.query,
    input.prompt,
    input.title,
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

export function formatToolActivityText(toolName, input, title = '') {
  const name = String(toolName || title || 'tool').trim() || 'tool';
  const summary = summarizeToolInput(input) || String(title || '').trim();
  return truncate(summary ? `Tool (${name}): ${summary}` : `Tool (${name})`);
}

export function isSubagentToolName(name) {
  return SUBAGENT_TOOL_NAMES.has(String(name || '').trim().toLowerCase());
}

/**
 * One instance per turn. `normalizeAcpUpdate(update)` returns zero or more
 * `{ channel, payload }` actions.
 */
export function createSdkMessageNormalizer() {
  let streamText = '';
  let lastEmittedStreamText = '';
  let openThought = null; // { reasoningId, text }
  let stepIndex = 0;
  let thoughtIndex = 0;
  let lastUsage = null;
  const knownSubagentRuns = new Map();
  const seenToolFrames = new Set();

  function allocateThoughtId() {
    const id = `grok-thought-main-${stepIndex}-${thoughtIndex}`;
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

  function normalizeAcpUpdate(update) {
    const actions = [];
    if (!update || typeof update !== 'object') return actions;

    const kind = String(update.sessionUpdate || update.type || '').trim();

    if (kind === 'agent_message_chunk' || kind === 'agent_message') {
      const chunk = extractTextContent(update.content);
      if (!chunk) return actions;
      streamText += chunk;
      if (shouldEmitStreamUpdate(streamText, lastEmittedStreamText)) {
        lastEmittedStreamText = streamText;
        actions.push({
          channel: 'stream',
          payload: {
            text: streamText,
            done: false,
            subagentRunId: null,
          },
        });
      }
      return actions;
    }

    if (kind === 'agent_thought_chunk' || kind === 'agent_thought') {
      const chunk = extractTextContent(update.content);
      if (!chunk) return actions;
      if (!openThought) {
        openThought = { reasoningId: allocateThoughtId(), text: '' };
      }
      openThought.text = capThought(openThought.text + chunk);
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

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const toolCallId = String(update.toolCallId || update.tool_call_id || update.id || '').trim();
      const title = String(update.title || '').trim();
      const toolName = String(update.kind || update.name || update.toolName || title || 'tool').trim() || 'tool';
      const status = String(update.status || (kind === 'tool_call' ? 'pending' : '')).trim().toLowerCase();
      const frameKey = `${toolCallId}\u0000${status || kind}`;
      if (toolCallId && seenToolFrames.has(frameKey)) return actions;
      if (toolCallId) seenToolFrames.add(frameKey);

      const input = update.rawInput || update.input || update.arguments || null;
      const activityText = formatToolActivityText(toolName, input, title);
      if (activityText) {
        actions.push({
          channel: 'activity',
          payload: {
            text: activityText,
            subagentRunId: null,
          },
        });
      }

      if (isSubagentToolName(toolName) && toolCallId) {
        const displayName = title || toolName;
        if (status === 'pending' || status === 'in_progress' || status === 'running' || kind === 'tool_call') {
          if (!knownSubagentRuns.has(toolCallId)) {
            knownSubagentRuns.set(toolCallId, displayName);
            actions.push({
              channel: 'subagent',
              payload: {
                subagentRunId: toolCallId,
                displayName,
                status: 'running',
                parentSubagentId: null,
              },
            });
          }
        }
        if (status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled') {
          if (knownSubagentRuns.has(toolCallId) || status) {
            actions.push({
              channel: 'subagent',
              payload: {
                subagentRunId: toolCallId,
                displayName: knownSubagentRuns.get(toolCallId) || displayName,
                status: status === 'completed' ? 'completed' : 'failed',
                parentSubagentId: null,
              },
            });
            knownSubagentRuns.delete(toolCallId);
          }
        }
      }
      return actions;
    }

    if (kind === 'usage_update' || kind === 'usage') {
      lastUsage = {
        used: update.used,
        size: update.size,
        cost: update.cost,
        ...(typeof update === 'object' ? update : {}),
      };
      return actions;
    }

    if (kind === 'plan') {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const lines = entries
        .map((entry) => String(entry?.content || entry?.text || entry?.title || '').trim())
        .filter(Boolean);
      if (lines.length) {
        actions.push({
          channel: 'activity',
          payload: {
            text: truncate(`Plan: ${lines.join(' · ')}`, 200),
            subagentRunId: null,
          },
        });
      }
      return actions;
    }

    // Ignore user_message_chunk and unknown updates.
    return actions;
  }

  function finalizeResult({
    stopReason = '',
    text = '',
    isError = false,
    errorMessage = '',
    model = '',
    usage = null,
  } = {}) {
    const actions = [];
    closeOpenThought(actions);
    const finalText = String(text || streamText || '').trim();
    if (finalText && finalText !== lastEmittedStreamText) {
      actions.push({
        channel: 'stream',
        payload: {
          text: finalText,
          done: true,
          subagentRunId: null,
        },
      });
      lastEmittedStreamText = finalText;
      streamText = finalText;
    } else if (streamText) {
      actions.push({
        channel: 'stream',
        payload: {
          text: streamText,
          done: true,
          subagentRunId: null,
        },
      });
    }
    // Prefer the prompt-result usage (authoritative per-turn totals). Fall back
    // to any usage_update stream payload the normalizer already observed.
    const resolvedUsage = usage && typeof usage === 'object' ? usage : lastUsage;
    actions.push({
      channel: 'result',
      payload: {
        text: finalText,
        isError: isError === true,
        errorMessage: String(errorMessage || '').trim(),
        stopReason: String(stopReason || '').trim(),
        usage: resolvedUsage,
        model: String(model || '').trim(),
      },
    });
    return actions;
  }

  function finalStreamText() {
    return streamText;
  }

  return {
    normalizeAcpUpdate,
    finalizeResult,
    finalStreamText,
    get model() {
      return '';
    },
    get lastUsage() {
      return lastUsage;
    },
  };
}
