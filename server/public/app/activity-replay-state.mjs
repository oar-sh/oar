// A row's place in its turn's order (migration 0038), or null: rows from
// before it, or from an older relay, have none.
export function normalizeTurnSeq(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

export function normalizeRelayActivityEntry(item) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const text = String(item.text || '').trim();
    const subagentRunId = item.subagentRunId ? String(item.subagentRunId).trim() : null;
    if (!text) return null;
    const metadata = (item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata))
      ? item.metadata
      : null;
    const turnSeq = normalizeTurnSeq(item.turnSeq);
    return { text, subagentRunId, metadata, ...(turnSeq !== null ? { turnSeq } : {}) };
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

// The thread an activity row belongs to: a sub-agent run, or '' for the main
// agent. Every cap below counts each thread apart, so a busy sub-agent never
// pushes the main agent's lines out (or another sub-agent's).
function activityThreadKey(item) {
  return normalizeRelayActivityEntry(item)?.subagentRunId || '';
}

// No limit: a cap of 0 (the setting's far end), or anything not a positive
// number.
function isUnlimitedCap(cap) {
  const value = Number(cap);
  return !Number.isFinite(value) || value <= 0;
}

/**
 * Keep the newest `cap` rows of each thread among those `isKept` does not
 * protect, and every protected row; the order stays. A sub-agent's thread
 * keeps `subagentCap` (the same unless given). A list already within the cap
 * is returned as it is.
 */
