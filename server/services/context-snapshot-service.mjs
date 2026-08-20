'use strict';

import { resolveFallbackContextLimitTokens } from '../../shared/context-window-fallbacks.mjs';

// Re-exported for existing importers; the table itself lives in shared/ so the
// Cursor worker's fallback cannot drift from this one.
export { resolveFallbackContextLimitTokens };

const CONTEXT_CACHE_MAX = 128;

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || '';
}

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function toNullablePercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function getByPath(obj, parts) {
  let current = obj;
  for (const part of (parts || [])) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function findFirstNumericByKey(obj, candidateKeys) {
  if (!obj || typeof obj !== 'object') return null;
  const wanted = new Set((candidateKeys || []).map((key) => normalizeText(key)).filter(Boolean));
  if (!wanted.size) return null;

  const stack = [obj];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, value] of Object.entries(current)) {
      if (value && typeof value === 'object') stack.push(value);
      if (!wanted.has(key)) continue;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return null;
}

function resolveContextLimitTokens(modelId, data, modelUsage, getModelContextLimitTokens = null) {
  const directCandidates = [
    getByPath(data, ['maxContextTokens']),
    getByPath(data, ['contextWindow']),
    getByPath(data, ['maxTokens']),
    getByPath(data, ['contextLimitTokens']),
    getByPath(data, ['max_context_tokens']),
    getByPath(data, ['tokenBudget']),
    getByPath(modelUsage, ['maxContextTokens']),
    getByPath(modelUsage, ['contextWindow']),
    getByPath(modelUsage, ['maxTokens']),
  ];
  for (const value of directCandidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.round(numeric);
  }
  const model = normalizeText(modelId).toLowerCase();
  const catalogLimit = typeof getModelContextLimitTokens === 'function'
    ? toNullableInt(getModelContextLimitTokens(model))
    : null;
  if (catalogLimit !== null && catalogLimit > 0) return catalogLimit;
  return resolveFallbackContextLimitTokens(model);
}

function resolveExplicitContextLimitTokens(data, modelUsage) {
  const directCandidates = [
    getByPath(data, ['maxContextTokens']),
    getByPath(data, ['contextWindow']),
    getByPath(data, ['maxTokens']),
    getByPath(data, ['contextLimitTokens']),
    getByPath(data, ['max_context_tokens']),
    getByPath(data, ['tokenBudget']),
    getByPath(modelUsage, ['maxContextTokens']),
    getByPath(modelUsage, ['contextWindow']),
    getByPath(modelUsage, ['maxTokens']),
  ];
  for (const value of directCandidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.round(numeric);
  }
  return null;
}

function extractSessionIdFromEventsPath(pathModule, eventsPath) {
  const parent = pathModule.basename(pathModule.dirname(String(eventsPath || '')));
  return parent || null;
}

function hasContextFields(data) {
  return (
    Number.isFinite(Number(data?.currentTokens)) ||
    Number.isFinite(Number(data?.systemTokens)) ||
    Number.isFinite(Number(data?.conversationTokens)) ||
    Number.isFinite(Number(data?.toolDefinitionsTokens))
  );
}

function hasUsageSignals(data) {
  return hasContextFields(data)
    || Number.isFinite(Number(data?.inputTokens))
    || Number.isFinite(Number(data?.outputTokens))
    || Number.isFinite(Number(data?.reasoningTokens))
    || Number.isFinite(Number(data?.cacheReadTokens))
    || Number.isFinite(Number(data?.cacheWriteTokens));
}

function resolveEventModelId(data) {
  return normalizeText(data?.currentModel || data?.model || data?.newModel) || null;
}

