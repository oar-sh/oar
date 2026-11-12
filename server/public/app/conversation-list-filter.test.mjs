import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConversationFilter,
  conversationMatchesFilter,
  filterConversations,
  drainRemainingPages,
  describeFilterMatchCount,
  ACTIVE_WINDOW_MS,
  ACTIVE_FILTER_STORAGE_KEY,
  ACTIVE_FILTER_LABEL,
  ACTIVITY_CLOCK_SKEW_MS,
  ACTIVE_FILTER_MAX_STALE_PAGES,
  relayActivityMs,
  noteActivityFirstSeen,
  estimateRelayNowMs,
  noteMissingChase,
  conversationActivityMs,
  isRecentlyActive,
  isConversationActive,
  conversationPassesListFilters,
  nextActiveWindowEdgeMs,
  activeFilterNeedsMorePages,
  parseActiveFilterSetting,
  readActiveFilterSetting,
  writeActiveFilterSetting,
  describeActiveFilterTitle,
  activeFilterBadgeText,
  describeActiveMatchCount,
} from './conversation-list-filter.mjs';

test('normalizeConversationFilter trims and lowercases', () => {
  assert.equal(normalizeConversationFilter('  Vault  '), 'vault');
  assert.equal(normalizeConversationFilter('EXAMPLE.COM'), 'example.com');
  assert.equal(normalizeConversationFilter(''), '');
  assert.equal(normalizeConversationFilter('   '), '');
  assert.equal(normalizeConversationFilter(null), '');
  assert.equal(normalizeConversationFilter(undefined), '');
});

test('conversationMatchesFilter matches title substrings case-insensitively', () => {
  const conversation = { id: 'c1', title: 'OAR session bug' };
  assert.equal(conversationMatchesFilter(conversation, 'session'), true);
  assert.equal(conversationMatchesFilter(conversation, 'oar'), true);
  assert.equal(conversationMatchesFilter(conversation, 'bug'), true);
  assert.equal(conversationMatchesFilter(conversation, 'vault'), false);
});

test('conversationMatchesFilter treats an empty filter as match-all', () => {
  assert.equal(conversationMatchesFilter({ title: 'anything' }, ''), true);
  assert.equal(conversationMatchesFilter({}, ''), true);
});

test('conversationMatchesFilter tolerates missing or non-string titles', () => {
  assert.equal(conversationMatchesFilter({}, 'x'), false);
  assert.equal(conversationMatchesFilter(null, 'x'), false);
  assert.equal(conversationMatchesFilter({ title: null }, 'x'), false);
  assert.equal(conversationMatchesFilter({ title: 1234 }, '23'), true);
});

test('filterConversations returns the input list untouched for an empty filter', () => {
  const list = [{ title: 'a' }, { title: 'b' }];
  assert.equal(filterConversations(list, ''), list);
  assert.equal(filterConversations(list, '   '), list);
});

test('filterConversations filters by normalized title match', () => {
  const list = [
    { id: '1', title: 'New Conversation' },
    { id: '2', title: 'vault' },
    { id: '3', title: 'pg fluid' },
    { id: '4', title: 'UOH11B' },
  ];
  assert.deepEqual(filterConversations(list, '  VAULT ').map((c) => c.id), ['2']);
  assert.deepEqual(filterConversations(list, 'u').map((c) => c.id), ['2', '3', '4']);
  assert.deepEqual(filterConversations(list, 'zzz'), []);
});

test('filter matching normalizes Unicode composition on both sides', () => {
  const decomposed = 'Cafe\u0301 notes';
  const precomposed = 'Caf\u00e9 notes';
  assert.notEqual(decomposed, precomposed);
  assert.deepEqual(filterConversations([{ id: '1', title: decomposed }], 'CAF\u00c9').map((c) => c.id), ['1']);
  assert.deepEqual(filterConversations([{ id: '2', title: precomposed }], 'cafe\u0301').map((c) => c.id), ['2']);
  assert.equal(normalizeConversationFilter('  \u00c4rger  '), '\u00e4rger');
  assert.equal(conversationMatchesFilter({ title: 'A\u0308rger im Build' }, normalizeConversationFilter('\u00e4rger')), true);
});

