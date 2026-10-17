import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_DROP,
  autoScrollStep,
  describeDragItems,
  dragItemKey,
  dropAnnouncement,
  groupMoveStep,
  resolveDropTarget,
} from './conversation-group-drag.mjs';
import { arrangeConversationList } from './conversation-group-order.mjs';

// The fixture list, top to bottom (names invented):
//   head   c-lead   (group g-alpha, open)  members c-m1, c-m2, c-m3
//   loose  c-solo-a
//   head   g-beta   (synthetic, open)      members c-b1, c-b2
//   head   c-folded (group g-gamma, folded) members c-g1 (hidden)
//   loose  c-solo-b
const items = [
  { key: 'c-lead', kind: 'head', conversationId: 'c-lead', groupId: 'g-alpha', open: true, memberIds: ['c-m1', 'c-m2', 'c-m3'] },
  { key: 'c-m1', kind: 'member', conversationId: 'c-m1', groupId: 'g-alpha' },
  { key: 'c-m2', kind: 'member', conversationId: 'c-m2', groupId: 'g-alpha' },
  { key: 'c-m3', kind: 'member', conversationId: 'c-m3', groupId: 'g-alpha' },
  { key: 'c-solo-a', kind: 'row', conversationId: 'c-solo-a', groupId: null },
  { key: 'group:g-beta', kind: 'head', conversationId: null, groupId: 'g-beta', open: true, memberIds: ['c-b1', 'c-b2'] },
  { key: 'c-b1', kind: 'member', conversationId: 'c-b1', groupId: 'g-beta' },
  { key: 'c-b2', kind: 'member', conversationId: 'c-b2', groupId: 'g-beta' },
  { key: 'c-folded', kind: 'head', conversationId: 'c-folded', groupId: 'g-gamma', open: false, memberIds: ['c-g1'] },
  { key: 'c-solo-b', kind: 'row', conversationId: 'c-solo-b', groupId: null },
];

const at = (draggedId, key, y) => resolveDropTarget({ items, draggedId, hover: { key, y } });
const brief = (result) => [result.action, result.groupId, result.beforeConversationId, result.indicator && `${result.indicator.itemId}:${result.indicator.edge}`];

test('the item key is the conversation id, or group:<id> for a synthetic head', () => {
  assert.equal(dragItemKey({ conversationId: 'c-x', groupId: 'g-y' }), 'c-x');
  assert.equal(dragItemKey({ conversationId: null, groupId: 'g-y' }), 'group:g-y');
});

test('the plain items come from the arranged list: kinds, groups, fold and member order', () => {
  const rows = [
    { id: 'c-lead', updatedAt: '2031-05-01T10:00:00Z', groupId: 'g-alpha' },
    { id: 'c-m1', updatedAt: '2031-05-03T10:00:00Z', groupId: 'g-alpha' },
    { id: 'c-m2', updatedAt: '2031-05-02T10:00:00Z', groupId: 'g-alpha' },
    { id: 'c-loose', updatedAt: '2031-04-01T10:00:00Z' },
    { id: 'c-hand', updatedAt: '2031-03-01T10:00:00Z', groupId: 'g-hand' },
  ];
  const groups = {
    'g-alpha': { id: 'g-alpha', parentConversationId: 'c-lead' },
    'g-hand': { id: 'g-hand', parentConversationId: null },
  };
  const arranged = arrangeConversationList(rows, groups, { isOpen: (groupId) => groupId === 'g-alpha' });
  assert.deepEqual(describeDragItems(arranged), [
    { key: 'c-lead', kind: 'head', conversationId: 'c-lead', groupId: 'g-alpha', open: true, memberIds: ['c-m1', 'c-m2'] },
    { key: 'c-m1', kind: 'member', conversationId: 'c-m1', groupId: 'g-alpha' },
    { key: 'c-m2', kind: 'member', conversationId: 'c-m2', groupId: 'g-alpha' },
    { key: 'c-loose', kind: 'row', conversationId: 'c-loose', groupId: null },
    { key: 'group:g-hand', kind: 'head', conversationId: null, groupId: 'g-hand', open: false, memberIds: ['c-hand'] },
  ]);
  assert.deepEqual(describeDragItems(null), []);
  assert.deepEqual(describeDragItems([null, { kind: 'footer' }, { kind: 'row', conversation: {} }]), []);
});

