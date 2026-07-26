import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { createDeleteArchiveService } from './delete-archive-service.mjs';
const REPO_ROOT = process.cwd();

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      status TEXT,
      sdk_session_id TEXT,
      archived INTEGER DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      attachments TEXT,
      timestamp TEXT
    );
    CREATE TABLE relay_questions (id TEXT PRIMARY KEY, conversation_id TEXT);
    CREATE TABLE relay_boards (id TEXT PRIMARY KEY, conversation_id TEXT);
    CREATE TABLE queue (id TEXT PRIMARY KEY, conversation_id TEXT);
    CREATE TABLE runtime_sessions (id TEXT PRIMARY KEY, conversation_id TEXT);
  `);
  return db;
}

test('deleteArchiveService removes generated image files when hard-deleting a conversation', async () => {
  const db = createTestDb();
  const root = path.join(REPO_ROOT, '.test-artifacts', `delete-archive-generated-images-${process.pid}`);
  const now = '2026-07-22T00:00:00.000Z';
  const imagePath = path.join(root, 'sdk-1', 'generated-images', 'conv-1', 'msg-1', 'img-01.png');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([7, 8, 9]));

  db.prepare(`INSERT INTO conversations (id, status, sdk_session_id, updated_at) VALUES (?, ?, ?, ?)`)
    .run('conv-1', 'active', 'sdk-1', now);
  db.prepare(`INSERT INTO messages (id, conversation_id, attachments, timestamp) VALUES (?, ?, ?, ?)`)
    .run(
      'msg-1',
      'conv-1',
      JSON.stringify([{
        type: 'image/png',
        generatedImage: {
          imageId: 'img-01',
          messageId: 'msg-1',
          sessionId: 'sdk-1',
          relativePath: 'conv-1/msg-1/img-01.png',
        },
      }]),
      now,
    );

  const sdkClient = { async deleteSession() {} };
  const service = createDeleteArchiveService(db, sdkClient, {
    resolveSessionStateRoot: () => root,
  });

  try {
    const result = await service.deleteConversation('conv-1');
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(imagePath), false);
    const conversation = db.prepare(`SELECT id FROM conversations WHERE id = ?`).get('conv-1');
    assert.equal(conversation, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    db.close();
  }
});
