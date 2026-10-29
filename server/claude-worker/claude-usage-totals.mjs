// The CLI's token totals per model, out of a result message.
//
// A result's `modelUsage` is the CLI session's running total, not the turn's:
// a long-lived CLI reports more on every turn, a CLI resumed on a session
// starts from the totals that session's transcript saved (its first result
// already carries the earlier turns), and a `/clear` starts it over. Its
// `usage` is the turn's own, and the main agent loop's only (sub-agents and
// auxiliary calls are left out). The publisher turns these into the
// process's own running totals (claude-turn-publisher.mjs, runningCounts),
// which the relay books per process (plan-usage-service.mjs,
// recordDeepSeekUsageReport).

function count(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function addTo(totals, model, hit, miss, output) {
  const current = totals.get(model) || { model, hitTokens: 0, missTokens: 0, outputTokens: 0 };
  current.hitTokens += hit;
  current.missTokens += miss;
  current.outputTokens += output;
  totals.set(model, current);
}

/**
 * `[{ model, hitTokens, missTokens, outputTokens }]`: cache reads are hits,
 * fresh and cache-creation input are misses. `modelKey` maps the CLI's name
 * of a model to the relay's (DeepSeek: without the `[1m]` suffix); entries
 * that map to the same id are summed. `usage` stands in only for a result
 * without `modelUsage`, under the turn's model (pass `modelUsage` as null to
 * read `usage` alone). Models with no tokens are left out.
 */
export function claudeUsageTotals(modelUsage, {
  usage = null,
  model = '',
  modelKey = (value) => String(value ?? '').trim(),
} = {}) {
  const keyOf = (value) => String(modelKey(value) ?? '').trim().toLowerCase();
  const totals = new Map();
  if (modelUsage && typeof modelUsage === 'object' && !Array.isArray(modelUsage)) {
    for (const [name, entry] of Object.entries(modelUsage)) {
      const key = keyOf(name);
      if (!key || !entry || typeof entry !== 'object') continue;
      addTo(
        totals,
        key,
        count(entry.cacheReadInputTokens),
        count(entry.inputTokens) + count(entry.cacheCreationInputTokens),
        count(entry.outputTokens),
      );
    }
  } else {
    const key = keyOf(model);
    if (key && usage && typeof usage === 'object') {
      addTo(
        totals,
        key,
        count(usage.cache_read_input_tokens),
        count(usage.input_tokens) + count(usage.cache_creation_input_tokens),
        count(usage.output_tokens),
      );
    }
  }
  return [...totals.values()].filter((entry) => entry.hitTokens + entry.missTokens + entry.outputTokens > 0);
}

/**
 * The CLI's running count of web searches per model, `[{ model,
 * searchRequests }]`, out of a result's `modelUsage`: the CLI adds every API
 * request's `server_tool_use.web_search_requests` to it, the internal request
 * its WebSearch tool makes included, which never shows up in the message
 * stream. Same `modelKey` and summing as the token totals. Only the entries
 * that carry the count, zero included, so an empty list means the CLI does
 * not report it. It has no fetch count.
 */
export function claudeSearchTotals(modelUsage, { modelKey = (value) => String(value ?? '').trim() } = {}) {
  const searches = new Map();
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return [];
  for (const [name, entry] of Object.entries(modelUsage)) {
    const key = String(modelKey(name) ?? '').trim().toLowerCase();
    if (!key || !entry || typeof entry !== 'object' || !Number.isFinite(Number(entry.webSearchRequests ?? NaN))) continue;
    const current = searches.get(key) || { model: key, searchRequests: 0 };
    current.searchRequests += count(entry.webSearchRequests);
    searches.set(key, current);
  }
  return [...searches.values()];
}

/**
 * The turn's web searches and fetches per model, `[{ model, searchRequests,
 * fetchRequests }]`, from the result's `serverToolUse` (the normalizer's
 * per-turn count, not a running total): the message stream's, which leaves
 * out the WebSearch tool's own request. Same `modelKey` and summing as the
 * token totals; models with no requests are left out.
 */
export function claudeToolRequests(serverToolUse, { modelKey = (value) => String(value ?? '').trim() } = {}) {
  const requests = new Map();
  for (const entry of Array.isArray(serverToolUse) ? serverToolUse : []) {
    const key = String(modelKey(entry?.model) ?? '').trim().toLowerCase();
    if (!key || !entry || typeof entry !== 'object') continue;
    const current = requests.get(key) || { model: key, searchRequests: 0, fetchRequests: 0 };
    current.searchRequests += count(entry.webSearchRequests);
    current.fetchRequests += count(entry.webFetchRequests);
    requests.set(key, current);
  }
  return [...requests.values()].filter((entry) => entry.searchRequests + entry.fetchRequests > 0);
}

function costOf(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * The CLI's totals per model with Claude Code's own cost estimate, for the
 * Claude API booking (claude-api-usage-service.mjs): `[{ model, hitTokens,
 * missTokens, outputTokens, costUsd, costUnknown }]`. From `modelUsage` (the
 * session's running totals, sub-agents and helper calls included; `costUSD`
 * per model, `costBasis: 'unknown'` for a model the CLI has no price for), or
 * from `usage` alone under the turn's model (pass `modelUsage` as null): the
 * turn's main agent loop, which carries no cost. Model ids keep Claude's
 * `[1m]` tier; the relay books them under the base id.
 */
export function claudeBillingTotals(modelUsage, { usage = null, model = '' } = {}) {
  const totals = new Map();
  const add = (name, hit, miss, output, costUsd, costUnknown) => {
    const key = String(name ?? '').trim().toLowerCase();
    if (!key) return;
    const current = totals.get(key) || { model: key, hitTokens: 0, missTokens: 0, outputTokens: 0, costUsd: 0, costUnknown: false };
    current.hitTokens += hit;
    current.missTokens += miss;
    current.outputTokens += output;
    current.costUsd += costUsd;
    current.costUnknown = current.costUnknown || costUnknown;
    totals.set(key, current);
  };
  if (modelUsage && typeof modelUsage === 'object' && !Array.isArray(modelUsage)) {
    for (const [name, entry] of Object.entries(modelUsage)) {
      if (!entry || typeof entry !== 'object') continue;
      add(
        name,
        count(entry.cacheReadInputTokens),
        count(entry.inputTokens) + count(entry.cacheCreationInputTokens),
        count(entry.outputTokens),
        costOf(entry.costUSD),
        entry.costBasis === 'unknown',
      );
    }
  } else if (usage && typeof usage === 'object') {
    add(
      model,
      count(usage.cache_read_input_tokens),
      count(usage.input_tokens) + count(usage.cache_creation_input_tokens),
      count(usage.output_tokens),
      0,
      false,
    );
  }
  return [...totals.values()].filter((entry) => entry.hitTokens + entry.missTokens + entry.outputTokens > 0 || entry.costUsd > 0);
}

/**
 * The CLI's totals per model with the four token kinds apart, for the token
 * booking (POST /api/turn-token-usage): `[{ model, inputTokens,
 * cacheWriteTokens, cacheReadTokens, outputTokens, costUsd, costUnknown }]`.
 * `inputTokens` is fresh input (Anthropic counts cache reads and writes
 * apart). Read like claudeBillingTotals: `modelUsage` (running totals, with
 * Claude Code's cost estimate) or `usage` alone under the turn's model (no
 * cost: `costUsd` null). `modelKey` maps the CLI's model names to the
 * relay's, as in claudeUsageTotals; the `[1m]` tier is dropped. Models with
 * no tokens and no cost are left out.
 */
export function claudeTokenTotals(modelUsage, {
  usage = null,
  model = '',
  modelKey = (value) => String(value ?? '').trim(),
} = {}) {
  const totals = new Map();
  const add = (name, entry) => {
    const key = String(modelKey(name) ?? '').trim().toLowerCase().replace(/\[1m\]$/, '');
    if (!key) return;
    const current = totals.get(key) || {
      model: key, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: null, costUnknown: false,
    };
    current.inputTokens += entry.inputTokens;
    current.cacheWriteTokens += entry.cacheWriteTokens;
    current.cacheReadTokens += entry.cacheReadTokens;
    current.outputTokens += entry.outputTokens;
    if (entry.costUsd !== null) current.costUsd = (current.costUsd ?? 0) + entry.costUsd;
    current.costUnknown = current.costUnknown || entry.costUnknown;
    totals.set(key, current);
  };
  if (modelUsage && typeof modelUsage === 'object' && !Array.isArray(modelUsage)) {
    for (const [name, entry] of Object.entries(modelUsage)) {
      if (!entry || typeof entry !== 'object') continue;
      add(name, {
        inputTokens: count(entry.inputTokens),
        cacheWriteTokens: count(entry.cacheCreationInputTokens),
        cacheReadTokens: count(entry.cacheReadInputTokens),
        outputTokens: count(entry.outputTokens),
        costUsd: costOf(entry.costUSD),
        costUnknown: entry.costBasis === 'unknown',
      });
    }
  } else if (usage && typeof usage === 'object') {
    add(model, {
      inputTokens: count(usage.input_tokens),
      cacheWriteTokens: count(usage.cache_creation_input_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      outputTokens: count(usage.output_tokens),
      costUsd: null,
      costUnknown: false,
    });
  }
  return [...totals.values()].filter((entry) => (
    entry.inputTokens + entry.cacheWriteTokens + entry.cacheReadTokens + entry.outputTokens > 0 || entry.costUsd > 0
  ));
}
