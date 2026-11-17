'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { applySchema } from './db-schema.mjs';
import { createMessageRepository, settleFailedRowControlsAndCards } from './repositories/message-repository.mjs';
import { createQuestionRepository } from './repositories/question-repository.mjs';
import { createSessionRepository } from './repositories/session-repository.mjs';

// failRecoveredRowTerminally fails a row every recovery path gives up on (the
// dead-worker sweep, the stale sweep, a consumed row, the Claude API fence).
// server-runtime.mjs boots a live server on import, so the function's own
// source is cut out of the file and run against a real database.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(startMarker, endMarker) {
  const start = runtimeSource.indexOf(startMarker);
  assert.notEqual(start, -1, `expected server-runtime.mjs to contain ${startMarker}`);
  const end = runtimeSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected ${endMarker} after ${startMarker}`);
  return runtimeSource.slice(start, end);
}

const failSource = sliceBetween('function failRecoveredRowTerminally(', '\n// The stale-turn sweep itself');
const AT = '2026-11-16T12:00:00.000Z';

function createFixture({ wrapStmts = (stmts) => stmts } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = wrapStmts({ ...createMessageRepository(db), ...createQuestionRepository(db), ...createSessionRepository(db) });
  const emitted = [];
  let nextId = 0;
  const { failRecoveredRowTerminally } = new Function(
    'db', 'stmts', 'io', 'uuidv4', 'relayEventService', 'runtimeLogPrefix', 'settleFailedRowControlsAndCards', 'formatQuestionRow',
    `${failSource}\nreturn { failRecoveredRowTerminally };`,
  )(
    db,
    stmts,
    { emit: (event, payload) => emitted.push({ event, payload }) },
    () => `reply-${(nextId += 1)}`,
    null,
    () => '',
    settleFailedRowControlsAndCards,
    (row) => ({ id: row.id, status: row.status }),
  );
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'Chat', ?, ?)`).run(AT, AT);
  db.prepare(`
    INSERT INTO queue (id, conversation_id, status, text, timestamp, processing_at, owner_sdk_session_id, retry_count)
    VALUES ('q-1', 'conv-1', 'processing', 'prompt', ?, ?, 'session-1', 0)
  `).run(AT, AT);
  const insertQuestion = db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, prompt, status, created_at, expires_at)
    VALUES (?, 'q-1', 'conv-1', 'q-1', 'Which one?', ?, ?, '2026-11-17T12:00:00.000Z')
  `);
  insertQuestion.run('card-open', 'pending', AT);
  insertQuestion.run('card-earlier-attempt', 'pending', AT);
  insertQuestion.run('card-answered', 'answered', AT);
  const insertControl = db.prepare(`
    INSERT INTO relay_control_requests (id, type, conversation_id, queue_message_id, status, created_at, updated_at)
    VALUES (?, ?, 'conv-1', 'q-1', ?, ?, ?)
  `);
  insertControl.run('stop-turn', 'abort_turn', 'pending', AT, AT);
  insertControl.run('stop-subagent', 'abort_subagent', 'processing', AT, AT);
  insertControl.run('stop-done', 'abort_turn', 'done', AT, AT);
  const row = () => db.prepare(`SELECT * FROM queue WHERE id = 'q-1'`).get();
  return {
    db,
    emitted,
    row,
    fail: (reason = 'worker-died-sweep', options = undefined) => failRecoveredRowTerminally(row(), reason, options),
    questions: () => Object.fromEntries(db.prepare(`SELECT id, status FROM relay_questions`).all().map((q) => [q.id, q.status])),
    controls: () => Object.fromEntries(db.prepare(`SELECT id, status FROM relay_control_requests`).all().map((c) => [c.id, c.status])),
  };
}

test("a failed row's open question cards and Stops end with it, and the cards are announced after the failure", () => {
  const fixture = createFixture();
  fixture.fail();

  assert.equal(fixture.row().status, 'failed');
  assert.deepEqual(fixture.questions(), { 'card-open': 'cancelled', 'card-earlier-attempt': 'cancelled', 'card-answered': 'answered' });
  assert.deepEqual(fixture.controls(), { 'stop-turn': 'failed', 'stop-subagent': 'failed', 'stop-done': 'done' });
  const events = fixture.emitted.map(({ event, payload }) => (event === 'relay_question_updated' ? `${event}:${payload.question.id}:${payload.question.status}` : event));
  assert.deepEqual(events, [
    'assistant_message',
    'message_status',
    'relay_question_updated:card-open:cancelled',
    'relay_question_updated:card-earlier-attempt:cancelled',
  ]);
});

test('a row that settled before its failure keeps its cards and Stops', () => {
  const fixture = createFixture();
  fixture.db.prepare(`UPDATE queue SET status = 'done' WHERE id = 'q-1'`).run();
  fixture.fail();

  assert.equal(fixture.row().status, 'done');
  assert.deepEqual(fixture.questions(), { 'card-open': 'pending', 'card-earlier-attempt': 'pending', 'card-answered': 'answered' });
  assert.deepEqual(fixture.controls(), { 'stop-turn': 'pending', 'stop-subagent': 'processing', 'stop-done': 'done' });
  assert.deepEqual(fixture.emitted, []);
});

test('the cards and Stops end in the failure\'s transaction: a failure that throws leaves all of it as it was', () => {
  const fixture = createFixture({
    wrapStmts: (stmts) => ({ ...stmts, updateConvTime: { run: () => { throw new Error('disk full'); } } }),
  });
  assert.throws(() => fixture.fail(), /disk full/);

  assert.equal(fixture.row().status, 'processing');
  assert.deepEqual(fixture.questions(), { 'card-open': 'pending', 'card-earlier-attempt': 'pending', 'card-answered': 'answered' });
  assert.deepEqual(fixture.controls(), { 'stop-turn': 'pending', 'stop-subagent': 'processing', 'stop-done': 'done' });
  assert.deepEqual(fixture.emitted, []);
});

test('the failure\'s log line names its cause: the record\'s code, or the recovery limit', () => {
  const lines = [];
  const warn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    createFixture().fail('worker-died-sweep', { failureRecord: { code: 'conversation-archived' }, failureText: 'Archived.' });
    createFixture().fail('stale-recovery');
  } finally {
    console.warn = warn;
  }
  assert.match(lines[0], /^FAILED conversation-archived q-1 conv=conv-1 retries=1 reason=worker-died-sweep$/);
  assert.match(lines[1], /^RECOVERY LIMIT q-1 conv=conv-1 retries=1 reason=stale-recovery$/);
});

test('the settle sits in the transaction, after the compare-and-set', () => {
  const fail = sliceBetween('function failRecoveredRowTerminally(', '\n}\n');
  const tx = fail.slice(fail.indexOf('const tx = db.transaction(() => {'), fail.indexOf('  });\n  if (!tx()) return;'));
  assert.notEqual(tx.indexOf('const tx = db.transaction(() => {'), -1);
  assert.ok(tx.indexOf('if (result.changes === 0) return false;') < tx.indexOf('cancelledQuestionIds = settleFailedRowControlsAndCards(stmts, row.id, now);'));
  assert.notEqual(tx.indexOf('settleFailedRowControlsAndCards('), -1, 'inside the transaction body');
  assert.ok(fail.indexOf('if (!tx()) return;') < fail.indexOf('announceCancelledQuestions(cancelledQuestionIds);'), 'announced after the commit');
  // The dead-worker sweep's continuation teardown ends its cards the same way.
  const sweep = sliceBetween('function recoverDeadWorkerProcessingRows(sessionId, reason) {', '\n}\n');
  assert.match(sweep, /db\.transaction\(\(\) => \(stmts\.dropStaleContinuation\.run\(row\.id\)\.changes \? settleFailedRowControlsAndCards\(stmts, row\.id, new Date\(\)\.toISOString\(\)\) : \[\]\)\)\(\);/);
  assert.match(sweep, /announceCancelledQuestions\(cardIds\);/);
});
