import test from 'node:test';
import assert from 'node:assert/strict';

import {
  arrangeConversationList,
  compareGroupMembers,
  conversationGroupPosition,
  conversationGroupRole,
  groupActivityTimes,
  orderConversationRows,
  pageConversationRows,
  parseConversationTimeMs,
} from './conversation-group-order.mjs';

const at = (minute) => `2026-10-13T10:${String(minute).padStart(2, '0')}:00.000Z`;
const row = (id, minute, groupId = null) => ({ id, updatedAt: at(minute), groupId });
const GROUPS = {
  grp_a: { id: 'grp_a', parentConversationId: 'lead-a' },
  grp_b: { id: 'grp_b', parentConversationId: 'lead-b' },
  grp_hand: { id: 'grp_hand', parentConversationId: null, name: 'Sample batch' },
};

test('a group sorts by its newest row, head first, members newest first, ungrouped rows between', () => {
  const rows = [
    row('lead-a', 10, 'grp_a'),
    row('child-a1', 30, 'grp_a'),
    row('child-a2', 20, 'grp_a'),
    row('solo', 25),
    row('lead-b', 15, 'grp_b'),
    row('child-b1', 5, 'grp_b'),
    row('hand-1', 1, 'grp_hand'),
  ];
  assert.deepEqual(orderConversationRows(rows, GROUPS).map((r) => r.id),
    ['lead-a', 'child-a1', 'child-a2', 'solo', 'lead-b', 'child-b1', 'hand-1']);
  assert.equal(groupActivityTimes(rows).get('grp_a'), parseConversationTimeMs(at(30)));
  assert.equal(conversationGroupRole(rows[0], GROUPS), 'head');
  assert.equal(conversationGroupRole(rows[1], GROUPS), 'member');
  assert.equal(conversationGroupRole(rows[3], GROUPS), null);
});

test('the Archived view takes the archived rows\' times: the same group can sit elsewhere there', () => {
  const live = [row('lead-a', 10, 'grp_a'), row('child-a1', 30, 'grp_a'), row('solo', 25)];
  const archived = [row('child-a2', 2, 'grp_a'), row('old-solo', 3)];
  assert.deepEqual(orderConversationRows(live, GROUPS).map((r) => r.id), ['lead-a', 'child-a1', 'solo']);
  assert.deepEqual(orderConversationRows(archived, GROUPS).map((r) => r.id), ['old-solo', 'child-a2']);
});

test('a page never splits a group, and the cursor continues after it', () => {
  const rows = [
    row('lead-a', 10, 'grp_a'),
    row('child-a1', 30, 'grp_a'),
    row('child-a2', 20, 'grp_a'),
    row('solo', 25),
    row('lead-b', 15, 'grp_b'),
    row('child-b1', 5, 'grp_b'),
  ];
  const first = pageConversationRows(rows, GROUPS, { limit: 2 });
  assert.deepEqual(first.rows.map((r) => r.id), ['lead-a', 'child-a1', 'child-a2']);
  assert.equal(first.pageInfo.hasMore, true);
  assert.deepEqual(first.pageInfo.nextCursor, { beforeConversationId: 'child-a2', beforeUpdatedAt: at(30), beforeGroupId: 'grp_a' });
  const second = pageConversationRows(rows, GROUPS, { limit: 2, ...first.pageInfo.nextCursor });
  assert.deepEqual(second.rows.map((r) => r.id), ['solo', 'lead-b', 'child-b1']);
  assert.equal(second.pageInfo.hasMore, false);
  // The cursor row is gone: its time and group still place the next page,
  // and the group it stood in comes again whole (a caller drops the repeats).
  const afterDelete = pageConversationRows(rows.filter((r) => r.id !== 'child-a2'), GROUPS, { limit: 5, ...first.pageInfo.nextCursor });
  assert.deepEqual(afterDelete.rows.map((r) => r.id), ['lead-a', 'child-a1', 'solo', 'lead-b', 'child-b1']);
  // Ungrouped rows page as before.
  const plain = pageConversationRows([row('x', 3), row('y', 2), row('z', 1)], null, { limit: 2 });
  assert.deepEqual(plain.rows.map((r) => r.id), ['x', 'y']);
  assert.deepEqual(plain.pageInfo, { hasMore: true, nextCursor: { beforeConversationId: 'y', beforeUpdatedAt: at(2) } });
  assert.deepEqual(pageConversationRows([row('x', 3), row('y', 2), row('z', 1)], null, { limit: 2, beforeConversationId: 'y', beforeUpdatedAt: at(2) }).rows.map((r) => r.id), ['z']);
});

