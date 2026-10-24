import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { RELAY_ASK_LIMITS, RELAY_ASK_SOCKET_EVENT } from '../../shared/relay-asks.mjs';
import { RelayAskError, createRelayAskService } from './relay-ask-service.mjs';

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const LEAD = 'conv-fixture-lead';
const WORKER = 'conv-fixture-worker';

function seed(db, id, title, { origin = null } = {}) {
  const at = new Date(T0 - 60_000).toISOString();
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at, origin_json) VALUES (?, ?, ?, ?, ?)`)
    .run(id, title, at, at, origin ? JSON.stringify(origin) : null);
}

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  seed(db, LEAD, 'Lead');
  seed(db, WORKER, 'Cache layer', { origin: { kind: 'agent', relayId: 'r-self', relayName: 'bench', conversationId: LEAD, local: true, hops: 0 } });
  let clock = T0;
  let counter = 0;
  const emitted = [];
  const asked = [];
  const answered = [];
  const pushed = [];
  const service = createRelayAskService({
    db,
    emit: (event, payload) => emitted.push({ event, payload }),
    relayEvents: {
      noteQuestion: (question) => asked.push(question),
      noteQuestionAnswered: (outcome) => answered.push(outcome),
    },
    pushQuestion: (question) => pushed.push(question),
    now: () => clock,
    newId: () => `ask_fixture${String(++counter).padStart(2, '0')}`,
    logger: { log() {}, warn() {} },
  });
  return { db, service, emitted, asked, answered, pushed, advance: (ms) => { clock += ms; } };
}

const QUESTION = { question: 'Which database?', options: ['Postgres', 'SQLite'], recommendation: 'sqlite', detail: '<script>alert(1)</script>' };

test('an ask is stored for its session, shown as kind ask, and told to the watchers of question_asked', () => {
  const { service, emitted, asked, pushed } = setup();
  const ask = service.create({ conversationId: WORKER, createdBy: LEAD, ...QUESTION });
  assert.equal(ask.id, 'ask_fixture01');
  assert.equal(ask.kind, 'ask');
  assert.equal(ask.status, 'pending');
  assert.deepEqual(ask.session, { id: WORKER, title: 'Cache layer', startedBy: 'agent' });
  assert.deepEqual(ask.options, ['Postgres', 'SQLite']);
  assert.equal(ask.recommendation, 'SQLite');
  assert.equal(ask.detail, '<script>alert(1)</script>', 'stored as the agent wrote it; shown as text');
  assert.deepEqual(ask.askedBy, { conversationId: LEAD, title: 'Lead' });
  assert.equal(ask.onBehalf, true);
  assert.equal(emitted.at(-1).event, RELAY_ASK_SOCKET_EVENT);
  assert.equal(emitted.at(-1).payload.pending, 1);
  assert.deepEqual(asked, [{ id: ask.id, conversationId: WORKER, prompt: 'Which database?', choices: ['Postgres', 'SQLite'], kind: 'ask' }]);
  assert.equal(pushed.length, 0, 'no push for a normal ask');
  service.create({ conversationId: LEAD, createdBy: LEAD, question: 'Now?', urgency: 'now' });
  assert.equal(pushed.length, 1, 'urgency now pushes');
  assert.equal(service.get('ask_fixture02').session.startedBy, 'owner');
});

test('an ask about an unknown or archived session, or one that is not valid, is refused', () => {
  const { db, service } = setup();
  assert.throws(() => service.create({ conversationId: 'conv-nope', createdBy: LEAD, question: 'Q' }), (error) => error instanceof RelayAskError && error.code === 'notFound');
  db.prepare(`UPDATE conversations SET archived = 1 WHERE id = ?`).run(WORKER);
  assert.throws(() => service.create({ conversationId: WORKER, createdBy: LEAD, question: 'Q' }), (error) => error.code === 'notFound');
  assert.throws(() => service.create({ conversationId: LEAD, createdBy: LEAD, question: '' }), (error) => error.code === 'invalid');
});

test('a conversation holds at most twenty pending asks', () => {
  const { service } = setup();
  for (let i = 0; i < RELAY_ASK_LIMITS.pendingPerConversation; i += 1) service.create({ conversationId: LEAD, createdBy: LEAD, question: `Q${i}?` });
  assert.throws(() => service.create({ conversationId: LEAD, createdBy: LEAD, question: 'One more?' }), (error) => error.code === 'limit');
  service.withdraw('ask_fixture01', { byConversationId: LEAD });
  assert.equal(service.create({ conversationId: LEAD, createdBy: LEAD, question: 'One more?' }).status, 'pending');
});

test('the answer closes it and tells the session and the conversation that asked', () => {
  const { service, answered, emitted } = setup();
  const ask = service.create({ conversationId: WORKER, createdBy: LEAD, ...QUESTION });
  const done = service.answer(ask.id, { choice: 'sqlite', answer: 'SQLite, for now' });
  assert.equal(done.status, 'answered');
  assert.equal(done.answer, 'SQLite, for now');
  assert.equal(done.choice, 'SQLite');
  assert.deepEqual(answered, [{
    sessionId: WORKER,
    notify: [WORKER, LEAD],
    // No via: this relay's own UI (the event service names this relay).
    detail: { questionId: ask.id, prompt: 'Which database?', answer: 'SQLite, for now', choice: 'SQLite' },
  }]);
  assert.equal(emitted.at(-1).payload.pending, 0);
  assert.throws(() => service.answer(ask.id, { choice: 'Postgres' }), (error) => error.code === 'closed');
  assert.throws(() => service.dismiss(ask.id), (error) => error.code === 'closed');
  assert.throws(() => service.answer('ask_nope01', { answer: 'x' }), (error) => error.code === 'notFound');
});

test('an answer that is no option, or empty, is refused and the ask stays open', () => {
  const { service, answered } = setup();
  const ask = service.create({ conversationId: LEAD, createdBy: LEAD, ...QUESTION });
  assert.throws(() => service.answer(ask.id, { choice: 'MySQL' }), (error) => error.code === 'invalid');
  assert.throws(() => service.answer(ask.id, {}), (error) => error.code === 'invalid');
  assert.equal(service.get(ask.id).status, 'pending');
  assert.equal(answered.length, 0);
});

test('a dismissal tells the askers there will be no answer; a withdrawal tells nobody', () => {
  const { service, answered } = setup();
  const first = service.create({ conversationId: LEAD, createdBy: LEAD, question: 'Deploy?' });
  assert.equal(service.dismiss(first.id).status, 'dismissed');
  assert.deepEqual(answered.at(-1), { sessionId: LEAD, notify: [LEAD], detail: { questionId: first.id, prompt: 'Deploy?', dismissed: true } });
  const second = service.create({ conversationId: WORKER, createdBy: LEAD, question: 'Rename?' });
  assert.throws(() => service.withdraw(second.id, { byConversationId: WORKER }), (error) => error.code === 'forbidden', 'only the conversation that asked');
  assert.equal(service.withdraw(second.id, { byConversationId: LEAD }).status, 'withdrawn');
  assert.equal(answered.length, 1);
});

test('the Inbox lists pending and recently closed asks, newest first; closed ones go after a day', () => {
  const { service, advance } = setup();
  const old = service.create({ conversationId: LEAD, createdBy: LEAD, question: 'Old?' });
  advance(1000);
  service.create({ conversationId: WORKER, createdBy: LEAD, question: 'New?' });
  service.answer(old.id, { answer: 'yes' });
  assert.deepEqual(service.listHere().map((ask) => [ask.question, ask.status]), [['New?', 'pending'], ['Old?', 'answered']]);
  advance(RELAY_ASK_LIMITS.answeredKeepMs + 1);
  assert.deepEqual(service.listHere().map((ask) => ask.question), ['New?']);
  assert.equal(service.pendingCount(), 1);
});

test('list_questions shows the asks in a conversation and those it asked, pending first', () => {
  const { service } = setup();
  const own = service.create({ conversationId: LEAD, createdBy: LEAD, question: 'Mine?' });
  service.create({ conversationId: WORKER, createdBy: LEAD, question: 'For the worker?' });
  service.answer(own.id, { answer: 'yes' });
  assert.deepEqual(service.listOf(LEAD).map((ask) => ask.question), ['For the worker?', 'Mine?']);
  assert.deepEqual(service.listOf(WORKER).map((ask) => ask.question), ['For the worker?']);
});

test('archiving the session cancels its pending asks; a compaction moves them', () => {
  const { db, service } = setup();
  const ask = service.create({ conversationId: WORKER, createdBy: LEAD, question: 'Q?' });
  seed(db, 'conv-fixture-next', 'Lead (compacted)');
  assert.equal(service.carryToCompacted(LEAD, 'conv-fixture-next'), 1);
  assert.equal(service.get(ask.id).askedBy.conversationId, 'conv-fixture-next');
  assert.equal(service.noteConversationGone(WORKER), 1);
  assert.equal(service.get(ask.id).status, 'cancelled');
});

test('a paired relay\'s agent asks here; that relay alone reads the outcome, and may withdraw it', () => {
  const { service, answered } = setup();
  const ask = service.create({
    conversationId: WORKER,
    creator: { relayId: 'instance-lab', relayName: 'lab-relay\n', conversationId: 'conv-far', conversationTitle: 'Far lead', extra: 'dropped' },
    question: 'Ship?',
    options: ['Yes', 'No'],
  });
  assert.deepEqual(ask.askedBy, { relay: 'lab-relay', conversationId: 'conv-far', title: 'Far lead' });
  assert.equal(ask.onBehalf, true);
  assert.deepEqual(service.statusForRelay({ relayId: 'instance-lab', ids: [ask.id] })[0].status, 'pending');
  assert.deepEqual(service.statusForRelay({ relayId: 'instance-other', ids: [ask.id, 'ask_nope01'] }).map((entry) => entry.status), ['unknown', 'unknown']);
  service.answer(ask.id, { choice: 'Yes', via: 'lab-relay' });
  assert.deepEqual(answered.at(-1).notify, [WORKER], 'the session here is told; the paired relay fetches its own');
  assert.equal(answered.at(-1).detail.via, 'lab-relay', 'and where the answer came from');
  const [state] = service.statusForRelay({ relayId: 'instance-lab', ids: [ask.id] });
  assert.equal(state.status, 'answered');
  assert.equal(state.answer, 'Yes');
  assert.equal(state.answeredVia, 'lab-relay');
  assert.equal(service.get(ask.id).answeredVia, 'lab-relay');
  const second = service.create({ conversationId: WORKER, creator: { relayId: 'instance-lab' }, question: 'Again?' });
  assert.throws(() => service.withdraw(second.id, { byRelayId: 'instance-other' }), (error) => error.code === 'forbidden');
  assert.equal(service.withdraw(second.id, { byRelayId: 'instance-lab' }).status, 'withdrawn');
});

test('a mirror of an ask on a paired relay is closed by that relay\'s status, and its asker told', () => {
  const { service, answered } = setup();
  const mirror = service.addMirror({
    relayId: 'relay-lab',
    createdBy: LEAD,
    remote: { id: 'ask_there01', question: 'Deploy?', options: ['Yes', 'No'], session: { id: 'conv-there', title: 'Far worker' } },
  });
  assert.equal(mirror.id, 'ask_there01');
  assert.equal(mirror.relayId, 'relay-lab');
  assert.deepEqual(service.mirrorRelays(), ['relay-lab']);
  assert.deepEqual(service.pendingMirrorIds('relay-lab'), ['ask_there01']);
  assert.equal(service.applyRemoteStatus('relay-lab', { relayName: 'lab', statuses: [{ id: 'ask_there01', status: 'pending' }] }), 0);
  assert.equal(service.applyRemoteStatus('relay-lab', { relayName: 'lab', statuses: [{ id: 'ask_there01', status: 'answered', answer: 'Yes', choice: 'Yes', answeredVia: 'bench-relay' }] }), 1);
  assert.deepEqual(answered.at(-1), {
    sessionId: 'conv-there',
    sessionTitle: 'Far worker',
    relay: { id: 'relay-lab', name: 'lab' },
    notify: [LEAD],
    detail: { questionId: 'ask_there01', prompt: 'Deploy?', answer: 'Yes', choice: 'Yes', via: 'bench-relay' },
  });
  assert.equal(service.getMirror('relay-lab', 'ask_there01').answeredVia, 'bench-relay');
  assert.equal(service.getMirror('relay-lab', 'ask_there01').status, 'answered');
  assert.deepEqual(service.mirrorRelays(), []);
  assert.equal(service.listOf(LEAD)[0].id, 'ask_there01', 'list_questions shows it');
  assert.equal(service.listHere().length, 0, 'the Inbox lists only this relay\'s own');
  // Withdrawn there: closed here, nobody told.
  service.addMirror({ relayId: 'relay-lab', createdBy: LEAD, remote: { id: 'ask_there02', question: 'Again?', session: { id: 'conv-there' } } });
  service.applyRemoteStatus('relay-lab', { statuses: [{ id: 'ask_there02', status: 'unknown' }] });
  assert.equal(service.getMirror('relay-lab', 'ask_there02').status, 'cancelled');
  assert.equal(answered.length, 1);
});
