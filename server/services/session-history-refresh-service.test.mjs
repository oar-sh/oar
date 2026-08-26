import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createSessionHistoryRefreshService } from './session-history-refresh-service.mjs';
import { applySchema } from '../db-schema.mjs';

function makeDb() {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

// messages/relay tables have a foreign key to conversations in the real
// schema, so fixtures need the parent row before inserting history.
function insertConversation(db, id) {
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
    .run(id, `Conversation ${id}`, id);
}

// upload_refs has a foreign key to uploaded_files in the real schema, so any
// sha256 the service may re-reference needs its durable file row.
function insertUploadedFile(db, sha256) {
  db.prepare(`INSERT OR IGNORE INTO uploaded_files (sha256, original_name, mime_type, size_bytes, created_at) VALUES (?, 'fixture.bin', 'application/octet-stream', 1, '2026-01-01T00:00:00Z')`)
    .run(sha256);
}

function makeStmts(db) {
  return {
    getConv: db.prepare(`SELECT * FROM conversations WHERE id = ?`),
    insertConv: db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`),
    setConvSdkSessionIdIfMissing: db.prepare(`
      UPDATE conversations
      SET sdk_session_id = ?, updated_at = ?
      WHERE id = ? AND (sdk_session_id IS NULL OR sdk_session_id = '')
    `),
    insertMsg: db.prepare(`
      INSERT INTO messages (id, conversation_id, role, text, model, mode, attachments, timestamp, model_requested, model_actual, model_origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertActivity: db.prepare(`
      INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, relay_mode, text, created_at, subagent_run_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertThought: db.prepare(`
      INSERT INTO relay_thought (queue_message_id, response_message_id, conversation_id, relay_mode, reasoning_id, seq, text, done, created_at, subagent_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteConvActivity: db.prepare(`DELETE FROM relay_activity WHERE conversation_id = ?`),
    deleteConvThoughts: db.prepare(`DELETE FROM relay_thought WHERE conversation_id = ?`),
    deleteConvStreamEvents: db.prepare(`DELETE FROM relay_stream_events WHERE conversation_id = ?`),
    deleteConvSubagentRuns: db.prepare(`DELETE FROM subagent_runs WHERE conversation_id = ?`),
  };
}

test('clearRetrievableHistory removes only retrievable tables', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-1', 'One', 'conv-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m1', 'conv-1', 'user', 'hello', '2026-01-01T00:00:01Z')`).run();
  db.prepare(`INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, relay_mode, text, created_at) VALUES ('q1', 'm2', 'conv-1', 'agent', 'Tool (rg)', '2026-01-01T00:00:02Z')`).run();
  db.prepare(`INSERT INTO relay_thought (queue_message_id, response_message_id, conversation_id, relay_mode, seq, text, created_at) VALUES ('q1', 'm2', 'conv-1', 'agent', 1, 'thinking', '2026-01-01T00:00:03Z')`).run();
  db.prepare(`INSERT INTO relay_stream_events (queue_message_id, response_message_id, conversation_id, relay_mode, seq, text, done, created_at) VALUES ('q1', 'm2', 'conv-1', 'agent', 1, 'partial', 0, '2026-01-01T00:00:04Z')`).run();
  db.prepare(`INSERT INTO subagent_runs (id, queue_message_id, conversation_id, status, started_at, updated_at) VALUES ('sub-1', 'q1', 'conv-1', 'running', '2026-01-01T00:00:05Z', '2026-01-01T00:00:05Z')`).run();
  db.prepare(`INSERT INTO workflow_runs (id, response_message_id, conversation_id, run_index, digest_json, created_at) VALUES ('wfr-1', 'm2', 'conv-1', 0, '{"runId":"wf_1"}', '2026-01-01T00:00:06Z')`).run();
  db.prepare(`INSERT INTO queue (id, conversation_id, status, text, timestamp) VALUES ('q1', 'conv-1', 'done', 'prompt', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, prompt, created_at, expires_at) VALUES ('rq-1', 'q1', 'conv-1', 'm2', 'Question?', '2026-01-01T00:00:07Z', '2026-01-01T01:00:00Z')`).run();

  const service = createSessionHistoryRefreshService({ db, stmts });
  assert.equal(service.clearRetrievableHistory('conv-1'), true);

  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 0);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM relay_activity WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 0);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM relay_thought WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 0);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM relay_stream_events WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 0);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM subagent_runs WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 0);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM workflow_runs WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 0);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM relay_questions WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 1);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM queue WHERE conversation_id = 'conv-1'`).get()?.cnt || 0), 1);
});

test('evaluateRefreshIdleState rejects busy queue and in-flight processing', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-3', 'Three', 'conv-3', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO queue (id, conversation_id, status, text, timestamp) VALUES ('q-3', 'conv-3', 'processing', 'prompt', '2026-01-01T00:00:00Z')`).run();

  const busyQueueService = createSessionHistoryRefreshService({
    db,
    stmts,
    inFlightStateForConversation: () => null,
  });
  assert.deepEqual(busyQueueService.evaluateRefreshIdleState('conv-3'), { idle: false, reason: 'queue-busy' });

  db.prepare(`DELETE FROM queue WHERE conversation_id = 'conv-3'`).run();
  const busyTurnService = createSessionHistoryRefreshService({
    db,
    stmts,
    inFlightStateForConversation: () => ({ status: 'processing' }),
  });
  assert.deepEqual(busyTurnService.evaluateRefreshIdleState('conv-3'), { idle: false, reason: 'turn-processing' });
});

