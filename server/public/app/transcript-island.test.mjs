import assert from 'node:assert/strict';
import test from 'node:test';

import { createHeldBackLiveRows, newerPageReachesEnd } from './transcript-island.mjs';

test('rows held back are counted once each, for the window they wait for', () => {
  const rows = createHeldBackLiveRows();
  assert.equal(rows.note('conv-river', 'row-7'), 1);
  assert.equal(rows.note('conv-river', 'row-7'), 1);
  assert.equal(rows.note('conv-river', 'row-8'), 2);
  // A row without an id still counts.
  assert.equal(rows.note('conv-river', ''), 3);
  assert.equal(rows.count('conv-river'), 3);
  assert.deepEqual(rows.ids('conv-river'), ['row-7', 'row-8']);
  assert.equal(rows.count('conv-meadow'), 0);
  assert.deepEqual(rows.ids('conv-meadow'), []);
  // No conversation, nothing held.
  assert.equal(rows.note('', 'row-9'), 0);
});

test('a window that meets the end, or another conversation, lets them go', () => {
  const rows = createHeldBackLiveRows();
  rows.note('conv-river', 'row-7');
  assert.equal(rows.follow({ conversationId: 'conv-river', atTail: false }), false);
  assert.equal(rows.count('conv-river'), 1);
  assert.equal(rows.follow({ conversationId: 'conv-river', atTail: true }), true);
  assert.equal(rows.count('conv-river'), 0);
  assert.equal(rows.follow({ conversationId: 'conv-river', atTail: true }), false);
  rows.note('conv-river', 'row-8');
  assert.equal(rows.follow({ conversationId: 'conv-meadow', atTail: false }), true);
  assert.equal(rows.count('conv-river'), 0);
  // A row for a conversation not followed starts that one's list.
  rows.note('conv-river', 'row-9');
  assert.equal(rows.count('conv-river'), 1);
  assert.equal(rows.count('conv-meadow'), 0);
});

test('a last page reaches the end only when it brings every row held back', () => {
  assert.equal(newerPageReachesEnd({ pageHasMore: true, pageMessageIds: ['a'], heldBackIds: [] }), false);
  assert.equal(newerPageReachesEnd({ pageHasMore: false, pageMessageIds: ['a', 'b'], heldBackIds: ['b'] }), true);
  // Fetched before the row was written: one more page.
  assert.equal(newerPageReachesEnd({ pageHasMore: false, pageMessageIds: ['a'], heldBackIds: ['b'] }), false);
  // On the page already.
  assert.equal(newerPageReachesEnd({ pageHasMore: false, pageMessageIds: ['a'], heldBackIds: ['b'], renderedIds: ['b'] }), true);
  // An empty page ends it: the missing row was deleted.
  assert.equal(newerPageReachesEnd({ pageHasMore: false, pageMessageIds: [], heldBackIds: ['b'] }), true);
  assert.equal(newerPageReachesEnd(), true);
});
