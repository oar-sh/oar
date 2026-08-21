const MAX_TOOL_DETAIL_LENGTH = 140;
// Matches the Copilot reasoning-stream bridge's per-thought cap.
const MAX_THOUGHT_CHARS = 16 * 1024;
const REDACTED_THINKING_PLACEHOLDER = '[Reasoning redacted by the model provider]';
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

/**
 * One user-readable line for a `system`/`api_retry` stream message. Exported
 * because the session process needs the identical wording for retries that
 * arrive between turns (carried into the next context as a pending activity).
 */
export function formatApiRetryNotice(sdkMessage) {
  const status = Number(sdkMessage?.error_status) || 0;
  const attempt = Number(sdkMessage?.attempt) || 0;
  const max = Number(sdkMessage?.max_retries) || 0;
  const delaySec = Math.round((Number(sdkMessage?.retry_delay_ms) || 0) / 1000);
  const cause = status === 529
    ? 'Anthropic API overloaded (529)'
    : `Anthropic API error${status ? ` (${status})` : ''}`;
  const counter = attempt && max ? ` ${attempt}/${max}` : '';
  const wait = delaySec > 0 ? ` in ~${delaySec}s` : '';
  return `${cause} — retrying${counter}${wait}…`;
}

/**
 * The single activity action a `compact_boundary` publishes. Exported because
 * a compaction at resume arrives with no turn context — the session process
 * buffers this same action onto the next one rather than losing the boundary
 * (the per-turn normalizer never sees it).
 *
 * `post_tokens` is optional in the SDK type and absent from every auto-compact
 * payload observed live, so the metadata degrades to a pre-only row instead of
 * being dropped. The wire shape is snake_case under `compact_metadata` (the
 * CLI converts its internal camelCase before yielding); the camelCase read is
 * a cheap hedge, since the on-disk transcript uses that spelling.
 */