function hasSnapshotSignals(data) {
  const currentModel = resolveEventModelId(data);
  const modelUsage = currentModel && data?.modelMetrics?.[currentModel]?.usage && typeof data.modelMetrics[currentModel].usage === 'object'
    ? data.modelMetrics[currentModel].usage
    : null;
  return hasContextFields(data)
    || resolveExplicitContextLimitTokens(data, modelUsage) !== null
    || Number.isFinite(Number(data?.usedPercent))
    || Number.isFinite(Number(data?.freeTokens))
    || Number.isFinite(Number(data?.remainingTokens))
    || Number.isFinite(Number(data?.bufferTokens))
    || Number.isFinite(Number(data?.inputTokens))
    || Number.isFinite(Number(data?.reasoningTokens))
    || Number.isFinite(Number(data?.cacheReadTokens))
    || Number.isFinite(Number(data?.cacheWriteTokens))
    || Number.isFinite(Number(modelUsage?.inputTokens))
    || Number.isFinite(Number(modelUsage?.reasoningTokens))
    || Number.isFinite(Number(modelUsage?.cacheReadTokens))
    || Number.isFinite(Number(modelUsage?.cacheWriteTokens));
}

function buildSnapshotFromEvent({ event, data, eventsPath, sessionId, pathModule, getModelContextLimitTokens }) {
  const currentModel = resolveEventModelId(data);
  const copilotSessionId = extractSessionIdFromEventsPath(pathModule, eventsPath) || sessionId;
  const modelUsage = currentModel && data?.modelMetrics?.[currentModel]?.usage && typeof data.modelMetrics[currentModel].usage === 'object'
    ? data.modelMetrics[currentModel].usage
    : null;
  const systemTokens = toNullableInt(data?.systemTokens);
  const conversationTokens = toNullableInt(data?.conversationTokens);
  const toolsTokens = toNullableInt(data?.toolDefinitionsTokens);
  const promptTokens = toNullableInt(modelUsage?.inputTokens) ?? toNullableInt(data?.inputTokens);
  const completionTokens = toNullableInt(modelUsage?.outputTokens) ?? toNullableInt(data?.outputTokens);
  const reasoningTokens = toNullableInt(modelUsage?.reasoningTokens) ?? toNullableInt(data?.reasoningTokens);
  const usedTotalTokens = toNullableInt(data?.currentTokens)
    ?? toNullableInt(findFirstNumericByKey(data, ['usedTokens', 'totalTokens', 'usedTotalTokens']))
    ?? ((systemTokens !== null || conversationTokens !== null || toolsTokens !== null)
      ? (Number(systemTokens || 0) + Number(conversationTokens || 0) + Number(toolsTokens || 0))
      : null)
    ?? ((promptTokens !== null || completionTokens !== null || reasoningTokens !== null)
      ? (Number(promptTokens || 0) + Number(completionTokens || 0) + Number(reasoningTokens || 0))
      : null);
  const contextLimitTokens = resolveContextLimitTokens(currentModel, data, modelUsage, getModelContextLimitTokens);
  const usedPercent = toNullablePercent(data?.usedPercent)
    ?? toNullablePercent(findFirstNumericByKey(data, ['usedPercent', 'contextUsagePercent', 'tokenUsagePercent']))
    ?? ((usedTotalTokens !== null && contextLimitTokens !== null && contextLimitTokens > 0)
      ? Math.round((usedTotalTokens / contextLimitTokens) * 10000) / 100
      : null);
  const reportedFreeTokens = toNullableInt(data?.freeTokens)
    ?? toNullableInt(data?.remainingTokens)
    ?? toNullableInt(findFirstNumericByKey(data, ['freeTokens', 'remainingTokens', 'availableTokens']));
  const freeTokens = reportedFreeTokens
    ?? ((usedTotalTokens !== null && contextLimitTokens !== null)
      ? Math.max(0, contextLimitTokens - usedTotalTokens)
      : null);
  // A remainder the CLI reported is already net of its own buffer; only the
  // fallback above folds the buffer into free space.
  const freeTokensIncludesBuffer = reportedFreeTokens === null && freeTokens !== null;
  const bufferTokens = toNullableInt(data?.bufferTokens)
    ?? toNullableInt(findFirstNumericByKey(data, ['bufferTokens', 'safeBufferTokens']))
    ?? null;
  const systemToolsTokens = ((systemTokens !== null || toolsTokens !== null)
    ? Number(systemTokens || 0) + Number(toolsTokens || 0)
    : null);
  const cacheReadTokens = toNullableInt(modelUsage?.cacheReadTokens)
    ?? toNullableInt(data?.cacheReadTokens)
    ?? toNullableInt(data?.compactionTokensUsed?.cacheReadTokens)
    ?? null;
  const cacheWriteTokens = toNullableInt(modelUsage?.cacheWriteTokens)
    ?? toNullableInt(data?.cacheWriteTokens)
    ?? toNullableInt(data?.compactionTokensUsed?.cacheWriteTokens)
    ?? null;
  const partialMetricsWarning = !hasContextFields(data)
    ? 'Legacy context-window metrics are unavailable in current session events; showing partial token data only.'
    : null;

  return {
    snapshot: {
      runtime_session_id: sessionId,
      copilot_session_id: copilotSessionId,
      model: currentModel,
      used_total_tokens: usedTotalTokens,
      max_context_tokens: contextLimitTokens,
      used_percent: usedPercent,
      free_tokens: freeTokens,
      free_tokens_includes_buffer: freeTokensIncludesBuffer,
      buffer_tokens: bufferTokens,
      system_tokens: systemTokens,
      messages_tokens: conversationTokens,
      tools_tokens: toolsTokens,
      system_tools_tokens: toNullableInt(systemToolsTokens),
      used_prompt_tokens: promptTokens,
      used_completion_tokens: completionTokens,
      reasoning_tokens: reasoningTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      captured_at: normalizeText(event?.timestamp) || null,
      estimate_kind: null,
    },
    error: partialMetricsWarning,
  };
}

