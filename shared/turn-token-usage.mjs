import { claudeBaseModelId } from './model-id.mjs';

// The token report a worker posts after a turn (POST /api/turn-token-usage),
// checked and normalised. Shared by the relay (the route and
// services/token-usage-service.mjs) and the workers that build it.
//
// A token field a provider did not report is null; a negative, non-finite
// or unsafely large one is not a count either and becomes null, and a
// fraction is cut to the integer. 0 always means the provider reported zero. `inputTokens` is fresh
// input: without the tokens read from or written to the prompt cache.

export const TURN_TOKEN_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheWriteTokens',
  'cacheReadTokens',
  'reasoningTokens',
]);

export const TURN_TOKEN_COST_SOURCES = Object.freeze(['claude-code', 'provider', 'oar-deepseek-table']);

export const TURN_TOKEN_PROVIDERS = Object.freeze(['github', 'claude', 'claude-api', 'claude-cloud', 'deepseek', 'cursor', 'grok']);

// One report names at most this many models; more is not a turn.
export const TURN_TOKEN_MAX_MODELS = 32;
const ID_MAX_LENGTH = 200;
const BILLING_PATTERN = /^byok-[a-z0-9][a-z0-9_-]{0,39}$/;

/** A provider's model id as the tables keep it: lower case, without `[1m]`. */
export function tokenUsageModel(value) {
  return claudeBaseModelId(String(value ?? '').trim()).toLowerCase();
}

// Past these a value is not a count or a cost but a broken report.
const MAX_COST_USD = 1e9;

/** A token count, or null when the value is not one. */
export function tokenCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
  return Math.trunc(value);
}

function costValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_COST_USD) return null;
  return value;
}

/** a + b where either may be null: null only when both are. */
export function addNullable(a, b) {
  if (a == null) return b == null ? null : b;
  if (b == null) return a;
  return a + b;
}

/** '' or `byok-<provider type>`; null for anything else. */
export function normalizeTurnTokenBilling(value) {
  const billing = String(value || '').trim().toLowerCase();
  if (!billing) return '';
  return BILLING_PATTERN.test(billing) ? billing : null;
}

/**
 * `[{ model, inputTokens, …, costUsd, costSource, costUnknown }]`, one per
 * model: the same model named twice (also `x` and `x[1m]`) is summed.
 */
export function normalizeTurnTokenEntries(entries) {
  const byModel = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const model = tokenUsageModel(entry?.model);
    if (!model || model.length > ID_MAX_LENGTH) continue;
    const next = {
      model,
      ...Object.fromEntries(TURN_TOKEN_FIELDS.map((field) => [field, tokenCount(entry?.[field])])),
      costUsd: costValue(entry?.costUsd),
      costSource: TURN_TOKEN_COST_SOURCES.includes(entry?.costSource) ? entry.costSource : null,
      costUnknown: entry?.costUnknown === true,
    };
    const current = byModel.get(model);
    if (!current) {
      byModel.set(model, next);
      continue;
    }
    // The caps hold for the sum too, not only for each entry.
    for (const field of TURN_TOKEN_FIELDS) {
      const sum = addNullable(current[field], next[field]);
      current[field] = sum === null ? null : tokenCount(sum);
    }
    const costSum = addNullable(current.costUsd, next.costUsd);
    current.costUsd = costSum === null ? null : costValue(costSum);
    current.costSource = current.costSource || next.costSource;
    current.costUnknown = current.costUnknown || next.costUnknown;
  }
  return [...byModel.values()];
}

function idValue(value) {
  const id = String(value ?? '').trim();
  return id.length > ID_MAX_LENGTH ? null : id;
}

/**
 * The report a worker posts, checked: `{ ok, report }` or `{ ok: false,
 * error }`. `models` carries the turn's own counts; `sessionTotals` (Claude
 * cloud) the session's running totals, of which the relay books the growth.
 * Who the provider and billing are is the relay's to settle; the body's are
 * only stated.
 */
export function normalizeTurnTokenUsageReport(body = {}) {
  const conversationId = idValue(body?.conversationId);
  const turnId = idValue(body?.turnId);
  const runId = idValue(body?.runId);
  if (!conversationId) return { ok: false, error: 'Missing conversationId' };
  if (!turnId) return { ok: false, error: 'Missing turnId' };
  if (runId === null) return { ok: false, error: 'Invalid runId' };
  const provider = String(body?.provider || '').trim().toLowerCase();
  if (provider && !TURN_TOKEN_PROVIDERS.includes(provider)) return { ok: false, error: 'Unknown provider' };
  const billing = normalizeTurnTokenBilling(body?.billing);
  if (billing === null) return { ok: false, error: 'Invalid billing' };
  const at = body?.at == null || body?.at === '' ? null : String(body.at).trim();
  if (at !== null && !Number.isFinite(Date.parse(at))) return { ok: false, error: 'Invalid at' };
  const hasModels = Array.isArray(body?.models);
  const hasSessionTotals = Array.isArray(body?.sessionTotals);
  if (hasModels === hasSessionTotals) return { ok: false, error: 'Send either models or sessionTotals' };
  const raw = hasModels ? body.models : body.sessionTotals;
  if (raw.length > TURN_TOKEN_MAX_MODELS) return { ok: false, error: `More than ${TURN_TOKEN_MAX_MODELS} models` };
  const entries = normalizeTurnTokenEntries(raw);
  if (!entries.length) return { ok: false, error: 'Missing models' };
  const nativeSessionId = idValue(body?.nativeSessionId) || null;
  if (hasSessionTotals && !nativeSessionId) return { ok: false, error: 'Missing nativeSessionId' };
  return {
    ok: true,
    report: {
      conversationId,
      turnId,
      runId,
      provider,
      billing,
      nativeSessionId,
      responseMessageId: idValue(body?.responseMessageId) || null,
      at: at === null ? null : new Date(Date.parse(at)).toISOString(),
      ...(hasModels ? { models: entries } : { sessionTotals: entries }),
    },
  };
}