export function compactBoundaryActivityAction(sdkMessage) {
  const metadata = sdkMessage?.compact_metadata || sdkMessage?.compactMetadata || {};
  const preTokens = Number(metadata.pre_tokens ?? metadata.preTokens);
  const postTokens = Number(metadata.post_tokens ?? metadata.postTokens);
  const hasPre = Number.isFinite(preTokens);
  const hasPost = Number.isFinite(postTokens);
  let detail = '';
  if (hasPre && hasPost) detail = ` (${formatCompactTokens(preTokens)} → ${formatCompactTokens(postTokens)} tokens)`;
  else if (hasPre) detail = ` (was ${formatCompactTokens(preTokens)} tokens)`;
  return {
    channel: 'activity',
    payload: {
      text: `Context compacted${detail}`,
      subagentRunId: null,
      // Structured twin of the prose: the transcript promotes this row to a
      // full-width break instead of burying it in the tool-activity details,
      // and needs the token counts to label it.
      metadata: {
        kind: 'compact_boundary',
        preTokens: hasPre ? preTokens : null,
        postTokens: hasPost ? postTokens : null,
      },
    },
  };
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
 * - `background_tasks` → `{ tasks: [{ taskId, taskType, description }] }`
 *   (REPLACE semantics: the full live set after each membership change)
 * - `background_task_settled` → `{ taskId, status }`
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
        // The SDK delivers one complete `assistant` event PER CONTENT BLOCK
        // (all sharing the message's API id, each arriving before that block's
        // content_block_stop), so positional bookkeeping alone cannot pair a
        // complete thinking block with its streamed frames. The streamed
        // reasoning ids are recorded here per API message id and consumed in
        // block order by the complete events — the server upserts thoughts by
        // reasoningId, so the complete republish updates the streamed thought
        // in place instead of duplicating it.
        currentMessageId: '',
        streamedThinkingIds: new Map(), // API message id -> [reasoningId, ...] in stream order
        consumedThinkingIds: new Map(), // API message id -> count consumed by complete events
        // Assistant-message counter for the thread; the fallback id key when
        // partial frames (and thus recorded streamed ids) are unavailable.
        messageIndex: 0,
        // Set when `message_start` opens a message, so the complete `assistant`
        // message reuses that index instead of allocating a new one. Without
        // partial messages there is no `message_start`, and each complete
        // message allocates its own index.
        messageStarted: false,
        // Which complete message the thread is currently inside, for the
        // one-event-per-block delivery model.
        lastCompleteMessageId: '',
        currentComplete: null,
      });
    }
    return threads.get(key);
  }

  function thoughtIdFor(state, kind, blockIndex) {
    return `claude-${kind}-${state.key}-${state.messageIndex}-${blockIndex}`;
  }

  // Reasoning id for a thinking block on a complete assistant event: reuse the
  // id its streamed frames already published (matched by API message id, in
  // block order), falling back to a fresh positional id when no partial frames
  // were seen for the message.
  function completeThinkingIdFor(state, messageId, blockIndex) {
    const streamedIds = messageId ? state.streamedThinkingIds.get(messageId) : null;
    if (streamedIds?.length) {
      const consumed = state.consumedThinkingIds.get(messageId) || 0;
      if (consumed < streamedIds.length) {
        state.consumedThinkingIds.set(messageId, consumed + 1);
        return streamedIds[consumed];
      }
    }
    return thoughtIdFor(state, 'thought', blockIndex);
  }

  // Called when a new assistant message begins on a thread, from whichever
  // signal arrives first (`message_start`, or the complete message itself).
  // Complete events arrive one per content block, all sharing message.id, so
  // later blocks of the same message must not open a new message (that would
  // drift the positional thought ids and re-trigger the boundary logic).
  function beginAssistantMessage(state, { fromStreamEvent, messageId = '' }) {
    if (fromStreamEvent) {
      state.messageIndex += 1;
      state.messageStarted = true;
      state.thinking.clear();
      // New API message: the pending bubble must show this message's prose,
      // not the previous message's narration concatenated onto it. The
      // stream channel publishes cumulative text, so the accumulator resets
      // at the message boundary.
      state.streamText = '';
      state.lastEmittedStreamText = '';
      return;
    }
    if (messageId && state.lastCompleteMessageId === messageId) return;
    state.lastCompleteMessageId = messageId;
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
  function actionsForAssistantMessage(content, parentToolUseId, messageId) {
    const actions = [];
    const state = threadState(parentToolUseId);
    const subagentRunId = subagentRunIdFor(parentToolUseId);
    beginAssistantMessage(state, { fromStreamEvent: false, messageId });

    // Whether a text block is interim narration (a thought) or the answer is
    // a property of the whole API message, but the SDK delivers one complete
    // event per content block — so within one event a text block can never
    // share `content` with a tool_use. Track tool-bearing per message.id:
    // text seen before the message's first tool_use buffers until either a
    // tool_use proves it narration or the message ends (answer text is
    // published from the result message and must never double as a thought).
    if (messageId && state.currentComplete?.id !== messageId) {
      state.currentComplete = { id: messageId, sawToolUse: false, pendingTexts: [] };
    }
    const tracker = messageId ? state.currentComplete : null;
    const hasToolUseInEvent = content.some((block) => block?.type === 'tool_use');

    const emitNarration = (text, index) => {
      const capped = capThought(text || '');
      if (!capped.trim()) return;
      actions.push({
        channel: 'thought',
        payload: {
          reasoningId: thoughtIdFor(state, 'narration', index),
          text: capped,
          done: true,
          subagentRunId,
        },
      });
    };

    for (const [index, block] of content.entries()) {
      const blockType = String(block?.type || '');
      if (blockType === 'thinking' || blockType === 'redacted_thinking') {
        // Consume the pairing slot BEFORE the empty check: the summarized
        // display can deliver an empty raw block ahead of the summary block,
        // and skipping the empty one would hand its streamed id to the summary.
        const reasoningId = completeThinkingIdFor(state, messageId, index);
        const text = blockType === 'redacted_thinking'
          // Redacted blocks carry encrypted `data`, never `thinking` — a
          // placeholder keeps the reasoning visible instead of vanishing.
          ? (String(block?.data || '').trim() ? REDACTED_THINKING_PLACEHOLDER : '')
          : capThought(block?.thinking || '');
        if (!text.trim()) continue;
        actions.push({
          channel: 'thought',
          payload: {
            reasoningId,
            text,
            done: true,
            subagentRunId,
          },
        });
        continue;
      }
      if (blockType === 'text') {
        if (tracker) {
          if (tracker.sawToolUse) emitNarration(block?.text, index);
          else tracker.pendingTexts.push({ index, text: String(block?.text || '') });
        } else if (hasToolUseInEvent) {
          // No message id to correlate on: fall back to the per-event check.
          emitNarration(block?.text, index);
        }
        continue;
      }
      if (blockType === 'tool_use') {
        if (tracker) {
          tracker.sawToolUse = true;
          for (const pending of tracker.pendingTexts.splice(0)) {
            emitNarration(pending.text, pending.index);
          }
        }
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
      state.currentMessageId = String(event?.message?.id || '').trim();
      return actions;
    }

    if (eventType === 'content_block_start') {
      const blockType = String(event?.content_block?.type || '');
      if (blockType === 'thinking' || blockType === 'redacted_thinking') {
        const index = Number(event?.index ?? 0);
        const reasoningId = thoughtIdFor(state, 'thought', index);
        state.thinking.set(index, { reasoningId, text: '' });
        if (state.currentMessageId) {
          const ids = state.streamedThinkingIds.get(state.currentMessageId) || [];
          ids.push(reasoningId);
          state.streamedThinkingIds.set(state.currentMessageId, ids);
        }
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

    // The CLI retried a safeguards-refused request on a fallback model
    // (e.g. Fable 5 → Opus 4.8, scope "session"). From here on this turn's
    // output comes from the fallback model, so the recorded model must follow
    // it — the init-channel action updates the turn's responseModel in place.
    // The CLI's own notice is surfaced as an activity line; silently flipping
    // models is exactly the confusion this exists to prevent (conv 3366b9d3).
    if (type === 'system' && sdkMessage.subtype === 'model_refusal_fallback') {
      const actions = [];
      const fallbackModel = String(sdkMessage.fallbackModel || '').trim();
      if (fallbackModel) {
        initModel = fallbackModel;
        actions.push({ channel: 'init', payload: { sessionId: initSessionId, model: fallbackModel } });
      }
      const notice = String(sdkMessage.content || '').trim()
        || `Model switched to ${fallbackModel || 'a fallback model'} after a refusal.`;
      actions.push({ channel: 'activity', payload: { text: truncate(notice, 500), subagentRunId: null } });
      return actions;
    }

    // An upstream API request failed and the CLI is retrying with backoff.
    // While that happens the CLI emits no assistant traffic at all, so
    // without this line the relay UI shows a bare typing indicator that is
    // indistinguishable from a wedged worker (three 529 stalls read as relay
    // freezes on 2026-08-18). At most max_retries lines per request.
    if (type === 'system' && sdkMessage.subtype === 'api_retry') {
      return [{
        channel: 'activity',
        payload: { text: formatApiRetryNotice(sdkMessage), subagentRunId: null },
      }];
    }

    if (type === 'stream_event') {
      return normalizeStreamEvent(sdkMessage);
    }

    if (type === 'assistant') {
      const parentToolUseId = sdkMessage?.parent_tool_use_id || null;
      const content = Array.isArray(sdkMessage?.message?.content) ? sdkMessage.message.content : [];
      const messageId = String(sdkMessage?.message?.id || '').trim();
      return actionsForAssistantMessage(content, parentToolUseId, messageId);
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
      return [compactBoundaryActivityAction(sdkMessage)];
    }

    // The live background-task set, emitted on every membership change with
    // REPLACE semantics. The turn runner gates the input-gate release on it: a
    // released gate closes the CLI's control transport, and background agents
    // that outlive the visible turn then lose every permission request.
    if (type === 'system' && sdkMessage.subtype === 'background_tasks_changed') {
      const tasks = (Array.isArray(sdkMessage.tasks) ? sdkMessage.tasks : [])
        .map((task) => ({
          taskId: String(task?.task_id || '').trim(),
          taskType: String(task?.task_type || '').trim(),
          description: String(task?.description || '').trim(),
        }))
        .filter((task) => task.taskId);
      return [{ channel: 'background_tasks', payload: { tasks } }];
    }

    if (type === 'system' && sdkMessage.subtype === 'task_notification') {
      const taskId = String(sdkMessage.task_id || '').trim() || 'unknown';
      const status = String(sdkMessage.status || '').trim() || 'unknown';
      return [
        // Settling is the edge the runner pairs with the level signal above: a
        // settled session-level task means a continuation turn is about to be
        // dequeued, so the gate must stay held even though the set is empty.
        { channel: 'background_task_settled', payload: { taskId, status } },
        {
          channel: 'activity',
          payload: {
            text: truncate(`Background task ${taskId} ${status}: ${String(sdkMessage.summary || '').trim()}`),
            subagentRunId: null,
          },
        },
      ];
    }

    if (type === 'result') {
      // A resumed session whose previous CLI process died with background tasks
      // still tracked replays a bookkeeping turn for the orphaned-task
      // notification and emits a zero-work result BEFORE the delivered user
      // message's turn (num_turns 0, duration_api_ms 0). Treating that phantom
      // as the turn result makes the runner release the input gate, which
      // closes the CLI's control transport — every subsequent permission
      // request in the real turn then fails with "AbortError: Stream closed"
      // (canUseTool is never reached). Skip it; the real result follows.
      const isPhantom = sdkMessage.subtype === 'success'
        && sdkMessage.is_error !== true
        && Number(sdkMessage.num_turns) === 0
        && Number(sdkMessage.duration_api_ms) === 0;
      if (isPhantom) return [];
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