function createEstimateState(seed = null) {
  return {
    totalCompletionTokens: Number(seed?.totalCompletionTokens || 0),
    latestTimestamp: normalizeText(seed?.latestTimestamp) || null,
    latestModel: normalizeText(seed?.latestModel) || null,
    explicitContextLimitTokens: toNullableInt(seed?.explicitContextLimitTokens),
  };
}

function updateEstimateState(estimate, event, data) {
  if (!estimate || !data || typeof data !== 'object') return estimate;
  const next = estimate;
  const modelId = resolveEventModelId(data);
  const timestamp = normalizeText(event?.timestamp) || null;
  if (modelId) next.latestModel = modelId;
  if (timestamp) next.latestTimestamp = timestamp;
  const currentModel = modelId;
  const modelUsage = currentModel && data?.modelMetrics?.[currentModel]?.usage && typeof data.modelMetrics[currentModel].usage === 'object'
    ? data.modelMetrics[currentModel].usage
    : null;
  const explicitContextLimitTokens = resolveExplicitContextLimitTokens(data, modelUsage);
  if (explicitContextLimitTokens !== null) next.explicitContextLimitTokens = explicitContextLimitTokens;
  if (String(event?.type || '').trim() !== 'assistant.message') return next;
  const completionTokens = toNullableInt(modelUsage?.outputTokens) ?? toNullableInt(data?.outputTokens);
  if (completionTokens !== null) next.totalCompletionTokens += completionTokens;
  return next;
}

function buildEstimatedSnapshot({ estimate, eventsPath, sessionId, pathModule, getModelContextLimitTokens }) {
  const totalCompletionTokens = toNullableInt(estimate?.totalCompletionTokens);
  if (totalCompletionTokens === null || totalCompletionTokens <= 0) return null;
  const copilotSessionId = extractSessionIdFromEventsPath(pathModule, eventsPath) || sessionId;
  const model = normalizeText(estimate?.latestModel) || null;
  const contextLimitTokens = toNullableInt(estimate?.explicitContextLimitTokens)
    ?? resolveContextLimitTokens(model, null, null, getModelContextLimitTokens);
  // Cumulative assistant output grows without bound while compaction keeps the
  // real window in check, so this ratio can exceed 1. Clamp it: an occupancy
  // gauge reading "340%" is worse than one pinned at 100%.
  const usedPercent = (contextLimitTokens !== null && contextLimitTokens > 0)
    ? Math.min(100, Math.round((totalCompletionTokens / contextLimitTokens) * 10000) / 100)
    : null;
  const freeTokens = (contextLimitTokens !== null)
    ? Math.max(0, contextLimitTokens - totalCompletionTokens)
    : null;
  return {
    snapshot: {
      runtime_session_id: sessionId,
      copilot_session_id: copilotSessionId,
      model,
      used_total_tokens: totalCompletionTokens,
      max_context_tokens: contextLimitTokens,
      used_percent: usedPercent,
      free_tokens: freeTokens,
      buffer_tokens: null,
      system_tokens: null,
      messages_tokens: totalCompletionTokens,
      tools_tokens: null,
      system_tools_tokens: null,
      used_prompt_tokens: null,
      used_completion_tokens: totalCompletionTokens,
      reasoning_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      captured_at: normalizeText(estimate?.latestTimestamp) || null,
      estimate_kind: 'assistant-output-lower-bound',
    },
    error: 'Legacy context-window metrics are unavailable in current session events; showing a lower-bound estimate from cumulative assistant completion tokens only. Prompt, system/tool, cache, and buffer tokens are unavailable.',
  };
}

