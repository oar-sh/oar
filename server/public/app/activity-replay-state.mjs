const DEFAULT_ACTIVITY_LIMIT = 24;

export function normalizeRelayActivityEntry(item) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const text = String(item.text || '').trim();
    const subagentRunId = item.subagentRunId ? String(item.subagentRunId).trim() : null;
    if (!text) return null;
    const metadata = (item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata))
      ? item.metadata
      : null;
    return { text, subagentRunId, metadata };
  }
  const text = String(item || '').trim();
  if (!text) return null;
  return { text, subagentRunId: null, metadata: null };
}

// A compaction boundary is published as an ordinary activity row carrying
// structured metadata. The transcript promotes it to a full-width break row
// (and drops it from the bubble's tool-activity list), so both sides ask here.
export function isCompactBoundaryActivityEntry(item) {
  return normalizeRelayActivityEntry(item)?.metadata?.kind === 'compact_boundary';
}

function toTokenCount(value) {
  // `Number(null)` is 0, not NaN: without this an omitted post_tokens (every
  // real auto-compaction) would read as a compaction down to zero tokens.
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

// One message carries at most one break row, so when a turn compacted more
// than once only the LAST boundary is promoted. This returns that entry by
// identity, so the render path can keep the others visible as prose instead
// of dropping them (they would otherwise vanish from the transcript).
export function promotedCompactBoundaryEntry(items) {
  const list = Array.isArray(items) ? items : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (isCompactBoundaryActivityEntry(list[index])) return list[index];
  }
  return null;
}

// The last compaction recorded against one message's activities, as
// { preTokens, postTokens } (either may be null when the SDK omitted it).
export function compactBoundaryFromActivities(items) {
  const promoted = promotedCompactBoundaryEntry(items);
  if (!promoted) return null;
  const metadata = normalizeRelayActivityEntry(promoted).metadata;
  return {
    preTokens: toTokenCount(metadata.preTokens),
    postTokens: toTokenCount(metadata.postTokens),
  };
}

// Head-cap that never drops structured rows. Activity lists are capped from
// the front (the start of a turn is the interesting part), but a
// metadata-bearing row carries transcript structure rather than prose, and a
// long agentic turn can push its compaction boundary past the cap — losing
// the break row entirely, with no prose fallback since the bubble filters
// compact entries out. Keep every structured row, spend the rest of the
// budget on the leading prose rows, preserve the original order.
export function capRelayActivityEntries(items, limit = DEFAULT_ACTIVITY_LIMIT) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(1, Math.trunc(Number(limit)) || DEFAULT_ACTIVITY_LIMIT);
  if (list.length <= max) return list.slice();
  const structuredIndexes = [];
  for (let index = 0; index < list.length; index += 1) {
    if (normalizeRelayActivityEntry(list[index])?.metadata) structuredIndexes.push(index);
  }
  if (!structuredIndexes.length) return list.slice(0, max);
  // Safety valve for a pathological turn with more structured rows than the
  // cap allows: the most recent ones win.
  const keep = new Set(structuredIndexes.slice(-max));
  let budget = max - keep.size;
  const kept = [];
  for (let index = 0; index < list.length; index += 1) {
    if (keep.has(index)) {
      kept.push(list[index]);
      continue;
    }
    if (budget <= 0) continue;
    budget -= 1;
    kept.push(list[index]);
  }
  return kept;
}

export function relayActivityEntryText(item) {
  return normalizeRelayActivityEntry(item)?.text || '';
}

function normalizeActivityItems(items, limit = DEFAULT_ACTIVITY_LIMIT) {
  const normalized = Array.isArray(items)
    ? items.map((item) => normalizeRelayActivityEntry(item)).filter(Boolean)
    : [];
  return normalized.slice(-Math.max(1, Number(limit) || DEFAULT_ACTIVITY_LIMIT));
}

function activityEntryKey(item) {
  const entry = normalizeRelayActivityEntry(item);
  if (!entry) return '';
  return `${entry.subagentRunId || ''}::${entry.text}`;
}

function isSubsequence(subset, sequence) {
  if (!subset.length) return true;
  let cursor = 0;
  for (const item of sequence) {
    if (activityEntryKey(item) === activityEntryKey(subset[cursor])) cursor += 1;
    if (cursor >= subset.length) return true;
  }
  return false;
}

export function mergeRelayActivityTexts(existingItems, incomingItems, limit = DEFAULT_ACTIVITY_LIMIT) {
  const existing = normalizeActivityItems(existingItems, Number.POSITIVE_INFINITY);
  const incoming = normalizeActivityItems(incomingItems, Number.POSITIVE_INFINITY);
  if (!existing.length) return normalizeActivityItems(incoming, limit);
  if (!incoming.length) return normalizeActivityItems(existing, limit);
  if (isSubsequence(existing, incoming)) return normalizeActivityItems(incoming, limit);
  if (isSubsequence(incoming, existing)) return normalizeActivityItems(existing, limit);

  const primary = incoming.length > existing.length ? incoming : existing;
  const secondary = primary === incoming ? existing : incoming;
  const merged = primary.slice();
  const seen = new Set(primary.map((item) => activityEntryKey(item)));
  for (const item of secondary) {
    const key = activityEntryKey(item);
    if (!key || seen.has(key)) continue;
    merged.push(item);
    seen.add(key);
  }
  return normalizeActivityItems(merged, limit);
}

export function shouldApplyConversationLoad({
  requestedConversationId,
  activeConversationId,
  capturedVersion,
  currentVersion,
} = {}) {
  const requestedId = String(requestedConversationId || '').trim();
  const activeId = String(activeConversationId || '').trim();
  return !!requestedId
    && requestedId === activeId
    && Number(capturedVersion) === Number(currentVersion);
}
