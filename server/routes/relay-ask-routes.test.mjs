import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createConversationGroupRepository } from '../repositories/conversation-group-repository.mjs';
import { createRelayAskService } from '../services/relay-ask-service.mjs';
import { markRemoteRelayLoopbackRequest } from '../services/remote-relay-inbound.mjs';
import { asAgent, asOwner, asPeer } from '../services/relay-principal-test-harness.mjs';
import { RELAY_ASK_REMOTE_PATHS } from '../services/relay-ask-link-service.mjs';
import { REMOTE_RELAY_ERROR_CODES as CODES } from '../../shared/remote-relay-contract.mjs';
import { questionExpiresAt } from '../../shared/question-timeout.mjs';
import { registerAskUserRoutes } from './ask-user-routes.mjs';
import { registerRelayAskRoutes } from './relay-ask-routes.mjs';
import { createPushDispatchService } from '../services/push-dispatch-service.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The routes of questions that don't block: the browser's (the session's
// cards, the Inbox), the question routes an ask's id goes through, and the
// paired relays' (ask, status, withdraw, answer from their Inbox). An answer
// over the pairing is taken for an ask only, never for a card.

const SESSION = 'conv-fixture-worker';
const LEAD = 'conv-fixture-lead';
const NOW = '2026-03-02T10:00:00.000Z';
const PAIRED = { id: 'r-lab', relayId: 'instance-lab', name: 'lab-relay', url: 'https://relay-b.example.test', lastStatus: 'online' };
const FROM_PAIRED = { 'x-oar-remote-origin': PAIRED.relayId, 'x-oar-remote-hops': '1' };
// A second paired relay (its own key too).
const OTHER = { id: 'r-other', relayId: 'instance-other', name: 'other-relay', url: 'https://relay-d.example.test', lastStatus: 'online' };

function seed(db) {
  for (const [id, title] of [[SESSION, 'Cache layer'], [LEAD, 'Lead']]) {
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, title, NOW, NOW);
  }
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES ('q-turn', ?, 'go', 'processing', ?)`).run(SESSION, NOW);
  const insertCard = db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, relay_mode, prompt, choices, request, status, created_at, expires_at)
    VALUES (?, 'q-turn', ?, 'q-turn', 'agent', ?, ?, ?, 'pending', ?, '2999-01-01T00:00:00.000Z')
  `);
  insertCard.run('card-approval', SESSION, 'Allow send to linux-test: "Rebuild the sidebar"?', JSON.stringify(['Allow', 'Deny']),
    JSON.stringify({ request: null, context: { source: 'remote_relay', header: 'Remote relay' }, allowFreeform: false }), NOW);
  insertCard.run('card-ask-user', SESSION, 'Which theme?', JSON.stringify(['Light', 'Dark']),
    JSON.stringify({ request: null, context: null, allowFreeform: true }), NOW);
}

function formatQuestionRow(row) {
  if (!row) return null;
  const envelope = JSON.parse(row.request || '{}') || {};
  return {
    id: row.id,
    queueId: row.queue_id,
    conversationId: row.conversation_id,
    sdkSessionId: row.sdk_session_id || null,
    messageId: row.message_id,
    prompt: row.prompt,
    choices: JSON.parse(row.choices || '[]'),
    context: envelope.context || null,
    allowFreeform: envelope.allowFreeform ?? true,
    requestSchema: null,
    status: row.status,
    answer: row.answer || null,
    createdAt: row.created_at,
    answeredAt: row.answered_at || null,
  };
}

function boot({ inboundEnabled = true, client = null, boards = false, questionNotice = null, pairedRelays = null, pushQuestion = undefined } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  seed(db);
  const stmts = createQuestionRepository(db);
  const groups = createConversationGroupRepository(db);
  const told = [];
  const asks = createRelayAskService({
    db,
    relayEvents: { noteQuestion() {}, noteQuestionAnswered: (outcome) => told.push(outcome) },
    ...(pushQuestion ? { pushQuestion } : {}),
    logger: { log() {}, warn() {} },
  });
  const remoteRelayInbound = {
    listRelays: () => [PAIRED, OTHER],
    selfNames: () => ['bench-relay'],
    inboundEnabled: () => inboundEnabled,
  };
  const calls = [];
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (path, ...handlers) => routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1));
  }
  const deps = {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db,
    stmts,
    runtimeState: {},
    uuidv4: () => 'unused',
    ts: () => NOW,
    questionExpiresAt,
    sanitizeRelayQuestionPrompt: ({ prompt }) => String(prompt || ''),
    sanitizeRelayQuestionRequest: () => null,
    sanitizeRelayQuestionContext: () => null,
    parseQuestionRequest: (value) => { try { return JSON.parse(value); } catch { return null; } },
    normalizeQuestionChoices: (choices) => (Array.isArray(choices) ? choices.map(String) : []),
    formatQuestionRow,
    conversationGroups: groups,
    ...(boards ? { formatRelayBoardRow: (row) => formatBoardRow(db, row) } : {}),
    ...(questionNotice ? { questionNotice } : {}),
    normalizeRelayMode: (mode) => String(mode || '').trim() || null,
    DEFAULT_RELAY_MODE: 'agent',
    remoteRelayInbound,
    relayAskService: asks,
    remoteRelayRegistry: {
      selfName: () => 'bench-relay',
      list: () => pairedRelays || [PAIRED, { id: 'r-gone', name: 'gone-relay', url: 'https://relay-c.example.test', lastStatus: 'offline' }],
      get: (id) => (id === PAIRED.id ? PAIRED : null),
    },
    remoteRelayClient: client && {
      async request(relay, method, path, options = {}) {
        calls.push({ relay: relay.id, method, path, body: options.body });
        return client(relay, method, path, options);
      },
    },
  };
  registerAskUserRoutes(app, deps);
  registerRelayAskRoutes(app, deps);
  async function call(method, path, { body = {}, headers = {}, params = {}, query = {}, loopback = false, ownerToken = false } = {}) {
    const handler = routes.get(`${method} ${path}`);
    assert.ok(handler, `${method} ${path} is registered`);
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    const req = { body, headers, params, query };
    // Who `auth` would have said is calling: this relay's own relay_tool (the
    // loopback) carries the calling agent's token; a paired relay its own key
    // (the entry its origin header names); everyone else the owner token (a
    // relay this one does not list, or an older one: its claim is unverified).
    const claimed = String(headers['x-oar-remote-origin'] || '');
    const pairedEntry = [PAIRED, OTHER].find((entry) => claimed && entry.relayId === claimed) || null;
    if (loopback) asAgent(markRemoteRelayLoopbackRequest(req), body?.origin?.conversationId || 'loopback-caller');
    else if (pairedEntry && !ownerToken) asPeer(req, pairedEntry);
    else asOwner(req);
    await handler(req, res);
    // The Inbox routes answer after an await of their own.
    await new Promise((resolve) => setImmediate(resolve));
    return captured;
  }
  const card = (id) => db.prepare(`SELECT status, answer FROM relay_questions WHERE id = ?`).get(id);
  return { db, stmts, groups, asks, told, calls, call, card };
}

