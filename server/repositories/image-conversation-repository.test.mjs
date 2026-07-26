import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  createImageConversationRepository,
  migrateImageConversationSchema,
} from './image-conversation-repository.mjs';
import { createImageOperationService } from '../services/image-operation-service.mjs';

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      attachments TEXT,
      text TEXT NOT NULL DEFAULT '',
      model TEXT,
      mode TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE queue (id TEXT PRIMARY KEY);
    CREATE TABLE uploaded_files (
      sha256 TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL
    );
  `);
  migrateImageConversationSchema(db);
  return db;
}

function seedOperation(db, repository, {
  conversationId = 'conversation-a',
  sessionId = 'session-a',
  operationId = 'operation-a',
  sourceMessageId = 'source-a',
  queueMessageId = 'queue-a',
  createdAt = '2026-01-01T00:00:00.000Z',
} = {}) {
  db.prepare(`INSERT OR IGNORE INTO conversations (id) VALUES (?)`).run(conversationId);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, text, timestamp)
    VALUES (?, ?, '', ?)
  `).run(sourceMessageId, conversationId, createdAt);
  repository.insertSession.run({
    id: sessionId,
    conversationId,
    origin: 'native',
    schemaVersion: repository.imageSchemaVersion,
    createdAt,
    updatedAt: createdAt,
  });
  repository.insertOperation.run({
    id: operationId,
    imageSessionId: sessionId,
    sourceMessageId,
    queueMessageId,
    kind: 'generate',
    parentNodeId: null,
    prompt: 'draw a tree',
    selectedImageModel: 'gpt-image-1',
    orchestrationModel: null,
    provider: 'openai',
    executionMode: 'direct_images',
    parametersJson: '{}',
    requestFingerprint: `fingerprint-${operationId}`,
    idempotencyKey: `idempotency-${operationId}`,
    replacesOperationId: null,
    createdAt,
  });
}

test('image continuity migration is additive and idempotent', () => {
  const db = createDb();
  migrateImageConversationSchema(db);
  const tables = new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'image_%'
  `).all().map((row) => row.name));
  assert.equal(tables.has('image_sessions'), true);
  assert.equal(tables.has('image_operations'), true);
  assert.equal(tables.has('image_nodes'), true);
  assert.equal(tables.has('image_edges'), true);
  assert.equal(tables.has('image_provider_deletion_tombstones'), true);
  assert.equal(db.prepare(`PRAGMA table_info(queue)`).all().some((column) => column.name === 'image_operation_id'), true);
  db.close();
});

test('one source message maps to one immutable operation', () => {
  const db = createDb();
  const repository = createImageConversationRepository(db);
  seedOperation(db, repository);
  assert.throws(() => repository.insertOperation.run({
    id: 'operation-b',
    imageSessionId: 'session-a',
    sourceMessageId: 'source-a',
    queueMessageId: 'queue-b',
    kind: 'generate',
    parentNodeId: null,
    prompt: 'different prompt',
    selectedImageModel: 'gpt-image-1',
    orchestrationModel: null,
    provider: 'openai',
    executionMode: 'direct_images',
    parametersJson: '{}',
    requestFingerprint: 'fingerprint-b',
    idempotencyKey: 'idempotency-b',
    replacesOperationId: null,
    createdAt: '2026-01-01T00:00:01.000Z',
  }), /UNIQUE constraint failed/);
  db.close();
});

test('lineage rejects a second parent and cross-session edges', () => {
  const db = createDb();
  const repository = createImageConversationRepository(db);
  seedOperation(db, repository);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, text, timestamp)
    VALUES ('assistant-a', 'conversation-a', '', '2026-01-01T00:00:01.000Z')
  `).run();
  repository.insertNode.run({
    id: 'node-parent-a',
    imageSessionId: 'session-a',
    operationId: 'operation-a',
    assistantMessageId: 'assistant-a',
    attachmentImageId: 'image-a',
    outputIndex: 0,
    createdAt: '2026-01-01T00:00:01.000Z',
  });

  seedOperation(db, repository, {
    sessionId: 'session-b',
    operationId: 'operation-b',
    sourceMessageId: 'source-b',
    queueMessageId: 'queue-b',
    createdAt: '2026-01-01T00:00:02.000Z',
  });
  db.prepare(`
    INSERT INTO messages (id, conversation_id, text, timestamp)
    VALUES ('assistant-b', 'conversation-a', '', '2026-01-01T00:00:03.000Z')
  `).run();
  repository.insertNode.run({
    id: 'node-child-b',
    imageSessionId: 'session-b',
    operationId: 'operation-b',
    assistantMessageId: 'assistant-b',
    attachmentImageId: 'image-b',
    outputIndex: 0,
    createdAt: '2026-01-01T00:00:03.000Z',
  });

  assert.throws(() => repository.insertEdgeChecked({
    imageSessionId: 'session-a',
    parentNodeId: 'node-parent-a',
    childNodeId: 'node-child-b',
    operationId: 'operation-b',
    createdAt: '2026-01-01T00:00:04.000Z',
  }), /same image session/);
  db.close();
});

