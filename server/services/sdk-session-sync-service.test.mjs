import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { createSdkSessionSyncService } from './sdk-session-sync-service.mjs';
import { applySchema } from '../db-schema.mjs';

function createTestDb() {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

test('syncSession migrates pending queue owner from placeholder conversation id', () => {
  const db = createTestDb();
  const nowIso = '2026-07-01T10:00:00.000Z';
  db.prepare(`
    INSERT INTO conversations (id, title, created_at, sdk_session_id, status, updated_at)
    VALUES (?, 'Conversation', ?, ?, ?, ?)
  `).run('conv-1', nowIso, 'conv-1', 'active', nowIso);
  db.prepare(`
    INSERT INTO runtime_sessions (
      id, conversation_id, sdk_session_id, status, strategy, runtime_key, model, created_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('runtime-1', 'conv-1', 'conv-1', 'active', 'isolated', 'runtime-1', 'gpt-5.4-mini', nowIso, nowIso);
  db.prepare(`
    INSERT INTO queue (id, conversation_id, status, owner_sdk_session_id, text, timestamp)
    VALUES (?, ?, ?, ?, 'prompt', '2026-07-01T10:00:00.000Z')
  `).run('q-pending', 'conv-1', 'pending', 'conv-1');

  const service = createSdkSessionSyncService(db);
  const result = service.syncSession({ sdk_session_id: 'sdk-1', conversation_id: 'conv-1' });

  assert.equal(result.conversationId, 'conv-1');
  assert.equal(result.sdkSessionId, 'sdk-1');
  assert.equal(result.runtimeSessionId, 'runtime-1');
  assert.equal(result.createdRuntimeSession, false);

  const syncedConversation = db.prepare('SELECT sdk_session_id FROM conversations WHERE id = ?').get('conv-1');
  assert.equal(syncedConversation?.sdk_session_id, 'sdk-1');
  const syncedRuntimeSession = db.prepare('SELECT sdk_session_id FROM runtime_sessions WHERE id = ?').get('runtime-1');
  assert.equal(syncedRuntimeSession?.sdk_session_id, 'sdk-1');
  const pendingQueue = db.prepare('SELECT owner_sdk_session_id FROM queue WHERE id = ?').get('q-pending');
  assert.equal(pendingQueue?.owner_sdk_session_id, 'sdk-1');
});

test('syncSession only migrates pending queue rows for the bound conversation', () => {
  const db = createTestDb();
  const nowIso = '2026-07-01T10:00:00.000Z';
  db.prepare(`
    INSERT INTO conversations (id, title, created_at, sdk_session_id, status, updated_at)
    VALUES (?, 'Conversation', ?, ?, ?, ?)
  `).run('conv-1', nowIso, 'conv-1', 'active', nowIso);
  db.prepare(`
    INSERT INTO runtime_sessions (
      id, conversation_id, sdk_session_id, status, strategy, runtime_key, model, created_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('runtime-1', 'conv-1', 'conv-1', 'active', 'isolated', 'runtime-1', null, nowIso, nowIso);
  db.prepare(`
    INSERT INTO queue (id, conversation_id, status, owner_sdk_session_id, text, timestamp)
    VALUES (?, ?, ?, ?, 'prompt', '2026-07-01T10:00:00.000Z')
  `).run('q-pending-other', 'conv-2', 'pending', 'conv-1');
  db.prepare(`
    INSERT INTO queue (id, conversation_id, status, owner_sdk_session_id, text, timestamp)
    VALUES (?, ?, ?, ?, 'prompt', '2026-07-01T10:00:00.000Z')
  `).run('q-processing', 'conv-1', 'processing', 'conv-1');

  const service = createSdkSessionSyncService(db);
  service.syncSession({ sdk_session_id: 'sdk-1', conversation_id: 'conv-1' });

  const otherConversationQueue = db.prepare('SELECT owner_sdk_session_id FROM queue WHERE id = ?').get('q-pending-other');
  assert.equal(otherConversationQueue?.owner_sdk_session_id, 'conv-1');
  const processingQueue = db.prepare('SELECT owner_sdk_session_id FROM queue WHERE id = ?').get('q-processing');
  assert.equal(processingQueue?.owner_sdk_session_id, 'conv-1');
});