// As server-runtime.mjs formats a board row, reduced to what the Inbox reads.
function formatBoardRow(db, row) {
  if (!row) return null;
  const conversation = db.prepare(`SELECT plan_only FROM conversations WHERE id = ?`).get(row.conversation_id);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    boardType: row.board_type,
    title: row.title,
    body: row.body,
    actions: JSON.parse(row.actions_json || '[]'),
    recommendedAction: row.recommended_action || null,
    status: row.status,
    selectedAction: row.selected_action || null,
    actedAt: row.acted_at || null,
    createdAt: row.created_at,
    planOnly: Number(conversation?.plan_only) === 1,
  };
}

let boardCounter = 0;
function seedBoard(db, { conversationId = SESSION, status = 'pending', boardType = 'plan_ready', createdAt = NOW, actedAt = null, title = 'Plan ready for review', body = '1. Split the parser' } = {}) {
  boardCounter += 1;
  const id = `board-${boardCounter}`;
  db.prepare(`
    INSERT INTO relay_boards (id, queue_id, conversation_id, message_id, board_type, relay_mode, title, body, actions_json, recommended_action, context_json, status, selected_action, acted_at, created_at, updated_at)
    VALUES (?, 'q-turn', ?, ?, ?, 'plan', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
  `).run(id, conversationId, `msg-${id}`, boardType, title, body, JSON.stringify([{ id: 'approve_only', label: 'Approve plan' }, { id: 'autopilot', label: 'Implement in autopilot' }]),
    status, status === 'pending' ? null : 'approve_only', actedAt, createdAt, createdAt);
  return id;
}

const QUESTION = { question: 'Which database?', options: ['Postgres', 'SQLite'], detail: '<img src=x onerror=alert(1)>' };

test('an approval-kind answer sent with the pairing token is refused, and the card stays open', async () => {
  const fx = boot();
  // The route paired relays answered asks through is closed: nothing is
  // answered over the pairing (agent auth §2.2).
  for (const id of ['card-approval', 'card-ask-user']) {
    const answered = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.answer, { headers: FROM_PAIRED, body: { id, choice: 'Allow', answer: 'Allow' } });
    assert.equal(answered.status, 403, id);
    assert.equal(answered.body.code, 'REMOTE_RELAY_PEER_SCOPE');
    const dismissed = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.dismiss, { headers: FROM_PAIRED, body: { id } });
    assert.equal(dismissed.status, 403, id);
  }
  // Through the question route with the pairing's headers, or an origin in the body.
  const direct = await fx.call('POST', '/api/relay-question/:id/answer', { headers: FROM_PAIRED, params: { id: 'card-approval' }, body: { answer: 'Allow' } });
  assert.equal(direct.status, 403);
  const bodyOrigin = await fx.call('POST', '/api/relay-question/:id/answer', { params: { id: 'card-approval' }, body: { answer: 'Allow', origin: { relayId: PAIRED.relayId, relayName: 'lab', hops: 1 } } });
  assert.equal(bodyOrigin.status, 403);
  assert.deepEqual({ ...fx.card('card-approval') }, { status: 'pending', answer: null });
  // A card cannot be dismissed at all; the user answers it in its session.
  assert.equal((await fx.call('POST', '/api/relay-question/:id/dismiss', { params: { id: 'card-approval' } })).status, 400);
  assert.equal(fx.card('card-approval').status, 'pending');
});

test('an ask is answered and dismissed through the question routes by the user, never by an agent', async () => {
  const fx = boot();
  const ask = fx.asks.create({ conversationId: SESSION, createdBy: LEAD, ...QUESTION });
  const fromAgent = await fx.call('POST', '/api/relay-question/:id/answer', { headers: FROM_PAIRED, params: { id: ask.id }, body: { answer: 'SQLite' } });
  assert.equal(fromAgent.status, 403);
  assert.match(fromAgent.body.error, /Only the person can answer questions/);
  assert.equal(fromAgent.body.code, 'AUTH_PERSON_REQUIRED');
  const fromOwnAgent = await fx.call('POST', '/api/relay-question/:id/answer', { loopback: true, headers: { 'x-oar-remote-origin': 'instance-self' }, params: { id: ask.id }, body: { answer: 'SQLite' } });
  assert.equal(fromOwnAgent.status, 403, 'this relay\'s own agents neither');
  assert.equal(fx.asks.get(ask.id).status, 'pending');
  const wrong = await fx.call('POST', '/api/relay-question/:id/answer', { params: { id: ask.id }, body: { choice: 'MySQL' } });
  assert.equal(wrong.status, 400);
  const answered = await fx.call('POST', '/api/relay-question/:id/answer', { params: { id: ask.id }, body: { answer: 'sqlite' } });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.question.status, 'answered');
  assert.equal(answered.body.question.choice, 'SQLite');
  assert.equal(fx.told.length, 1);
  const again = await fx.call('POST', '/api/relay-question/:id/answer', { params: { id: ask.id }, body: { answer: 'Postgres' } });
  assert.equal(again.status, 409);
  const second = fx.asks.create({ conversationId: SESSION, createdBy: LEAD, question: 'Rename it?' });
  const dismissed = await fx.call('POST', '/api/relay-question/:id/dismiss', { params: { id: second.id } });
  assert.equal(dismissed.body.question.status, 'dismissed');
  assert.equal(fx.told.at(-1).detail.dismissed, true);
  assert.equal((await fx.call('GET', '/api/relay-question/:id', { params: { id: second.id } })).body.question.kind, 'ask');
});

test('/api/relay-questions names each card\'s kind, and lists asks only when asked to', async () => {
  const fx = boot();
  const ask = fx.asks.create({ conversationId: SESSION, createdBy: LEAD, ...QUESTION });
  const plain = await fx.call('GET', '/api/relay-questions', { query: { conversationId: SESSION } });
  assert.deepEqual(plain.body.questions.map((question) => [question.id, question.kind]).sort(), [['card-approval', 'approval'], ['card-ask-user', 'ask_user']]);
  const all = await fx.call('GET', '/api/relay-questions', { query: { conversationId: SESSION, includeAsks: '1' } });
  assert.deepEqual(all.body.questions.map((question) => question.kind).sort(), ['approval', 'ask', 'ask_user']);
  const asAgent = await fx.call('GET', '/api/relay-questions', { headers: FROM_PAIRED, query: { conversationId: SESSION, includeAsks: '1' } });
  assert.deepEqual(asAgent.body.questions.map((question) => question.id).sort(), [ask.id, 'card-ask-user'].sort(), 'the approval card stays hidden');
  assert.equal(asAgent.body.questions.find((question) => question.id === ask.id).detail, QUESTION.detail, 'agent text goes out as data');
});