test('describeFilterMatchCount pluralizes the announced result count', () => {
  assert.equal(describeFilterMatchCount(0), 'No conversations match');
  assert.equal(describeFilterMatchCount(1), '1 conversation matches');
  assert.equal(describeFilterMatchCount(7), '7 conversations match');
  assert.equal(describeFilterMatchCount(undefined), 'No conversations match');
  assert.equal(describeFilterMatchCount(0, { loadedOnly: true }), 'No loaded conversations match');
  assert.equal(describeFilterMatchCount(1, { loadedOnly: true }), '1 loaded conversation matches');
  assert.equal(describeFilterMatchCount(4, { loadedOnly: true }), '4 loaded conversations match');
});

test('filterConversations tolerates a non-array input', () => {
  assert.deepEqual(filterConversations(null, 'x'), []);
  assert.deepEqual(filterConversations(undefined, ''), []);
});

// pageResults holds one entry per loadMore() call; hasMore stays true until the
// scripted calls are exhausted (a false entry models a busy/failed attempt that
// does not consume a page).
function makeFakeLoader(pageResults) {
  let calls = 0;
  return {
    loader: {
      getState: () => ({ hasMore: calls < pageResults.length }),
      loadMore: async () => {
        const result = pageResults[calls];
        calls += 1;
        return result;
      },
    },
    callCount: () => calls,
  };
}

const instantRetry = { retryDelayMs: 0, delay: async () => {} };

test('drainRemainingPages drains until hasMore is exhausted', async () => {
  const { loader, callCount } = makeFakeLoader([true, true, true]);
  const loaded = await drainRemainingPages(loader, () => true, instantRetry);
  assert.equal(loaded, true);
  assert.equal(callCount(), 3);
});

test('drainRemainingPages stops when shouldContinue flips false', async () => {
  const { loader, callCount } = makeFakeLoader([true, true, true, true]);
  let allowed = 2;
  const loaded = await drainRemainingPages(loader, () => allowed-- > 0, instantRetry);
  assert.equal(loaded, true);
  assert.equal(callCount(), 2);
});

test('drainRemainingPages retries through busy loadMore attempts', async () => {
  // A concurrent boundary-check load/prefetch makes loadMore return false
  // without an error; the drain must ride that out rather than give up.
  const { loader, callCount } = makeFakeLoader([false, false, true, true]);
  const loaded = await drainRemainingPages(loader, () => true, instantRetry);
  assert.equal(loaded, true);
  assert.equal(callCount(), 4);
});

test('drainRemainingPages gives up after maxIdleRetries consecutive failures', async () => {
  let calls = 0;
  const loader = {
    getState: () => ({ hasMore: true }),
    loadMore: async () => {
      calls += 1;
      return false;
    },
  };
  const loaded = await drainRemainingPages(loader, () => true, { ...instantRetry, maxIdleRetries: 3 });
  assert.equal(loaded, false);
  assert.equal(calls, 4);
});

test('drainRemainingPages does nothing when there are no more pages', async () => {
  const { loader, callCount } = makeFakeLoader([]);
  const loaded = await drainRemainingPages(loader, () => true, instantRetry);
  assert.equal(loaded, false);
  assert.equal(callCount(), 0);
});

test('drainRemainingPages rejects loaders without the expected shape', async () => {
  assert.equal(await drainRemainingPages(null), false);
  assert.equal(await drainRemainingPages({}), false);
  assert.equal(await drainRemainingPages({ loadMore: async () => true }), false);
});

// Models the real loader's busy window: loadMore() returns false while a
// boundary-check fetch is in flight, and getState() reports isLoading until
// busyCalls attempts have passed, after which pages load normally.
function makeBusyLoader({ busyCalls, pages, busyFlag = 'isLoading' }) {
  let calls = 0;
  let loadedPages = 0;
  return {
    loader: {
      getState: () => ({
        hasMore: loadedPages < pages,
        nextCursor: { page: loadedPages },
        isLoading: busyFlag === 'isLoading' && calls < busyCalls,
        isPrefetching: busyFlag === 'isPrefetching' && calls < busyCalls,
      }),
      loadMore: async () => {
        calls += 1;
        if (calls <= busyCalls) return false;
        loadedPages += 1;
        return true;
      },
    },
    callCount: () => calls,
    loadedPages: () => loadedPages,
  };
}