test('nothing to do: no hover, an unknown row or target, the row itself', () => {
  assert.deepEqual(resolveDropTarget({ items, draggedId: 'c-m1', hover: null }), NO_DROP);
  assert.deepEqual(resolveDropTarget({ items, draggedId: 'c-nowhere', hover: { key: 'c-m2', y: 0.1 } }), NO_DROP);
  assert.deepEqual(resolveDropTarget({ items, draggedId: '', hover: { key: 'c-m2', y: 0.1 } }), NO_DROP);
  assert.deepEqual(at('c-m1', 'c-gone', 0.1), NO_DROP);
  for (const y of [0, 0.3, 0.5, 0.9, 1]) {
    assert.deepEqual(at('c-m2', 'c-m2', y), NO_DROP, `member on itself at ${y}`);
    assert.deepEqual(at('c-solo-a', 'c-solo-a', y), NO_DROP, `loose row on itself at ${y}`);
    assert.deepEqual(at('c-lead', 'c-lead', y), NO_DROP, `head on itself at ${y}`);
  }
});

test('a member over another member of its group: before it in the upper half, after it in the lower half', () => {
  // c-m3 to the top half of c-m1: before c-m1.
  assert.deepEqual(brief(at('c-m3', 'c-m1', 0.1)), ['reorder', 'g-alpha', 'c-m1', 'c-m1:before']);
  assert.deepEqual(brief(at('c-m3', 'c-m1', 0.4)), ['reorder', 'g-alpha', 'c-m1', 'c-m1:before']);
  // Lower half of c-m1: before the one after it (c-m2).
  assert.deepEqual(brief(at('c-m3', 'c-m1', 0.5)), ['reorder', 'g-alpha', 'c-m2', 'c-m1:after']);
  assert.deepEqual(brief(at('c-m3', 'c-m1', 0.9)), ['reorder', 'g-alpha', 'c-m2', 'c-m1:after']);
  // c-m1 below the last member: to the end.
  assert.deepEqual(brief(at('c-m1', 'c-m3', 0.8)), ['reorder', 'g-alpha', null, 'c-m3:after']);
  assert.deepEqual(brief(at('c-m1', 'c-m3', 0.2)), ['reorder', 'g-alpha', 'c-m3', 'c-m3:before']);
  // Out-of-range heights are clamped.
  assert.deepEqual(brief(at('c-m3', 'c-m1', -3)), ['reorder', 'g-alpha', 'c-m1', 'c-m1:before']);
  assert.deepEqual(brief(at('c-m1', 'c-m3', 7)), ['reorder', 'g-alpha', null, 'c-m3:after']);
  assert.deepEqual(brief(at('c-m3', 'c-m1', 'not a number')), ['reorder', 'g-alpha', 'c-m1', 'c-m1:before']);
});

test('a member dropped where it already is does nothing', () => {
  // Right after the row before it, or right before the row after it.
  assert.deepEqual(at('c-m2', 'c-m1', 0.8), NO_DROP);
  assert.deepEqual(at('c-m2', 'c-m3', 0.2), NO_DROP);
  // The last member after the second to last, or onto the end below itself.
  assert.deepEqual(at('c-m3', 'c-m2', 0.9), NO_DROP);
  // The first member below its own head (to the top) is where it is.
  assert.deepEqual(at('c-m1', 'c-lead', 0.9), NO_DROP);
  // But one place further moves.
  assert.deepEqual(brief(at('c-m1', 'c-m2', 0.9)), ['reorder', 'g-alpha', 'c-m3', 'c-m2:after']);
  assert.deepEqual(brief(at('c-m3', 'c-m2', 0.1)), ['reorder', 'g-alpha', 'c-m2', 'c-m2:before']);
});

test('a member over its own head: the lower half moves it to the top, the upper half does nothing', () => {
  assert.deepEqual(brief(at('c-m3', 'c-lead', 0.7)), ['reorder', 'g-alpha', 'c-m1', 'c-lead:after']);
  assert.deepEqual(at('c-m3', 'c-lead', 0.3), NO_DROP);
  // Same over a synthetic head.
  assert.deepEqual(brief(at('c-b2', 'group:g-beta', 0.9)), ['reorder', 'g-beta', 'c-b1', 'group:g-beta:after']);
  assert.deepEqual(at('c-b2', 'group:g-beta', 0.1), NO_DROP);
  assert.deepEqual(at('c-b1', 'group:g-beta', 0.9), NO_DROP, 'already first');
});

test('a head never moves within its own group', () => {
  for (const key of ['c-m1', 'c-m2', 'c-m3']) {
    for (const y of [0, 0.3, 0.6, 1]) assert.deepEqual(at('c-lead', key, y), NO_DROP, `${key} at ${y}`);
  }
});

