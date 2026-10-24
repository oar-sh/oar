import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { REMOTE_RELAY_ERROR_CODES as CODES } from '../../shared/remote-relay-contract.mjs';
import { createRemoteRelayDispatcher } from './remote-relay-dispatcher.mjs';
import { formatRemoteRelayApprovalPrompt } from './remote-relay-caller-context.mjs';
import { createRelayAskService } from './relay-ask-service.mjs';
import { RELAY_ASK_REMOTE_PATHS } from './relay-ask-link-service.mjs';

// remote_relay ask / list_questions / withdraw through the dispatcher, on this
// relay's real ask service (an in-memory database) and a stub paired relay.

const CALLER = 'conv-fixture-caller';
const WORKER = 'conv-fixture-worker';
const READER = Object.freeze({ id: 'rr_reader', relayId: 'relay-reader-id', name: 'reader-test', url: 'https://relay-b.example.test', permission: 'read', lastStatus: 'online' });
const PROMPTER = Object.freeze({ id: 'rr_prompter', relayId: 'relay-prompter-id', name: 'prompter-test', url: 'https://relay-c.example.test', permission: 'prompt', lastStatus: 'online' });
const LOCKED = Object.freeze({ id: 'rr_locked', relayId: 'relay-locked-id', name: 'locked-test', url: 'https://relay-d.example.test', permission: 'full', lastStatus: 'online' });
const FULL = Object.freeze({ id: 'rr_full', relayId: 'relay-full-id', name: 'full-test', url: 'https://relay-e.example.test', permission: 'full', lastStatus: 'online' });
// Locked here, but an agent there once wrote to the caller: open by contact only.
const CONTACT = Object.freeze({ id: 'rr_contact', relayId: 'relay-contact-id', name: 'contact-test', url: 'https://relay-f.example.test', permission: 'full', lastStatus: 'online' });
const RELAYS = [READER, PROMPTER, LOCKED, FULL, CONTACT];

function createRegistry() {
  return {
    list: () => RELAYS,
    resolve(name) {
      const relay = RELAYS.find((entry) => entry.name === String(name || '').replace(/^@/, '').toLowerCase());
      return relay ? { relay } : { error: 'unknown', names: RELAYS.map((entry) => entry.name) };
    },
    selfIdentity: () => ({ relayId: 'relay-self-id', name: 'win-test', version: '0.9.16', publicUrl: 'https://relay-a.example.test' }),
    selfName: () => 'win-test',
  };
}

function setup({ mode = 'agent', agentSessions = true, remote = () => ({}), hops = 0, approve = true } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const at = new Date(Date.now() - 60_000).toISOString();
  for (const [id, title] of [[CALLER, 'Coordinator'], [WORKER, 'Cache layer']]) {
    db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at, at);
  }
  const told = [];
  const asks = createRelayAskService({ db, relayEvents: { noteQuestion() {}, noteQuestionAnswered: (outcome) => told.push(outcome) }, logger: { log() {}, warn() {} } });
  const approvals = [];
  const events = [];
  const remoteCalls = [];
  const noted = [];
  const dispatcher = createRemoteRelayDispatcher({
    registry: createRegistry(),
    client: {
      request: async (relay, method, path, options = {}) => {
        remoteCalls.push({ relay: relay.id, method, path, body: options.body, query: options.query });
        return remote(relay, method, path, options);
      },
    },
    localClient: { request: async () => ({}) },
    getAgentSessionsSettings: () => ({ enabled: agentSessions, maxWaitSeconds: 600 }),
    repository: {
      hasUnlock: (conversationId, relayId) => [READER.id, PROMPTER.id, FULL.id].includes(relayId),
      hasContactFrom: (conversationId, instanceId) => instanceId === CONTACT.relayId,
      latestHumanMessageId: () => 'm-human',
    },
    getCallerContext: async (conversationId) => ({ conversationId, title: 'Coordinator', provider: 'claude', mode, processingRowId: 'q-1', hops }),
    requestApproval: async (request) => {
      approvals.push(request);
      return approve;
    },
    emitStatusEvent: (event) => events.push(event),
    logger: { log() {}, warn() {} },
    relayAsks: asks,
    relayAskLink: { noteAsked: (relayId) => noted.push(relayId), fetchNow: async () => ({ ok: true }) },
  });
  const run = (action, args = {}, conversationId = CALLER) => dispatcher.dispatch({ conversationId, action, args });
  return { db, asks, told, run, approvals, events, remoteCalls, noted };
}