test('a paired relay\'s read of the questions never carries the asking turn\'s queue id; this relay\'s does', async () => {
  const fx = boot();
  const ask = fx.asks.create({ conversationId: SESSION, createdBy: SESSION, queueId: 'q-tern-7', ...QUESTION });
  const own = await fx.call('GET', '/api/relay-questions', { query: { conversationId: SESSION, includeAsks: '1' } });
  assert.equal(own.body.questions.find((question) => question.id === ask.id).queueId, 'q-tern-7');
  const paired = await fx.call('GET', '/api/relay-questions', { headers: FROM_PAIRED, query: { conversationId: SESSION, includeAsks: '1' } });
  const seen = paired.body.questions.find((question) => question.id === ask.id);
  assert.ok(seen, 'the ask is listed');
  assert.equal('queueId' in seen, false);
  const one = await fx.call('GET', '/api/relay-question/:id', { headers: FROM_PAIRED, params: { id: ask.id } });
  assert.equal(one.status, 200);
  assert.equal('queueId' in one.body.question, false);
  const oneHere = await fx.call('GET', '/api/relay-question/:id', { params: { id: ask.id } });
  assert.equal(oneHere.body.question.queueId, 'q-tern-7');
});

test('a session\'s card list is the browser\'s, not an agent\'s', async () => {
  const fx = boot();
  fx.asks.create({ conversationId: SESSION, createdBy: LEAD, ...QUESTION });
  fx.asks.create({ conversationId: LEAD, createdBy: LEAD, question: 'Elsewhere?' });
  const listed = await fx.call('GET', '/api/relay-asks', { query: { conversationId: SESSION } });
  assert.deepEqual(listed.body.asks.map((ask) => ask.question), ['Which database?']);
  assert.equal(listed.body.pending, 2);
  assert.equal((await fx.call('GET', '/api/relay-asks', { headers: FROM_PAIRED })).status, 403);
});

test('a paired relay\'s agent asks here; that relay reads the outcome of its own asks and withdraws them', async () => {
  const fx = boot();
  const asked = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.ask, {
    headers: FROM_PAIRED,
    body: { session: SESSION, ...QUESTION, asker: { conversationId: 'conv-far', title: 'Far lead' } },
  });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const { ask } = asked.body;
  assert.deepEqual(ask.askedBy, { relay: 'lab-relay', conversationId: 'conv-far', title: 'Far lead' });
  const unknownSession = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.ask, { headers: FROM_PAIRED, body: { session: 'conv-nope', question: 'Q?' } });
  assert.equal(unknownSession.status, 404);
  const status = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.status, { headers: FROM_PAIRED, body: { ids: [ask.id] } });
  assert.equal(status.body.asks[0].status, 'pending');
  const other = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.status, { headers: { 'x-oar-remote-origin': 'instance-other' }, body: { ids: [ask.id] } });
  assert.equal(other.body.asks[0].status, 'unknown', 'another relay learns nothing of it');
  // That relay cannot answer it over the pairing; this relay's user answers it here.
  const overPairing = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.answer, { headers: FROM_PAIRED, body: { id: ask.id, choice: 'Postgres' } });
  assert.equal(overPairing.status, 403, JSON.stringify(overPairing.body));
  assert.equal(overPairing.body.code, 'REMOTE_RELAY_PEER_SCOPE');
  assert.equal(fx.asks.get(ask.id).status, 'pending');
  const answered = await fx.call('POST', '/api/relay-question/:id/answer', { params: { id: ask.id }, body: { choice: 'Postgres' } });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual(fx.told.at(-1).notify, [SESSION]);
  const after = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.status, { headers: FROM_PAIRED, body: { ids: [ask.id] } });
  assert.deepEqual([after.body.asks[0].status, after.body.asks[0].answer], ['answered', 'Postgres']);
  const second = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.ask, { headers: FROM_PAIRED, body: { session: SESSION, question: 'Again?' } });
  const withdrawn = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.withdraw, { headers: FROM_PAIRED, body: { id: second.body.ask.id } });
  assert.equal(withdrawn.body.ask.status, 'withdrawn');
});

test('a paired relay\'s Inbox learns that a card was answered, never the answer; this relay\'s own Inbox shows it', async () => {
  const fx = boot();
  fx.db.prepare(`UPDATE relay_questions SET status = 'answered', answer = 'Dark, the secret theme', answered_at = ? WHERE id = 'card-ask-user'`)
    .run(new Date().toISOString());
  const remote = await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers: FROM_PAIRED });
  const there = remote.body.items.find((item) => item.id === 'card-ask-user');
  assert.equal(there.status, 'answered');
  assert.equal('answer' in there, false);
  assert.equal(JSON.stringify(remote.body).includes('secret theme'), false, 'the answer text goes nowhere in it');
  const own = await fx.call('GET', '/api/inbox');
  assert.equal(own.body.relays[0].items.find((item) => item.id === 'card-ask-user').answer, 'Dark, the secret theme');
});

test('a relay without a key here (one-way, or an older OAR) is refused with the reason; a paired relay is named by its name here', async () => {
  const fx = boot();
  const oneWay = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.ask, {
    headers: { 'x-oar-remote-origin': 'instance-unpaired' },
    body: { session: SESSION, question: 'Q?', asker: { conversationId: 'conv-far', relayName: 'far-relay\nx' } },
  });
  assert.equal(oneWay.status, 403);
  assert.equal(oneWay.body.code, CODES.peerKeyRequired);
  assert.equal(oneWay.body.originVerified, false);
  assert.match(oneWay.body.error, /not paired with this relay/);
  assert.match(oneWay.body.error, /Re-pair in Settings → Relays/);
  // The paired relay on the owner token (an older OAR): unverified, refused.
  const older = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.ask, { headers: FROM_PAIRED, ownerToken: true, body: { session: SESSION, question: 'Q?' } });
  assert.equal(older.status, 403);
  assert.equal(older.body.code, CODES.peerKeyRequired);
  const paired = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.ask, {
    headers: FROM_PAIRED,
    body: { session: SESSION, question: 'Q2?', asker: { relayName: 'claims-another-name' } },
  });
  assert.equal(paired.body.ask.askedBy.relay, 'lab-relay');
  // It does not answer it over the pairing (agent auth §2.2).
  const answered = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.answer, { headers: FROM_PAIRED, body: { id: paired.body.ask.id, answer: 'ok', via: 'far-relay' } });
  assert.equal(answered.status, 403);
  assert.equal(fx.asks.get(paired.body.ask.id).status, 'pending');
});

test('the paired routes take another relay\'s request only, under the inbound switch', async () => {
  const fx = boot();
  assert.equal((await fx.call('POST', RELAY_ASK_REMOTE_PATHS.ask, { body: { session: SESSION, question: 'Q?' } })).status, 403, 'the browser has its own routes');
  assert.equal((await fx.call('POST', RELAY_ASK_REMOTE_PATHS.ask, { loopback: true, headers: { 'x-oar-remote-origin': 'instance-self' }, body: { session: SESSION, question: 'Q?' } })).status, 403);
  const closed = boot({ inboundEnabled: false });
  const refused = await closed.call('POST', RELAY_ASK_REMOTE_PATHS.ask, { headers: FROM_PAIRED, body: { session: SESSION, question: 'Q?' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, CODES.inboundDisabled);
  assert.equal((await closed.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers: FROM_PAIRED })).status, 403);
});