function hydrateSnapshotFromEstimate(snapshot, estimate, getModelContextLimitTokens = null) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const model = normalizeText(snapshot.model) || normalizeText(estimate?.latestModel) || null;
  const contextLimitTokens = toNullableInt(snapshot.max_context_tokens)
    ?? toNullableInt(estimate?.explicitContextLimitTokens)
    ?? resolveContextLimitTokens(model, null, null, getModelContextLimitTokens);
  const usedTotalTokens = toNullableInt(snapshot.used_total_tokens);
  const usedPercent = toNullablePercent(snapshot.used_percent)
    ?? ((usedTotalTokens !== null && contextLimitTokens !== null && contextLimitTokens > 0)
      ? Math.round((usedTotalTokens / contextLimitTokens) * 10000) / 100
      : null);
  const freeTokens = toNullableInt(snapshot.free_tokens)
    ?? ((usedTotalTokens !== null && contextLimitTokens !== null)
      ? Math.max(0, contextLimitTokens - usedTotalTokens)
      : null);
  const completionTokens = toNullableInt(snapshot.used_completion_tokens)
    ?? toNullableInt(estimate?.totalCompletionTokens);
  return {
    ...snapshot,
    model,
    max_context_tokens: contextLimitTokens,
    used_percent: usedPercent,
    free_tokens: freeTokens,
    used_completion_tokens: completionTokens,
  };
}

function consumeContextSignals(lines, options, seed = null) {
  let latest = seed?.latest || null;
  const estimate = createEstimateState(seed?.estimate || null);
  for (const line of (lines || [])) {
    if (!line) continue;
    let event = null;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const data = event?.data && typeof event.data === 'object' ? event.data : null;
    if (!data) continue;
    updateEstimateState(estimate, event, data);
    if (!hasSnapshotSignals(data)) continue;
    latest = buildSnapshotFromEvent({ event, data, ...options });
  }
  return { latest, estimate };
}

function readFileChunk(fsModule, eventsPath, startOffset, endOffset) {
  const safeStart = Math.max(0, Number(startOffset) || 0);
  const safeEnd = Math.max(safeStart, Number(endOffset) || 0);
  const byteLength = safeEnd - safeStart;
  if (byteLength <= 0) return '';

  const handle = fsModule.openSync(eventsPath, 'r');
  try {
    const buffer = Buffer.alloc(byteLength);
    const bytesRead = fsModule.readSync(handle, buffer, 0, byteLength, safeStart);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    fsModule.closeSync(handle);
  }
}

function splitJsonLines(text, carry = '') {
  const combined = `${String(carry || '')}${String(text || '')}`;
  if (!combined) return { lines: [], remainder: '' };
  const normalized = combined.replace(/\r\n/g, '\n');
  const endsWithNewline = normalized.endsWith('\n');
  const parts = normalized.split('\n');
  const remainder = endsWithNewline ? '' : parts.pop() || '';
  return {
    lines: parts.filter(Boolean),
    remainder,
  };
}

