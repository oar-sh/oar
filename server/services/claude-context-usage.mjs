'use strict';

/**
 * Maps the Claude Agent SDK's context-usage control response onto the relay's
 * existing context-snapshot contract.
 *
 * Claude sessions have no Copilot `events.jsonl` to tail, so this is the only
 * source of context data for them. The SDK hands back the same breakdown that
 * powers `/context` in Claude Code — see `SDKControlGetContextUsageResponse` in
 * `@anthropic-ai/claude-agent-sdk`.
 */

// Category names as the SDK reports them, mapped onto the snapshot's coarser
// system/tools/messages buckets. Matched case-insensitively; unknown categories
// are still carried in the view payload, they just don't fold into a bucket.
const SYSTEM_CATEGORY_NAMES = new Set(['system prompt', 'memory files', 'custom agents']);
const TOOLS_CATEGORY_NAMES = new Set(['system tools', 'tools', 'mcp tools', 'skills', 'slash commands']);
const MESSAGES_CATEGORY_NAMES = new Set(['messages', 'conversation']);
const FREE_CATEGORY_NAMES = new Set(['free space', 'free', 'autocompact buffer']);

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

function normalizeText(value) {
  return String(value || '').trim();
}

export function isFreeSpaceCategoryName(name) {
  return FREE_CATEGORY_NAMES.has(normalizeText(name).toLowerCase());
}

/**
 * Validate and normalize a raw SDK context-usage response. Returns null for
 * anything that isn't usable, so callers never have to guard field-by-field.
 */
export function normalizeClaudeContextUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const totalTokens = toNullableInt(raw.totalTokens);
  const maxTokens = toNullableInt(raw.maxTokens) ?? toNullableInt(raw.rawMaxTokens);
  if (totalTokens === null && maxTokens === null) return null;

  const categories = (Array.isArray(raw.categories) ? raw.categories : [])
    .map((entry) => {
      const name = normalizeText(entry?.name);
      const tokens = toNullableInt(entry?.tokens);
      if (!name || tokens === null) return null;
      return {
        name,
        tokens,
        color: normalizeText(entry?.color) || null,
        isDeferred: entry?.isDeferred === true,
      };
    })
    .filter(Boolean)
    // The SDK sometimes includes free space as a category; the view layer
    // derives that from the total instead, so drop it here to avoid double
    // counting it in the bar.
    .filter((entry) => !isFreeSpaceCategoryName(entry.name));

  const apiUsage = raw.apiUsage && typeof raw.apiUsage === 'object' ? raw.apiUsage : null;

  return {
    model: normalizeText(raw.model) || null,
    totalTokens,
    maxTokens,
    percentage: toNullablePercent(raw.percentage),
    categories,
    skills: raw.skills && typeof raw.skills === 'object'
      ? {
        totalSkills: toNullableInt(raw.skills.totalSkills),
        includedSkills: toNullableInt(raw.skills.includedSkills),
        tokens: toNullableInt(raw.skills.tokens),
      }
      : null,
    autoCompactThreshold: toNullablePercent(raw.autoCompactThreshold),
    isAutoCompactEnabled: raw.isAutoCompactEnabled === true,
    apiUsage: apiUsage
      ? {
        inputTokens: toNullableInt(apiUsage.input_tokens),
        outputTokens: toNullableInt(apiUsage.output_tokens),
        cacheReadTokens: toNullableInt(apiUsage.cache_read_input_tokens),
        cacheWriteTokens: toNullableInt(apiUsage.cache_creation_input_tokens),
      }
      : null,
  };
}

/**
 * `modelUsage` is keyed by the raw model string. Prefer the requested model,
 * fall back to the only entry when there is exactly one (the common case), so a
 * model-id spelling mismatch doesn't lose the context window.
 */
export function resolveModelUsageEntry(modelUsage, model) {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const wanted = normalizeText(model).toLowerCase();
  const entries = Object.entries(modelUsage).filter(([, value]) => value && typeof value === 'object');
  if (!entries.length) return null;
  if (wanted) {
    const match = entries.find(([key]) => normalizeText(key).toLowerCase() === wanted);
    if (match) return match[1];
  }
  return entries.length === 1 ? entries[0][1] : null;
}