test('what a paired relay\'s Inbox gets of this relay: asks, cards to open here, approval cards by their header alone', async () => {
  const fx = boot();
  const ask = fx.asks.create({ conversationId: SESSION, createdBy: LEAD, ...QUESTION });
  const inbox = await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers: FROM_PAIRED });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.pending, 3);
  const byId = new Map(inbox.body.items.map((item) => [item.id, item]));
  assert.equal(byId.get(ask.id).kind, 'ask');
  assert.equal(byId.get(ask.id).detail, QUESTION.detail);
  assert.equal(byId.get('card-ask-user').question, 'Which theme?');
  assert.equal('sdkSessionId' in byId.get('card-ask-user'), false, 'nothing that routes an answer');
  assert.deepEqual(byId.get('card-approval'), {
    id: 'card-approval', kind: 'approval', session: { id: SESSION, title: 'Cache layer', startedBy: 'owner', group: null }, header: 'Remote relay', status: 'pending', createdAt: NOW, question: '',
  });
});

test('a relay added one way (it lists no entry for this one) is not asked for its Inbox: a quiet note, never "not reachable"', async () => {
  const fx = boot({
    pairedRelays: [{ ...PAIRED, peerTokenState: 'unlisted' }],
    client: () => { throw new Error('unexpected'); },
  });
  const inbox = await fx.call('GET', '/api/inbox');
  assert.equal(inbox.status, 200);
  const lab = inbox.body.relays[1];
  assert.deepEqual([lab.id, lab.reachable, lab.oneWay, lab.items.length, 'error' in lab], ['r-lab', true, true, 0, false]);
  assert.equal(lab.note, 'Added one way: lab-relay shows its Inbox only to a relay it lists. To see it here, use Re-pair on relay "lab-relay" in Settings → Relays: it adds this relay there, and both relays then sign in to each other with keys.');
  assert.deepEqual(fx.calls, [], 'nothing is sent to that relay');
});

test('the Inbox lists this relay and every paired relay that answers; an ask there is answered on that relay, not through the pairing', async () => {
  const remoteItem = { id: 'ask_there01', kind: 'ask', session: { id: 'conv-there', title: 'Far worker' }, question: 'Deploy?', options: ['Yes'], status: 'pending', createdAt: NOW };
  const fx = boot({
    client: (_relay, method, path, { body }) => {
      if (method === 'GET' && path === RELAY_ASK_REMOTE_PATHS.inbox) return { items: [remoteItem] };
      if (path === RELAY_ASK_REMOTE_PATHS.answer) return { ask: { id: body.id, status: 'answered' } };
      throw new Error('unexpected');
    },
  });
  fx.asks.create({ conversationId: SESSION, createdBy: LEAD, ...QUESTION });
  const inbox = await fx.call('GET', '/api/inbox');
  assert.equal(inbox.status, 200);
  assert.deepEqual(inbox.body.relays.map((relay) => [relay.id, relay.reachable, relay.items.length]), [['self', true, 3], ['r-lab', true, 1], ['r-gone', false, 0]]);
  assert.equal(inbox.body.relays[0].name, 'bench-relay');
  assert.equal(inbox.body.pending, 4);
  // The page learns that a paired relay's asks are read-only here ("Open there").
  assert.equal(inbox.body.pairedAnswers, false);
  assert.equal(inbox.body.relays[1].url, 'https://relay-b.example.test');
  // A relay whose identity did not say `capabilities.answerLink`: "Open there" only.
  assert.equal(inbox.body.relays[1].answerLink, false);
  assert.deepEqual(fx.calls.map((entry) => entry.relay), ['r-lab'], 'an offline relay is not even asked');
  const callsBefore = fx.calls.length;
  const answered = await fx.call('POST', '/api/inbox/relays/:relayId/asks/:id/answer', { params: { relayId: 'r-lab', id: 'ask_there01' }, body: { choice: 'Yes' } });
  assert.equal(answered.status, 409, JSON.stringify(answered.body));
  assert.equal(answered.body.code, 'ANSWER_ON_THAT_RELAY');
  assert.equal(answered.body.openUrl, 'https://relay-b.example.test');
  assert.equal(fx.calls.length, callsBefore, 'nothing is sent to that relay');
  assert.equal((await fx.call('POST', '/api/inbox/relays/:relayId/asks/:id/answer', { params: { relayId: 'r-nope', id: 'x' } })).status, 404);
  assert.equal((await fx.call('GET', '/api/inbox', { headers: FROM_PAIRED })).status, 403, 'another relay\'s agent reads no Inbox');
});

// ─── Groups ─────────────────────────────────────────────────────────

test('each Inbox item names the group its session sits in, by the name the sidebar shows; a session in none says null', async () => {
  const fx = boot({ boards: true });
  const named = fx.groups.createGroup({ name: 'Storage work', conversationIds: [SESSION] });
  const ask = fx.asks.create({ conversationId: SESSION, createdBy: LEAD, ...QUESTION });
  const leadAsk = fx.asks.create({ conversationId: LEAD, createdBy: LEAD, question: 'Split the module?' });
  const board = seedBoard(fx.db, { createdAt: '2026-03-02T09:00:00.000Z' });
  const own = await fx.call('GET', '/api/inbox');
  const byId = new Map(own.body.relays[0].items.map((item) => [item.id, item]));
  for (const id of [ask.id, 'card-ask-user', 'card-approval', board]) {
    assert.deepEqual(byId.get(id).session.group, { id: named.id, name: 'Storage work' }, id);
  }
  assert.equal(byId.get(leadAsk.id).session.group, null);
  // Unnamed, a group shows its head's title; renamed, the next read has it.
  const headed = fx.groups.createGroup({ parentConversationId: LEAD, conversationIds: [LEAD] });
  fx.groups.renameGroup(named.id, 'Cache rollout');
  const again = new Map((await fx.call('GET', '/api/inbox')).body.relays[0].items.map((item) => [item.id, item]));
  assert.deepEqual(again.get(leadAsk.id).session.group, { id: headed.id, name: 'Lead' });
  assert.deepEqual(again.get(ask.id).session.group, { id: named.id, name: 'Cache rollout' });
});

test('one Inbox read looks up each session\'s group once and each group once, however many items share them', async () => {
  const fx = boot({ boards: true });
  const shared = fx.groups.createGroup({ name: 'Storage work', conversationIds: [SESSION, LEAD] });
  fx.asks.create({ conversationId: SESSION, createdBy: LEAD, ...QUESTION });
  fx.asks.create({ conversationId: SESSION, createdBy: LEAD, question: 'Keep the old index?' });
  fx.asks.create({ conversationId: LEAD, createdBy: LEAD, question: 'Split the module?' });
  seedBoard(fx.db, { createdAt: '2026-03-02T09:00:00.000Z' });
  const counted = { groupOfConversation: [], describeGroup: [] };
  for (const name of Object.keys(counted)) {
    const real = fx.groups[name].bind(fx.groups);
    fx.groups[name] = (id) => {
      counted[name].push(id);
      return real(id);
    };
  }
  const own = await fx.call('GET', '/api/inbox');
  // Two asks, both cards and the plan card share SESSION; one ask is in LEAD.
  assert.ok(own.body.relays[0].items.filter((item) => item.session.id === SESSION).length >= 4);
  assert.deepEqual([...counted.groupOfConversation].sort(), [LEAD, SESSION].sort());
  assert.deepEqual(counted.describeGroup, [shared.id]);
  // The next read looks them up again: nothing is kept between requests.
  await fx.call('GET', '/api/inbox');
  assert.equal(counted.groupOfConversation.length, 4);
  assert.equal(counted.describeGroup.length, 2);
});