test('arrange: heads, members while open, synthetic heads, and the open conversation', () => {
  const rows = [
    row('lead-a', 10, 'grp_a'),
    row('child-a1', 30, 'grp_a'),
    row('solo', 25),
    row('hand-1', 1, 'grp_hand'),
  ];
  const open = arrangeConversationList(rows, GROUPS);
  assert.deepEqual(open.map((item) => `${item.kind}:${item.conversation?.id || '-'}`),
    ['head:lead-a', 'member:child-a1', 'row:solo', 'head:-', 'member:hand-1']);
  assert.equal(open[0].group.members.length, 1);
  assert.equal(open[3].group.info.name, 'Sample batch');
  const folded = arrangeConversationList(rows, GROUPS, { isOpen: () => false });
  assert.deepEqual(folded.map((item) => `${item.kind}:${item.conversation?.id || '-'}`), ['head:lead-a', 'row:solo', 'head:-']);
  assert.equal(folded[0].group.open, false);
});

test('arrange with a filter: a matching member shows its head as context; a matching head shows the group whole', () => {
  const rows = [
    { ...row('lead-a', 10, 'grp_a'), title: 'Release lead' },
    { ...row('child-a1', 30, 'grp_a'), title: 'Docs pass' },
    { ...row('child-a2', 20, 'grp_a'), title: 'Tests pass' },
    { ...row('solo', 25), title: 'Docs for the site' },
    { ...row('hand-1', 1, 'grp_hand'), title: 'Old import' },
  ];
  const matchesDocs = (r) => /docs/i.test(r.title);
  const byMember = arrangeConversationList(rows, GROUPS, { isOpen: () => false, matches: matchesDocs });
  assert.deepEqual(byMember.map((item) => `${item.kind}:${item.conversation?.id || '-'}`), ['head:lead-a', 'member:child-a1', 'row:solo']);
  assert.equal(byMember[0].group.contextOnly, true);
  assert.equal(byMember[0].group.open, true);
  const byHead = arrangeConversationList(rows, GROUPS, { matches: (r) => /release/i.test(r.title) });
  assert.deepEqual(byHead.map((item) => `${item.kind}:${item.conversation?.id || '-'}`), ['head:lead-a', 'member:child-a1', 'member:child-a2']);
  assert.equal(byHead[0].group.contextOnly, false);
  const byName = arrangeConversationList(rows, GROUPS, {
    matches: () => false,
    groupNameMatches: (info) => /sample/i.test(info?.name || ''),
  });
  assert.deepEqual(byName.map((item) => `${item.kind}:${item.conversation?.id || '-'}`), ['head:-', 'member:hand-1']);
});

test('a cursor row that vanished inside a group: the next page serves that group again, whole, then the rest', () => {
  const rows = [
    row('lead-a', 10, 'grp_a'),
    row('child-a1', 30, 'grp_a'),
    row('child-a2', 20, 'grp_a'),
    row('solo', 25),
    row('lead-b', 15, 'grp_b'),
  ];
  const first = pageConversationRows(rows, GROUPS, { limit: 2 });
  assert.deepEqual(first.rows.map((r) => r.id), ['lead-a', 'child-a1', 'child-a2']);
  assert.deepEqual(first.pageInfo.nextCursor, { beforeConversationId: 'child-a2', beforeUpdatedAt: at(30), beforeGroupId: 'grp_a' });
  // A caller that stopped on child-a2 (mid-group) and finds it gone: with the
  // group named, the group comes again whole; without it the rest of the
  // group was lost (the group's key sorts after the row's id).
  const remaining = rows.filter((r) => r.id !== 'child-a2');
  const withGroup = pageConversationRows(remaining, GROUPS, { limit: 10, beforeConversationId: 'child-a2', beforeUpdatedAt: at(30), beforeGroupId: 'grp_a' });
  assert.deepEqual(withGroup.rows.map((r) => r.id), ['lead-a', 'child-a1', 'solo', 'lead-b']);
  const withoutGroup = pageConversationRows(remaining, GROUPS, { limit: 10, beforeConversationId: 'child-a2', beforeUpdatedAt: at(30) });
  assert.deepEqual(withoutGroup.rows.map((r) => r.id), ['solo', 'lead-b'], 'the old fallback loses the rest of the group');
});

