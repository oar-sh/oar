import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from './session-repository.mjs';

const AT = '2026-10-30T12:00:00.000Z';

function createTestDb() {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function addConversation(db, { id, archived = 0, status = 'active', sdkSessionId = null }) {
  db.prepare(`
    INSERT INTO conversations (id, title, status, archived, sdk_session_id, created_at, updated_at)
    VALUES (?, 'Demo', ?, ?, ?, ?, ?)
  `).run(id, status, archived, sdkSessionId, AT, AT);
}

function addRuntimeSession(db, { conversationId, sdkSessionId }) {
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(`rs-${conversationId}`, conversationId, sdkSessionId, `key-${conversationId}`, AT, AT);
}

function listed(stmts) {
  return stmts.listArchivedRuntimeSessionIds.all().map((row) => row.sdk_session_id).sort();
}

test('archived runtime sessions: the session ids of archived conversations, not those in use', () => {
  const db = createTestDb();
  const stmts = createSessionRepository(db);
  addConversation(db, { id: 'conv-archived', archived: 1, sdkSessionId: 'sid-archived' });
  addRuntimeSession(db, { conversationId: 'conv-archived', sdkSessionId: 'sid-archived' });
  addConversation(db, { id: 'conv-live', sdkSessionId: 'sid-live' });
  addRuntimeSession(db, { conversationId: 'conv-live', sdkSessionId: 'sid-live' });
  // Archived but never given a session: nothing to stop.
  addConversation(db, { id: 'conv-no-sid', archived: 1 });
  addRuntimeSession(db, { conversationId: 'conv-no-sid', sdkSessionId: '' });
  assert.deepEqual(listed(stmts), ['sid-archived']);
  db.close();
});

test('archived runtime sessions: an id a conversation in use names too is left out', () => {
  const db = createTestDb();
  const stmts = createSessionRepository(db);
  addConversation(db, { id: 'conv-old', archived: 1 });
  addRuntimeSession(db, { conversationId: 'conv-old', sdkSessionId: 'sid-shared' });
  // A runtime session id is unique; the conversation in use names it on its
  // own row.
  addConversation(db, { id: 'conv-new', sdkSessionId: 'sid-shared' });
  // An archived twin does not count as in use.
  addConversation(db, { id: 'conv-old-2', archived: 1 });
  addRuntimeSession(db, { conversationId: 'conv-old-2', sdkSessionId: 'sid-archived-twin' });
  addConversation(db, { id: 'conv-old-2b', archived: 1, sdkSessionId: 'sid-archived-twin' });
  // Nor does a deleted one.
  addConversation(db, { id: 'conv-old-3', archived: 1 });
  addRuntimeSession(db, { conversationId: 'conv-old-3', sdkSessionId: 'sid-deleted-twin' });
  addConversation(db, { id: 'conv-deleted', status: 'deleted', sdkSessionId: 'sid-deleted-twin' });
  assert.deepEqual(listed(stmts), ['sid-archived-twin', 'sid-deleted-twin']);
  db.close();
});