test('a paired relay\'s Inbox read carries the groups; this relay\'s Inbox passes a paired relay\'s through as they came', async () => {
  const fx = boot({
    client: (_relay, method, path) => {
      if (method === 'GET' && path === RELAY_ASK_REMOTE_PATHS.inbox) {
        return { items: [
          { id: 'ask_there01', kind: 'ask', session: { id: 'conv-there', title: 'Far worker', group: { id: 'grp-far', name: 'Night jobs' } }, question: 'Deploy?', status: 'pending', createdAt: NOW },
          // A relay before 0.9.32 sends no group.
          { id: 'ask_there02', kind: 'ask', session: { id: 'conv-old', title: 'Old relay' }, question: 'Rename?', status: 'pending', createdAt: NOW },
        ] };
      }
      throw new Error('unexpected');
    },
  });
  const group = fx.groups.createGroup({ name: 'Storage work', conversationIds: [SESSION] });
  const ask = fx.asks.create({ conversationId: SESSION, createdBy: LEAD, ...QUESTION });
  const read = await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers: FROM_PAIRED });
  assert.equal(read.status, 200);
  for (const item of read.body.items) assert.deepEqual(item.session.group, { id: group.id, name: 'Storage work' }, item.id);
  assert.ok(read.body.items.some((item) => item.id === ask.id));
  const inbox = await fx.call('GET', '/api/inbox');
  const lab = inbox.body.relays.find((relay) => relay.id === PAIRED.id);
  assert.deepEqual(lab.items.map((item) => item.session.group ?? null), [{ id: 'grp-far', name: 'Night jobs' }, null]);
});

test('without the group repository (an older wiring) every item says null', async () => {
  const db = new Database(':memory:');
  applySchema(db);
  seed(db);
  const routes = new Map();
  const app = { get: (path, ...handlers) => routes.set(path, handlers.at(-1)), post() {}, delete() {} };
  registerRelayAskRoutes(app, { auth: (_req, _res, next) => next(), db, stmts: createQuestionRepository(db), formatQuestionRow, remoteRelayInbound: { listRelays: () => [], selfNames: () => [], inboundEnabled: () => true } });
  const captured = {};
  const req = asOwner({ headers: {}, query: {}, params: {}, body: {} });
  await routes.get('/api/inbox')(req, { status() { return this; }, json(payload) { captured.body = payload; return this; } });
  assert.ok(captured.body.relays[0].items.length >= 2);
  for (const item of captured.body.relays[0].items) assert.equal(item.session.group, null, item.id);
});

// ─── Plan cards ─────────────────────────────────────────────────────

test('the Inbox lists each session\'s newest pending plan card and the ones settled in the last day', async () => {
  const fx = boot({ boards: true });
  const older = seedBoard(fx.db, { createdAt: '2026-03-01T10:00:00.000Z', title: 'Old plan' });
  const newest = seedBoard(fx.db, { createdAt: '2026-03-02T09:00:00.000Z', title: 'New plan' });
  const lead = seedBoard(fx.db, { conversationId: LEAD, createdAt: '2026-03-02T08:00:00.000Z' });
  seedBoard(fx.db, { boardType: 'generic', title: 'Not a plan card' });
  const settled = seedBoard(fx.db, { conversationId: LEAD, status: 'acted', actedAt: new Date().toISOString(), title: 'Approved plan' });
  seedBoard(fx.db, { conversationId: LEAD, status: 'dismissed', actedAt: '2020-01-01T00:00:00.000Z', title: 'Long ago' });
  fx.db.prepare(`UPDATE conversations SET plan_only = 1 WHERE id = ?`).run(SESSION);
  const own = await fx.call('GET', '/api/inbox');
  const items = own.body.relays[0].items.filter((item) => item.kind === 'plan');
  assert.deepEqual(items.map((item) => item.id).sort(), [newest, lead, settled].sort());
  assert.ok(!items.some((item) => item.id === older), 'an older pending card stays in its session');
  const item = items.find((entry) => entry.id === newest);
  assert.equal(item.title, 'New plan');
  assert.equal(item.body, '1. Split the parser');
  assert.deepEqual(item.actions.map((action) => action.id), ['approve_only', 'autopilot']);
  assert.equal(item.planOnly, true);
  assert.equal(item.status, 'pending');
  assert.equal(item.session.id, SESSION);
  assert.equal(item.session.title, 'Cache layer');
  const done = items.find((entry) => entry.id === settled);
  assert.equal(done.status, 'acted');
  assert.equal(done.selectedAction, 'approve_only');
  assert.ok(done.actedAt);
  // The badge counts the pending ones with the cards.
  const pendingAll = own.body.relays[0].items.filter((entry) => entry.status === 'pending').length;
  assert.equal(own.body.pending, own.body.relays.reduce((sum, relay) => sum + relay.items.filter((entry) => entry.status === 'pending').length, 0));
  assert.ok(pendingAll >= 2, 'the two pending plan cards count');
});

test('no plan card of a deleted or archived session', async () => {
  const fx = boot({ boards: true });
  seedBoard(fx.db);
  seedBoard(fx.db, { conversationId: LEAD });
  fx.db.prepare(`UPDATE conversations SET status = 'deleted' WHERE id = ?`).run(SESSION);
  fx.db.prepare(`UPDATE conversations SET archived = 1 WHERE id = ?`).run(LEAD);
  const own = await fx.call('GET', '/api/inbox');
  assert.equal(own.body.relays[0].items.filter((item) => item.kind === 'plan').length, 0);
});