const QUESTION = { question: 'Which database for the cache?', options: ['Postgres', 'SQLite'], recommendation: 'SQLite', detail: 'Reads dominate.' };

test('an own ask returns at once, pending, with no card even in ask mode and without the agent sessions setting', async () => {
  const { run, approvals, events, asks } = setup({ mode: 'ask', agentSessions: false });
  const asked = await run('ask', QUESTION);
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.relay, 'win-test');
  assert.equal(asked.body.status, 'pending');
  assert.match(asked.body.question_id, /^ask_[0-9a-f]{12}$/);
  assert.equal(asked.body.question.session.id, CALLER);
  assert.equal(asked.body.question.recommendation, 'SQLite');
  assert.match(asked.body.summary, /^ask → win-test: question ask_[0-9a-f]+ pending$/);
  assert.match(asked.body.note, /question_answered .* without any subscription/);
  assert.equal(approvals.length, 0);
  assert.equal(events.length, 0, 'not a write');
  assert.equal(asks.get(asked.body.question_id).status, 'pending');
  // By its own name, and naming its own conversation as session, too.
  assert.equal((await run('ask', { relay: 'win-test', session: CALLER, question: 'And this?' })).status, 200);

  const listed = await run('list_questions');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.questions.map((ask) => ask.question), ['And this?', 'Which database for the cache?']);
  assert.match(listed.body.summary, /: 2 pending$/);

  const withdrawn = await run('withdraw', { question_id: asked.body.question_id });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.equal(withdrawn.body.question.status, 'withdrawn');
  const twice = await run('withdraw', { question_id: asked.body.question_id });
  assert.equal(twice.status, 409);
});

test('an ask on behalf of another session here needs the agent sessions setting, and names a live session', async () => {
  const off = setup({ agentSessions: false });
  const refused = await off.run('ask', { session: WORKER, ...QUESTION });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, CODES.localDisabled);

  const { run, asks } = setup();
  const asked = await run('ask', { session: WORKER, ...QUESTION });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.question.session.id, WORKER);
  assert.deepEqual(asked.body.question.askedBy, { conversationId: CALLER, title: 'Coordinator' });
  assert.match(asked.body.note, /Session conv-fixture-worker gets the answer too/);
  assert.equal((await run('ask', { session: 'conv-fixture-nope', question: 'Q?' })).status, 404);
  // The worker cannot withdraw what the caller asked for it.
  const fromWorker = await run('withdraw', { question_id: asked.body.question_id }, WORKER);
  assert.equal(fromWorker.status, 403);
  assert.equal(asks.get(asked.body.question_id).status, 'pending');
  // list_questions for the worker shows it.
  assert.equal((await run('list_questions', { session: WORKER })).body.questions.length, 1);
});

