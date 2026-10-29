import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import {
  RESTART_RESUME_KIND,
  buildRestartResumeNoteText,
  createRestartResumeService,
  parseRestartResumeUpdate,
  readRestartResumeSetting,
} from './restart-resume-service.mjs';

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const quiet = { log() {}, warn() {} };

function seedConversation(db, id, { archived = 0 } = {}) {
  const at = new Date(T0 - 60 * 60_000).toISOString();
  db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, archived, created_at, updated_at) VALUES (?, 'Orbit camera', 'agent', ?, ?, ?)`).run(id, archived, at, at);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, provider_model, created_at, last_used_at)
    VALUES (?, ?, ?, ?, 'claude-sonnet-5', 'claude', 'claude-sonnet-5', ?, ?)
  `).run(`rs-${id}`, id, `sdk-${id}`, `key-${id}`, at, at);
}

// A queue row as the runtime before left it.
function seedRow(db, id, conversationId, { status = 'processing', minutesAgo = 5, kind = null, consumed = false, text = 'Fix the orbit camera' } = {}) {
  const at = new Date(T0 - minutesAgo * 60_000).toISOString();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, model, mode, timestamp) VALUES (?, ?, 'user', ?, 'claude-sonnet-5', 'agent', ?)`).run(id, conversationId, text, at);
  db.prepare(`
    INSERT INTO queue (id, conversation_id, runtime_session_id, is_new_conversation, model, model_variant_id, relay_mode, text, status, timestamp,
      processing_at, retry_count, owner_sdk_session_id, kind, consumed_at)
    VALUES (?, ?, ?, 0, 'claude-sonnet-5', 'claude-sonnet-5-high', 'agent', ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(id, conversationId, `rs-${conversationId}`, text, status, at, status === 'processing' ? at : null, `sdk-${conversationId}`, kind, consumed ? at : null);
  return { id, conversation_id: conversationId };
}

function setup({ enabled = true } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  let clock = T0;
  let on = enabled;
  const emitted = [];
  const wakes = [];
  const lines = [];
  const make = () => createRestartResumeService({
    db,
    stmts,
    isEnabled: () => on,
    emit: (event, payload) => emitted.push({ event, payload }),
    wake: (wake) => wakes.push(wake),
    now: () => clock,
    bootAt: T0,
    logger: { log: (line) => lines.push(line), warn() {} },
  });
  return {
    db,
    stmts,
    make,
    emitted,
    wakes,
    lines,
    setEnabled: (value) => { on = value; },
    tick: (ms) => { clock += ms; },
    settleRow: (id, status) => db.prepare(`UPDATE queue SET status = ? WHERE id = ?`).run(status, id),
  };
}

function notes(db, conversationId) {
  return db.prepare(`
    SELECT m.id, m.role, m.kind, m.text, q.status, q.model, q.model_variant_id, q.relay_mode, q.owner_sdk_session_id, q.timestamp
    FROM messages m JOIN queue q ON q.id = m.id
    WHERE m.conversation_id = ? AND m.kind = ? ORDER BY m.timestamp ASC
  `).all(conversationId, RESTART_RESUME_KIND);
}

test('the setting is off unless switched on, and takes only a boolean', () => {
  assert.equal(readRestartResumeSetting(undefined), false);
  assert.equal(readRestartResumeSetting(''), false);
  assert.equal(readRestartResumeSetting('0'), false);
  assert.equal(readRestartResumeSetting('1'), true);
  assert.deepEqual(parseRestartResumeUpdate(true), { ok: true, enabled: true });
  assert.equal(parseRestartResumeUpdate('yes').ok, false);
});

test('the note says when the relay restarted, asks to carry on, and does not quote the user', () => {
  const text = buildRestartResumeNoteText({ restartedAt: T0 });
  assert.match(text, /^Automatic message from OAR, not from the user: the relay restarted at 2026-03-02 10:00 UTC/);
  assert.match(text, /interrupted/);
  assert.match(text, /carry on/);
});

