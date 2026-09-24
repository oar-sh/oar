import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConversationFilter,
  conversationMatchesFilter,
  filterConversations,
  drainRemainingPages,
  describeFilterMatchCount,
} from './conversation-list-filter.mjs';

test('normalizeConversationFilter trims and lowercases', () => {
  assert.equal(normalizeConversationFilter('  Vault  '), 'vault');
  assert.equal(normalizeConversationFilter('MRL.CX'), 'mrl.cx');
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
