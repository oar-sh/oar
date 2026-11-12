// Title filtering for the conversation sidebar, and the 🔥 "active only"
// filter beside it. Kept DOM-free so it can be unit tested; journal-view.js
// touches window/document at module scope and cannot be imported from
// node:test.

import { parseConversationTimeMs } from './conversation-group-order.mjs';

// NFC first so a decomposed "é" (e + U+0301, as some IMEs and pasted text
// produce) matches a precomposed one. Case folding is toLocaleLowerCase only, so
// multi-char folds are a known limit: "ß" does not match "SS".
function foldForMatch(text) {
  return String(text ?? '').normalize('NFC').toLocaleLowerCase();
}

export function normalizeConversationFilter(text) {
  return foldForMatch(text).trim();
}

export function conversationMatchesFilter(conversation, normalizedFilter) {
  if (!normalizedFilter) return true;
  return foldForMatch(conversation?.title).includes(normalizedFilter);
}

export function filterConversations(conversations, filterText) {
  const list = Array.isArray(conversations) ? conversations : [];
  const normalized = normalizeConversationFilter(filterText);
  if (!normalized) return list;
  return list.filter((conversation) => conversationMatchesFilter(conversation, normalized));
}

export function describeFilterMatchCount(count, { loadedOnly = false } = {}) {
  const n = Math.max(0, Number(count) || 0);
  const noun = loadedOnly ? 'loaded conversation' : 'conversation';
  if (n === 0) return `No ${noun}s match`;
  return n === 1 ? `1 ${noun} matches` : `${n} ${noun}s match`;
}

function cursorKey(state) {
  try {
    return JSON.stringify(state?.nextCursor ?? null);
  } catch {
    return '';
  }
}

// While a filter is active the sidebar has to search conversations that only
// exist on unloaded pages, so pull every remaining page through the loader.
// shouldContinue() is checked before each page so clearing the filter (or
// switching it) aborts the drain. loadMore() resolving falsy is ambiguous:
// - the loader is busy (a boundary-check load/prefetch is in flight): wait it
//   out without spending idle retries, so the drain does not give up while the
//   list is still loading. busyRetries caps a genuinely stuck fetch.
// - a reset bumped the loader version mid-fetch, or the fetch failed: retry,
//   but stop after maxIdleRetries consecutive no-progress attempts so a failing
//   endpoint is not hammered forever.
// An advanced cursor counts as progress even when the page was empty.
export async function drainRemainingPages(loader, shouldContinue = () => true, {
  retryDelayMs = 200,
  maxIdleRetries = 10,
  maxBusyRetries = 300,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!loader || typeof loader.loadMore !== 'function' || typeof loader.getState !== 'function') {
    return false;
  }
  let loadedAnything = false;
  let idleRetries = 0;
  let busyRetries = 0;
  while (loader.getState().hasMore && shouldContinue()) {
    const cursorBefore = cursorKey(loader.getState());
    const loaded = await loader.loadMore();
    const state = loader.getState();
    if (loaded) loadedAnything = true;
    if (loaded || cursorKey(state) !== cursorBefore) {
      idleRetries = 0;
      busyRetries = 0;
      continue;
    }
    if (state.isLoading || state.isPrefetching) {
      busyRetries += 1;
      if (busyRetries > maxBusyRetries) break;
    } else {
      idleRetries += 1;
      if (idleRetries > maxIdleRetries) break;
    }
    await delay(retryDelayMs);
  }
  return loadedAnything;
}

// ── 🔥 Active only ──────────────────────────────────────────────────────────
// A session counts as active while any of these holds:
//  1. it works: a turn runs or is queued, or background work runs (the same
//     signal the row's colour and spinner use; the caller passes it in);
//  2. its last activity (a turn's end, a stream, the list's updatedAt) lies
//     less than ACTIVE_WINDOW_MS back;
//  3. a card waits on the person in it (an ask_user question, a Safety
//     check, a plan card, a relay ask; the caller passes it in).
// Archived sessions never count: the 🔥 filter is a view of the live list.

export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
export const ACTIVE_FILTER_STORAGE_KEY = 'copilot_conv_active_filter';
// A relay time further ahead of this page's clock than this is a clock that
// runs ahead, not activity to come: the row counts from when the page first
// saw that time (noteActivityFirstSeen).
export const ACTIVITY_CLOCK_SKEW_MS = 60 * 1000;
// The 🔥 drain chases sessions known to be active but not loaded for at most
// this many pages in which none of them turned up (noteMissingChase).
export const ACTIVE_FILTER_MAX_STALE_PAGES = 3;