test('persistRebuiltHistory stores messages, activities, and structured thoughts', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-4', 'Four', 'conv-4', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  const service = createSessionHistoryRefreshService({ db, stmts });

  const messages = [
    { id: 'u1', role: 'user', text: 'hello', timestamp: '2026-01-01T00:00:01Z' },
    {
      id: 'a1',
      role: 'assistant',
      text: 'world',
      timestamp: '2026-01-01T00:00:02Z',
      activities: ['Tool (rg): foo'],
      thoughts: [{ reasoningId: 'thought-1', text: 'First paragraph.\n\nSecond paragraph.', done: true }],
    },
  ];
  const persisted = service.persistRebuiltHistory('conv-4', messages);
  assert.equal(persisted.insertedCount, 2);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = 'conv-4'`).get()?.cnt || 0), 2);
  const activityRows = db.prepare(`
    SELECT queue_message_id, response_message_id, text
    FROM relay_activity
    WHERE conversation_id = 'conv-4'
    ORDER BY id ASC
  `).all();
  assert.deepEqual(activityRows, [
    { queue_message_id: 'a1', response_message_id: 'a1', text: 'Tool (rg): foo' },
  ]);
  const thoughtRows = db.prepare(`
    SELECT queue_message_id, response_message_id, reasoning_id, seq, text, done
    FROM relay_thought
    WHERE conversation_id = 'conv-4'
  `).all();
  assert.deepEqual(thoughtRows, [{
    queue_message_id: 'a1',
    response_message_id: 'a1',
    reasoning_id: 'thought-1',
    seq: 1,
    text: 'First paragraph.\n\nSecond paragraph.',
    done: 1,
  }]);
});

test('mapSdkEventsToMessages delegates to shared parser', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  const calls = [];
  const service = createSessionHistoryRefreshService({
    db,
    stmts,
    parseSessionEventsToMessages: (events) => {
      calls.push(events);
      return [{ id: 'a1', role: 'assistant', text: 'ok', timestamp: '2026-01-01T00:00:00Z' }];
    },
  });
  const mapped = service.mapSdkEventsToMessages([{ type: 'assistant.message', data: { content: 'ok' } }]);
  assert.equal(calls.length, 1);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].id, 'a1');
});

test('replaceRetrievableHistory swaps messages atomically', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-5', 'Five', 'conv-5', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('old', 'conv-5', 'user', 'old text', '2026-01-01T00:00:01Z')`).run();
  db.prepare(`
    INSERT INTO relay_thought (queue_message_id, response_message_id, conversation_id, relay_mode, reasoning_id, seq, text, done, created_at)
    VALUES ('q-5', 'old-a', 'conv-5', 'agent', 'reason-5', 1, 'preserve me', 1, '2026-01-01T00:00:01Z')
  `).run();
  const service = createSessionHistoryRefreshService({ db, stmts });
  assert.equal(service.countRetrievableMessages('conv-5'), 1);

  service.replaceRetrievableHistory('conv-5', [
    { id: 'new-u', role: 'user', text: 'fresh', timestamp: '2026-01-01T00:00:02Z' },
    {
      id: 'new-a',
      role: 'assistant',
      text: 'reply',
      timestamp: '2026-01-01T00:00:03Z',
      activities: [{ text: 'Tool (rg): scan', subagentRunId: 'sub-9' }],
      thoughts: [{ reasoningId: 'rebuilt-thought', text: 'retained structure', done: true }],
    },
  ]);

  const rows = db.prepare(`SELECT id, text FROM messages WHERE conversation_id = 'conv-5' ORDER BY timestamp ASC`).all();
  assert.deepEqual(rows, [
    { id: 'new-u', text: 'fresh' },
    { id: 'new-a', text: 'reply' },
  ]);
  const activityRow = db.prepare(`
    SELECT text, subagent_run_id
    FROM relay_activity
    WHERE conversation_id = 'conv-5'
    ORDER BY id ASC
  `).get();
  assert.deepEqual(activityRow, { text: 'Tool (rg): scan', subagent_run_id: 'sub-9' });
  const thoughtRow = db.prepare(`
    SELECT reasoning_id, text, response_message_id
    FROM relay_thought
    WHERE conversation_id = 'conv-5'
  `).get();
  assert.deepEqual(thoughtRow, {
    reasoning_id: 'rebuilt-thought',
    text: 'retained structure',
    response_message_id: 'new-a',
  });
});