export function createContextSnapshotService({
  fs,
  path,
  resolveSessionStateRoot,
  getModelContextLimitTokens = null,
} = {}) {
  const contextCache = new Map();

  function cacheRecord(cacheKey, record) {
    contextCache.set(cacheKey, record);
    if (contextCache.size <= CONTEXT_CACHE_MAX) return;
    let oldestKey = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, value] of contextCache.entries()) {
      const cachedAt = Number(value?.cachedAt || 0);
      if (cachedAt < oldestAt) {
        oldestAt = cachedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) contextCache.delete(oldestKey);
  }

  function readContextFromSessionEvents(runtimeSessionId, runtimeSessionKey = null) {
    const sessionId = normalizeText(runtimeSessionId);
    const sessionKey = normalizeText(runtimeSessionKey || runtimeSessionId);
    if (!sessionKey) {
      return { snapshot: null, eventsPath: null, error: 'Missing runtime session ID' };
    }

    const root = String(resolveSessionStateRoot?.() || '').trim();
    const eventsPath = path.join(root, sessionKey, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) {
      contextCache.delete(sessionKey);
      return { snapshot: null, eventsPath, error: `Session events file not found at ${eventsPath}` };
    }

    let stat = null;
    try {
      stat = fs.statSync(eventsPath);
    } catch (error) {
      contextCache.delete(sessionKey);
      return { snapshot: null, eventsPath, error: `Failed reading events file stats: ${error?.message || String(error)}` };
    }

    const sizeBytes = Number(stat?.size || 0);
    const mtimeMs = Number(stat?.mtimeMs || 0);
    const cached = contextCache.get(sessionKey) || null;
    if (cached && cached.eventsPath === eventsPath && cached.sizeBytes === sizeBytes && cached.mtimeMs === mtimeMs) {
      cached.cachedAt = Date.now();
      return {
        snapshot: hydrateSnapshotFromEstimate(cached.snapshot, cached.estimate, getModelContextLimitTokens),
        eventsPath,
        error: cached.error || null,
      };
    }

    const canAppend = cached
      && cached.eventsPath === eventsPath
      && sizeBytes >= Number(cached.sizeBytes || 0);
    const startOffset = canAppend ? Number(cached.sizeBytes || 0) : 0;

    let chunkText = '';
    try {
      chunkText = readFileChunk(fs, eventsPath, startOffset, sizeBytes);
    } catch (error) {
      return { snapshot: cached?.snapshot || null, eventsPath, error: `Failed reading events file: ${error?.message || String(error)}` };
    }

    const split = splitJsonLines(chunkText, canAppend ? cached?.remainder || '' : '');
    const consumed = consumeContextSignals(split.lines, {
      eventsPath,
      sessionId,
      pathModule: path,
      getModelContextLimitTokens,
    }, canAppend ? {
      latest: cached?.latest || null,
      estimate: cached?.estimate || null,
    } : null);

    const latest = consumed?.latest || null;
    const estimated = buildEstimatedSnapshot({
      estimate: consumed?.estimate || null,
      eventsPath,
      sessionId,
      pathModule: path,
      getModelContextLimitTokens,
    });
    const previousSnapshot = canAppend ? (cached?.snapshot || null) : null;
    const previousError = canAppend ? (cached?.error || null) : null;
    const nextSnapshot = hydrateSnapshotFromEstimate(
      latest?.snapshot || estimated?.snapshot || previousSnapshot,
      consumed?.estimate || null,
      getModelContextLimitTokens,
    );
    const nextError = latest
      ? (latest.error || null)
      : estimated
        ? (estimated.error || null)
      : (previousError || (nextSnapshot ? null : 'No context-bearing events found for this session'));

    cacheRecord(sessionKey, {
      eventsPath,
      sizeBytes,
      mtimeMs,
      latest,
      estimate: consumed?.estimate || null,
      snapshot: nextSnapshot,
      error: nextError,
      remainder: split.remainder,
      cachedAt: Date.now(),
    });

    return {
      snapshot: nextSnapshot,
      eventsPath,
      error: nextError,
    };
  }

  return {
    readContextFromSessionEvents,
  };
}