test('operation service atomically links a queued root generation', () => {
  const db = createDb();
  const repository = createImageConversationRepository(db);
  db.prepare(`INSERT INTO conversations (id) VALUES ('conversation-a')`).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, text, timestamp)
    VALUES ('source-a', 'conversation-a', 'draw a lighthouse', '2026-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`INSERT INTO queue (id) VALUES ('source-a')`).run();
  let sequence = 0;
  const service = createImageOperationService({
    db,
    repository,
    uuidv4: () => `uuid-${++sequence}`,
  });

  const operation = service.createEnqueuedOperation({
    conversationId: 'conversation-a',
    sourceMessageId: 'source-a',
    queueMessageId: 'source-a',
    prompt: 'draw a lighthouse',
    selectedImageModel: 'gpt-image-1',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(operation.kind, 'generate');
  assert.equal(repository.getOperation.get(operation.id).prompt, 'draw a lighthouse');
  assert.equal(db.prepare(`SELECT image_operation_id FROM queue WHERE id = 'source-a'`).get().image_operation_id, operation.id);
  db.close();
});

test('legacy generated image becomes an image-only edit parent on first reply', () => {
  const db = createDb();
  const repository = createImageConversationRepository(db);
  db.prepare(`INSERT INTO conversations (id) VALUES ('conversation-a')`).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, attachments, text, timestamp)
    VALUES (
      'assistant-a',
      'conversation-a',
      'assistant',
      '{"bad":"shape"}',
      '',
      '2026-01-01T00:00:00.000Z'
    )
  `).run();
  db.prepare(`
    UPDATE messages SET attachments = ?
    WHERE id = 'assistant-a'
  `).run(JSON.stringify([{
    name: 'legacy.png',
    type: 'image/png',
    generatedImage: { imageId: 'img-01', messageId: 'assistant-a' },
  }]));
  db.prepare(`
    INSERT INTO messages (id, conversation_id, text, timestamp)
    VALUES ('source-edit', 'conversation-a', 'make it dusk', '2026-01-01T00:01:00.000Z')
  `).run();
  db.prepare(`INSERT INTO queue (id) VALUES ('source-edit')`).run();
  let sequence = 0;
  const service = createImageOperationService({
    db,
    repository,
    uuidv4: () => `uuid-${++sequence}`,
  });

  const operation = service.createEnqueuedOperation({
    conversationId: 'conversation-a',
    sourceMessageId: 'source-edit',
    queueMessageId: 'source-edit',
    prompt: 'make it dusk',
    selectedImageModel: 'gpt-image-1',
    imageTarget: { messageId: 'assistant-a', imageId: 'img-01' },
    createdAt: '2026-01-01T00:01:00.000Z',
  });

  assert.equal(operation.kind, 'legacy_edit');
  assert.equal(operation.reconstructionMode, 'image_only');
  const parent = repository.getNode.get(operation.parentNodeId);
  assert.equal(parent.assistant_message_id, 'assistant-a');
  assert.equal(parent.attachment_image_id, 'img-01');
  db.close();
});