test('an ask on behalf of another session is a write: the card in ask and plan mode, a No asks nothing, the audit line', async () => {
  for (const mode of ['ask', 'plan']) {
    const denied = setup({ mode, approve: false });
    const refused = await denied.run('ask', { session: WORKER, ...QUESTION });
    assert.equal(refused.status, 403, mode);
    assert.equal(refused.body.code, CODES.approvalDenied);
    assert.equal(denied.approvals.length, 1);
    assert.equal(denied.approvals[0].action, 'ask');
    assert.equal(denied.asks.listOf(WORKER).length, 0, 'nothing was asked');
    assert.deepEqual(denied.events.map((event) => [event.action, event.ok]), [['ask', false]]);
  }
  const card = formatRemoteRelayApprovalPrompt({ relay: { id: 'self', name: 'win-test', local: true }, action: 'ask', args: { session: WORKER, ...QUESTION } });
  assert.match(card, /^Allow the agent to ask you a question on behalf of another session on this relay \(session conv-fix\)\?/);
  assert.match(card, /“Which database for the cache\?”/);
  assert.match(card, /Options: Postgres · SQLite/);

  const allowed = setup({ mode: 'ask' });
  const asked = await allowed.run('ask', { session: WORKER, ...QUESTION });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(allowed.approvals.length, 1);
  assert.deepEqual(allowed.events.map((event) => [event.action, event.session, event.ok]), [['ask', WORKER, true]]);
  // In agent mode: no card, still the audit line.
  const agent = setup();
  assert.equal((await agent.run('ask', { session: WORKER, question: 'Q?' })).status, 200);
  assert.equal(agent.approvals.length, 0);
  assert.equal(agent.events.length, 1);
});

test('an own ask stays free: no card, no audit, no write limit; list_questions and withdraw neither', async () => {
  const { run, approvals, events } = setup({ mode: 'plan' });
  for (let i = 0; i < 12; i += 1) assert.equal((await run('ask', { question: `Mine ${i}?` })).status, 200, `ask ${i}`);
  assert.equal((await run('list_questions')).status, 200);
  assert.equal(approvals.length, 0);
  assert.equal(events.length, 0);
});

test('an ask on behalf crosses the hop limit like a send; one on a relay the user unlocked does not', async () => {
  const remote = (_relay, _method, path, { body }) => (path === RELAY_ASK_REMOTE_PATHS.ask
    ? { ok: true, ask: { id: 'ask_there0002', question: body.question, session: { id: body.session } } }
    : {});
  const far = setup({ hops: 2, remote });
  const refused = await far.run('ask', { relay: 'contact-test', session: 'conv-there', question: 'Q?' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, CODES.hopLimit);
  assert.equal(far.remoteCalls.length, 0, 'nothing reached that relay');
  const unlocked = await far.run('ask', { relay: 'prompter-test', session: 'conv-there', question: 'Q?' });
  assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
});

test('the pending asks of a conversation are capped', async () => {
  const { run } = setup();
  for (let i = 0; i < 20; i += 1) assert.equal((await run('ask', { question: `Q${i}?` })).status, 200);
  const over = await run('ask', { question: 'One more?' });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, CODES.questionLimit);
});