/** The relay's own times for the row (its clock): `updatedAt` and `lastActivityAt`. */
export function relayActivityMs(conversation) {
  if (!conversation || typeof conversation !== 'object') return 0;
  return Math.max(
    parseConversationTimeMs(conversation.updatedAt ?? conversation.updated_at),
    parseConversationTimeMs(conversation.lastActivityAt),
  );
}

/**
 * Remembers when this page first saw a relay time that lies in its future
 * (beyond ACTIVITY_CLOCK_SKEW_MS), on the record as `activityFirstSeen`;
 * forgets it once the time is no longer ahead. journal-view.js calls it for
 * every row it paints under 🔥.
 */
export function noteActivityFirstSeen(conversation, now = Date.now()) {
  if (!conversation || typeof conversation !== 'object') return;
  const relayAt = relayActivityMs(conversation);
  if (relayAt > now + ACTIVITY_CLOCK_SKEW_MS) {
    if (conversation.activityFirstSeen?.relayAt !== relayAt) conversation.activityFirstSeen = { relayAt, at: now };
  } else if (conversation.activityFirstSeen) {
    delete conversation.activityFirstSeen;
  }
}

/**
 * The newest activity time of a row in ms on this page's clock: the list's
 * `updatedAt`, the relay's `lastActivityAt` (sent while background work runs)
 * and `localActivityAt`, the page's own stamp from live turn and stream
 * events. A relay time more than ACTIVITY_CLOCK_SKEW_MS ahead counts as the
 * moment the page first saw it (or `now`, before that is noted), so a relay
 * clock that runs ahead does not keep a row active for the skew on top.
 */
export function conversationActivityMs(conversation, { now = Date.now() } = {}) {
  if (!conversation || typeof conversation !== 'object') return 0;
  const local = Number(conversation.localActivityAt);
  let relayAt = relayActivityMs(conversation);
  if (relayAt > now + ACTIVITY_CLOCK_SKEW_MS) {
    const seen = conversation.activityFirstSeen;
    relayAt = seen && seen.relayAt === relayAt && Number.isFinite(seen.at) ? seen.at : now;
  }
  return Math.max(relayAt, Number.isFinite(local) && local > 0 ? local : 0);
}

/** Recent: the last activity is less than `windowMs` old. */
export function isRecentlyActive(conversation, { now = Date.now(), windowMs = ACTIVE_WINDOW_MS } = {}) {
  const at = conversationActivityMs(conversation, { now });
  return at > 0 && now - at < windowMs;
}

/**
 * "Now" on the relay's clock, as well as the page can tell: its own clock,
 * or the newest relay time among the rows when that lies ahead of it. The
 * page cursor (a relay time) is measured against this, so a relay clock
 * that runs ahead does not keep the drain paging.
 */