test('a row from elsewhere over a member joins that group at that place', () => {
  // A loose row.
  assert.deepEqual(brief(at('c-solo-a', 'c-m2', 0.1)), ['join', 'g-alpha', 'c-m2', 'c-m2:before']);
  assert.deepEqual(brief(at('c-solo-a', 'c-m2', 0.6)), ['join', 'g-alpha', 'c-m3', 'c-m2:after']);
  assert.deepEqual(brief(at('c-solo-b', 'c-b2', 0.9)), ['join', 'g-beta', null, 'c-b2:after']);
  // A member of another group.
  assert.deepEqual(brief(at('c-b1', 'c-m1', 0.2)), ['join', 'g-alpha', 'c-m1', 'c-m1:before']);
  // A head of another group (its old group is left headless).
  assert.deepEqual(brief(at('c-lead', 'c-b1', 0.8)), ['join', 'g-beta', 'c-b2', 'c-b1:after']);
  assert.deepEqual(brief(at('c-folded', 'c-m3', 0.9)), ['join', 'g-alpha', null, 'c-m3:after']);
});

test('a row from elsewhere over a head: the lower half of an open head is the top of the group, else the end', () => {
  assert.deepEqual(brief(at('c-solo-a', 'c-lead', 0.6)), ['join', 'g-alpha', 'c-m1', 'c-lead:after']);
  assert.deepEqual(brief(at('c-solo-a', 'c-lead', 0.4)), ['join', 'g-alpha', null, 'c-lead:inside']);
  assert.deepEqual(brief(at('c-solo-a', 'c-lead', 0)), ['join', 'g-alpha', null, 'c-lead:inside']);
  // A synthetic head works the same.
  assert.deepEqual(brief(at('c-m2', 'group:g-beta', 0.75)), ['join', 'g-beta', 'c-b1', 'group:g-beta:after']);
  assert.deepEqual(brief(at('c-m2', 'group:g-beta', 0.25)), ['join', 'g-beta', null, 'group:g-beta:inside']);
  // A folded head: always the end, the members are not on screen.
  for (const y of [0, 0.3, 0.6, 1]) {
    assert.deepEqual(brief(at('c-solo-b', 'c-folded', y)), ['join', 'g-gamma', null, 'c-folded:inside'], `folded at ${y}`);
  }
  // A head carrying its group into another one.
  assert.deepEqual(brief(at('c-lead', 'c-folded', 0.5)), ['join', 'g-gamma', null, 'c-folded:inside']);
});

test('an open head without members takes a drop at the end', () => {
  const lone = [
    { key: 'group:g-empty', kind: 'head', conversationId: null, groupId: 'g-empty', open: true, memberIds: [] },
    { key: 'c-x', kind: 'row', conversationId: 'c-x', groupId: null },
  ];
  const result = resolveDropTarget({ items: lone, draggedId: 'c-x', hover: { key: 'group:g-empty', y: 0.9 } });
  assert.deepEqual(brief(result), ['join', 'g-empty', null, 'group:g-empty:inside']);
});

test('a loose row onto the middle of another loose row makes a group of the two; the edges do nothing', () => {
  const middle = at('c-solo-b', 'c-solo-a', 0.5);
  assert.deepEqual(middle, {
    action: 'new-group',
    groupId: null,
    beforeConversationId: null,
    indicator: { itemId: 'c-solo-a', edge: 'inside' },
    targetConversationId: 'c-solo-a',
  });
  assert.equal(at('c-solo-b', 'c-solo-a', 0.25).action, 'new-group', 'the band includes 25 %');
  assert.equal(at('c-solo-b', 'c-solo-a', 0.75).action, 'new-group', 'and 75 %');
  for (const y of [0, 0.1, 0.24, 0.76, 0.9, 1]) assert.deepEqual(at('c-solo-b', 'c-solo-a', y), NO_DROP, `edge at ${y}`);
});

test('a grouped row over a loose row leaves its group, at either edge and in the middle', () => {
  assert.deepEqual(brief(at('c-m2', 'c-solo-a', 0.1)), ['leave', null, null, 'c-solo-a:before']);
  assert.deepEqual(brief(at('c-m2', 'c-solo-a', 0.5)), ['leave', null, null, 'c-solo-a:after']);
  assert.deepEqual(brief(at('c-m2', 'c-solo-a', 0.9)), ['leave', null, null, 'c-solo-a:after']);
  // A head leaves too; its group goes on headless.
  assert.deepEqual(brief(at('c-lead', 'c-solo-b', 0.4)), ['leave', null, null, 'c-solo-b:before']);
});