test('a hand order inside a group: head first, placed members by position, the others newest first; groups still sort by activity', () => {
  const placed = (id, minute, groupId, groupPosition) => ({ ...row(id, minute, groupId), groupPosition });
  const rows = [
    row('lead-a', 10, 'grp_a'),
    placed('child-a1', 30, 'grp_a', 20),
    placed('child-a2', 5, 'grp_a', 10),
    row('child-a3', 40, 'grp_a'),
    row('child-a4', 35, 'grp_a'),
    row('solo', 38),
    // A position on the snake_case column as the server's rows carry it.
    { id: 'hand-1', updated_at: at(1), group_id: 'grp_hand', group_position: 20 },
    { id: 'hand-2', updated_at: at(2), group_id: 'grp_hand', group_position: 10 },
  ];
  assert.deepEqual(orderConversationRows(rows, GROUPS).map((r) => r.id),
    ['lead-a', 'child-a2', 'child-a1', 'child-a3', 'child-a4', 'solo', 'hand-2', 'hand-1']);
  const items = arrangeConversationList(rows, GROUPS);
  assert.deepEqual(items[0].group.members.map((r) => r.id), ['child-a2', 'child-a1', 'child-a3', 'child-a4']);
  // A page still ends at the group's end.
  const page = pageConversationRows(rows, GROUPS, { limit: 2 });
  assert.deepEqual(page.rows.map((r) => r.id), ['lead-a', 'child-a2', 'child-a1', 'child-a3', 'child-a4']);
  assert.equal(page.pageInfo.nextCursor.beforeConversationId, 'child-a4');
  assert.equal(conversationGroupPosition({ groupPosition: 30 }), 30);
  assert.equal(conversationGroupPosition({ group_position: '40' }), 40);
  assert.equal(conversationGroupPosition({ groupPosition: null }), null);
  assert.equal(conversationGroupPosition({}), null);
  // Equal positions fall back to time, then id.
  assert.ok(compareGroupMembers(placed('x', 2, 'grp_a', 10), placed('y', 1, 'grp_a', 10)) < 0);
  assert.ok(compareGroupMembers(placed('x', 1, 'grp_a', 10), placed('y', 1, 'grp_a', 10)) > 0);
});

test('a cursor row moved up inside its group: the next page starts after the whole group', () => {
  const rows = [
    row('solo-new', 50),
    { ...row('child-a1', 40, 'grp_a'), groupPosition: 5 },
    row('lead-a', 10, 'grp_a'),
    { ...row('child-a2', 30, 'grp_a'), groupPosition: 10 },
    row('solo-old', 5),
  ];
  // The page ended with child-a1, then the group's last row; it has since
  // been moved to the top of the group.
  const next = pageConversationRows(rows, GROUPS, { limit: 2, beforeConversationId: 'child-a1' });
  assert.deepEqual(next.rows.map((entry) => entry.id), ['solo-old']);
  // A loose cursor row still continues right after itself.
  assert.deepEqual(pageConversationRows(rows, GROUPS, { limit: 1, beforeConversationId: 'solo-new' }).rows.map((entry) => entry.id), ['lead-a', 'child-a1', 'child-a2']);
});

test('an owner\'s group an agent emptied shows as an empty head, placed by when it was emptied', () => {
  const groups = {
    ...GROUPS,
    grp_kept: { id: 'grp_kept', parentConversationId: null, name: 'Kept batch', keptEmptyAt: at(22), memberCount: 0 },
    grp_old: { id: 'grp_old', parentConversationId: null, name: null, keptEmptyAt: at(1), memberCount: 0 },
  };
  const rows = [row('solo-new', 30), row('lead-a', 20, 'grp_a'), row('child-a1', 21, 'grp_a'), row('solo-old', 5)];
  // Off by default: the list shows rows and the groups they are in.
  assert.equal(arrangeConversationList(rows, groups).some((item) => item.group?.empty), false);
  const items = arrangeConversationList(rows, groups, { emptyGroups: true });
  assert.deepEqual(items.map((item) => item.conversation?.id || `[${item.group.id}]`), ['solo-new', '[grp_kept]', 'lead-a', 'child-a1', 'solo-old', '[grp_old]']);
  const kept = items.find((item) => item.group?.id === 'grp_kept');
  assert.equal(kept.kind, 'head');
  assert.equal(kept.conversation, null);
  assert.equal(kept.group.empty, true);
  assert.deepEqual(kept.group.members, []);
  // A kept group that has a row again is an ordinary group.
  const back = arrangeConversationList([...rows, row('joined', 12, 'grp_kept')], groups, { emptyGroups: true });
  assert.equal(back.filter((item) => item.group?.id === 'grp_kept' && item.kind === 'head').length, 1);
  assert.equal(back.some((item) => item.group?.empty && item.group.id === 'grp_kept'), false);
  // Under a filter only when its name matches; Maps work as well.
  const filtered = arrangeConversationList(rows, new Map(Object.entries(groups)), {
    emptyGroups: true,
    matches: () => false,
    groupNameMatches: (info) => /kept/i.test(info?.name || ''),
  });
  assert.deepEqual(filtered.map((item) => item.group?.id), ['grp_kept']);
});
