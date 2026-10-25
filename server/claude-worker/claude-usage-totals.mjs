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