test('below the last item a grouped row leaves its group; a loose row stays', () => {
  const below = (draggedId) => resolveDropTarget({ items, draggedId, hover: { below: true } });
  assert.deepEqual(brief(below('c-b1')), ['leave', null, null, 'c-solo-b:after']);
  assert.deepEqual(brief(below('c-lead')), ['leave', null, null, 'c-solo-b:after']);
  assert.deepEqual(below('c-solo-a'), NO_DROP);
});

test('Move up and Move down give the place before which the row lands; the ends cannot pass', () => {
  const members = ['c-m1', 'c-m2', 'c-m3'];
  assert.equal(groupMoveStep(members, 'c-m1', 'up'), null);
  assert.deepEqual(groupMoveStep(members, 'c-m1', 'down'), { beforeConversationId: 'c-m3' });
  assert.deepEqual(groupMoveStep(members, 'c-m2', 'up'), { beforeConversationId: 'c-m1' });
  assert.deepEqual(groupMoveStep(members, 'c-m2', 'down'), { beforeConversationId: null });
  assert.deepEqual(groupMoveStep(members, 'c-m3', 'up'), { beforeConversationId: 'c-m2' });
  assert.equal(groupMoveStep(members, 'c-m3', 'down'), null);
  assert.equal(groupMoveStep(members, 'c-other', 'up'), null);
  assert.equal(groupMoveStep(members, 'c-m2', 'sideways'), null);
  assert.equal(groupMoveStep(null, 'c-m2', 'up'), null);
  assert.equal(groupMoveStep(['c-only'], 'c-only', 'up'), null);
  assert.equal(groupMoveStep(['c-only'], 'c-only', 'down'), null);
});

test('auto-scroll runs near the edges only, faster toward them, and at full speed past them', () => {
  const top = 100;
  const bottom = 700;
  assert.equal(autoScrollStep(400, top, bottom), 0, 'middle');
  assert.equal(autoScrollStep(top + 48, top, bottom), 0, 'just outside the top zone');
  assert.equal(autoScrollStep(bottom - 48, top, bottom), 0, 'just outside the bottom zone');
  assert.equal(autoScrollStep(top + 47, top, bottom), -1, 'barely inside: the slowest step');
  assert.equal(autoScrollStep(bottom - 47, top, bottom), 1);
  const nearTop = autoScrollStep(top + 10, top, bottom);
  const nearerTop = autoScrollStep(top + 2, top, bottom);
  assert.ok(nearTop < 0 && nearerTop < nearTop, `speeds up toward the top: ${nearTop}, ${nearerTop}`);
  assert.equal(autoScrollStep(top, top, bottom), -18);
  assert.equal(autoScrollStep(top - 50, top, bottom), -18, 'past the edge: full speed');
  assert.equal(autoScrollStep(bottom + 50, top, bottom), 18);
  assert.equal(autoScrollStep(bottom, top, bottom, { maxStep: 30 }), 30);
  // A list shorter than both zones splits at its middle.
  assert.equal(autoScrollStep(110, 100, 150), -Math.ceil(18 * (15 / 25) ** 2));
  assert.equal(autoScrollStep(140, 100, 150), Math.ceil(18 * (15 / 25) ** 2));
  // Nothing to scroll without a box or a pointer.
  assert.equal(autoScrollStep(NaN, top, bottom), 0);
  assert.equal(autoScrollStep(100, 100, 100), 0);
});

test('the announcement names the row and where it went', () => {
  assert.equal(dropAnnouncement('join', { title: 'Parser fix', groupName: 'Night batch' }), 'Moved “Parser fix” to “Night batch”');
  assert.equal(dropAnnouncement('reorder', { title: 'Parser fix', groupName: 'Night batch' }), 'Moved “Parser fix” within “Night batch”');
  assert.equal(dropAnnouncement('leave', { title: 'Parser fix' }), 'Removed “Parser fix” from its group');
  assert.equal(dropAnnouncement('new-group', { title: 'Parser fix', otherTitle: 'Lint pass' }), 'New group with “Lint pass” and “Parser fix”');
  assert.equal(dropAnnouncement('leave', { title: '  ' }), 'Removed “Untitled” from its group');
  assert.equal(dropAnnouncement('none', { title: 'Parser fix' }), '');
});