test('a paired relay\'s Inbox gets a plan card\'s title and status alone', async () => {
  const fx = boot({ boards: true });
  const id = seedBoard(fx.db, { title: 'Ship the cache', body: 'secret plan body' });
  const remote = await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers: FROM_PAIRED });
  const there = remote.body.items.find((item) => item.id === id);
  assert.deepEqual(Object.keys(there).sort(), ['createdAt', 'id', 'kind', 'question', 'session', 'status', 'title']);
  assert.equal(there.kind, 'plan');
  assert.equal(there.title, 'Ship the cache');
  assert.equal(there.question, 'Ship the cache', 'an older Inbox shows it as the card\'s question');
  assert.equal(JSON.stringify(remote.body).includes('secret plan body'), false);
  assert.equal(remote.body.pending, remote.body.items.filter((item) => item.status === 'pending').length);
  // A settled one: the same keys, not when it was settled.
  fx.db.prepare(`UPDATE relay_boards SET status = 'acted', selected_action = 'approve_only', acted_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  const settled = (await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers: FROM_PAIRED })).body.items.find((item) => item.id === id);
  assert.deepEqual(Object.keys(settled).sort(), ['createdAt', 'id', 'kind', 'question', 'session', 'status', 'title']);
  assert.equal(settled.status, 'acted');
});

test('without the board formatter the Inbox lists no plan cards (an older wiring)', async () => {
  const fx = boot();
  seedBoard(fx.db);
  const own = await fx.call('GET', '/api/inbox');
  assert.equal(own.body.relays[0].items.filter((item) => item.kind === 'plan').length, 0);
});
test('a paired relay\'s Inbox gets an approval card\'s variant and summary, still without its text', async () => {
  const fx = boot();
  fx.db.prepare(`UPDATE relay_questions SET request = ? WHERE id = 'card-approval'`).run(JSON.stringify({
    request: null,
    context: { source: 'remote_relay', header: 'Remote relay', variant: 'write', summary: 'Send a prompt on relay "linux-test" requested by \'Lead\'' },
    allowFreeform: false,
  }));
  const inbox = await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers: FROM_PAIRED });
  const item = inbox.body.items.find((entry) => entry.id === 'card-approval');
  assert.equal(item.question, '');
  assert.equal(item.variant, 'write');
  assert.equal(item.summary, 'Send a prompt on relay "linux-test" requested by \'Lead\'');
  assert.ok(!JSON.stringify(item).includes('Rebuild the sidebar'), 'the card text stays here');
  assert.equal('options' in item, false);
});

// ─── Who pushes a card a turn waits on ─────────────────────────────

const FROM_OTHER = { 'x-oar-remote-origin': 'instance-other', 'x-oar-remote-hops': '1' };

function noticesOf(body) {
  return Object.fromEntries(body.items.filter((item) => 'notice' in item).map((item) => [item.id, [item.notice, item.claimed]]));
}

test('?push=1: this relay\'s own push decides first; a missed card is claimed by the first caller, and the claim sticks', async () => {
  const ledger = new Map([['card-approval', 'pending']]);
  const fx = boot({ boards: true, questionNotice: (id) => ledger.get(id) ?? null });
  fx.asks.create({ conversationId: SESSION, createdBy: LEAD, ...QUESTION });
  seedBoard(fx.db);
  const read = async (headers, push = true) => (await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers, query: push ? { push: '1' } : {} })).body;

  // The approval's push is not settled; the ask_user card was never pushed here (from before a restart).
  assert.deepEqual(noticesOf(await read(FROM_PAIRED)), { 'card-approval': ['wait', undefined], 'card-ask-user': ['you', 'now'] });
  // Decision 5: only cards a turn waits on (relay_questions rows: approvals,
  // ask_user) say who pushes; a non-blocking ask and a plan card never do.
  const listed = (await read(FROM_PAIRED)).items;
  assert.deepEqual(listed.filter((item) => item.kind === 'ask' || item.kind === 'plan').map((item) => [item.kind, 'notice' in item, 'claimed' in item]), [['ask', false, false], ['plan', false, false]]);
  ledger.set('card-approval', 'reached');
  assert.deepEqual(noticesOf(await read(FROM_PAIRED)), { 'card-approval': ['here', undefined], 'card-ask-user': ['you', 'before'] });
  assert.deepEqual(noticesOf(await read(FROM_OTHER)), { 'card-approval': ['here', undefined], 'card-ask-user': ['other', undefined] });
  ledger.set('card-approval', 'missed');
  assert.deepEqual(noticesOf(await read(FROM_OTHER)), { 'card-approval': ['you', 'now'], 'card-ask-user': ['other', undefined] });
  assert.deepEqual(noticesOf(await read(FROM_PAIRED)), { 'card-approval': ['other', undefined], 'card-ask-user': ['you', 'before'] });
});

test('without ?push=1 nothing is claimed and no notice goes out', async () => {
  const fx = boot({ questionNotice: () => null });
  const plain = await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers: FROM_PAIRED });
  assert.deepEqual(noticesOf(plain.body), {});
  assert.ok(plain.body.items.every((item) => !('claimed' in item)));
  const pushing = await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers: FROM_OTHER, query: { push: '1' } });
  assert.deepEqual(noticesOf(pushing.body), { 'card-approval': ['you', 'now'], 'card-ask-user': ['you', 'now'] }, 'the plain read claimed nothing');
});

test('a card no longer pending loses its claim; a card that was never claimed is claimable at any age', async () => {
  const fx = boot();
  fx.db.prepare(`UPDATE relay_questions SET created_at = '2026-03-01T00:00:00.000Z'`).run();
  const read = async (headers) => noticesOf((await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers, query: { push: '1' } })).body);
  assert.deepEqual(await read(FROM_PAIRED), { 'card-approval': ['you', 'now'], 'card-ask-user': ['you', 'now'] }, 'without a push service here every card is claimable');
  fx.db.prepare(`UPDATE relay_questions SET status = 'answered', answer = 'Dark', answered_at = ? WHERE id = 'card-ask-user'`).run(NOW);
  assert.deepEqual(await read(FROM_OTHER), { 'card-approval': ['other', undefined] });
  fx.db.prepare(`UPDATE relay_questions SET status = 'pending', answer = NULL, answered_at = NULL WHERE id = 'card-ask-user'`).run();
  assert.deepEqual(await read(FROM_OTHER), { 'card-approval': ['other', undefined], 'card-ask-user': ['you', 'now'] }, 'its old claim went with it');
});

test('a restart of this relay forgets the claims: its cards are claimable again', async () => {
  const read = async (fx, headers) => noticesOf((await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers, query: { push: '1' } })).body);
  const before = boot();
  assert.deepEqual(await read(before, FROM_OTHER), { 'card-approval': ['you', 'now'], 'card-ask-user': ['you', 'now'] });
  assert.deepEqual(await read(before, FROM_PAIRED), { 'card-approval': ['other', undefined], 'card-ask-user': ['other', undefined] });
  const after = boot();
  assert.deepEqual(await read(after, FROM_PAIRED), { 'card-approval': ['you', 'now'], 'card-ask-user': ['you', 'now'] });
});

test('a read whose pending cards fail to load keeps the claims, and claims nothing', async () => {
  const fx = boot();
  const read = async (headers) => noticesOf((await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers, query: { push: '1' } })).body);
  assert.deepEqual(await read(FROM_PAIRED), { 'card-approval': ['you', 'now'], 'card-ask-user': ['you', 'now'] });
  const listQuestions = fx.stmts.listQuestions;
  fx.stmts.listQuestions = { all() { throw new Error('database is locked'); } };
  assert.deepEqual(await read(FROM_OTHER), {}, 'no card listed, none offered');
  fx.stmts.listQuestions = listQuestions;
  assert.deepEqual(await read(FROM_OTHER), { 'card-approval': ['other', undefined], 'card-ask-user': ['other', undefined] }, 'the claims survived the failed read');
  assert.deepEqual(await read(FROM_PAIRED), { 'card-approval': ['you', 'before'], 'card-ask-user': ['you', 'before'] });
});

test('a session\'s card list reads the asks in it (listIn): none it asked elsewhere, no mirrors; each with its turn', async () => {
  const fx = boot();
  const own = fx.asks.create({ conversationId: SESSION, createdBy: SESSION, question: 'Own?', queueId: 'q-turn' });
  fx.asks.create({ conversationId: LEAD, createdBy: SESSION, question: 'For the lead?' });
  fx.asks.addMirror({ relayId: PAIRED.id, createdBy: SESSION, remote: { id: 'ask_there01', question: 'Far?', session: { id: SESSION } } });
  fx.asks.listOf = () => { throw new Error('the card list reads listIn'); };
  const listed = await fx.call('GET', '/api/relay-asks', { query: { conversationId: SESSION } });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.asks.map((ask) => [ask.id, ask.queueId]), [[own.id, 'q-turn']]);
  assert.deepEqual((await fx.call('GET', '/api/relay-asks', { query: { conversationId: LEAD } })).body.asks.map((ask) => ask.question), ['For the lead?']);
});

test('a paired relay never gets an ask\'s queueId: ask, withdraw, status and its Inbox (answer and dismiss are closed)', async () => {
  const fx = boot();
  fx.asks.create({ conversationId: SESSION, createdBy: SESSION, question: 'Own?', queueId: 'q-turn' });
  const noQueue = (value, what) => assert.equal(JSON.stringify(value).includes('queueId'), false, what);
  const asked = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.ask, { headers: FROM_PAIRED, body: { session: SESSION, ...QUESTION } });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  noQueue(asked.body, 'ask');
  assert.equal(fx.db.prepare(`SELECT queue_id FROM relay_asks WHERE id = ?`).get(asked.body.ask.id).queue_id, null, 'a paired relay\'s ask stores none');
  const answered = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.answer, { headers: FROM_PAIRED, body: { id: asked.body.ask.id, choice: 'SQLite' } });
  assert.equal(answered.status, 403, JSON.stringify(answered.body));
  noQueue(answered.body, 'answer');
  const second = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.ask, { headers: FROM_PAIRED, body: { session: SESSION, question: 'Rename it?' } });
  const dismissed = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.dismiss, { headers: FROM_PAIRED, body: { id: second.body.ask.id } });
  assert.equal(dismissed.status, 403, JSON.stringify(dismissed.body));
  noQueue(dismissed.body, 'dismiss');
  const third = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.ask, { headers: FROM_PAIRED, body: { session: SESSION, question: 'Later?' } });
  const withdrawn = await fx.call('POST', RELAY_ASK_REMOTE_PATHS.withdraw, { headers: FROM_PAIRED, body: { id: third.body.ask.id } });
  assert.equal(withdrawn.body.ask.status, 'withdrawn');
  noQueue(withdrawn.body, 'withdraw');
  noQueue((await fx.call('POST', RELAY_ASK_REMOTE_PATHS.status, { headers: FROM_PAIRED, body: { ids: [asked.body.ask.id] } })).body, 'status');
  const inbox = await fx.call('GET', RELAY_ASK_REMOTE_PATHS.inbox, { headers: FROM_PAIRED });
  assert.ok(inbox.body.items.some((item) => item.kind === 'ask' && item.question === 'Own?'));
  for (const item of inbox.body.items.filter((entry) => entry.kind === 'ask')) assert.equal('queueId' in item, false, 'Inbox');
});

// A card's push carries a choice button; the service worker answers it with
// the payload's data alone. The chain here: this relay's push of the card,
// the worker's tap on a choice, the answer route.
const SW_SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const SW_SCOPE = 'https://relay-a.example.test/';
const CARD_SESSION = 'sdk-fixture-4e2b';

function seedSessionCard(db, { id = 'card-session', continuationId = null, continuationQuestionId = null } = {}) {
  db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, relay_mode, prompt, choices, request, sdk_session_id, continuation_id, continuation_question_id, status, created_at, expires_at)
    VALUES (?, 'q-turn', ?, 'q-turn', 'agent', 'Ship the patch?', ?, ?, ?, ?, ?, 'pending', ?, '2999-01-01T00:00:00.000Z')
  `).run(id, SESSION, JSON.stringify(['Ship', 'Hold']), JSON.stringify({ request: null, context: null, allowFreeform: true }),
    CARD_SESSION, continuationId, continuationQuestionId, NOW);
  return id;
}

