import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { createAskUserRoutingService } from './ask-user-routing-service.mjs';
import { migrate } from '../migrations/0001-add-structured-answer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function makeDb() {
  // Use an on-disk DB in the project tree (temp files in /tmp are disallowed).
  const dbPath = path.join(here, `.test-relay-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE relay_questions (
      id TEXT PRIMARY KEY,
      queue_id TEXT,
      conversation_id TEXT,
      message_id TEXT,
      relay_mode TEXT,
      prompt TEXT,
      choices TEXT,
      request TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      answer TEXT,
      sdk_session_id TEXT,
      owner_worker_id TEXT,
      continuation_id TEXT,
      continuation_question_id TEXT,
      created_at TEXT,
      answered_at TEXT,
      expires_at TEXT
    );
  `);
  return { db, dbPath };
}

function cleanup(db, dbPath) {
  try { db.close(); } catch { /* noop */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* noop */ }
  }
}

function insertQuestion(db, id, schema) {
  db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, relay_mode, prompt, request_schema, status, created_at, expires_at)
    VALUES (?, 'q1', 'c1', 'm1', 'agent', 'prompt', ?, 'pending', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
  `).run(id, schema ? JSON.stringify(schema) : null);
}

test('migration adds structured_answer and request_schema columns idempotently', () => {
  const { db, dbPath } = makeDb();
  try {
    const first = migrate(dbPath);
    assert.deepEqual(first.applied.sort(), ['request_schema', 'structured_answer']);
    const second = migrate(dbPath);
    assert.deepEqual(second.applied, []);
    const cols = db.prepare(`PRAGMA table_info(relay_questions)`).all().map((c) => c.name);
    assert.ok(cols.includes('structured_answer'));
    assert.ok(cols.includes('request_schema'));
  } finally {
    cleanup(db, dbPath);
  }
});

test('routeAnswer persists structured_answer when provided', () => {
  const { db, dbPath } = makeDb();
  try {
    migrate(dbPath);
    const schema = {
      type: 'object',
      properties: { meaning: { type: 'string' }, format: { type: 'string' } },
      required: ['meaning', 'format'],
    };
    insertQuestion(db, 'qid-multi', schema);
    const service = createAskUserRoutingService(db);
    const structured = JSON.stringify({ meaning: 'agent', format: 'json' });
    const result = service.routeAnswer({ question_id: 'qid-multi', answer: 'meaning: agent · format: json', structured_answer: structured });
    assert.equal(result.ok, true);
    const row = db.prepare(`SELECT status, answer, structured_answer FROM relay_questions WHERE id = ?`).get('qid-multi');
    assert.equal(row.status, 'answered');
    assert.equal(row.structured_answer, structured);
    assert.match(row.answer, /agent/);
  } finally {
    cleanup(db, dbPath);
  }
});

test('routeAnswer remains backward compatible for flat answers', () => {
  const { db, dbPath } = makeDb();
  try {
    migrate(dbPath);
    insertQuestion(db, 'qid-flat', null);
    const service = createAskUserRoutingService(db);
    const result = service.routeAnswer({ question_id: 'qid-flat', answer: 'Mars' });
    assert.equal(result.ok, true);
    const row = db.prepare(`SELECT status, answer, structured_answer FROM relay_questions WHERE id = ?`).get('qid-flat');
    assert.equal(row.status, 'answered');
    assert.equal(row.answer, 'Mars');
    assert.equal(row.structured_answer, null);
  } finally {
    cleanup(db, dbPath);
  }
});