test('an ask on a paired relay needs it unlocked and the prompt permission, a session there, and leaves a mirror', async () => {
  const { run, asks, remoteCalls, noted } = setup({
    remote: (_relay, method, path, { body }) => {
      if (path === RELAY_ASK_REMOTE_PATHS.ask) {
        return { ok: true, ask: { id: 'ask_there0001', question: body.question, options: body.options, session: { id: body.session, title: 'Far worker' }, status: 'pending' } };
      }
      if (path === RELAY_ASK_REMOTE_PATHS.withdraw) return { ok: true, ask: { id: body.id, status: 'withdrawn' } };
      return {};
    },
  });
  const locked = await run('ask', { relay: 'locked-test', session: 'conv-there', question: 'Q?' });
  assert.equal(locked.body.code, CODES.locked);
  const reader = await run('ask', { relay: 'reader-test', session: 'conv-there', question: 'Q?' });
  assert.equal(reader.status, 403);
  assert.equal(reader.body.code, CODES.forbidden);
  assert.match(reader.body.error, /ask needs "prompt"/);
  const noSession = await run('ask', { relay: 'prompter-test', question: 'Q?' });
  assert.equal(noSession.status, 400);
  assert.match(noSession.body.error, /needs session/);
  assert.equal(remoteCalls.length, 0, 'nothing reached the paired relays');

  const asked = await run('ask', { relay: 'prompter-test', session: 'conv-there', ...QUESTION, urgency: 'now' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.deepEqual(remoteCalls.at(-1), {
    relay: PROMPTER.id,
    method: 'POST',
    path: RELAY_ASK_REMOTE_PATHS.ask,
    body: { session: 'conv-there', ...QUESTION, urgency: 'now', asker: { conversationId: CALLER, title: 'Coordinator', relayName: 'win-test' } },
    query: undefined,
  });
  assert.equal(asked.body.question_id, 'ask_there0001');
  assert.deepEqual(noted, [PROMPTER.id]);
  assert.equal(asks.getMirror(PROMPTER.id, 'ask_there0001').status, 'pending');
  const listed = await run('list_questions', { relay: 'prompter-test' });
  assert.deepEqual(listed.body.questions.map((ask) => ask.id), ['ask_there0001']);
  assert.equal((await run('withdraw', { relay: 'prompter-test', question_id: 'ask_nope0001' })).status, 404);
  const withdrawn = await run('withdraw', { relay: 'prompter-test', question_id: 'ask_there0001' });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.equal(remoteCalls.at(-1).path, RELAY_ASK_REMOTE_PATHS.withdraw);
  assert.equal(asks.getMirror(PROMPTER.id, 'ask_there0001').status, 'withdrawn');
});

test('a paired relay without asks says it needs an update', async () => {
  const notFound = Object.assign(new Error('Not found'), { code: CODES.notFound, status: 404, remoteBody: null });
  const { run } = setup({ remote: () => { throw notFound; } });
  const result = await run('ask', { relay: 'prompter-test', session: 'conv-there', question: 'Q?' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, CODES.unsupported);
  assert.match(result.body.error, /without questions that don't block/);
});

test('answer_question refuses an ask: only the user answers it', async () => {
  const { run, remoteCalls } = setup({
    remote: (_relay, method, path) => (method === 'GET' && path.startsWith('/api/relay-question/')
      ? { question: { id: 'ask_there0001', kind: 'ask', status: 'pending', conversationId: 'conv-there', question: 'Deploy?', options: ['Yes'] } }
      : {}),
  });
  const result = await run('answer_question', { relay: 'full-test', question_id: 'ask_there0001', choices: ['Yes'] });
  assert.equal(result.status, 403);
  assert.match(result.body.error, /the user's to answer/);
  assert.equal(remoteCalls.filter((entry) => entry.method === 'POST').length, 0, 'no answer was sent');
});

test('read_session lists the pending asks of a session with their kind', async () => {
  const { run, remoteCalls } = setup({
    remote: (_relay, method, path) => {
      if (path === '/api/relay-questions') {
        return {
          questions: [
            { id: 'q-card', prompt: 'Which theme?', choices: ['Light'], context: null, allowFreeform: true, messageId: 'm-1', kind: 'ask_user' },
            { id: 'ask_there0001', kind: 'ask', question: 'Deploy?', prompt: 'Deploy?', options: ['Yes', 'No'], recommendation: 'No', status: 'pending', createdAt: '2026-03-02T10:00:00.000Z' },
          ],
        };
      }
      return { id: 'conv-there', title: 'Far worker', messages: [] };
    },
  });
  const read = await run('read_session', { relay: 'reader-test', session: 'conv-there' });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.pendingQuestions.map((question) => [question.id, question.kind]), [['q-card', 'ask_user'], ['ask_there0001', 'ask']]);
  assert.deepEqual(read.body.pendingQuestions[1], {
    id: 'ask_there0001',
    kind: 'ask',
    question: 'Deploy?',
    options: ['Yes', 'No'],
    recommendation: 'No',
    createdAt: '2026-03-02T10:00:00.000Z',
    note: 'Asked with ask: it does not block the session, and only the user answers it.',
  });
  assert.equal(remoteCalls.find((entry) => entry.path === '/api/relay-questions').query.includeAsks, 1);
});
