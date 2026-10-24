import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { migrateConversationGroups } from '../migrations/0014-conversation-groups.mjs';
import {
  createConversationGroupRepository,
  normalizeGroupName,
  resolveGroupDisplayName,
} from './conversation-group-repository.mjs';

const NOW = '2026-10-13T10:00:00.000Z';

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const insert = db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`);
  const conv = (id, title = id, at = NOW) => insert.run(id, title, at, at);
  const groupOf = (id) => db.prepare(`SELECT group_id FROM conversations WHERE id = ?`).get(id)?.group_id || null;
  const positionOf = (id) => db.prepare(`SELECT group_position FROM conversations WHERE id = ?`).get(id)?.group_position ?? null;
  return { db, repo: createConversationGroupRepository(db), conv, groupOf, positionOf };
}

test('a creator without a group gets one with itself as head; its later children join it', () => {
  const { repo, conv, groupOf } = setup();
  conv('conv-lead', 'Release notes lead');
  conv('conv-child-1');
  conv('conv-child-2');
  const groupId = repo.attachCreatedConversation('conv-child-1', 'conv-lead', NOW);
  assert.ok(groupId);
  assert.equal(groupOf('conv-lead'), groupId);
  assert.equal(groupOf('conv-child-1'), groupId);
  assert.equal(repo.getGroup(groupId).parentConversationId, 'conv-lead');
  assert.equal(repo.getGroup(groupId).name, null);
  assert.equal(repo.attachCreatedConversation('conv-child-2', 'conv-lead', NOW), groupId);
  assert.deepEqual(repo.membersOf(groupId).map((m) => m.id).sort(), ['conv-child-1', 'conv-child-2', 'conv-lead']);
});

test('a creator in a hand-made group passes that group on; a missing creator leaves the child ungrouped', () => {
  const { repo, conv, groupOf } = setup();
  conv('conv-a');
  conv('conv-b');
  conv('conv-child');
  const group = repo.createGroup({ name: 'Sample batch', conversationIds: ['conv-a', 'conv-b'] }, NOW);
  assert.equal(group.parentConversationId, null);
  assert.equal(repo.attachCreatedConversation('conv-child', 'conv-a', NOW), group.id);
  assert.equal(groupOf('conv-child'), group.id);
  conv('conv-orphan');
  assert.equal(repo.attachCreatedConversation('conv-orphan', 'conv-gone', NOW), null);
  assert.equal(groupOf('conv-orphan'), null);
});

test('moving a head out freezes its title as the name and leaves the group headless; the last member out removes it', () => {
  const { repo, conv, groupOf } = setup();
  conv('conv-lead', 'Catalog import');
  conv('conv-child');
  const groupId = repo.attachCreatedConversation('conv-child', 'conv-lead', NOW);
  assert.deepEqual(repo.setMembership('conv-lead', null, NOW), { ok: true, changed: true, groupId: null, previousGroupId: groupId });
  const headless = repo.getGroup(groupId);
  assert.equal(headless.parentConversationId, null);
  assert.equal(headless.name, 'Catalog import');
  assert.equal(groupOf('conv-lead'), null);
  assert.deepEqual(repo.setMembership('conv-child', null, NOW), { ok: true, changed: true, groupId: null, previousGroupId: groupId });
  assert.equal(repo.getGroup(groupId), null);
});

test('a hand-set name survives the head leaving; renaming to empty returns to the head title', () => {
  const { repo, conv } = setup();
  conv('conv-lead', 'Catalog import');
  conv('conv-child');
  const groupId = repo.attachCreatedConversation('conv-child', 'conv-lead', NOW);
  assert.equal(repo.renameGroup(groupId, '  Night   batch  ', NOW).name, 'Night batch');
  repo.forgetConversation('conv-lead', NOW);
  assert.equal(repo.getGroup(groupId).name, 'Night batch');
  assert.equal(repo.renameGroup(groupId, '', NOW).name, null);
  assert.equal(resolveGroupDisplayName({ name: null, headTitle: null }), 'Group');
  assert.equal(resolveGroupDisplayName({ name: null, headTitle: 'Catalog import' }), 'Catalog import');
  assert.equal(normalizeGroupName('x'.repeat(80)).length, 60);
});

test('a conversation moves between groups, the source goes when empty, and dissolve frees every member', () => {
  const { repo, conv, groupOf } = setup();
  conv('conv-a');
  conv('conv-b');
  conv('conv-c');
  const first = repo.createGroup({ name: 'First', conversationIds: ['conv-a'] }, NOW);
  const second = repo.createGroup({ name: 'Second', conversationIds: ['conv-b', 'conv-c'] }, NOW);
  assert.deepEqual(repo.setMembership('conv-a', second.id, NOW), { ok: true, changed: true, groupId: second.id, previousGroupId: first.id });
  assert.equal(repo.getGroup(first.id), null);
  assert.deepEqual(repo.setMembership('conv-a', second.id, NOW), { ok: true, changed: false, groupId: second.id, previousGroupId: second.id });
  assert.deepEqual(repo.setMembership('conv-a', 'grp_missing', NOW), { ok: false, error: 'group-not-found' });
  assert.deepEqual(repo.setMembership('conv-missing', second.id, NOW), { ok: false, error: 'conversation-not-found' });
  assert.equal(repo.dissolveGroup(second.id), true);
  assert.equal(groupOf('conv-a'), null);
  assert.equal(groupOf('conv-b'), null);
  assert.equal(repo.getGroup(second.id), null);
});

test('deleting the head freezes the name; compaction carries the group and the head role; the sweep removes empty groups', () => {
  const { db, repo, conv, groupOf } = setup();
  conv('conv-lead', 'Catalog import');
  conv('conv-child');
  const groupId = repo.attachCreatedConversation('conv-child', 'conv-lead', NOW);
  conv('conv-lead-2', 'Catalog import (compacted)');
  assert.equal(repo.carryToCompacted('conv-lead', 'conv-lead-2', NOW), groupId);
  assert.equal(groupOf('conv-lead-2'), groupId);
  assert.equal(repo.getGroup(groupId).parentConversationId, 'conv-lead-2');
  assert.equal(repo.forgetConversation('conv-lead-2', NOW), groupId);
  assert.equal(repo.getGroup(groupId).parentConversationId, null);
  assert.equal(repo.getGroup(groupId).name, 'Catalog import (compacted)');
  // The compacted source stays a member (archived); only deleted rows free the group.
  assert.equal(repo.sweepEmpty(), 0);
  db.prepare(`UPDATE conversations SET status = 'deleted' WHERE id IN ('conv-child', 'conv-lead')`).run();
  assert.equal(repo.sweepEmpty(), 1);
  assert.equal(repo.getGroup(groupId), null);
});

test('repair: a tombstoned head leaves its group with the title frozen to the cap; an absent row keeps its link; empty groups go', () => {
  const { db, repo, conv } = setup();
  conv('conv-lead', 'L'.repeat(79));
  conv('conv-child');
  const groupId = repo.attachCreatedConversation('conv-child', 'conv-lead', NOW);
  conv('conv-lead-2', 'Other lead');
  conv('conv-child-2');
  const other = repo.attachCreatedConversation('conv-child-2', 'conv-lead-2', NOW);
  conv('conv-alone');
  const empty = repo.createGroup({ name: 'Empty soon', conversationIds: ['conv-alone'] }, NOW);
  // A delete path that does not know groups: one head tombstoned, one row
  // simply gone (a cache wipe, which froze the name first), one member gone.
  db.prepare(`UPDATE conversations SET status = 'deleted' WHERE id = 'conv-lead'`).run();
  assert.equal(repo.freezeNamesForHeads(['conv-lead-2'], NOW), 1);
  db.prepare(`DELETE FROM conversations WHERE id IN ('conv-lead-2', 'conv-alone')`).run();
  assert.deepEqual(repo.repair(NOW), { headsDetached: 1, groupsRemoved: 1 });
  assert.equal(repo.getGroup(groupId).parentConversationId, null);
  assert.equal(repo.getGroup(groupId).name, 'L'.repeat(60));
  assert.equal(repo.getGroup(other).parentConversationId, 'conv-lead-2', 'the link waits for a re-import');
  assert.equal(repo.getGroup(other).name, 'Other lead');
  assert.equal(repo.getGroup(empty.id), null);
  assert.deepEqual(repo.repair(NOW), { headsDetached: 0, groupsRemoved: 0 });
  // A rename after a frozen title stays within the cap.
  assert.equal(repo.renameGroup(groupId, 'Short', NOW).name, 'Short');
  // What the change event carries.
  assert.deepEqual(repo.describeGroup(other), { id: other, name: 'Other lead', displayName: 'Other lead', parentConversationId: 'conv-lead-2', memberCount: 1, liveMemberCount: 1, keptEmptyAt: null });
  assert.deepEqual(repo.membershipsOf(['conv-child-2', 'conv-lead-2', 'conv-nobody']), { 'conv-child-2': { groupId: other, role: 'member' }, 'conv-lead-2': null, 'conv-nobody': null });
});

test('listGroupsByIds skips unknown ids and a schema without the migration sees no groups', () => {
  const { repo, conv } = setup();
  conv('conv-a');
  const group = repo.createGroup({ conversationIds: ['conv-a'] }, NOW);
  const map = repo.listGroupsByIds([group.id, 'grp_missing', '', group.id]);
  assert.deepEqual([...map.keys()], [group.id]);
  const bare = new Database(':memory:');
  bare.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const off = createConversationGroupRepository(bare);
  assert.equal(off.enabled, false);
  assert.equal(off.attachCreatedConversation('a', 'b'), null);
  assert.deepEqual(off.setMembership('a', null), { ok: false, error: 'groups-unavailable' });
});

const at = (minute) => `2026-10-13T10:${String(minute).padStart(2, '0')}:00.000Z`;

test('a drag gives the group a hand order: before a row, onto itself, to the end, in from outside, and out again', () => {
  const { repo, conv, groupOf, positionOf } = setup();
  conv('conv-a', 'Chat A', at(1));
  conv('conv-b', 'Chat B', at(2));
  conv('conv-c', 'Chat C', at(3));
  conv('conv-new', 'Chat new', at(4));
  conv('conv-outsider', 'Chat outsider', at(5));
  const group = repo.createGroup({ name: 'Sample batch', conversationIds: ['conv-a', 'conv-b', 'conv-c'] }, NOW);
  // Nobody ordered it yet: newest first, no positions.
  assert.deepEqual(repo.orderOf(group.id), ['conv-c', 'conv-b', 'conv-a']);
  assert.deepEqual(repo.membersOf(group.id).map((m) => m.groupPosition), [null, null, null]);

  assert.deepEqual(repo.moveConversation('conv-a', { groupId: group.id, beforeConversationId: 'conv-c' }, NOW),
    { ok: true, changed: true, groupId: group.id, previousGroupId: group.id, order: ['conv-a', 'conv-c', 'conv-b'] });
  assert.deepEqual(['conv-a', 'conv-c', 'conv-b'].map(positionOf), [10, 20, 30]);
  assert.deepEqual(repo.membersOf(group.id).map((m) => [m.id, m.groupPosition]), [['conv-a', 10], ['conv-c', 20], ['conv-b', 30]]);
  // Before itself: nothing moves.
  assert.deepEqual(repo.moveConversation('conv-a', { groupId: group.id, beforeConversationId: 'conv-a' }, NOW),
    { ok: true, changed: false, groupId: group.id, previousGroupId: group.id, order: ['conv-a', 'conv-c', 'conv-b'] });
  // To the end.
  assert.deepEqual(repo.moveConversation('conv-c', { groupId: group.id }, NOW).order, ['conv-a', 'conv-b', 'conv-c']);
  assert.deepEqual(['conv-a', 'conv-b', 'conv-c'].map(positionOf), [10, 20, 30]);
  // In from outside, before a member.
  assert.deepEqual(repo.moveConversation('conv-new', { groupId: group.id, beforeConversationId: 'conv-b' }, NOW),
    { ok: true, changed: true, groupId: group.id, previousGroupId: null, order: ['conv-a', 'conv-new', 'conv-b', 'conv-c'] });
  assert.deepEqual(['conv-a', 'conv-new', 'conv-b', 'conv-c'].map(positionOf), [10, 20, 30, 40]);
  // A "before" row that is not in the group: the end.
  assert.deepEqual(repo.moveConversation('conv-a', { groupId: group.id, beforeConversationId: 'conv-outsider' }, NOW).order,
    ['conv-new', 'conv-b', 'conv-c', 'conv-a']);
  // Out again: the position goes with the membership.
  assert.deepEqual(repo.moveConversation('conv-new', { groupId: null }, NOW),
    { ok: true, changed: true, groupId: null, previousGroupId: group.id, order: [] });
  assert.equal(groupOf('conv-new'), null);
  assert.equal(positionOf('conv-new'), null);
  assert.deepEqual(repo.moveConversation('conv-new', { groupId: null }, NOW),
    { ok: true, changed: false, groupId: null, previousGroupId: null, order: [] });
  assert.deepEqual(repo.positionsOf(['conv-b', 'conv-new', 'conv-nobody']), { 'conv-b': 20, 'conv-new': null, 'conv-nobody': null });
  assert.deepEqual(repo.moveConversation('conv-missing', { groupId: group.id }, NOW), { ok: false, error: 'conversation-not-found' });
  assert.deepEqual(repo.moveConversation('conv-a', { groupId: 'grp_missing' }, NOW), { ok: false, error: 'group-not-found' });
});

test('a drag between groups numbers the target and removes a source left empty', () => {
  const { repo, conv, groupOf, positionOf } = setup();
  conv('conv-a', 'Chat A', at(1));
  conv('conv-b', 'Chat B', at(2));
  conv('conv-c', 'Chat C', at(3));
  const first = repo.createGroup({ name: 'First', conversationIds: ['conv-a'] }, NOW);
  const second = repo.createGroup({ name: 'Second', conversationIds: ['conv-b', 'conv-c'] }, NOW);
  assert.deepEqual(repo.moveConversation('conv-a', { groupId: second.id, beforeConversationId: 'conv-b' }, NOW),
    { ok: true, changed: true, groupId: second.id, previousGroupId: first.id, order: ['conv-c', 'conv-a', 'conv-b'] });
  assert.equal(repo.getGroup(first.id), null);
  assert.equal(groupOf('conv-a'), second.id);
  assert.deepEqual(['conv-c', 'conv-a', 'conv-b'].map(positionOf), [10, 20, 30]);
  // Into a hand-ordered group from another one, and the rest of the source keeps its order.
  conv('conv-d', 'Chat D', at(4));
  conv('conv-e', 'Chat E', at(5));
  const third = repo.createGroup({ name: 'Third', conversationIds: ['conv-d', 'conv-e'] }, NOW);
  repo.moveConversation('conv-d', { groupId: third.id, beforeConversationId: 'conv-e' }, NOW);
  assert.deepEqual(repo.moveConversation('conv-e', { groupId: second.id, beforeConversationId: null }, NOW).order,
    ['conv-c', 'conv-a', 'conv-b', 'conv-e']);
  assert.deepEqual(repo.orderOf(third.id), ['conv-d']);
  assert.equal(positionOf('conv-d'), 10);
});

test('the head stays first: it cannot be reordered, a drop before it lands first after it, and moving it out freezes the name', () => {
  const { repo, conv, positionOf } = setup();
  conv('conv-lead', 'Catalog import', at(1));
  conv('conv-child-1', 'Chat one', at(2));
  conv('conv-child-2', 'Chat two', at(3));
  const groupId = repo.attachCreatedConversation('conv-child-1', 'conv-lead', NOW);
  repo.attachCreatedConversation('conv-child-2', 'conv-lead', NOW);
  assert.deepEqual(repo.orderOf(groupId), ['conv-lead', 'conv-child-2', 'conv-child-1']);
  assert.deepEqual(repo.moveConversation('conv-lead', { groupId, beforeConversationId: null }, NOW),
    { ok: true, changed: false, groupId, previousGroupId: groupId, order: ['conv-lead', 'conv-child-2', 'conv-child-1'] });
  assert.equal(positionOf('conv-lead'), null);
  assert.deepEqual(repo.moveConversation('conv-child-1', { groupId, beforeConversationId: 'conv-lead' }, NOW).order,
    ['conv-lead', 'conv-child-1', 'conv-child-2']);
  assert.deepEqual(['conv-lead', 'conv-child-1', 'conv-child-2'].map(positionOf), [null, 10, 20]);
  assert.deepEqual(repo.membersOf(groupId).map((m) => m.id), ['conv-lead', 'conv-child-1', 'conv-child-2']);
  assert.deepEqual(repo.moveConversation('conv-lead', { groupId: null }, NOW),
    { ok: true, changed: true, groupId: null, previousGroupId: groupId, order: [] });
  assert.equal(repo.getGroup(groupId).parentConversationId, null);
  assert.equal(repo.getGroup(groupId).name, 'Catalog import');
});

test('arrivals join the end of a hand order, else stay unplaced; leaving, dissolving clear; compaction carries the place', () => {
  const { repo, conv, groupOf, positionOf } = setup();
  conv('conv-lead', 'Catalog import', at(1));
  conv('conv-child-1', 'Chat one', at(2));
  conv('conv-child-2', 'Chat two', at(3));
  const groupId = repo.attachCreatedConversation('conv-child-1', 'conv-lead', NOW);
  // Not ordered by hand yet: an agent's new child stays unplaced.
  repo.attachCreatedConversation('conv-child-2', 'conv-lead', NOW);
  assert.equal(positionOf('conv-child-2'), null);
  repo.moveConversation('conv-child-1', { groupId, beforeConversationId: 'conv-child-2' }, NOW);
  assert.deepEqual(['conv-child-1', 'conv-child-2'].map(positionOf), [10, 20]);
  // An agent's new child, and a row moved in by the menu, join at the end.
  conv('conv-child-3', 'Chat three', at(9));
  repo.attachCreatedConversation('conv-child-3', 'conv-lead', NOW);
  assert.equal(positionOf('conv-child-3'), 30);
  conv('conv-menu', 'Chat by menu', at(8));
  assert.equal(repo.setMembership('conv-menu', groupId, NOW).changed, true);
  assert.equal(positionOf('conv-menu'), 40);
  assert.deepEqual(repo.orderOf(groupId), ['conv-lead', 'conv-child-1', 'conv-child-2', 'conv-child-3', 'conv-menu']);
  // The menu into a group nobody ordered: unplaced.
  conv('conv-x', 'Chat X', at(4));
  conv('conv-y', 'Chat Y', at(5));
  const plain = repo.createGroup({ name: 'Plain', conversationIds: ['conv-x'] }, NOW);
  repo.setMembership('conv-y', plain.id, NOW);
  assert.deepEqual(['conv-x', 'conv-y'].map(positionOf), [null, null]);
  // Leaving by the menu clears the place.
  repo.setMembership('conv-menu', null, NOW);
  assert.equal(positionOf('conv-menu'), null);
  // Compaction: the new row takes the old one's place.
  conv('conv-child-2b', 'Chat two (compacted)', at(10));
  assert.equal(repo.carryToCompacted('conv-child-2', 'conv-child-2b', NOW), groupId);
  assert.equal(positionOf('conv-child-2b'), 20);
  assert.equal(groupOf('conv-child-2'), groupId, 'the old row stays in the group');
  assert.equal(positionOf('conv-child-2'), null, 'without the place it handed on');
  // Dissolving clears every place.
  assert.equal(repo.dissolveGroup(groupId), true);
  for (const id of ['conv-lead', 'conv-child-1', 'conv-child-2', 'conv-child-2b', 'conv-child-3']) {
    assert.equal(groupOf(id), null);
    assert.equal(positionOf(id), null);
  }
});

test('a schema without the position column moves membership only, in the activity order', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  migrateConversationGroups(db);
  const insert = db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`);
  insert.run('conv-a', 'Chat A', at(1), at(1));
  insert.run('conv-b', 'Chat B', at(2), at(2));
  insert.run('conv-c', 'Chat C', at(3), at(3));
  const repo = createConversationGroupRepository(db);
  assert.equal(repo.enabled, true);
  const group = repo.createGroup({ conversationIds: ['conv-a', 'conv-b'] }, NOW);
  assert.deepEqual(repo.moveConversation('conv-c', { groupId: group.id, beforeConversationId: 'conv-a' }, NOW),
    { ok: true, changed: true, groupId: group.id, previousGroupId: null, order: ['conv-c', 'conv-b', 'conv-a'] });
  assert.equal(repo.moveConversation('conv-a', { groupId: group.id, beforeConversationId: 'conv-c' }, NOW).changed, false);
  assert.deepEqual(repo.membersOf(group.id).map((m) => m.groupPosition), [null, null, null]);
  assert.equal(repo.setMembership('conv-a', null, NOW).changed, true);
  assert.deepEqual(repo.positionsOf(['conv-b', 'conv-a']), { 'conv-b': null, 'conv-a': null });
  const bare = new Database(':memory:');
  bare.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const off = createConversationGroupRepository(bare);
  assert.deepEqual(off.moveConversation('a', { groupId: null }), { ok: false, error: 'groups-unavailable' });
  assert.deepEqual(off.orderOf('grp_x'), []);
});

