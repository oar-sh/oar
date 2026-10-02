import { capThought } from '../../shared/thought-cap.mjs';
import {
  compactBoundaryActivityAction,
  displayToolName,
  formatApiRetryNotice,
  formatToolActivityText,
  isSubagentToolName,
} from '../claude-worker/sdk-message-normalizer.mjs';

const MAX_ACTIVITY_LENGTH = 140;
const REDACTED_THINKING_PLACEHOLDER = '[Reasoning redacted by the model provider]';
// Sandbox log lines worth a row: a step that begins, is skipped or fails.
// Each step also logs its completion, and lines without a step are the
// runner talking to itself (the path it launches the CLI from).
const QUIET_STEP_STATUSES = new Set(['completed']);
const LOUD_LOG_LEVELS = new Set(['warn', 'warning', 'error']);

function truncate(text, maxLength = MAX_ACTIVITY_LENGTH) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The sequence number of a cloud event (`sequence_num` is a string on the wire), or null. */
export function toCloudSequence(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A turn the user stopped ends with an error result too
 * (`error_during_execution`, `terminal_reason: "aborted_tools"`); what tells
 * it from a failure is the terminal reason.
 */
export function isInterruptedCloudResult(payload) {
  return String(payload?.terminal_reason || '').trim().toLowerCase().startsWith('aborted');
}

/** The `result` payload of a turn in the shape the Claude worker's publisher reads. */
export function readCloudResult(payload) {
  const subtype = String(payload?.subtype || '').trim();
  const errors = (Array.isArray(payload?.errors) ? payload.errors : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  const apiErrorStatus = Number(payload?.api_error_status ?? NaN);
  return {
    // An interrupted or failed turn carries no `result` string at all.
    text: typeof payload?.result === 'string' ? payload.result.trim() : '',
    isError: subtype !== 'success' || payload?.is_error === true,
    subtype,
    interrupted: isInterruptedCloudResult(payload),
    terminalReason: String(payload?.terminal_reason || '').trim(),
    assistantError: '',
    apiErrorStatus: Number.isFinite(apiErrorStatus) ? apiErrorStatus : null,
    errors,
    modelUsage: payload?.modelUsage && typeof payload.modelUsage === 'object' ? payload.modelUsage : null,
    totalCostUsd: finiteOrNull(payload?.total_cost_usd),
  };
}

/**
 * What `GET /v1/code/sessions/{id}` says after a turn, for the relay's usage
 * routes: the context occupancy in the shape `/api/claude-context-usage`
 * stores, the session's cost so far, and the session's page on claude.ai.
 * Accepts the bare `response_shape` or the body that wraps it.
 */
export function readCloudSessionUsage(sessionBody, { model = '' } = {}) {
  const shape = sessionBody?.response_shape || sessionBody?.raw?.response_shape || sessionBody || {};
  const metadata = shape?.external_metadata && typeof shape.external_metadata === 'object'
    ? shape.external_metadata
    : {};
  const usage = metadata.usage && typeof metadata.usage === 'object' ? metadata.usage : {};
  const usedTokens = finiteOrNull(metadata.context_usage?.used_tokens);
  const maxTokens = finiteOrNull(metadata.context_usage?.max_tokens);
  const contextUsage = usedTokens === null && maxTokens === null
    ? null
    : {
      model: String(metadata.last_served_model || model || '').trim() || null,
      totalTokens: usedTokens,
      maxTokens,
      percentage: usedTokens !== null && maxTokens ? Math.round((usedTokens / maxTokens) * 10000) / 100 : null,
      categories: [],
      apiUsage: {
        input_tokens: finiteOrNull(usage.input_tokens),
        output_tokens: finiteOrNull(usage.output_tokens),
        cache_read_input_tokens: finiteOrNull(usage.cache_read_tokens),
        cache_creation_input_tokens: finiteOrNull(usage.cache_write_tokens),
      },
    };
  return {
    contextUsage,
    costUsd: finiteOrNull(usage.cost_usd),
    sessionUrl: String(shape?.session_url || sessionBody?.sessionUrl || '').trim() || null,
    workerStatus: String(shape?.worker_status || '').trim().toLowerCase() || null,
  };
}

/**
 * Stateful normalizer mapping the events of one cloud turn onto relay channel
 * actions. One instance per turn. The event `payload` is the plain SDK
 * message, delivered one complete content block per `assistant` event and
 * without partial frames.
 *
 * `normalize(event, { sequence })` takes the event envelope
 * (`{ event_type, source, sequence_num, payload }`) and returns
 * `{ channel, payload }` actions:
 * - `init`       → `{ model }`
 * - `stream`     → `{ text, done:false }`: every text block of the turn so far,
 *   blank line between blocks
 * - `thought`    → `{ reasoningId, text, done:true }`
 * - `activity`   → `{ text, subagentRunId? }`
 * - `subagent`   → `{ subagentRunId, parentSubagentId, displayName, status }`
 * - `push`       → `{ branch }` (the agent pushed a branch)
 * - `permission` → `{ requestId, toolName, displayName, input, toolUseId }`
 *   (the agent waits for the user: a question or a permission prompt)
 * - `permission_settled` → `{ requestId }` (some client answered it)
 *
 * The turn's `result` is not an action: the runner pairs it with the turn by
 * sequence number and reads it with `readCloudResult`.
 */
export function createClaudeCloudEventNormalizer() {
  const textBlocks = [];
  const knownSubagentRuns = new Map(); // toolUseId -> { displayName, parentSubagentId }
  let model = '';
  let lastSandboxLine = '';
  let lastRateLimitStatus = 'allowed';

  function streamText() {
    return textBlocks.join('\n\n');
  }

  function sandboxLogActions(payload) {
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const content = String(data.content || '').trim();
    if (!content) return [];
    const stepStatus = String(data.extra?.step_status || '').trim().toLowerCase();
    const loud = LOUD_LOG_LEVELS.has(String(data.level || '').trim().toLowerCase());
    if (!loud && (!stepStatus || QUIET_STEP_STATUSES.has(stepStatus))) return [];
    const text = truncate(`Cloud: ${content}`);
    if (text === lastSandboxLine) return [];
    lastSandboxLine = text;
    return [{ channel: 'activity', payload: { text, subagentRunId: null } }];
  }

  function assistantActions(payload, sequence) {
    const actions = [];
    const parentToolUseId = String(payload?.parent_tool_use_id || '').trim() || null;
    const content = Array.isArray(payload?.message?.content) ? payload.message.content : [];
    for (const [index, block] of content.entries()) {
      const blockType = String(block?.type || '');
      if (blockType === 'text') {
        // Only the main thread's prose is the reply; a subagent's text is its
        // own report to the agent that started it.
        const text = String(block?.text || '').trim();
        if (parentToolUseId || !text) continue;
        textBlocks.push(text);
        actions.push({ channel: 'stream', payload: { text: streamText(), done: false, subagentRunId: null } });
        continue;
      }
      if (blockType === 'thinking' || blockType === 'redacted_thinking') {
        const text = blockType === 'redacted_thinking'
          ? (String(block?.data || '').trim() ? REDACTED_THINKING_PLACEHOLDER : '')
          : capThought(block?.thinking || '');
        if (!text.trim()) continue;
        actions.push({
          channel: 'thought',
          payload: {
            // Keyed by the event's sequence number: a replayed event (stream
            // reconnect, catch-up after a restart) updates its thought in
            // place instead of adding a second one.
            reasoningId: `claude-cloud-thought-${sequence ?? 'x'}-${index}`,
            text,
            done: true,
            subagentRunId: parentToolUseId,
          },
        });
        continue;
      }
      if (blockType === 'tool_use') {
        const toolName = displayToolName(block?.name) || 'unknown';
        const toolUseId = String(block?.id || '').trim();
        const input = block?.input && typeof block.input === 'object' ? block.input : {};
        if (isSubagentToolName(toolName) && toolUseId) {
          const displayName = String(input.description || input.name || input.subagent_type || 'Subagent').trim()
            || 'Subagent';
          knownSubagentRuns.set(toolUseId, { displayName, parentSubagentId: parentToolUseId });
          actions.push({
            channel: 'subagent',
            payload: { subagentRunId: toolUseId, parentSubagentId: parentToolUseId, displayName, status: 'running' },
          });
        }
        actions.push({
          channel: 'activity',
          payload: { text: formatToolActivityText(toolName, input), subagentRunId: parentToolUseId },
        });
      }
    }
    return actions;
  }

  function toolResultActions(payload) {
    const actions = [];
    const parentToolUseId = String(payload?.parent_tool_use_id || '').trim() || null;
    const content = Array.isArray(payload?.message?.content) ? payload.message.content : [];
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const toolUseId = String(block?.tool_use_id || '').trim();
      const isError = block?.is_error === true;
      const run = toolUseId ? knownSubagentRuns.get(toolUseId) : null;
      if (run) {
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
          : (Array.isArray(block?.content) ? block.content.map((entry) => String(entry?.text || '')).join(' ') : '');
        actions.push({
          channel: 'activity',
          payload: { text: truncate(`Tool failed: ${errorText || 'unknown error'}`), subagentRunId: parentToolUseId },
        });
      }
    }
    return actions;
  }

  function systemActions(payload) {
    const subtype = String(payload?.subtype || '');
    if (subtype === 'init') {
      // Every turn of a cloud session opens with its own init.
      model = String(payload?.model || '').trim() || model;
      return [
        { channel: 'init', payload: { model } },
        {
          channel: 'activity',
          payload: { text: `Claude Code running in the cloud${model ? ` (model ${model})` : ''}`, subagentRunId: null },
        },
      ];
    }
    if (subtype === 'vcs_state_changed') {
      const branch = String(payload?.branch || '').trim();
      if (String(payload?.kind || '').trim().toLowerCase() !== 'push' || !branch) return [];
      return [
        { channel: 'activity', payload: { text: truncate(`Cloud: pushed branch ${branch}`), subagentRunId: null } },
        { channel: 'push', payload: { branch } },
      ];
    }
    if (subtype === 'task_notification') {
      const taskId = String(payload?.task_id || '').trim() || 'unknown';
      const status = String(payload?.status || '').trim() || 'unknown';
      return [{
        channel: 'activity',
        payload: {
          text: truncate(`Background task ${taskId} ${status}: ${String(payload?.summary || '').trim()}`),
          subagentRunId: null,
        },
      }];
    }
    if (subtype === 'api_retry') {
      return [{ channel: 'activity', payload: { text: formatApiRetryNotice(payload), subagentRunId: null } }];
    }
    if (subtype === 'compact_boundary') return [compactBoundaryActivityAction(payload)];
    return [];
  }

  function rateLimitActions(payload) {
    const info = payload?.rate_limit_info && typeof payload.rate_limit_info === 'object' ? payload.rate_limit_info : {};
    const status = String(info.status || '').trim().toLowerCase() || 'allowed';
    if (status === lastRateLimitStatus) return [];
    lastRateLimitStatus = status;
    if (status === 'allowed') return [];
    const resetsAt = Number(info.resetsAt);
    const reset = Number.isFinite(resetsAt) && resetsAt > 0
      ? `, resets ${new Date(resetsAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}`
      : '';
    const text = status === 'rejected'
      ? `Claude usage limit reached${reset}`
      : `Claude usage limit warning (${status.replace(/_/g, ' ')}${reset})`;
    return [{ channel: 'activity', payload: { text: truncate(text), subagentRunId: null } }];
  }

  function controlActions(event, payload) {
    if (payload.type === 'control_response') {
      const requestId = String(payload?.response?.request_id || '').trim();
      return requestId ? [{ channel: 'permission_settled', payload: { requestId } }] : [];
    }
    // The clients' own requests (set_permission_mode, interrupt) come back on
    // the stream as well; only the agent's requests ask the user something.
    if (String(event?.source || '').trim().toLowerCase() === 'client') return [];
    const request = payload?.request && typeof payload.request === 'object' ? payload.request : {};
    const requestId = String(payload?.request_id || '').trim();
    if (request.subtype !== 'can_use_tool' || !requestId) return [];
    return [{
      channel: 'permission',
      payload: {
        requestId,
        toolName: String(request.tool_name || '').trim(),
        displayName: String(request.display_name || request.tool_name || '').trim(),
        input: request.input && typeof request.input === 'object' ? request.input : {},
        toolUseId: String(request.tool_use_id || '').trim() || null,
      },
    }];
  }

  function normalize(event, { sequence = toCloudSequence(event?.sequence_num) } = {}) {
    const payload = event?.payload;
    if (!payload || typeof payload !== 'object') return [];
    const type = String(payload.type || event.event_type || '');
    if (type === 'env_manager_log') return sandboxLogActions(payload);
    if (type === 'system') return systemActions(payload);
    if (type === 'assistant') return assistantActions(payload, sequence);
    if (type === 'user') return toolResultActions(payload);
    if (type === 'rate_limit_event') return rateLimitActions(payload);
    if (type === 'control_request' || type === 'control_response') return controlActions(event, { ...payload, type });
    return [];
  }

  return {
    normalize,
    streamText,
    get model() { return model; },
  };
}