function sumCategories(categories, names) {
  let total = null;
  for (const entry of categories) {
    if (!names.has(entry.name.toLowerCase())) continue;
    total = (total || 0) + entry.tokens;
  }
  return total;
}

/**
 * Build a snapshot in the same shape `context-snapshot-service` produces for
 * Copilot, so the indicator line and the existing text renderer work unchanged.
 */
export function buildClaudeContextSnapshot({
  contextUsage,
  modelUsage = null,
  model = '',
  runtimeSessionId = null,
  sdkSessionId = null,
  capturedAt = null,
} = {}) {
  const usage = normalizeClaudeContextUsage(contextUsage);
  const modelUsageEntry = resolveModelUsageEntry(modelUsage, model || usage?.model);
  const contextWindow = toNullableInt(modelUsageEntry?.contextWindow);

  const maxContextTokens = usage?.maxTokens ?? contextWindow;
  const usedTotalTokens = usage?.totalTokens ?? null;
  if (usedTotalTokens === null && maxContextTokens === null) return null;

  const usedPercent = usage?.percentage
    ?? ((usedTotalTokens !== null && maxContextTokens !== null && maxContextTokens > 0)
      ? Math.round((usedTotalTokens / maxContextTokens) * 10000) / 100
      : null);
  const freeTokens = (usedTotalTokens !== null && maxContextTokens !== null)
    ? Math.max(0, maxContextTokens - usedTotalTokens)
    : null;

  const categories = usage?.categories || [];
  const systemTokens = sumCategories(categories, SYSTEM_CATEGORY_NAMES);
  const toolsTokens = sumCategories(categories, TOOLS_CATEGORY_NAMES);
  const messagesTokens = sumCategories(categories, MESSAGES_CATEGORY_NAMES);
  const systemToolsTokens = (systemTokens !== null || toolsTokens !== null)
    ? Number(systemTokens || 0) + Number(toolsTokens || 0)
    : null;

  return {
    runtime_session_id: runtimeSessionId || null,
    copilot_session_id: sdkSessionId || null,
    model: usage?.model || normalizeText(model) || null,
    used_total_tokens: usedTotalTokens,
    max_context_tokens: maxContextTokens,
    used_percent: usedPercent,
    free_tokens: freeTokens,
    // The auto-compact threshold is the share of the window Claude keeps in
    // reserve, so it is the closest analogue to Copilot's buffer.
    buffer_tokens: (usage?.isAutoCompactEnabled && usage?.autoCompactThreshold !== null
      && maxContextTokens !== null)
      ? Math.max(0, Math.round(maxContextTokens * (1 - (usage.autoCompactThreshold / 100))))
      : null,
    system_tokens: systemTokens,
    messages_tokens: messagesTokens,
    tools_tokens: toolsTokens,
    system_tools_tokens: systemToolsTokens,
    used_prompt_tokens: usage?.apiUsage?.inputTokens ?? null,
    used_completion_tokens: usage?.apiUsage?.outputTokens ?? null,
    reasoning_tokens: null,
    cache_read_tokens: usage?.apiUsage?.cacheReadTokens ?? null,
    cache_write_tokens: usage?.apiUsage?.cacheWriteTokens ?? null,
    captured_at: normalizeText(capturedAt) || null,
    estimate_kind: null,
  };
}

/**
 * Parse the JSON blob persisted on `runtime_sessions` and rebuild both the
 * snapshot and the normalized usage the view layer renders.
 */
export function readStoredClaudeContextUsage(row) {
  const rawJson = normalizeText(row?.context_usage_json);
  if (!rawJson) return { snapshot: null, contextUsage: null };

  let parsed = null;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { snapshot: null, contextUsage: null };
  }

  const capturedAt = normalizeText(row?.context_usage_captured_at) || null;
  const snapshot = buildClaudeContextSnapshot({
    contextUsage: parsed?.contextUsage,
    modelUsage: parsed?.modelUsage,
    model: parsed?.model || row?.provider_model || row?.model || '',
    runtimeSessionId: row?.id || null,
    sdkSessionId: row?.sdk_session_id || null,
    capturedAt,
  });
  return {
    snapshot,
    contextUsage: normalizeClaudeContextUsage(parsed?.contextUsage),
  };
}
