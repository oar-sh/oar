import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConversationFilter,
  conversationMatchesFilter,
  filterConversations,
  drainRemainingPages,
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