test('drainRemainingPages does not spend idle retries while the loader is busy', async () => {
  for (const busyFlag of ['isLoading', 'isPrefetching']) {
    const fake = makeBusyLoader({ busyCalls: 25, pages: 2, busyFlag });
    const loaded = await drainRemainingPages(fake.loader, () => true, { ...instantRetry, maxIdleRetries: 3 });
    assert.equal(loaded, true, busyFlag);
    assert.equal(fake.loadedPages(), 2, busyFlag);
    assert.equal(fake.callCount(), 27, busyFlag);
  }
});

test('drainRemainingPages gives up on a loader that stays busy forever', async () => {
  let calls = 0;
  const loader = {
    getState: () => ({ hasMore: true, nextCursor: { page: 0 }, isLoading: true, isPrefetching: false }),
    loadMore: async () => {
      calls += 1;
      return false;
    },
  };
  const loaded = await drainRemainingPages(loader, () => true, { ...instantRetry, maxIdleRetries: 2, maxBusyRetries: 5 });
  assert.equal(loaded, false);
  assert.equal(calls, 6);
});

test('drainRemainingPages stops waiting on a busy loader once the filter is cleared', async () => {
  const fake = makeBusyLoader({ busyCalls: 1000, pages: 3 });
  let filterActive = true;
  let delays = 0;
  const loaded = await drainRemainingPages(fake.loader, () => filterActive, {
    retryDelayMs: 0,
    delay: async () => {
      delays += 1;
      if (delays === 4) filterActive = false;
    },
  });
  assert.equal(loaded, false);
  assert.equal(fake.callCount(), 4);
  assert.equal(fake.loadedPages(), 0);
});

test('drainRemainingPages treats an advanced cursor as progress even for an empty page', async () => {
  let cursor = 0;
  let calls = 0;
  const loader = {
    getState: () => ({ hasMore: cursor < 20, nextCursor: { page: cursor }, isLoading: false, isPrefetching: false }),
    loadMore: async () => {
      calls += 1;
      cursor += 1;
      return false;
    },
  };
  await drainRemainingPages(loader, () => true, { ...instantRetry, maxIdleRetries: 2 });
  assert.equal(calls, 20);
});

// ── 🔥 Active only ──

