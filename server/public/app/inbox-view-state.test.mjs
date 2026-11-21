import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INBOX_FOLDED_ITEMS_MAX,
  INBOX_LEGACY_FILTER_KEY,
  INBOX_VIEW_STORAGE_KEY,
  inboxItemKey,
  mergeInboxViewChange,
  normalizeInboxView,
  pruneInboxView,
  readInboxView,
  setItemsFolded,
  toggleInList,
  writeInboxView,
} from './inbox-view-state.mjs';

// What the Inbox and 📓 remember: one key, the old filter key read once,
// folds capped and forgotten with their items.

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map,
  };
}

const NOW = Date.parse('2026-03-02T12:00:00.000Z');
const recent = new Date(NOW - 5 * 60_000).toISOString();
const item = (id, group = null, extra = {}) => ({ id, kind: 'ask', status: 'pending', createdAt: recent, session: { id: `conv-${id}`, group }, ...extra });

test('a view as stored: defaults for what is missing or wrong', () => {
  assert.deepEqual(normalizeInboxView(null), { who: 'all', unanswered: false, thisRelay: false, groups: [], foldedSections: [], foldedItems: [] });
  assert.deepEqual(normalizeInboxView({ who: 'nobody', unanswered: 'yes', thisRelay: true, groups: ['a', 3, 'a', ''], groupsOpen: true }), {
    who: 'all', unanswered: false, thisRelay: true, groups: ['a'], foldedSections: [], foldedItems: [],
  });
});

test('the old filter key becomes `who` once and goes; the new key wins over it', () => {
  const storage = memoryStorage({ [INBOX_LEGACY_FILTER_KEY]: 'agents' });
  assert.equal(readInboxView(storage).who, 'agents');
  assert.equal(storage.getItem(INBOX_LEGACY_FILTER_KEY), null);
  assert.equal(JSON.parse(storage.getItem(INBOX_VIEW_STORAGE_KEY)).who, 'agents');
  assert.equal(readInboxView(storage).who, 'agents');
  const both = memoryStorage({ [INBOX_LEGACY_FILTER_KEY]: 'agents', [INBOX_VIEW_STORAGE_KEY]: JSON.stringify({ who: 'mine', unanswered: true }) });
  assert.deepEqual([readInboxView(both).who, readInboxView(both).unanswered], ['mine', true]);
  assert.equal(both.getItem(INBOX_LEGACY_FILTER_KEY), null);
  // Unreadable JSON: the defaults.
  assert.equal(readInboxView(memoryStorage({ [INBOX_VIEW_STORAGE_KEY]: '{nope' })).who, 'all');
  // What is written is the stored shape only.
  const written = memoryStorage();
  writeInboxView(written, { ...normalizeInboxView(null), groupsOpen: true, thisRelay: true });
  assert.deepEqual(Object.keys(JSON.parse(written.getItem(INBOX_VIEW_STORAGE_KEY))).sort(), ['foldedItems', 'foldedSections', 'groups', 'thisRelay', 'unanswered', 'who']);
});

test('folds: newest kept, at most 300; a toggle adds or takes out', () => {
  let view = normalizeInboxView(null);
  view = setItemsFolded(view, Array.from({ length: INBOX_FOLDED_ITEMS_MAX + 20 }, (_, index) => inboxItemKey('self', `a${index}`)), true);
  assert.equal(view.foldedItems.length, INBOX_FOLDED_ITEMS_MAX);
  assert.equal(view.foldedItems[0], 'self\na20', 'the oldest went');
  view = setItemsFolded(view, ['self\na20'], false);
  assert.equal(view.foldedItems.includes('self\na20'), false);
  assert.deepEqual(toggleInList(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(toggleInList(['b'], 'a'), ['b', 'a']);
  assert.deepEqual(toggleInList(['a'], 'a', true), ['a']);
  assert.equal(inboxItemKey('', 'x'), 'self\nx');
});

test('a load forgets folds, groups and sections no longer there; a relay that did not answer keeps its own', () => {
  const view = {
    ...normalizeInboxView(null),
    foldedItems: ['self\na1', 'self\ngone', 'r-lab\nl1', 'r-old\nx'],
    groups: ['self\ng1', 'self\ngone', 'r-lab\ng9'],
    foldedSections: ['self', 'r-lab', 'r-old', 'self\ng1', 'self\ngone', 'r-lab\ng9'],
  };
  const relays = [
    { id: 'self', self: true, items: [item('a1', { id: 'g1', name: 'Storage' })] },
    { id: 'r-lab', reachable: false, items: [] },
  ];
  const pruned = pruneInboxView(view, relays, { now: NOW });
  assert.deepEqual(pruned.foldedItems, ['self\na1', 'r-lab\nl1']);
  assert.deepEqual(pruned.groups, ['self\ng1', 'r-lab\ng9']);
  assert.deepEqual(pruned.foldedSections, ['self', 'r-lab', 'self\ng1', 'r-lab\ng9']);
  assert.equal(pruneInboxView(pruned, relays, { now: NOW }), pruned, 'nothing to forget: the same view');
});

test('a save applies only what changed here onto what another tab stored meanwhile', () => {
  const before = normalizeInboxView({ who: 'all', foldedItems: ['self\na1'], groups: ['self\ngrp-a'] });
  // Another tab folded b1 and turned Unanswered on since this one read the view.
  const stored = normalizeInboxView({ who: 'all', unanswered: true, foldedItems: ['self\na1', 'self\nb1'], groups: ['self\ngrp-a'] });
  // Here: c1 folded, a1 unfolded, Mine picked.
  const after = { ...before, who: 'mine', foldedItems: ['self\nc1'] };
  const merged = mergeInboxViewChange(stored, before, after);
  assert.equal(merged.who, 'mine');
  assert.equal(merged.unanswered, true, 'the other tab\'s filter stays');
  assert.deepEqual(merged.foldedItems, ['self\nb1', 'self\nc1']);
  assert.deepEqual(merged.groups, ['self\ngrp-a'], 'an untouched list is the stored one');
  // Nothing changed here: the stored view as it is.
  assert.deepEqual(mergeInboxViewChange(stored, before, before), stored);
});