test('replaceRetrievableHistory remaps durable uploads when SDK message ids change', () => {
    const db = makeDb();
    const stmts = makeStmts(db);
    const sha256 = 'a'.repeat(64);
    const storedAttachments = JSON.stringify([{
      name: 'panel.jpg',
      type: 'image/jpeg',
      size: 4321,
      sha256,
      contentUrl: `/api/upload/${sha256}/content`,
    }]);
    db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-upload', 'Upload', 'conv-upload', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
    db.prepare(`
      INSERT INTO queue (id, conversation_id, status, text, attachments, timestamp)
      VALUES ('relay-message', 'conv-upload', 'done', 'prompt', ?, '2026-01-01T00:00:01Z')
    `).run(storedAttachments);
    db.prepare(`
      INSERT INTO uploaded_files (sha256, original_name, mime_type, size_bytes, created_at)
      VALUES (?, 'panel.jpg', 'image/jpeg', 4321, '2026-01-01T00:00:01Z')
    `).run(sha256);
    db.prepare(`
      INSERT INTO upload_refs (file_sha256, conversation_id, message_id, created_at)
      VALUES (?, 'conv-upload', 'relay-message', '2026-01-01T00:00:01Z')
    `).run(sha256);

    const service = createSessionHistoryRefreshService({ db, stmts });
    service.replaceRetrievableHistory('conv-upload', [{
      id: 'sdk-message',
      role: 'user',
      text: 'Inspect this image',
      attachments: [{
        name: 'panel.jpg',
        type: 'image/jpeg',
        size: 1000,
        sdkAssetId: 'sha256:sdk-copy',
      }],
      timestamp: '2026-01-01T00:00:02Z',
    }]);

    assert.deepEqual(
      JSON.parse(db.prepare(`SELECT attachments FROM messages WHERE id = 'sdk-message'`).get().attachments),
      JSON.parse(storedAttachments),
    );
    assert.deepEqual(
      db.prepare(`SELECT file_sha256, message_id FROM upload_refs WHERE message_id = 'sdk-message'`).get(),
      { file_sha256: sha256, message_id: 'sdk-message' },
    );
});

