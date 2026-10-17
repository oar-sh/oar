import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createConversationGroupRepository } from '../repositories/conversation-group-repository.mjs';
import { createDeleteArchiveService } from './delete-archive-service.mjs';
import { createCacheRebuildService } from './cache-rebuild-service.mjs';

// The two delete paths outside the conversation routes, with the session
// groups wired in: the startup retry of a delete (a head tombstoned when the
// relay died) and the cache rebuild's full wipe (every non-hand-titled row
// goes, and the head may be imported again under its id). Titles invented.

const NOW = '2026-10-13T10:00:00.000Z';

function boot() {
  const db = new Database(':memory:');
  applySchema(db);
  const insert = db.prepare(`INSERT INTO conversations (id, title, title_source, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`);
  const conv = (id, title, titleSource = 'auto') => insert.run(id, title, titleSource, NOW, NOW);
  const groups = createConversationGroupRepository(db);
  return { db, conv, groups };
}

test('the startup delete retry frees a tombstoned head: the group stays headless under the frozen title', async () => {
  const { db, conv, groups } = boot();
  conv('conv-lead', 'Release lead');
  conv('conv-child', 'Docs pass');
  const groupId = groups.attachCreatedConversation('conv-child', 'conv-lead', NOW);
  // The delete marked the head and the relay died before the rows went.
  db.prepare(`UPDATE conversations SET status = 'deleted', updated_at = ? WHERE id = 'conv-lead'`).run(NOW);
  const service = createDeleteArchiveService(db, null, { conversationGroups: groups });
  const result = await service.retryPendingDeletesOnStartup();
  assert.equal(result.pendingCount, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE id = 'conv-lead'`).get().n, 0);
  assert.deepEqual([groups.getGroup(groupId).parentConversationId, groups.getGroup(groupId).name], [null, 'Release lead']);
  assert.deepEqual(groups.membersOf(groupId).map((m) => m.id), ['conv-child']);
});

test('a full cache wipe keeps the surviving group named and linked; the re-imported head takes it up again', () => {
  const { db, conv, groups } = boot();
  conv('conv-lead', 'Release lead');
  conv('conv-child', 'Docs pass', 'manual');
  conv('conv-other', 'Lone chat');
  conv('conv-gone-child', 'Tests pass');
  const groupId = groups.attachCreatedConversation('conv-child', 'conv-lead', NOW);
  groups.attachCreatedConversation('conv-gone-child', 'conv-lead', NOW);
  const otherGroup = groups.createGroup({ conversationIds: ['conv-other'] }, NOW);
  const service = createCacheRebuildService({
    db,
    stmts: {},
    io: { emit() {} },
    fs: null,
    path: null,
    uploadsDir: '',
    bootstrapRuntimeSessionBindings: () => 0,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    conversationGroups: groups,
  });
  const { mode } = service.rebuildCache({ mode: 'wipe' });
  assert.equal(mode, 'full');
  // The head and the lone chat are gone; the hand-titled member stays.
  assert.deepEqual(db.prepare(`SELECT id FROM conversations ORDER BY id`).all().map((row) => row.id), ['conv-child']);
  const kept = groups.getGroup(groupId);
  assert.deepEqual([kept.name, kept.parentConversationId], ['Release lead', 'conv-lead'], 'named before the wipe, link kept');
  assert.equal(groups.getGroup(otherGroup.id), null, 'a group with no row left goes');
  // The head is imported again under its id and creates another session:
  // the same group, not a second one.
  conv('conv-lead', 'Release lead');
  conv('conv-child-2', 'Site copy');
  assert.equal(groups.attachCreatedConversation('conv-child-2', 'conv-lead', NOW), groupId);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM conversation_groups`).get().n, 1);
  assert.deepEqual(groups.membersOf(groupId).map((m) => m.id).sort(), ['conv-child', 'conv-child-2', 'conv-lead']);
  // Nothing dangles for a later boot repair either.
  assert.deepEqual(groups.repair(NOW), { headsDetached: 0, groupsRemoved: 0 });
});