function capNewestPerThread(list, cap, isKept, subagentCap = cap) {
  if (isUnlimitedCap(cap) && isUnlimitedCap(subagentCap)) return list;
  const maxFor = (key) => {
    const limit = key ? subagentCap : cap;
    return isUnlimitedCap(limit) ? Number.POSITIVE_INFINITY : Math.trunc(Number(limit));
  };
  const remaining = new Map();
  for (const item of list) {
    if (isKept(item)) continue;
    const key = activityThreadKey(item);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  if ([...remaining.entries()].every(([key, count]) => count <= maxFor(key))) return list;
  return list.filter((item) => {
    if (isKept(item)) return true;
    const key = activityThreadKey(item);
    const left = remaining.get(key) - 1;
    remaining.set(key, left);
    return left < maxFor(key);
  });
}

// The live list of one turn keeps the newest ordinary lines of each thread
// (the main agent, each sub-agent) only, as many as the "Tool lines shown
// while an agent works" setting says (live-activity-cap.mjs; 0 keeps all),
// but every structured row a line of the transcript is built from: the
// turn's compaction entries and the session-restart notes (a compaction
// window, a billing switch) would otherwise scroll out of a busy turn and
// take their line with them until the next reload. The call sites pass the
// setting; LIVE_ACTIVITY_CAP is its default.
export const LIVE_ACTIVITY_CAP = 50;
function isKeptLiveActivityEntry(item) {
  const kind = normalizeRelayActivityEntry(item)?.metadata?.kind;
  return kind === 'compact_boundary' || kind === 'compact_window_respawn' || kind === 'billing_switch_respawn';
}
export function capLiveActivityEntries(items, cap = LIVE_ACTIVITY_CAP) {
  const list = Array.isArray(items) ? items : [];
  return capNewestPerThread(list, cap, isKeptLiveActivityEntry);
}

// What the relay sends of a turn's activity rows, per thread.
//
// A running turn (the in-flight snapshot the live bubble polls every 900 ms):
// as many as the browser shows, which it says with `activityCap` (its "Tool
// lines shown" setting); a request without it (an older page, a paired
// relay's read) gets the default 50; the setting's "no limit" asks for the
// most the relay sends, 500.
export const IN_FLIGHT_ACTIVITY_LIMIT_PER_THREAD = 500;
// A finished one (the message payload): the main agent's newest 200 (the
// stream view lists them), each sub-agent's newest 50 (its own record is in
// the sub-agent viewer).
export const FINISHED_ACTIVITY_LIMIT_PER_THREAD = 200;
export const FINISHED_SUBAGENT_ACTIVITY_LIMIT_PER_THREAD = 50;

/** The in-flight cap a request asks for: `activityCap` as 1…500, 0 → 500, else 50. */
export function inFlightActivityCap(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return LIVE_ACTIVITY_CAP;
  const cap = Number(text);
  if (cap === 0) return IN_FLIGHT_ACTIVITY_LIMIT_PER_THREAD;
  return Math.min(IN_FLIGHT_ACTIVITY_LIMIT_PER_THREAD, cap);
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

// The relay's cap of a turn's activity rows, which never drops structured
// rows. Each thread (the main agent, each sub-agent) keeps its newest `limit`
// prose rows: a busy sub-agent no longer pushes the main agent's lines out,
// and the latest lines are the ones a reader of a long turn is after. A
// metadata-bearing row carries transcript structure rather than prose, and a
// long agentic turn can push its compaction boundary past the cap — losing
// the break row entirely, with no prose fallback since the bubble filters
// compact entries out. Keep every structured row, preserve the original
// order. Returns a new array. `subagentLimit` is a sub-agent thread's own
// limit (the finished payload keeps fewer of those).
//
// `omittedMarker`: when the main agent's rows were cut, a structured row
// saying how many (kind ACTIVITY_OMITTED_KIND) goes right before its first
// kept row, so a reader of the finished turn sees that its list starts late.
export function capRelayActivityEntries(items, limit, { subagentLimit = limit, omittedMarker = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(1, Math.trunc(Number(limit)) || LIVE_ACTIVITY_CAP);
  const subagentMax = Math.max(1, Math.trunc(Number(subagentLimit)) || max);
  const isStructured = (item) => !!normalizeRelayActivityEntry(item)?.metadata;
  const structured = list.filter(isStructured);
  // Safety valve for a pathological turn with more structured rows than the
  // cap allows: the most recent ones win.
  let source = list;
  if (structured.length > max) {
    const keep = new Set(structured.slice(-max));
    source = list.filter((item) => !isStructured(item) || keep.has(item));
  }
  const capped = capNewestPerThread(source, max, isStructured, subagentMax);
  if (capped === list) return list.slice();
  if (!omittedMarker) return capped;
  const isMainProse = (item) => !isStructured(item) && !activityThreadKey(item);
  const kept = new Set(capped);
  const dropped = source.filter((item) => isMainProse(item) && !kept.has(item));
  if (!dropped.length) return capped;
  const at = capped.findIndex(isMainProse);
  // Where the first line left out was in the turn's order, when it had one.
  const fromTurnSeq = normalizeRelayActivityEntry(dropped[0])?.turnSeq ?? null;
  const marker = omittedActivityMarker(dropped.length, fromTurnSeq);
  return at === -1 ? [...capped, marker] : [...capped.slice(0, at), marker, ...capped.slice(at)];
}

// The row that stands for the main agent's tool lines a finished turn's cap
// left out. It has no turn order of its own; `fromTurnSeq` is the place of
// the first line it stands for, where the stream view puts it.
export const ACTIVITY_OMITTED_KIND = 'activity_omitted';

export function omittedActivityMarker(count, fromTurnSeq = null) {
  const n = Math.max(1, Math.trunc(Number(count)) || 1);
  const from = normalizeTurnSeq(fromTurnSeq);
  return {
    text: `… ${n} earlier tool ${n === 1 ? 'line' : 'lines'} omitted`,
    subagentRunId: null,
    metadata: { kind: ACTIVITY_OMITTED_KIND, count: n, ...(from !== null ? { fromTurnSeq: from } : {}) },
  };
}

export function isOmittedActivityMarker(item) {
  return normalizeRelayActivityEntry(item)?.metadata?.kind === ACTIVITY_OMITTED_KIND;
}

// The finished turn's cap, as the relay sends it and the bubble reads it; a
// cut in the main agent's lines is marked.
export function capFinishedActivityEntries(items) {
  return capRelayActivityEntries(items, FINISHED_ACTIVITY_LIMIT_PER_THREAD, {
    subagentLimit: FINISHED_SUBAGENT_ACTIVITY_LIMIT_PER_THREAD,
    omittedMarker: true,
  });
}

export function relayActivityEntryText(item) {
  return normalizeRelayActivityEntry(item)?.text || '';
}

// The live list's rule: the newest `cap` ordinary lines of each thread, the
// structured rows kept (capLiveActivityEntries); Infinity or 0 keeps all.
function normalizeActivityItems(items, cap = LIVE_ACTIVITY_CAP) {
  const normalized = Array.isArray(items)
    ? items.map((item) => normalizeRelayActivityEntry(item)).filter(Boolean)
    : [];
  return capLiveActivityEntries(normalized, cap);
}

// A numbered row is the row with that number (the same tool line twice is two
// rows; a replayed event is one); an unnumbered one is known by its text.
function activityEntryKey(item) {
  const entry = normalizeRelayActivityEntry(item);
  if (!entry) return '';
  if (entry.turnSeq !== undefined) return `#${entry.turnSeq}`;
  return `${entry.subagentRunId || ''}::${entry.text}`;
}

const isNumbered = (item) => normalizeRelayActivityEntry(item)?.turnSeq !== undefined;

function isSubsequence(subset, sequence) {
  if (!subset.length) return true;
  let cursor = 0;
  for (const item of sequence) {
    if (activityEntryKey(item) === activityEntryKey(subset[cursor])) cursor += 1;
    if (cursor >= subset.length) return true;
  }
  return false;
}

export function mergeRelayActivityTexts(existingItems, incomingItems, limit = LIVE_ACTIVITY_CAP) {
  const existing = normalizeActivityItems(existingItems, Number.POSITIVE_INFINITY);
  const incoming = normalizeActivityItems(incomingItems, Number.POSITIVE_INFINITY);
  if (!existing.length) return normalizeActivityItems(incoming, limit);
  if (!incoming.length) return normalizeActivityItems(existing, limit);
  // Both sides numbered (migration 0038): the union by number, in order.
  if (existing.every(isNumbered) && incoming.every(isNumbered)) {
    const byTurnSeq = new Map();
    for (const item of [...existing, ...incoming]) byTurnSeq.set(item.turnSeq, item);
    return normalizeActivityItems([...byTurnSeq.values()].sort((a, b) => a.turnSeq - b.turnSeq), limit);
  }
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