export function estimateRelayNowMs(conversations, now = Date.now()) {
  let newest = now;
  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    const at = relayActivityMs(conversation);
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * One step of the chase for sessions known to be active but not on the
 * loaded pages (`missingCount` of them at the page cursor `cursorKey`).
 * A new cursor (a page loaded) in which the count did not fall below its
 * best counts as stale; `exhausted` after `maxStalePages` such pages, when
 * the caller stops chasing those ids (a card in an archived session, say,
 * which the live list never holds). The same cursor changes nothing.
 */
export function noteMissingChase(chase, { cursorKey = '', missingCount = 0, maxStalePages = ACTIVE_FILTER_MAX_STALE_PAGES } = {}) {
  const previous = chase && typeof chase === 'object' ? chase : null;
  const count = Math.max(0, Number(missingCount) || 0);
  if (count === 0) return { cursorKey, best: 0, stalePages: 0, exhausted: false };
  if (!previous) return { cursorKey, best: count, stalePages: 0, exhausted: false };
  if (previous.cursorKey === cursorKey) return { ...previous, exhausted: previous.stalePages >= maxStalePages };
  if (count < previous.best) return { cursorKey, best: count, stalePages: 0, exhausted: false };
  const stalePages = previous.stalePages + 1;
  return { cursorKey, best: previous.best, stalePages, exhausted: stalePages >= maxStalePages };
}

/**
 * Whether the row passes the 🔥 filter. `working` and `waiting` are the
 * caller's verdicts for conditions 1 and 3 (journal-view.js reads them from
 * the row state the list already computes).
 */
export function isConversationActive(conversation, {
  working = false,
  waiting = false,
  now = Date.now(),
  windowMs = ACTIVE_WINDOW_MS,
} = {}) {
  if (!conversation || conversation.archived === true) return false;
  return working === true || waiting === true || isRecentlyActive(conversation, { now, windowMs });
}

/**
 * Both filters together (AND): the title filter (`normalizedFilter`, from
 * normalizeConversationFilter) and, when `activeOnly`, the 🔥 one.
 * `isActive(row)` answers the latter.
 */
export function conversationPassesListFilters(conversation, {
  normalizedFilter = '',
  activeOnly = false,
  isActive = () => false,
} = {}) {
  if (!conversationMatchesFilter(conversation, normalizedFilter)) return false;
  return !activeOnly || isActive(conversation) === true;
}

/**
 * When the next row ages out of the window: the earliest `activity + windowMs`
 * still ahead of `now` among `conversations`, or 0 when none will. One timer
 * set for that moment replaces a poll; rows kept by conditions 1 or 3 change
 * with the events that move those.
 */
export function nextActiveWindowEdgeMs(conversations, { now = Date.now(), windowMs = ACTIVE_WINDOW_MS } = {}) {
  let next = 0;
  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    if (!conversation || conversation.archived === true) continue;
    const at = conversationActivityMs(conversation, { now });
    if (at <= 0) continue;
    const edge = at + windowMs;
    if (edge > now && (next === 0 || edge < next)) next = edge;
  }
  return next;
}

/**
 * Whether more pages have to load for the 🔥 filter to be complete. The list
 * comes newest first, so recent rows are on the loaded pages once the last
 * loaded row (`cursorTimeMs`, the page cursor's sort time) is older than the
 * window. Working and waiting rows can sit anywhere: `missingCount` counts
 * the ones known to be active (a waiting card, a working worker) not loaded
 * yet and still chased (noteMissingChase bounds that). `now` is the relay's
 * clock as estimateRelayNowMs reads it, since the cursor is a relay time.
 */
export function activeFilterNeedsMorePages({
  hasMore = false,
  cursorTimeMs = 0,
  missingCount = 0,
  now = Date.now(),
  windowMs = ACTIVE_WINDOW_MS,
} = {}) {
  if (!hasMore) return false;
  if (missingCount > 0) return true;
  const cursor = Number(cursorTimeMs) || 0;
  // No cursor time: nothing tells where the window ends, so keep loading.
  return cursor <= 0 || now - cursor < windowMs;
}

/** Only an explicit on is on: a missing or damaged value reads off. */
export function parseActiveFilterSetting(stored) {
  const value = String(stored ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

export function readActiveFilterSetting(store = globalThis.localStorage) {
  try {
    return parseActiveFilterSetting(store?.getItem(ACTIVE_FILTER_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function writeActiveFilterSetting(on, store = globalThis.localStorage) {
  try {
    store?.setItem(ACTIVE_FILTER_STORAGE_KEY, on ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

// The 🔥 button's accessible name. It stays the same: aria-pressed carries
// the state, the status region the count.
export const ACTIVE_FILTER_LABEL = 'Show active sessions only';

/** The 🔥 button's tooltip: what a click does, and while on, how many rows show. */
export function describeActiveFilterTitle(on, count = 0) {
  if (!on) return `${ACTIVE_FILTER_LABEL}: working, active in the last ${Math.round(ACTIVE_WINDOW_MS / 60000)} minutes, or waiting for you`;
  const n = Math.max(0, Number(count) || 0);
  return `Showing ${n} active session${n === 1 ? '' : 's'}; click to show all`;
}

/** The count on the 🔥 button: up to 99, then "99+"; nothing while off. */
export function activeFilterBadgeText(on, count = 0) {
  if (!on) return '';
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  return n > 99 ? '99+' : String(n);
}

export function describeActiveMatchCount(count, { loadedOnly = false } = {}) {
  const n = Math.max(0, Number(count) || 0);
  const noun = loadedOnly ? 'loaded active session' : 'active session';
  if (n === 0) return loadedOnly ? 'No loaded sessions are active' : 'Nothing active right now';
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}