const NOW = Date.parse('2031-03-04T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const HOUR = 60 * 60 * 1000;

test('the active window is five minutes', () => {
  assert.equal(ACTIVE_WINDOW_MS, 5 * 60 * 1000);
});

test('conversationActivityMs takes the newest of updatedAt, lastActivityAt and the local stamp', () => {
  const at = { now: NOW };
  assert.equal(conversationActivityMs({ updatedAt: iso(HOUR) }, at), NOW - HOUR);
  assert.equal(conversationActivityMs({ updatedAt: iso(HOUR), lastActivityAt: iso(1000) }, at), NOW - 1000);
  assert.equal(conversationActivityMs({ updatedAt: iso(HOUR), localActivityAt: NOW - 5 }, at), NOW - 5);
  // SQLite's UTC form, as older payloads carry it.
  assert.equal(conversationActivityMs({ updated_at: '2031-03-04 11:59:00' }, at), NOW - 60_000);
  assert.equal(conversationActivityMs({}), 0);
  assert.equal(conversationActivityMs(null), 0);
  assert.equal(conversationActivityMs({ updatedAt: 'not a date', localActivityAt: 'x' }), 0);
});

test('clock skew: a relay time over a minute ahead counts from when the page first saw it', () => {
  const ahead = iso(-10 * 60 * 1000); // the relay's clock ten minutes ahead
  const row = { id: 's', updatedAt: ahead };
  assert.equal(relayActivityMs(row), NOW + 10 * 60 * 1000);
  // Before it is noted, it counts as now (never as the future).
  assert.equal(conversationActivityMs(row, { now: NOW }), NOW);
  noteActivityFirstSeen(row, NOW);
  assert.deepEqual(row.activityFirstSeen, { relayAt: NOW + 10 * 60 * 1000, at: NOW });
  // Noting again later keeps the first sighting.
  noteActivityFirstSeen(row, NOW + 60_000);
  assert.equal(row.activityFirstSeen.at, NOW);
  // It ages out five minutes after it was first seen, not skew + five minutes.
  assert.equal(isRecentlyActive(row, { now: NOW + ACTIVE_WINDOW_MS - 1 }), true);
  assert.equal(isRecentlyActive(row, { now: NOW + ACTIVE_WINDOW_MS }), false);
  assert.equal(nextActiveWindowEdgeMs([row], { now: NOW + 1000 }), NOW + ACTIVE_WINDOW_MS, 'the timer aims at the first-seen edge');
  // A new relay time (new activity) is a new sighting.
  row.updatedAt = iso(-20 * 60 * 1000);
  noteActivityFirstSeen(row, NOW + 2 * 60_000);
  assert.equal(row.activityFirstSeen.at, NOW + 2 * 60_000);
  // Within the tolerance a time ahead is taken as it is, and the note goes.
  const near = { id: 'n', updatedAt: iso(-(ACTIVITY_CLOCK_SKEW_MS - 1000)), activityFirstSeen: { relayAt: 1, at: 1 } };
  noteActivityFirstSeen(near, NOW);
  assert.equal(near.activityFirstSeen, undefined);
  assert.equal(conversationActivityMs(near, { now: NOW }), NOW + ACTIVITY_CLOCK_SKEW_MS - 1000);
});

test('estimateRelayNowMs: the newest relay time when it runs ahead of this clock', () => {
  assert.equal(estimateRelayNowMs([{ updatedAt: iso(HOUR) }], NOW), NOW);
  assert.equal(estimateRelayNowMs([{ updatedAt: iso(HOUR) }, { updatedAt: iso(-30 * 60 * 1000) }], NOW), NOW + 30 * 60 * 1000);
  assert.equal(estimateRelayNowMs(null, NOW), NOW);
  // With the relay half an hour ahead, a cursor 20 minutes "in the future"
  // is 10 minutes old on its clock: no more pages for the window.
  const relayNow = estimateRelayNowMs([{ updatedAt: iso(-30 * 60 * 1000) }], NOW);
  assert.equal(activeFilterNeedsMorePages({ hasMore: true, cursorTimeMs: NOW + 20 * 60 * 1000, now: relayNow }), false);
  assert.equal(activeFilterNeedsMorePages({ hasMore: true, cursorTimeMs: NOW + 20 * 60 * 1000, now: NOW }), true, 'measured on this clock it would page on');
});

test('noteMissingChase: given up after three pages in which the missing set did not shrink', () => {
  assert.equal(ACTIVE_FILTER_MAX_STALE_PAGES, 3);
  let chase = noteMissingChase(null, { cursorKey: 'p1', missingCount: 2 });
  assert.deepEqual(chase, { cursorKey: 'p1', best: 2, stalePages: 0, exhausted: false });
  // The same cursor (a re-render, no page loaded) changes nothing.
  chase = noteMissingChase(chase, { cursorKey: 'p1', missingCount: 2 });
  assert.equal(chase.stalePages, 0);
  chase = noteMissingChase(chase, { cursorKey: 'p2', missingCount: 1 });
  assert.deepEqual([chase.best, chase.stalePages, chase.exhausted], [1, 0, false], 'one turned up: progress');
  chase = noteMissingChase(chase, { cursorKey: 'p3', missingCount: 1 });
  chase = noteMissingChase(chase, { cursorKey: 'p4', missingCount: 1 });
  assert.deepEqual([chase.stalePages, chase.exhausted], [2, false]);
  chase = noteMissingChase(chase, { cursorKey: 'p5', missingCount: 1 });
  assert.deepEqual([chase.stalePages, chase.exhausted], [3, true], 'three pages without progress');
  assert.equal(noteMissingChase(chase, { cursorKey: 'p5', missingCount: 1 }).exhausted, true, 'stays exhausted at that cursor');
  // Nothing missing: a clean slate.
  assert.deepEqual(noteMissingChase(chase, { cursorKey: 'p6', missingCount: 0 }), { cursorKey: 'p6', best: 0, stalePages: 0, exhausted: false });
});

test('condition 1: a working row is active however old its last activity', () => {
  const row = { id: 'w', title: 'Working', updatedAt: iso(3 * HOUR) };
  assert.equal(isConversationActive(row, { now: NOW }), false);
  assert.equal(isConversationActive(row, { now: NOW, working: true }), true);
});

test('condition 2: the five-minute edge, both sides', () => {
  const inside = { id: 'r', updatedAt: iso(ACTIVE_WINDOW_MS - 1) };
  const atEdge = { id: 'e', updatedAt: iso(ACTIVE_WINDOW_MS) };
  const outside = { id: 'o', updatedAt: iso(ACTIVE_WINDOW_MS + 1) };
  assert.equal(isConversationActive(inside, { now: NOW }), true, '1 ms inside the window');
  assert.equal(isConversationActive(atEdge, { now: NOW }), false, 'exactly five minutes ago has aged out');
  assert.equal(isConversationActive(outside, { now: NOW }), false, '1 ms past the window');
  assert.equal(isRecentlyActive({ updatedAt: iso(0) }, { now: NOW }), true);
  // A local stamp from a live event keeps a row whose fetched time is old.
  assert.equal(isConversationActive({ updatedAt: iso(HOUR), localActivityAt: NOW - 60_000 }, { now: NOW }), true);
  // A row with no time at all is never recent.
  assert.equal(isRecentlyActive({ id: 'none' }, { now: NOW }), false);
  // The window is a parameter: a caller (or a later setting) can pass another.
  assert.equal(isConversationActive(outside, { now: NOW, windowMs: 10 * 60 * 1000 }), true);
});

test('condition 3: a row with a card waiting on the person is active however old', () => {
  const row = { id: 'q', updatedAt: iso(2 * HOUR) };
  assert.equal(isConversationActive(row, { now: NOW, waiting: true }), true);
  assert.equal(isConversationActive(row, { now: NOW, waiting: false }), false);
});

test('archived rows never pass the active filter, whatever holds', () => {
  const row = { id: 'a', archived: true, updatedAt: iso(1000) };
  assert.equal(isConversationActive(row, { now: NOW }), false);
  assert.equal(isConversationActive(row, { now: NOW, working: true, waiting: true }), false);
  assert.equal(isConversationActive(null, { now: NOW, working: true }), false);
  assert.equal(nextActiveWindowEdgeMs([row], { now: NOW }), 0, 'no timer for an archived row');
});

test('conversationPassesListFilters ANDs the title filter with the active filter', () => {
  const isActive = (row) => row.active === true;
  const rows = [
    { id: '1', title: 'Deploy pipeline', active: true },
    { id: '2', title: 'Deploy docs', active: false },
    { id: '3', title: 'Release notes', active: true },
  ];
  const pass = (options) => rows.filter((row) => conversationPassesListFilters(row, { isActive, ...options })).map((row) => row.id);
  assert.deepEqual(pass({}), ['1', '2', '3']);
  assert.deepEqual(pass({ normalizedFilter: 'deploy' }), ['1', '2']);
  assert.deepEqual(pass({ activeOnly: true }), ['1', '3']);
  assert.deepEqual(pass({ activeOnly: true, normalizedFilter: 'deploy' }), ['1']);
  assert.deepEqual(pass({ activeOnly: true, normalizedFilter: 'zzz' }), []);
});

test('nextActiveWindowEdgeMs names the earliest edge still ahead, or 0', () => {
  const rows = [
    { id: 'old', updatedAt: iso(HOUR) },
    { id: 'two', updatedAt: iso(2 * 60 * 1000) },
    { id: 'one', updatedAt: iso(60 * 1000) },
  ];
  assert.equal(nextActiveWindowEdgeMs(rows, { now: NOW }), NOW - 2 * 60 * 1000 + ACTIVE_WINDOW_MS);
  assert.equal(nextActiveWindowEdgeMs([{ id: 'old', updatedAt: iso(HOUR) }], { now: NOW }), 0);
  assert.equal(nextActiveWindowEdgeMs([{ id: 'edge', updatedAt: iso(ACTIVE_WINDOW_MS) }], { now: NOW }), 0, 'an edge that is now has passed');
  assert.equal(nextActiveWindowEdgeMs(null, { now: NOW }), 0);
});

test('activeFilterNeedsMorePages: until the pages pass the window and hold every known active session', () => {
  const base = { hasMore: true, now: NOW };
  assert.equal(activeFilterNeedsMorePages({ ...base, hasMore: false, missingCount: 3 }), false, 'nothing left to load');
  assert.equal(activeFilterNeedsMorePages({ ...base, cursorTimeMs: NOW - HOUR }), false, 'the loaded pages reach past the window');
  assert.equal(activeFilterNeedsMorePages({ ...base, cursorTimeMs: NOW - 60_000 }), true, 'the last loaded row is still recent');
  assert.equal(activeFilterNeedsMorePages({ ...base, cursorTimeMs: NOW - HOUR, missingCount: 1 }), true, 'a waiting or working session is not loaded yet');
  assert.equal(activeFilterNeedsMorePages({ ...base, cursorTimeMs: 0 }), true, 'no cursor time: keep loading');
});

test('the active filter setting: only an explicit on is on', () => {
  for (const value of ['1', 'true', ' TRUE ']) assert.equal(parseActiveFilterSetting(value), true, value);
  for (const value of ['0', 'false', '', null, undefined, 'yes', '{}']) assert.equal(parseActiveFilterSetting(value), false, String(value));
});

test('the active filter setting persists in the given storage under its own key', () => {
  const map = new Map();
  const store = { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)) };
  assert.equal(readActiveFilterSetting(store), false, 'off until switched on');
  assert.equal(writeActiveFilterSetting(true, store), true);
  assert.equal(map.get(ACTIVE_FILTER_STORAGE_KEY), '1');
  assert.equal(readActiveFilterSetting(store), true);
  writeActiveFilterSetting(false, store);
  assert.equal(map.get(ACTIVE_FILTER_STORAGE_KEY), '0');
  assert.equal(readActiveFilterSetting(store), false);
  assert.equal(ACTIVE_FILTER_STORAGE_KEY.startsWith('copilot_conv_'), true, 'named like the other list preferences');
});