test('replaceRetrievableHistory restores full mixed attachment sets from image-only SDK hints', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  insertConversation(db, 'conv-mixed');
  const imageSha = 'b'.repeat(64);
  const documentSha = 'c'.repeat(64);
  const storedAttachments = [{
    name: 'panel.jpg',
    type: 'image/jpeg',
    size: 4321,
    sha256: imageSha,
  }, {
    name: 'notes.pdf',
    type: 'application/pdf',
    size: 9876,
    sha256: documentSha,
  }];
  db.prepare(`
    INSERT INTO queue (id, conversation_id, status, text, attachments, timestamp)
    VALUES ('mixed-relay', 'conv-mixed', 'done', 'prompt', ?, '2026-01-01T00:00:01Z')
  `).run(JSON.stringify(storedAttachments));
  insertUploadedFile(db, imageSha);
  insertUploadedFile(db, documentSha);

  const service = createSessionHistoryRefreshService({ db, stmts });
  service.replaceRetrievableHistory('conv-mixed', [{
    id: 'mixed-sdk',
    role: 'user',
    text: 'Inspect these files',
    attachments: [{ name: 'panel.jpg', type: 'image/jpeg', sdkAssetId: 'sha256:sdk-copy' }],
    timestamp: '2026-01-01T00:00:02Z',
  }]);

  assert.deepEqual(
    JSON.parse(db.prepare(`SELECT attachments FROM messages WHERE id = 'mixed-sdk'`).get().attachments),
    storedAttachments,
  );
});

test('replaceRetrievableHistory matches duplicate filenames one-to-one by nearest timestamp', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  insertConversation(db, 'conv-duplicate');
  const firstSha = 'd'.repeat(64);
  const secondSha = 'e'.repeat(64);
  db.prepare(`
    INSERT INTO queue (id, conversation_id, status, text, attachments, timestamp)
    VALUES
      ('relay-first', 'conv-duplicate', 'done', 'prompt', ?, '2026-01-01T00:00:01Z'),
      ('relay-second', 'conv-duplicate', 'done', 'prompt', ?, '2026-01-01T00:10:01Z')
  `).run(
    JSON.stringify([{ name: 'photo.jpg', type: 'image/jpeg', sha256: firstSha }]),
    JSON.stringify([{ name: 'photo.jpg', type: 'image/jpeg', sha256: secondSha }]),
  );
  insertUploadedFile(db, firstSha);
  insertUploadedFile(db, secondSha);

  const service = createSessionHistoryRefreshService({ db, stmts });
  service.replaceRetrievableHistory('conv-duplicate', [{
    id: 'sdk-first',
    role: 'user',
    text: 'First',
    attachments: [{ name: 'photo.jpg', type: 'image/jpeg', sdkAssetId: 'sha256:sdk-first' }],
    timestamp: '2026-01-01T00:00:02Z',
  }, {
    id: 'sdk-second',
    role: 'user',
    text: 'Second',
    attachments: [{ name: 'photo.jpg', type: 'image/jpeg', sdkAssetId: 'sha256:sdk-second' }],
    timestamp: '2026-01-01T00:10:02Z',
  }]);

  assert.equal(JSON.parse(db.prepare(`SELECT attachments FROM messages WHERE id = 'sdk-first'`).get().attachments)[0].sha256, firstSha);
  assert.equal(JSON.parse(db.prepare(`SELECT attachments FROM messages WHERE id = 'sdk-second'`).get().attachments)[0].sha256, secondSha);
});

