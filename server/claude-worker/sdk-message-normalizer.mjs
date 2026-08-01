const MAX_TOOL_DETAIL_LENGTH = 140;
// Matches the Copilot reasoning-stream bridge's per-thought cap.
const MAX_THOUGHT_CHARS = 16 * 1024;
const SUBAGENT_TOOL_NAMES = new Set(['task', 'agent']);

function truncate(text, maxLength = MAX_TOOL_DETAIL_LENGTH) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatCompactTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
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
 * Stateful normalizer mapping Claude Agent SDK messages onto relay channel
 * actions. One instance per turn.
 *
 * `normalize(sdkMessage)` returns an array of `{ channel, payload }` actions:
 * - `init`     → `{ sessionId, model }`
 * - `stream`   → `{ text, done, subagentRunId? }` (cumulative snapshots per thread)
 * - `thought`  → `{ reasoningId, text, done, subagentRunId? }` (thinking blocks
 *   and interim narration; ids are stable across partial/complete frames so the
 *   server upserts rather than duplicating)
 * - `activity` → `{ text, subagentRunId? }`
 * - `subagent` → `{ subagentRunId, parentSubagentId, displayName, status }`
 * - `result`   → `{ text, isError, subtype, sessionId, model, usage }`
 */
export function createSdkMessageNormalizer() {
  const threads = new Map(); // threadKey -> per-thread stream/thinking bookkeeping
  const knownSubagentRuns = new Map(); // toolUseId -> { displayName, parentSubagentId }
  let initSessionId = '';
  let initModel = '';

  function threadKeyFor(parentToolUseId) {
    return String(parentToolUseId || '').trim() || 'main';
  }

  function threadState(parentToolUseId) {
    const key = threadKeyFor(parentToolUseId);
    if (!threads.has(key)) {
      threads.set(key, {
        key,
        streamText: '',
        lastEmittedStreamText: '',
        thinking: new Map(), // block index -> { reasoningId, text }
        // Assistant-message counter for the thread. Reasoning ids are keyed on
        // (thread, message, block) so the partial `stream_event` frames and the
        // complete `assistant` message for the same block produce the SAME id —
        // the server upserts thoughts by reasoningId, so the complete message
        // updates the streamed thought in place instead of duplicating it.
        messageIndex: 0,
        // Set when `message_start` opens a message, so the complete `assistant`
        // message reuses that index instead of allocating a new one. Without
        // partial messages there is no `message_start`, and each complete
        // message allocates its own index.
        messageStarted: false,
      });
    }
    return threads.get(key);
  }

  function thoughtIdFor(state, kind, blockIndex) {
    return `claude-${kind}-${state.key}-${state.messageIndex}-${blockIndex}`;
  }

  // Called when a new assistant message begins on a thread, from whichever
  // signal arrives first (`message_start`, or the complete message itself).
  function beginAssistantMessage(state, { fromStreamEvent }) {
    if (fromStreamEvent) {
      state.messageIndex += 1;
      state.messageStarted = true;
      state.thinking.clear();
      return;
    }
    if (state.messageStarted) {
      state.messageStarted = false;
      return;
    }
    state.messageIndex += 1;
  }

  function subagentRunIdFor(parentToolUseId) {
    const value = String(parentToolUseId || '').trim();
    return value || null;
  }

  function actionsForToolUseBlock(block, parentToolUseId) {
    const actions = [];
    const toolName = String(block?.name || '').trim() || 'unknown';
    const toolUseId = String(block?.id || '').trim();
    const input = block?.input && typeof block.input === 'object' ? block.input : {};
    if (isSubagentToolName(toolName) && toolUseId) {
      const displayName = String(
        input.description
        || input.name
        || input.subagent_type
        || 'Subagent',
      ).trim() || 'Subagent';
      const parentSubagentId = subagentRunIdFor(parentToolUseId);
      knownSubagentRuns.set(toolUseId, { displayName, parentSubagentId });
      actions.push({
        channel: 'subagent',
        payload: {
          subagentRunId: toolUseId,
          parentSubagentId,
          displayName,
          status: 'running',
        },
      });
    }
    actions.push({
      channel: 'activity',
      payload: {
        text: formatToolActivityText(toolName, input),
        subagentRunId: subagentRunIdFor(parentToolUseId),
      },
    });
    return actions;
  }

  function actionsForToolResultBlock(block, parentToolUseId) {
    const actions = [];
    const toolUseId = String(block?.tool_use_id || '').trim();
    const isError = block?.is_error === true;
    if (toolUseId && knownSubagentRuns.has(toolUseId)) {
      const run = knownSubagentRuns.get(toolUseId);
      actions.push({
        channel: 'subagent',
        payload: {
          subagentRunId: toolUseId,
          parentSubagentId: run.parentSubagentId,
          displayName: run.displayName,
          status: isError ? 'failed' : 'completed',
        },
      });
    }
    if (isError) {
      const errorText = typeof block?.content === 'string'
        ? block.content
        : (Array.isArray(block?.content)
          ? block.content.map((entry) => String(entry?.text || '')).join(' ')
          : '');
      actions.push({
        channel: 'activity',
        payload: {
          text: truncate(`Tool failed: ${errorText || 'unknown error'}`),
          subagentRunId: subagentRunIdFor(parentToolUseId),
        },
      });
    }
    return actions;
  }

  /**
   * Complete assistant messages carry the authoritative copy of every block.
   * Thinking is republished here (same reasoningId as the streamed frames, so
   * it upserts) which is also the only path that surfaces thinking at all when
   * partial messages are unavailable. Assistant text that shares a message with
   * tool calls is interim narration and becomes a thought, mirroring the
   * Copilot extension's reasoning-stream bridge; text on a final, tool-free
   * message is the answer itself and must not be duplicated as a thought.
   */
  function actionsForAssistantMessage(content, parentToolUseId) {
    const actions = [];
    const state = threadState(parentToolUseId);
    const subagentRunId = subagentRunIdFor(parentToolUseId);
    beginAssistantMessage(state, { fromStreamEvent: false });
    const hasToolUse = content.some((block) => block?.type === 'tool_use');

    for (const [index, block] of content.entries()) {
      const blockType = String(block?.type || '');
      if (blockType === 'thinking' || blockType === 'redacted_thinking') {
        const text = capThought(block?.thinking || '');
        if (!text.trim()) continue;
        actions.push({
          channel: 'thought',
          payload: {
            reasoningId: thoughtIdFor(state, 'thought', index),
            text,
            done: true,
            subagentRunId,
          },
        });
        continue;
      }
      if (blockType === 'text' && hasToolUse) {
        const text = capThought(block?.text || '');
        if (!text.trim()) continue;
        actions.push({
          channel: 'thought',
          payload: {
            reasoningId: thoughtIdFor(state, 'narration', index),
            text,
            done: true,
            subagentRunId,
          },
        });
        continue;
      }
      if (blockType === 'tool_use') {
        actions.push(...actionsForToolUseBlock(block, parentToolUseId));
      }
    }
    return actions;
  }

  function normalizeStreamEvent(sdkMessage) {
    const actions = [];
    const event = sdkMessage?.event || {};
    const parentToolUseId = sdkMessage?.parent_tool_use_id || null;
    const state = threadState(parentToolUseId);
    const subagentRunId = subagentRunIdFor(parentToolUseId);
    const eventType = String(event?.type || '');

    if (eventType === 'message_start') {
      beginAssistantMessage(state, { fromStreamEvent: true });
      return actions;
    }

    if (eventType === 'content_block_start') {
      const blockType = String(event?.content_block?.type || '');
      if (blockType === 'thinking' || blockType === 'redacted_thinking') {
        const index = Number(event?.index ?? 0);
        state.thinking.set(index, {
          reasoningId: thoughtIdFor(state, 'thought', index),
          text: '',
        });
      }
      return actions;
    }

    if (eventType === 'content_block_delta') {
      const deltaType = String(event?.delta?.type || '');
      const index = Number(event?.index ?? 0);
      if (deltaType === 'text_delta') {
        state.streamText += String(event?.delta?.text || '');
        if (shouldEmitStreamUpdate(state.streamText, state.lastEmittedStreamText)) {
          state.lastEmittedStreamText = state.streamText;
          actions.push({
            channel: 'stream',
            payload: { text: state.streamText, done: false, subagentRunId },
          });
        }
        return actions;
      }
      if (deltaType === 'thinking_delta') {
        const thinking = state.thinking.get(index);
        if (thinking) {
          thinking.text = capThought(thinking.text + String(event?.delta?.thinking || ''));
          actions.push({
            channel: 'thought',
            payload: {
              reasoningId: thinking.reasoningId,
              text: thinking.text,
              done: false,
              subagentRunId,
            },
          });
        }
        return actions;
      }
      return actions;
    }

    if (eventType === 'content_block_stop') {
      const index = Number(event?.index ?? 0);
      const thinking = state.thinking.get(index);
      if (thinking) {
        state.thinking.delete(index);
        if (thinking.text.trim()) {
          actions.push({
            channel: 'thought',
            payload: {
              reasoningId: thinking.reasoningId,
              text: thinking.text,
              done: true,
              subagentRunId,
            },
          });
        }
      }
      return actions;
    }

    return actions;
  }

  function normalize(sdkMessage) {
    if (!sdkMessage || typeof sdkMessage !== 'object') return [];
    const type = String(sdkMessage.type || '');

    if (type === 'system' && sdkMessage.subtype === 'init') {
      initSessionId = String(sdkMessage.session_id || '').trim();
      initModel = String(sdkMessage.model || '').trim();
      return [{ channel: 'init', payload: { sessionId: initSessionId, model: initModel } }];
    }

    if (type === 'stream_event') {
      return normalizeStreamEvent(sdkMessage);
    }

    if (type === 'assistant') {
      const parentToolUseId = sdkMessage?.parent_tool_use_id || null;
      const content = Array.isArray(sdkMessage?.message?.content) ? sdkMessage.message.content : [];
      return actionsForAssistantMessage(content, parentToolUseId);
    }

    if (type === 'user') {
      const actions = [];
      const parentToolUseId = sdkMessage?.parent_tool_use_id || null;
      const content = Array.isArray(sdkMessage?.message?.content) ? sdkMessage.message.content : [];
      for (const block of content) {
        if (block?.type === 'tool_result') {
          actions.push(...actionsForToolResultBlock(block, parentToolUseId));
        }
      }
      return actions;
    }

    if (type === 'system' && sdkMessage.subtype === 'compact_boundary') {
      const preTokens = Number(sdkMessage?.compact_metadata?.pre_tokens);
      const postTokens = Number(sdkMessage?.compact_metadata?.post_tokens);
      const detail = Number.isFinite(preTokens) && Number.isFinite(postTokens)
        ? ` (${formatCompactTokens(preTokens)} → ${formatCompactTokens(postTokens)} tokens)`
        : '';
      return [{
        channel: 'activity',
        payload: {
          text: `Context compacted${detail}`,
          subagentRunId: null,
          preTokens: Number.isFinite(preTokens) ? preTokens : null,
          postTokens: Number.isFinite(postTokens) ? postTokens : null,
        },
      }];
    }

    if (type === 'result') {
      const isError = sdkMessage.subtype !== 'success' || sdkMessage.is_error === true;
      return [{
        channel: 'result',
        payload: {
          text: String(sdkMessage.result || '').trim(),
          isError,
          subtype: String(sdkMessage.subtype || ''),
          sessionId: String(sdkMessage.session_id || initSessionId || '').trim(),
          model: initModel,
          usage: sdkMessage.usage || null,
          // `modelUsage[model].contextWindow` is the authoritative per-model
          // window; it is the fallback when the context-usage control request
          // is unavailable. Its token counts are cumulative across the whole
          // turn, so they must not be read as context occupancy.
          modelUsage: sdkMessage.modelUsage || null,
          totalCostUsd: Number.isFinite(Number(sdkMessage.total_cost_usd))
            ? Number(sdkMessage.total_cost_usd)
            : null,
        },
      }];
    }

    return [];
  }

  function finalStreamText() {
    return threadState(null).streamText;
  }

  return {
    normalize,
    finalStreamText,
    get sessionId() { return initSessionId; },
    get model() { return initModel; },
  };
}