test('the active filter setting survives a storage that throws', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readActiveFilterSetting(broken), false);
  assert.equal(writeActiveFilterSetting(true, broken), false);
  assert.equal(readActiveFilterSetting(null), false);
});

test('the 🔥 button texts: a fixed name, a tooltip and a count only while on', () => {
  assert.equal(ACTIVE_FILTER_LABEL, 'Show active sessions only');
  assert.match(describeActiveFilterTitle(false), /^Show active sessions only: .*5 minutes/);
  assert.equal(describeActiveFilterTitle(true, 1), 'Showing 1 active session; click to show all');
  assert.equal(describeActiveFilterTitle(true, 4), 'Showing 4 active sessions; click to show all');
  assert.equal(activeFilterBadgeText(false, 7), '');
  assert.equal(activeFilterBadgeText(true, 0), '0');
  assert.equal(activeFilterBadgeText(true, 7), '7');
  assert.equal(activeFilterBadgeText(true, 120), '99+');
  assert.equal(describeActiveMatchCount(0), 'Nothing active right now');
  assert.equal(describeActiveMatchCount(1), '1 active session');
  assert.equal(describeActiveMatchCount(3), '3 active sessions');
  assert.equal(describeActiveMatchCount(2, { loadedOnly: true }), '2 loaded active sessions');
  assert.equal(describeActiveMatchCount(0, { loadedOnly: true }), 'No loaded sessions are active');
});