test('a turn cut off by the restart gets one note, queued behind what is queued, with the turn\'s model and owner', () => {
  const env = setup();
  seedConversation(env.db, 'conv-a');
  const cut = seedRow(env.db, 'q-cut', 'conv-a');
  // The user queued another message while the relay was away.
  seedRow(env.db, 'q-user', 'conv-a', { status: 'pending', minutesAgo: 1, text: 'And the zoom too' });
  const service = env.make();
  assert.equal(service.captureBoot(), 1);

  env.settleRow('q-cut', 'failed');
  assert.equal(service.noteOutcome(cut, 'cut'), true);
  const [note] = notes(env.db, 'conv-a');
  assert.ok(note, 'a note is queued');
  assert.equal(note.role, 'user');
  assert.equal(note.status, 'pending');
  assert.equal(note.model_variant_id, 'claude-sonnet-5-high');
  assert.equal(note.relay_mode, 'agent');
  assert.equal(note.owner_sdk_session_id, 'sdk-conv-a');
  assert.equal(note.text, buildRestartResumeNoteText({ restartedAt: T0 }));
  const queued = env.db.prepare(`SELECT id FROM queue WHERE conversation_id = 'conv-a' AND status = 'pending' ORDER BY timestamp ASC, rowid ASC`).all().map((row) => row.id);
  assert.deepEqual(queued, ['q-user', note.id], 'never ahead of a queued user message');
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM queue WHERE text = 'Fix the orbit camera'`).get().n, 1, 'the user\'s message is not sent again');
  assert.deepEqual(env.emitted.map((entry) => entry.event), ['user_message', 'message_status']);
  assert.equal(env.emitted[0].payload.message.kind, RESTART_RESUME_KIND);
  assert.deepEqual(env.wakes, [{ conversationId: 'conv-a', ownerSessionId: 'sdk-conv-a', messageId: note.id }]);

  // Once: the same row again, a later sweep, nothing more.
  assert.equal(service.noteOutcome(cut, 'cut'), false);
  service.tick();
  assert.equal(notes(env.db, 'conv-a').length, 1);
});

test('one note per session even when several of its turns were cut off', () => {
  const env = setup();
  seedConversation(env.db, 'conv-a');
  const continuation = seedRow(env.db, 'q-cont', 'conv-a', { kind: 'continuation', text: '' });
  const steer = seedRow(env.db, 'q-steer', 'conv-a', { consumed: true, minutesAgo: 2 });
  const service = env.make();
  service.captureBoot();
  env.settleRow('q-cont', 'failed');
  service.noteOutcome(continuation, 'cut');
  assert.equal(notes(env.db, 'conv-a').length, 0, 'waits while a turn of the start is still processing');
  env.settleRow('q-steer', 'failed');
  service.noteOutcome(steer, 'cut');
  assert.equal(notes(env.db, 'conv-a').length, 1);
});

test('nothing for a turn that is requeued and runs again by itself', () => {
  const env = setup();
  seedConversation(env.db, 'conv-a');
  seedConversation(env.db, 'conv-b');
  const turn = seedRow(env.db, 'q-turn', 'conv-a');
  const steer = seedRow(env.db, 'q-steer', 'conv-a', { consumed: true, minutesAgo: 2 });
  seedRow(env.db, 'q-other', 'conv-b');
  const service = env.make();
  service.captureBoot();
  // The dead worker's turn goes back to the queue; the steer it had taken fails.
  env.settleRow('q-turn', 'pending');
  service.noteOutcome(turn, 'requeued');
  env.settleRow('q-steer', 'failed');
  service.noteOutcome(steer, 'cut');
  assert.equal(notes(env.db, 'conv-a').length, 0);
  // A requeue no path reported is seen in the queue.
  env.settleRow('q-other', 'pending');
  service.tick();
  assert.equal(notes(env.db, 'conv-b').length, 0);
  assert.deepEqual(service.pending(), []);
});

test('nothing for a turn whose worker lived through the restart and finished it', () => {
  const env = setup();
  seedConversation(env.db, 'conv-a');
  seedRow(env.db, 'q-turn', 'conv-a');
  const service = env.make();
  service.captureBoot();
  service.tick();
  assert.deepEqual(service.pending(), ['conv-a'], 'still running');
  env.settleRow('q-turn', 'done');
  service.tick();
  assert.deepEqual(service.pending(), []);
  assert.equal(notes(env.db, 'conv-a').length, 0);
});

test('nothing for idle sessions, nor for turns that started after the restart', () => {
  const env = setup();
  seedConversation(env.db, 'conv-idle');
  seedRow(env.db, 'q-old', 'conv-idle', { status: 'done' });
  const service = env.make();
  assert.equal(service.captureBoot(), 0);
  const later = seedRow(env.db, 'q-new', 'conv-idle', { minutesAgo: 0 });
  env.settleRow('q-new', 'failed');
  assert.equal(service.noteOutcome(later, 'cut'), false);
  assert.equal(notes(env.db, 'conv-idle').length, 0);
});

test('nothing when the setting is off at the moment the note would go', () => {
  const env = setup({ enabled: false });
  seedConversation(env.db, 'conv-a');
  const cut = seedRow(env.db, 'q-cut', 'conv-a');
  const service = env.make();
  service.captureBoot();
  env.settleRow('q-cut', 'failed');
  service.noteOutcome(cut, 'cut');
  assert.equal(notes(env.db, 'conv-a').length, 0);
  assert.ok(env.lines.some((line) => line.includes('the setting is off')));
  assert.deepEqual(env.wakes, []);
});

test('nothing for an archived conversation, or one held at the usage limit', () => {
  const env = setup();
  seedConversation(env.db, 'conv-archived', { archived: 1 });
  seedConversation(env.db, 'conv-paused');
  const archived = seedRow(env.db, 'q-a', 'conv-archived');
  const paused = seedRow(env.db, 'q-p', 'conv-paused');
  // The usage-limit follow-up, held until the window resets.
  seedRow(env.db, 'q-follow', 'conv-paused', { status: 'pending', minutesAgo: 1 });
  env.db.prepare(`UPDATE queue SET usage_limit_pause = '{"auto":true}', next_attempt_at = ? WHERE id = 'q-follow'`).run(new Date(T0 + 3_600_000).toISOString());
  const service = env.make();
  service.captureBoot();
  for (const row of [archived, paused]) {
    env.settleRow(row.id, 'failed');
    service.noteOutcome(row, 'cut');
  }
  assert.equal(notes(env.db, 'conv-archived').length, 0);
  assert.equal(notes(env.db, 'conv-paused').length, 0);
});

test('a turn that failed for another reason (the retry budget) gets no note', () => {
  const env = setup();
  seedConversation(env.db, 'conv-a');
  const turn = seedRow(env.db, 'q-turn', 'conv-a');
  const continuation = seedRow(env.db, 'q-cont', 'conv-a', { kind: 'continuation' });
  const service = env.make();
  service.captureBoot();
  env.settleRow('q-turn', 'failed');
  service.noteOutcome(turn, 'failed');
  env.settleRow('q-cont', 'failed');
  service.noteOutcome(continuation, 'cut');
  assert.equal(notes(env.db, 'conv-a').length, 0);
});

test('a later runtime starts its own watch: a second restart may note the session again, the same one never', () => {
  const env = setup();
  seedConversation(env.db, 'conv-a');
  const cut = seedRow(env.db, 'q-cut', 'conv-a');
  const first = env.make();
  first.captureBoot();
  env.settleRow('q-cut', 'failed');
  first.noteOutcome(cut, 'cut');
  assert.equal(notes(env.db, 'conv-a').length, 1);
  // The note itself was running when the relay restarted again, and was cut off.
  const [note] = notes(env.db, 'conv-a');
  env.settleRow(note.id, 'processing');
  const second = env.make();
  assert.equal(second.captureBoot(), 1);
  env.settleRow(note.id, 'failed');
  second.noteOutcome({ id: note.id }, 'cut');
  assert.equal(notes(env.db, 'conv-a').length, 2);
});

test('the watch ends after its window', () => {
  const env = setup();
  seedConversation(env.db, 'conv-a');
  const cut = seedRow(env.db, 'q-cut', 'conv-a');
  const service = env.make();
  service.captureBoot();
  env.tick(31 * 60_000);
  service.tick();
  assert.deepEqual(service.pending(), []);
  env.settleRow('q-cut', 'failed');
  assert.equal(service.noteOutcome(cut, 'cut'), false);
  assert.equal(notes(env.db, 'conv-a').length, 0);
});

test('a turn whose worker lived through the restart and claimed it is not the restart\'s: a cut ten minutes later gets no note', () => {
  const env = setup();
  seedConversation(env.db, 'conv-a');
  const turn = seedRow(env.db, 'q-turn', 'conv-a');
  const service = env.make();
  service.captureBoot();
  // The surviving worker's heartbeat lists the turn.
  assert.equal(service.noteOutcome(turn, 'claimed'), true);
  service.tick();
  assert.deepEqual(service.pending(), []);
  // Later the worker crashes and the turn is failed as not replayable.
  env.tick(10 * 60_000);
  env.settleRow('q-turn', 'failed');
  assert.equal(service.noteOutcome(turn, 'cut'), false);
  service.tick();
  assert.equal(notes(env.db, 'conv-a').length, 0);
});

test('a session whose worker claimed one of its turns gets no note for another one cut off', () => {
  const env = setup();
  seedConversation(env.db, 'conv-a');
  const turn = seedRow(env.db, 'q-turn', 'conv-a');
  const continuation = seedRow(env.db, 'q-cont', 'conv-a', { kind: 'continuation', minutesAgo: 2 });
  const service = env.make();
  service.captureBoot();
  service.noteOutcome(turn, 'claimed');
  env.settleRow('q-cont', 'failed');
  service.noteOutcome(continuation, 'cut');
  assert.equal(notes(env.db, 'conv-a').length, 0, 'the worker lived through the restart');
  assert.deepEqual(service.pending(), []);
});

test('on a plan-only session a cut turn goes on in plan, the "Approve plan" turn in the agent mode it ran in', () => {
  const APPROVE = 'Plan approved by the user. Do not implement. Finish only the plan-only steps you were given, then stop.';
  for (const [text, expected] of [['Fix the orbit camera', 'plan'], [APPROVE, 'agent']]) {
    const env = setup();
    seedConversation(env.db, 'conv-a');
    env.db.prepare(`UPDATE conversations SET plan_only = 1, preferred_relay_mode = 'plan' WHERE id = 'conv-a'`).run();
    const cut = seedRow(env.db, 'q-cut', 'conv-a', { text });
    const service = env.make();
    service.captureBoot();
    env.settleRow('q-cut', 'failed');
    assert.equal(service.noteOutcome(cut, 'cut'), true);
    const [note] = notes(env.db, 'conv-a');
    assert.equal(note.relay_mode, expected, text);
    assert.equal(env.db.prepare(`SELECT preferred_relay_mode FROM conversations WHERE id = 'conv-a'`).get().preferred_relay_mode, 'plan');
  }
});