async function pushedQuestionData(db, question) {
  const payloads = [];
  const push = createPushDispatchService({
    db,
    webpush: { sendNotification: async (_subscription, body) => { payloads.push(JSON.parse(body)); return { statusCode: 201 }; } },
    hasActiveDevice: () => false,
    uuid: () => 'sub-fixture-1',
    logger: { warn() {}, log() {} },
  });
  push.upsertSubscription({ deviceId: 'device-fixture', endpoint: 'https://push.example.test/device-fixture', keys: { p256dh: 'p', auth: 'a' } });
  await push.notifyQuestion(question);
  assert.equal(payloads.length, 1, 'one push');
  return payloads[0].data;
}

// The service worker's tap on choice `index`; returns the answer POST's body.
async function tapChoice(data, index) {
  const listeners = new Map();
  const posts = [];
  const self = {
    location: { href: `${SW_SCOPE}sw.js?v=1`, origin: new URL(SW_SCOPE).origin },
    registration: { scope: SW_SCOPE, showNotification: async () => {} },
    clients: { matchAll: async () => [], openWindow: async () => null },
    addEventListener: (type, handler) => listeners.set(type, handler),
  };
  const context = vm.createContext({
    self, URL, console, queueMicrotask,
    fetch: async (url, options) => {
      posts.push({ url, body: JSON.parse(options?.body || '{}') });
      const response = { ok: false, status: 500, json: async () => ({}), clone: () => response };
      return response;
    },
  });
  vm.runInContext(SW_SOURCE, context);
  let done = null;
  listeners.get('notificationclick')({
    action: `choice-${index}`,
    notification: { data, close() {} },
    waitUntil: (promise) => { done = promise; },
  });
  await done;
  assert.equal(posts.length, 1, 'one answer POST');
  assert.equal(posts[0].url, `${SW_SCOPE}api/relay-question/${encodeURIComponent(data.questionId)}/answer`);
  return posts[0].body;
}

test('a card with a session is answered from its push notification: the tap names the card\'s session', async () => {
  const fx = boot();
  const id = seedSessionCard(fx.db);
  const data = await pushedQuestionData(fx.db, formatQuestionRow(fx.db.prepare(`SELECT * FROM relay_questions WHERE id = ?`).get(id)));
  const body = await tapChoice(data, 1);
  const answered = await fx.call('POST', '/api/relay-question/:id/answer', { params: { id }, body });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual({ ...fx.card(id) }, { status: 'answered', answer: 'Hold' });
});

