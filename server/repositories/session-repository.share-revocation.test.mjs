import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

// Mirrors the conversation_shares schema + statements from server-runtime.mjs /
// session-repository.mjs to exercise share revocation (M2) without booting the app.
const SCHEMA = `
  CREATE TABLE conversation_shares (
    token            TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    last_accessed_at TEXT,
    revoked_at       TEXT
  );
`;

function newStmts() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return {
    db,
    insert: db.prepare(`
      INSERT INTO conversation_shares (token, conversation_id, created_at, last_accessed_at, revoked_at)
      VALUES (?, ?, ?, ?, NULL)
    `),
    getByToken: db.prepare(`
      SELECT token, conversation_id, revoked_at FROM conversation_shares WHERE token = ? LIMIT 1
    `),
    getActiveByConversationId: db.prepare(`
      SELECT token, conversation_id, revoked_at FROM conversation_shares
      WHERE conversation_id = ? AND (revoked_at IS NULL OR revoked_at = '')
      ORDER BY created_at DESC LIMIT 1
    `),
    revokeByConversationId: db.prepare(`
      UPDATE conversation_shares SET revoked_at = ?
      WHERE conversation_id = ? AND (revoked_at IS NULL OR revoked_at = '')
    `),
  };
}

test('revoking by conversation id marks the share revoked and hides it from active lookups', () => {
  const stmts = newStmts();
  stmts.insert.run('a'.repeat(64), 'conv-1', '2026-01-01T00:00:00.000Z', null);

  assert.ok(stmts.getActiveByConversationId.get('conv-1'), 'share is active before revoke');

  const result = stmts.revokeByConversationId.run('2026-01-02T00:00:00.000Z', 'conv-1');
  assert.equal(result.changes, 1, 'one active share revoked');

  // The active lookup (used by the share-create idempotency path) no longer sees it.
  assert.equal(stmts.getActiveByConversationId.get('conv-1'), undefined);
  // The by-token lookup (used by every /api/shared read path) sees revoked_at set,
  // which those routes already treat as "not found".
  const row = stmts.getByToken.get('a'.repeat(64));
  assert.equal(row.revoked_at, '2026-01-02T00:00:00.000Z');
});

test('revoking is idempotent and does not touch already-revoked rows', () => {
  const stmts = newStmts();
  stmts.insert.run('b'.repeat(64), 'conv-2', '2026-01-01T00:00:00.000Z', null);
  const first = stmts.revokeByConversationId.run('2026-01-02T00:00:00.000Z', 'conv-2');
  assert.equal(first.changes, 1);
  // A second revoke changes nothing (the WHERE excludes already-revoked rows),
  // so the original revoked_at timestamp is preserved.
  const second = stmts.revokeByConversationId.run('2026-01-03T00:00:00.000Z', 'conv-2');
  assert.equal(second.changes, 0);
  assert.equal(stmts.getByToken.get('b'.repeat(64)).revoked_at, '2026-01-02T00:00:00.000Z');
});

test('revoking one conversation leaves another conversation share active', () => {
  const stmts = newStmts();
  stmts.insert.run('c'.repeat(64), 'conv-3', '2026-01-01T00:00:00.000Z', null);
  stmts.insert.run('d'.repeat(64), 'conv-4', '2026-01-01T00:00:00.000Z', null);
  stmts.revokeByConversationId.run('2026-01-02T00:00:00.000Z', 'conv-3');
  assert.equal(stmts.getActiveByConversationId.get('conv-3'), undefined);
  assert.ok(stmts.getActiveByConversationId.get('conv-4'), 'unrelated share stays active');
});