test('listGroups lists every group with display name and member count, newest first', () => {
  const { db, repo, conv } = setup();
  conv('conv-lead', 'Catalog import', at(1));
  conv('conv-child', 'child', at(2));
  conv('conv-a', 'a', at(5));
  conv('conv-b', 'b', at(3));
  conv('conv-gone', 'gone', at(9));
  const headed = repo.attachCreatedConversation('conv-child', 'conv-lead', NOW);
  const named = repo.createGroup({ name: 'Sample batch', conversationIds: ['conv-a', 'conv-b', 'conv-gone'] }, NOW);
  db.prepare(`UPDATE conversations SET status = 'deleted' WHERE id = 'conv-gone'`).run();
  assert.deepEqual(repo.listGroups(), [
    { id: named.id, name: 'Sample batch', memberCount: 2 },
    // A group nobody named shows its head's title, dressed as the list does.
    { id: headed, name: 'Catalog import', memberCount: 2 },
  ]);
  assert.equal(repo.listGroups({ headTitle: (title) => `${title}!` })[1].name, 'Catalog import!');
  // Only what an agent may see.
  for (const group of repo.listGroups()) assert.deepEqual(Object.keys(group).sort(), ['id', 'memberCount', 'name']);
  // A group without a live member is not listed.
  db.prepare(`UPDATE conversations SET status = 'deleted' WHERE id IN ('conv-a', 'conv-b')`).run();
  assert.deepEqual(repo.listGroups().map((group) => group.id), [headed]);
});

test('listGroups is empty without the migration', () => {
  const bare = new Database(':memory:');
  bare.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  assert.deepEqual(createConversationGroupRepository(bare).listGroups(), []);
});
