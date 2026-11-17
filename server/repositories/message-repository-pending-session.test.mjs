import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from './message-repository.mjs';

// listPendingRowsForSession: a session's waiting rows a worker would claim,
// whatever their provider (the Copilot switch fails them before a launch).

const NOW = '2026-11-17T01:00:00.000Z';

function boot() {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-1', 'chat', 'sid-1', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-2', 'other', 'sid-2', ?, ?)`).run(NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, provider_type, created_at, last_used_at)
    VALUES ('rs-1', 'conv-1', 'sid-1', 'rs-1', 'github', ?, ?), ('rs-2', 'conv-2', 'sid-2', 'rs-2', 'github', ?, ?)
  `).run(NOW, NOW, NOW, NOW);
  const add = (id, conversationId, runtimeSessionId, status, kind = null) => db.prepare(`
    INSERT INTO queue (id, conversation_id, runtime_session_id, text, status, timestamp, kind)
    VALUES (?, ?, ?, 'hello', ?, ?, ?)
  `).run(id, conversationId, runtimeSessionId, status, NOW, kind);
  add('q-pending', 'conv-1', 'rs-1', 'pending');
  add('q-pending-2', 'conv-1', 'rs-1', 'pending');
  add('q-processing', 'conv-1', 'rs-1', 'processing');
  add('q-continuation', 'conv-1', 'rs-1', 'pending', 'continuation');
  add('q-other-session', 'conv-2', 'rs-2', 'pending');
  return { db, stmts: createMessageRepository(db) };
}

test('a session\'s pending rows, not the processing ones, its continuations or another session\'s', () => {
  const { stmts } = boot();
  assert.deepEqual(stmts.listPendingRowsForSession.all('sid-1').map((row) => row.id).sort(), ['q-pending', 'q-pending-2']);
  assert.deepEqual(stmts.listPendingRowsForSession.all('sid-2').map((row) => row.id), ['q-other-session']);
  assert.deepEqual(stmts.listPendingRowsForSession.all('sid-none'), []);
});