test('the session check stays: an answer without the card\'s session, or with another, is refused', async () => {
  const fx = boot();
  const id = seedSessionCard(fx.db);
  const bare = await fx.call('POST', '/api/relay-question/:id/answer', { params: { id }, body: { answer: 'Ship' } });
  assert.equal(bare.status, 403);
  assert.equal(bare.body.error, 'session mismatch');
  const other = await fx.call('POST', '/api/relay-question/:id/answer', { params: { id }, body: { answer: 'Ship', sdk_session_id: 'sdk-fixture-other' } });
  assert.equal(other.status, 403);
  assert.equal(fx.card(id).status, 'pending');
});

test('with continuation routing on, a card of a continuation is answered from its push like the in-app card: by its session', async () => {
  const fx = boot();
  const id = seedSessionCard(fx.db, { continuationId: 'cont-fixture-81', continuationQuestionId: 'cq-fixture-3' });
  const data = await pushedQuestionData(fx.db, formatQuestionRow(fx.db.prepare(`SELECT * FROM relay_questions WHERE id = ?`).get(id)));
  const body = await tapChoice(data, 0);
  const answered = await fx.call('POST', '/api/relay-question/:id/answer', { params: { id }, body });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual({ ...fx.card(id) }, { status: 'answered', answer: 'Ship' });
});

// A card only the person answers, and a tool permission card, open the app
// from their push: no choice buttons, no session, a tap opens the
// conversation. Other questions keep their one-tap answer.
function seedContextCard(db, id, context) {
  db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, relay_mode, prompt, choices, request, sdk_session_id, status, created_at, expires_at)
    VALUES (?, 'q-turn', ?, 'q-turn', 'agent', 'Go ahead?', ?, ?, ?, 'pending', ?, '2999-01-01T00:00:00.000Z')
  `).run(id, SESSION, JSON.stringify(['Allow', 'Deny']), JSON.stringify({ request: null, context, allowFreeform: false }), CARD_SESSION, NOW);
  return id;
}

// The service worker draws the push, then the person taps its body.
async function showAndTapBody(payload) {
  const listeners = new Map();
  const shown = [];
  const opened = [];
  const posts = [];
  const self = {
    location: { href: `${SW_SCOPE}sw.js?v=1`, origin: new URL(SW_SCOPE).origin },
    registration: { scope: SW_SCOPE, showNotification: async (title, options) => { shown.push(options); } },
    clients: { matchAll: async () => [], openWindow: async (url) => { opened.push(url); return null; } },
    addEventListener: (type, handler) => listeners.set(type, handler),
  };
  const context = vm.createContext({
    self, URL, console, queueMicrotask,
    Notification: { maxActions: 2 },
    fetch: async (url, options) => {
      posts.push({ url, body: options?.body });
      const response = { ok: true, status: 200, json: async () => ({}), clone: () => response };
      return response;
    },
  });
  vm.runInContext(SW_SOURCE, context);
  let done = null;
  listeners.get('push')({ data: { json: () => payload }, waitUntil: (promise) => { done = promise; } });
  await done;
  assert.equal(shown.length, 1, 'one notification');
  listeners.get('notificationclick')({
    action: '',
    notification: { data: shown[0].data, close() {} },
    waitUntil: (promise) => { done = promise; },
  });
  await done;
  return { actions: shown[0].actions, opened, posts };
}

async function pushedQuestionPayload(db, question) {
  const payloads = [];
  const push = createPushDispatchService({
    db,
    webpush: { sendNotification: async (_subscription, body) => { payloads.push(JSON.parse(body)); return { statusCode: 201 }; } },
    hasActiveDevice: () => false,
    uuid: () => 'sub-fixture-2',
    logger: { warn() {}, log() {} },
  });
  push.upsertSubscription({ deviceId: 'device-fixture', endpoint: 'https://push.example.test/device-fixture', keys: { p256dh: 'p', auth: 'a' } });
  await push.notifyQuestion(question);
  assert.equal(payloads.length, 1, 'one push');
  return payloads[0];
}

const OPENS_APP_CARDS = [
  ['a relay approval of its own agent\'s call', { source: 'remote_relay', header: 'Remote relay' }],
  ['a Safety check', { source: 'ClaudeSafetyCheck', personOnly: true }],
  ['a Safety check on a sensitive file', { source: 'ClaudeSafetyCheck', personOnly: true, kind: 'sensitive-file' }],
  ['a Claude Cloud permission', { source: 'ClaudeCloudPermission' }],
  ['a card marked person-only', { source: 'AskUserQuestion', personOnly: true }],
  ['a Copilot tool permission in ask mode', { source: 'onPermissionRequest', permissionKind: 'shell' }],
];

for (const [label, cardContext] of OPENS_APP_CARDS) {
  test(`${label}: its push has no answer buttons and no session, and a tap opens the conversation`, async () => {
    const fx = boot();
    const id = seedContextCard(fx.db, `card-opens-${OPENS_APP_CARDS.findIndex(([name]) => name === label)}`, cardContext);
    const payload = await pushedQuestionPayload(fx.db, formatQuestionRow(fx.db.prepare(`SELECT * FROM relay_questions WHERE id = ?`).get(id)));
    assert.equal(payload.data.questionId, id);
    assert.equal('choices' in payload.data, false, 'no choices');
    assert.equal('sdkSessionId' in payload.data, false, 'no session');
    const tapped = await showAndTapBody(payload);
    assert.equal(tapped.actions.length, 0, 'no buttons drawn');
    assert.deepEqual(tapped.posts, [], 'nothing answered');
    assert.deepEqual(tapped.opened, [`${SW_SCOPE}?push_conv=${SESSION}`]);
    assert.equal(fx.card(id).status, 'pending');
  });
}

test('a Copilot question that is no permission keeps its one-tap answer', async () => {
  const fx = boot();
  const id = seedContextCard(fx.db, 'card-copilot-input', { source: 'onUserInputRequest', rationale: 'Copilot asks.' });
  const payload = await pushedQuestionPayload(fx.db, formatQuestionRow(fx.db.prepare(`SELECT * FROM relay_questions WHERE id = ?`).get(id)));
  assert.deepEqual(payload.data.choices, ['Allow', 'Deny']);
  assert.equal(payload.data.sdkSessionId, CARD_SESSION);
  const body = await tapChoice(payload.data, 0);
  const answered = await fx.call('POST', '/api/relay-question/:id/answer', { params: { id }, body });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual({ ...fx.card(id) }, { status: 'answered', answer: 'Allow' });
});

test('an urgent ask keeps its one-tap answer: it is a question, not an approval', async () => {
  const pushed = [];
  const fx = boot({ pushQuestion: (question) => pushed.push(question) });
  const ask = fx.asks.create({ conversationId: SESSION, createdBy: LEAD, urgency: 'now', ...QUESTION });
  assert.equal(pushed.length, 1, 'urgency "now" pushes');
  const payload = await pushedQuestionPayload(fx.db, pushed[0]);
  assert.deepEqual(payload.data.choices, ['Postgres', 'SQLite']);
  const body = await tapChoice(payload.data, 1);
  const answered = await fx.call('POST', '/api/relay-question/:id/answer', { params: { id: ask.id }, body });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(fx.asks.get(ask.id).status, 'answered');
});
