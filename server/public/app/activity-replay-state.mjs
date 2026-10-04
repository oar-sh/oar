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
// Every compaction entry answers here, whatever its state: the live bubble
// never shows any of them as prose.
export function isCompactBoundaryActivityEntry(item) {
  return normalizeRelayActivityEntry(item)?.metadata?.kind === 'compact_boundary';
}

// The live list of one turn keeps its newest ordinary lines only, but every
// structured row a line of the transcript is built from: the turn's
// compaction entries and the session-restart note would otherwise scroll out
// of a busy turn and take their line with them until the next reload.
export const LIVE_ACTIVITY_CAP = 24;
function isKeptLiveActivityEntry(item) {
  const kind = normalizeRelayActivityEntry(item)?.metadata?.kind;
  return kind === 'compact_boundary' || kind === 'compact_window_respawn';
}
export function capLiveActivityEntries(items, cap = LIVE_ACTIVITY_CAP) {
  const list = Array.isArray(items) ? items : [];
  let ordinary = list.reduce((count, item) => count + (isKeptLiveActivityEntry(item) ? 0 : 1), 0);
  if (ordinary <= cap) return list;
  return list.filter((item) => {
    if (isKeptLiveActivityEntry(item)) return true;
    ordinary -= 1;
    return ordinary < cap;
  });
}

// A compaction is published in up to two steps on the same message: a
// `pending` entry when it starts, then either the boundary (no `state`, token
// counts) or a `cancelled` entry when it ended without a result.
// → 'pending' | 'cancelled' | 'boundary' | null (not a compaction entry).
export function compactionEntryState(item) {
  const metadata = normalizeRelayActivityEntry(item)?.metadata;
  if (metadata?.kind !== 'compact_boundary') return null;
  const state = String(metadata.state || '').trim().toLowerCase();
  if (state === 'pending' || state === 'cancelled') return state;
  return 'boundary';
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
//
// The last compaction entry decides: a `pending` one is promoted only while
// the message is still `processing` (a finished or failed message never shows
// a dangling start). A dangling start or a `cancelled` end draws no line of
// its own, so the line falls back to an earlier boundary of the same message
// when there is one.
export function promotedCompactBoundaryEntry(items, { processing = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  let sawLast = false;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const state = compactionEntryState(list[index]);
    if (!state) continue;
    if (!sawLast) {
      sawLast = true;
      if (state === 'pending' && processing) return list[index];
    }
    if (state === 'boundary') return list[index];
  }
  return null;
}

// The last compaction recorded against one message's activities, as
// { preTokens, postTokens } (either may be null when the SDK omitted it), or
// { pending: true, preTokens: null, postTokens: null } while it runs.
export function compactBoundaryFromActivities(items, options = {}) {
  const promoted = promotedCompactBoundaryEntry(items, options);
  if (!promoted) return null;
  if (compactionEntryState(promoted) === 'pending') {
    return { pending: true, preTokens: null, postTokens: null };
  }
  const metadata = normalizeRelayActivityEntry(promoted).metadata;
  return {
    preTokens: toTokenCount(metadata.preTokens),
    postTokens: toTokenCount(metadata.postTokens),
  };
}

// Activity rows the message bubble lists as prose: everything except the
// promoted boundary (it is the break row) and every pending/cancelled step
// (transient state, never prose).
export function visibleActivityEntries(items, promoted) {
  const list = Array.isArray(items) ? items : [];
  return list.filter((item) => {
    if (item === promoted) return false;
    const state = compactionEntryState(item);
    return state !== 'pending' && state !== 'cancelled';
  });
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