test('replaceRetrievableHistory preserves hidden-from-shares state by message id', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  insertConversation(db, 'conv-hidden');
  const service = createSessionHistoryRefreshService({
    db,
    stmts,
    inFlightStateForConversation: () => null,
    parseSessionEventsToMessages: () => [],
  });
  db.prepare(`
    INSERT INTO messages (
      id, conversation_id, role, text, hidden_from_shares, share_hidden_at, timestamp
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(
    'hidden-1',
    'conv-hidden',
    'user',
    'private',
    '2026-01-01T00:01:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );

  service.replaceRetrievableHistory('conv-hidden', [{
    id: 'hidden-1',
    role: 'user',
    text: 'private',
    timestamp: '2026-01-01T00:00:00.000Z',
  }]);

  const row = db.prepare(`
    SELECT hidden_from_shares, share_hidden_at
    FROM messages
    WHERE id = 'hidden-1'
  `).get();
  assert.equal(row.hidden_from_shares, 1);
  assert.equal(row.share_hidden_at, '2026-01-01T00:01:00.000Z');
});

test('replaceRetrievableHistory remaps hidden-from-shares state when SDK message ids change', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  insertConversation(db, 'conv-remap');
  db.prepare(`
    INSERT INTO messages (
      id, conversation_id, role, text, hidden_from_shares, share_hidden_at, timestamp
    ) VALUES
      ('relay-hidden', 'conv-remap', 'user', 'keep this private', 1, '2026-01-01T00:05:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('relay-visible', 'conv-remap', 'user', 'public note', 0, NULL, '2026-01-01T00:01:00.000Z')
  `).run();

  const service = createSessionHistoryRefreshService({ db, stmts });
  service.replaceRetrievableHistory('conv-remap', [{
    id: 'sdk-hidden',
    role: 'user',
    text: 'keep this private',
    timestamp: '2026-01-01T00:00:01.000Z',
  }, {
    id: 'sdk-visible',
    role: 'user',
    text: 'public note',
    timestamp: '2026-01-01T00:01:01.000Z',
  }]);

  const hiddenRow = db.prepare(`SELECT hidden_from_shares, share_hidden_at FROM messages WHERE id = 'sdk-hidden'`).get();
  assert.equal(hiddenRow.hidden_from_shares, 1);
  assert.equal(hiddenRow.share_hidden_at, '2026-01-01T00:05:00.000Z');
  const visibleRow = db.prepare(`SELECT hidden_from_shares FROM messages WHERE id = 'sdk-visible'`).get();
  assert.equal(visibleRow.hidden_from_shares, 0);
});

test('replaceRetrievableHistory maps two remapped hidden duplicates one-to-one by nearest timestamp', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  insertConversation(db, 'conv-dup-hidden');
  db.prepare(`
    INSERT INTO messages (
      id, conversation_id, role, text, hidden_from_shares, share_hidden_at, timestamp
    ) VALUES
      ('relay-early', 'conv-dup-hidden', 'user', 'same text', 1, '2026-01-01T00:20:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('relay-late', 'conv-dup-hidden', 'user', 'same text', 1, '2026-01-01T00:20:00.000Z', '2026-01-01T00:10:00.000Z')
  `).run();

  const service = createSessionHistoryRefreshService({ db, stmts });
  service.replaceRetrievableHistory('conv-dup-hidden', [{
    id: 'sdk-early',
    role: 'user',
    text: 'same text',
    timestamp: '2026-01-01T00:00:01.000Z',
  }, {
    id: 'sdk-late',
    role: 'user',
    text: 'same text',
    timestamp: '2026-01-01T00:10:01.000Z',
  }]);

  assert.equal(db.prepare(`SELECT hidden_from_shares FROM messages WHERE id = 'sdk-early'`).get().hidden_from_shares, 1);
  assert.equal(db.prepare(`SELECT hidden_from_shares FROM messages WHERE id = 'sdk-late'`).get().hidden_from_shares, 1);
});

test('replaceRetrievableHistory keeps same-name candidates with distinct sha256 apart', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  insertConversation(db, 'conv-sha');
  const firstSha = 'f'.repeat(64);
  const secondSha = '0'.repeat(63) + '1';
  // Same filename, type, and timestamp: only sha256/size distinguish the
  // candidate keys, so both sets must survive candidate collection.
  db.prepare(`
    INSERT INTO queue (id, conversation_id, status, text, attachments, timestamp)
    VALUES
      ('relay-a', 'conv-sha', 'done', 'prompt', ?, '2026-01-01T00:00:01Z'),
      ('relay-b', 'conv-sha', 'done', 'prompt', ?, '2026-01-01T00:10:01Z')
  `).run(
    JSON.stringify([{ name: 'photo.jpg', type: 'image/jpeg', size: 111, sha256: firstSha }]),
    JSON.stringify([{ name: 'photo.jpg', type: 'image/jpeg', size: 999, sha256: secondSha }]),
  );
  insertUploadedFile(db, firstSha);
  insertUploadedFile(db, secondSha);

  const service = createSessionHistoryRefreshService({ db, stmts });
  service.replaceRetrievableHistory('conv-sha', [{
    id: 'sdk-a',
    role: 'user',
    text: 'first',
    attachments: [{ name: 'photo.jpg', type: 'image/jpeg', size: 5, sdkAssetId: 'sha256:sdk-a' }],
    timestamp: '2026-01-01T00:00:02Z',
  }, {
    id: 'sdk-b',
    role: 'user',
    text: 'second',
    attachments: [{ name: 'photo.jpg', type: 'image/jpeg', size: 5, sdkAssetId: 'sha256:sdk-b' }],
    timestamp: '2026-01-01T00:10:02Z',
  }]);

  assert.equal(JSON.parse(db.prepare(`SELECT attachments FROM messages WHERE id = 'sdk-a'`).get().attachments)[0].sha256, firstSha);
  assert.equal(JSON.parse(db.prepare(`SELECT attachments FROM messages WHERE id = 'sdk-b'`).get().attachments)[0].sha256, secondSha);
});

test('replaceRetrievableHistory rolls back when inserting a malformed snapshot fails', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-atomic', 'Atomic', 'conv-atomic', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('old-atomic', 'conv-atomic', 'user', 'old text', '2026-01-01T00:00:01Z')`).run();
  db.prepare(`
    INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, relay_mode, text, created_at)
    VALUES ('q-atomic', 'old-atomic', 'conv-atomic', 'agent', 'old activity', '2026-01-01T00:00:01Z')
  `).run();
  const service = createSessionHistoryRefreshService({ db, stmts });

  assert.throws(() => service.replaceRetrievableHistory('conv-atomic', [
    { id: 'duplicate', role: 'user', text: 'first', timestamp: '2026-01-01T00:00:02Z' },
    { id: 'duplicate', role: 'assistant', text: 'second', timestamp: '2026-01-01T00:00:03Z' },
  ]));

  assert.deepEqual(
    db.prepare(`SELECT id, text FROM messages WHERE conversation_id = 'conv-atomic'`).all(),
    [{ id: 'old-atomic', text: 'old text' }],
  );
  assert.deepEqual(
    db.prepare(`SELECT text FROM relay_activity WHERE conversation_id = 'conv-atomic'`).all(),
    [{ text: 'old activity' }],
  );
});

test('countRetrievableMessages reports stored message count', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-6', 'Six', 'conv-6', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m1', 'conv-6', 'user', 'one', '2026-01-01T00:00:01Z')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m2', 'conv-6', 'assistant', 'two', '2026-01-01T00:00:02Z')`).run();
  const service = createSessionHistoryRefreshService({ db, stmts });
  assert.equal(service.countRetrievableMessages('conv-6'), 2);
});
