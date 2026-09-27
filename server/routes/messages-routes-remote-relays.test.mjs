import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import {
  buildDequeuedRelayMessage,
  dequeuePendingMessage,
} from './messages-routes.mjs';
import { registerAskUserRoutes } from './ask-user-routes.mjs';
import { buildConversationMessages } from './sessions-routes.mjs';
import {
  makeRouteDeps as baseRouteDeps,
  captureRoutes,
  invokeRoute,
} from './messages-routes-test-harness.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import { createPushDispatchService } from '../services/push-dispatch-service.mjs';
import { createRemoteRelayCallerContext } from '../services/remote-relay-caller-context.mjs';
import { stripRelayPromptContext } from '../services/relay-prompt-sanitizer.mjs';
import { questionExpiresAt } from '../../shared/question-timeout.mjs';
import { formatRemotePromptHeader, withRemotePromptHeader } from '../../shared/remote-relay-contract.mjs';
import { applySchema } from '../db-schema.mjs';

// The inbound side of remote relays on POST /api/message and the write routes
// another relay's agent reaches (cancel-turn, cancel-queued-turn, question
// answers), against the REAL routes and the REAL SQLite schema:
//
//   human message  → mention unlocks + a hint in the queued prompt only
//   agent message  → origin stored and emitted, no unlock, draft and composer
//                    preferences untouched, no "reply ready" push
//   inbound switch → 403 REMOTE_INBOUND_DISABLED for agent traffic only
//
// Boot pattern mirrors messages-routes-attempt-fencing.test.mjs. Relay names,
// hosts and titles are fictional.

const CONV = 'conv-remote-1';
const RUNTIME_SESSION_ID = 'rs-remote-1';
const MODEL = 'claude-sonnet-5';
const NOW = '2026-01-01T00:00:00.000Z';
const DRAFT = 'half-typed note';

const RELAYS = [
  { id: 'r-linux', name: 'linux-test', url: 'https://relay-b.example.test', lastStatus: 'online', version: '0.9.4' },
  { id: 'r-lab', name: 'lab-relay', url: 'https://relay-c.example.test', lastStatus: 'offline', version: '' },
];

const ORIGIN = {
  relayId: 'relay-id-win',
  relayName: 'win-test',
  relayUrl: 'https://relay-a.example.test',
  conversationId: 'conv-source-1',
  conversationTitle: 'report builder',
  provider: 'claude',
  model: MODEL,
  hops: 1,
};

const LINUX_HINT = '<system_reminder>The user mentioned the remote OAR relay "linux-test" (online, OAR 0.9.4). '
  + 'The remote_relay tool can list, read, prompt and create sessions there.</system_reminder>';

function seedConversation(db) {
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at, draft_text, draft_updated_at, preferred_relay_mode, preferred_model)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, 'ask', ?)
  `).run(CONV, 'Remote relays', CONV, NOW, NOW, DRAFT, NOW, MODEL);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, ?, 'isolated', ?, ?, 'claude', ?, 'active', ?, ?)
  `).run(RUNTIME_SESSION_ID, CONV, CONV, `runtime-key-${RUNTIME_SESSION_ID}`, MODEL, MODEL, NOW, NOW);
}

// What server-runtime wires as deps.remoteRelayInbound, over the committed
// repository and a fixed registry.
function makeRemoteRelayInbound(db) {
  const repository = createRemoteRelayRepository(db);
  const state = { enabled: true };
  return {
    state,
    repository,
    listRelays: () => RELAYS,
    selfNames: () => ['win-test'],
    inboundEnabled: () => state.enabled,
    recordUnlock: (conversationId, relayId, messageId) => repository.recordUnlock(conversationId, relayId, messageId),
    describeRelay: (id) => {
      const relay = RELAYS.find((entry) => entry.id === id);
      return relay ? { id, name: relay.name, online: relay.lastStatus === 'online', version: relay.version } : null;
    },
  };
}

function boot({ withRemoteRelays = true } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  seedConversation(db);
  const stmts = {
    ...createSessionRepository(db),
    ...createMessageRepository(db),
    ...createQuestionRepository(db),
  };
  const remoteRelayInbound = withRemoteRelays ? makeRemoteRelayInbound(db) : null;
  const repository = remoteRelayInbound?.repository || createRemoteRelayRepository(db);
  const emitted = [];
  const pushes = [];
  const pushDispatchService = createPushDispatchService({
    db,
    webpush: { sendNotification: async (_subscription, payload) => { pushes.push(JSON.parse(payload)); } },
    hasActiveDevice: () => false,
    uuid: () => crypto.randomUUID(),
    logger: { warn: () => {} },
  });
  pushDispatchService.upsertSubscription({
    deviceId: 'device-1',
    endpoint: 'https://push.example.test/device-1',
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
  });
  const deps = baseRouteDeps({
    db,
    stmts,
    io: {
      emit: (event, payload) => emitted.push({ event, payload }),
      volatile: { emit: (event, payload) => emitted.push({ event, payload, volatile: true }) },
    },
    uuidv4: () => crypto.randomUUID(),
    ts: () => new Date().toISOString(),
    MAX_UPLOAD_ATTACHMENTS: 4,
    MAX_REQUEUE_RETRIES: 5,
    ensureSessionId: () => 'client-remote-1',
    DEFAULT_RELAY_MODE: 'agent',
    configuredConversationSessionMode: 'isolated',
    collectReferenceAttachmentsFromText: () => ({ attachments: [], skipped: 0 }),
    attachmentSummary: () => '',
    parseAttachments: (raw) => {
      try {
        return JSON.parse(raw || '[]') || [];
      } catch {
        return [];
      }
    },
    hydrateAttachment: (value) => value,
    linkUploadReferences: () => {},
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
    ensureRuntimeSessionBinding: (conversationId) => stmts.getRuntimeSessionByConversation.get(conversationId) || null,
    getOrCreateConversation: (id, firstLine) => {
      stmts.insertConv.run(id, String(firstLine || 'Untitled').slice(0, 80), NOW, NOW);
      return stmts.getConv.get(id);
    },
    getClaudeProviderSettings: () => ({ enabled: true, model: MODEL, models: [MODEL] }),
    // A conversation this route creates is Copilot-bound: its model resolves
    // against the hosted catalog.
    resolveRequestedModel: (model) => ({ ok: true, model: String(model || 'gpt-5.4-mini'), available: ['gpt-5.4-mini'] }),
    resolveRequestedReasoningEffort: (_model, effort) => ({ ok: true, effort: effort || null, supported: ['none'] }),
    workspaceRootPayload: () => ({}),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0 }),
    emitToClientsExceptSessionId: (event, payload) => emitted.push({ event, payload }),
    sanitizeActivityText: (value) => String(value || '').trim().slice(0, 4000),
    relayActivityForResponse: (responseId) => stmts.listActivityByResponse.all(responseId),
    addMsIso: (ms) => new Date(Date.now() + Math.max(0, Number(ms) || 0)).toISOString(),
    computeRetryDelayMs: () => 0,
    relayBridgeOwnerService: {
      normalizeIdentity: ({ sessionId } = {}) => {
        const normalized = String(sessionId || '').trim();
        return normalized ? { sessionId: normalized } : null;
      },
    },
    pushDispatchService,
    // The ask-user routes' stand-ins (see messages-routes-attempt-fencing).
    questionExpiresAt,
    sanitizeRelayQuestionPrompt: ({ prompt }) => String(prompt || '').trim(),
    sanitizeRelayQuestionRequest: () => null,
    sanitizeRelayQuestionContext: () => null,
    parseQuestionRequest: () => null,
    normalizeQuestionChoices: (choices) => (Array.isArray(choices) ? choices.map((c) => String(c)) : []),
    formatQuestionRow: (row) => ({ id: row.id, conversationId: row.conversation_id, status: row.status }),
    runtimeState: { featureFlags: {} },
    ...(remoteRelayInbound ? { remoteRelayInbound } : {}),
  });
  const routes = captureRoutes(deps);
  for (const [key, handler] of captureRoutes(deps, registerAskUserRoutes)) routes.set(key, handler);
  const post = (routePath, body, { headers = {}, params = {} } = {}) => invokeRoute(routes, 'POST', routePath, { body, headers, params });
  const get = (routePath, { headers = {}, params = {}, query = {} } = {}) => invokeRoute(routes, 'GET', routePath, { headers, params, query });
  const send = (text, extra = {}, options = {}) => post('/api/message', {
    clientId: 'client-remote-1',
    conversationId: CONV,
    text,
    model: MODEL,
    relayMode: 'agent',
    ...extra,
  }, options);
  const messageRow = (id) => db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
  const queueRow = (id) => stmts.findQById.get(id);
  const conversationRow = () => db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(CONV);
  const eventsNamed = (name) => emitted.filter((entry) => entry.event === name).map((entry) => entry.payload);
  return {
    db, stmts, deps, emitted, pushes, remoteRelayInbound, repository,
    post, get, send, messageRow, queueRow, conversationRow, eventsNamed,
  };
}

function deliver(fx) {
  const row = dequeuePendingMessage({
    db: fx.db,
    stmts: fx.stmts,
    nowIso: new Date().toISOString(),
    requesterSessionId: CONV,
  });
  if (!row) return null;
  return buildDequeuedRelayMessage({
    msg: row,
    stmts: fx.stmts,
    parseAttachments: fx.deps.parseAttachments,
    hydrateAttachment: fx.deps.hydrateAttachment,
    ensureRuntimeSessionBinding: fx.deps.ensureRuntimeSessionBinding,
    configuredConversationSessionMode: fx.deps.configuredConversationSessionMode,
    normalizeRelayMode: fx.deps.normalizeRelayMode,
    defaultRelayMode: fx.deps.DEFAULT_RELAY_MODE,
    defaultModel: MODEL,
  });
}

const agentHeaders = { 'x-oar-remote-origin': ORIGIN.relayId, 'x-oar-remote-hops': '1' };

// ─── Mentions ────────────────────────────────────────────────────────────────

test('a human mention unlocks the relay and hints the agent, while the bubble shows only what was typed', async () => {
  const fx = boot();
  const typed = 'please ask @linux-test for the report builder status';
  const { status, body } = await fx.send(typed);
  assert.equal(status, 200, JSON.stringify(body));

  assert.deepEqual(
    fx.repository.listUnlocks(CONV).map(({ remoteRelayId, messageId }) => ({ remoteRelayId, messageId })),
    [{ remoteRelayId: 'r-linux', messageId: body.messageId }],
  );

  // Stored message (the bubble) and the socket echo: exactly what was typed.
  assert.equal(fx.messageRow(body.messageId).text, typed);
  const [userMessage] = fx.eventsNamed('user_message');
  assert.equal(userMessage.message.text, typed);
  assert.equal('origin' in userMessage.message, false);

  // The queued prompt, which every provider's worker receives as its text.
  assert.equal(fx.queueRow(body.messageId).text, `${typed}\n\n${LINUX_HINT}`);
  const delivered = deliver(fx);
  assert.equal(delivered.id, body.messageId);
  assert.equal(delivered.text, `${typed}\n\n${LINUX_HINT}`);
  // Anything rendered from that prompt (transcripts) drops the hint.
  assert.equal(stripRelayPromptContext(delivered.text, 'agent'), typed);

  // A human send still wipes the composer draft.
  assert.equal(fx.conversationRow().draft_text, null);
  assert.equal(fx.eventsNamed('conversation_draft_updated').length, 1);
});

test('the plain name and the URL host unlock too; this relay\'s own name does not', async () => {
  const fx = boot();
  const first = await fx.send('what is linux-test doing right now?');
  assert.equal(first.status, 200);
  assert.equal(fx.queueRow(first.body.messageId).text.endsWith(LINUX_HINT), true);

  const second = await fx.send('and check https://relay-c.example.test/status');
  assert.equal(second.status, 200);
  assert.match(fx.queueRow(second.body.messageId).text, /"lab-relay" \(offline\)\. The remote_relay tool/);

  const own = await fx.send('this runs on win-test itself');
  assert.equal(own.status, 200);
  assert.equal(fx.queueRow(own.body.messageId).text, 'this runs on win-test itself');

  assert.deepEqual(
    fx.repository.listUnlocks(CONV).map(({ remoteRelayId, messageId }) => ({ remoteRelayId, messageId })),
    [
      { remoteRelayId: 'r-linux', messageId: first.body.messageId },
      { remoteRelayId: 'r-lab', messageId: second.body.messageId },
    ],
  );
});

test('a later mention of an unlocked relay hints the agent again and keeps the first unlock', async () => {
  const fx = boot();
  const first = await fx.send('@linux-test first');
  const again = await fx.send('@linux-test once more');
  assert.equal(again.status, 200);
  assert.equal(fx.queueRow(again.body.messageId).text, `@linux-test once more\n\n${LINUX_HINT}`);
  assert.deepEqual(fx.repository.listUnlocks(CONV).map((entry) => entry.messageId), [first.body.messageId]);
});

// ─── Agent prompts ───────────────────────────────────────────────────────────

test('an agent\'s prompt carries its origin, never unlocks, and leaves the draft and preferences alone', async () => {
  const fx = boot();
  const text = withRemotePromptHeader('ask @lab-relay and linux-test for the numbers', ORIGIN);
  const { status, body } = await fx.send(text, { origin: ORIGIN, relayMode: 'autopilot' }, { headers: agentHeaders });
  assert.equal(status, 200, JSON.stringify(body));

  // Decision 19: an agent's message never unlocks, whatever it names.
  assert.deepEqual(fx.repository.listUnlocks(CONV), []);

  // The header line the sending relay wrote is part of the stored text and of
  // the prompt the agent receives; no mention hint rides along.
  const header = formatRemotePromptHeader(ORIGIN);
  assert.equal(header, '[Remote prompt from an agent on relay "win-test" · session "report builder" · claude-sonnet-5 · acting for the user]');
  assert.equal(fx.messageRow(body.messageId).text, text);
  assert.equal(fx.queueRow(body.messageId).text, text);
  assert.equal(deliver(fx).text.startsWith(`${header}\n\n`), true);

  // Provenance: stored on the message row, sent with the live echo, exposed
  // (camelCase) on the conversation payload's message.
  assert.deepEqual(fx.repository.getMessageOrigin(body.messageId), { kind: 'agent', ...ORIGIN });
  const [userMessage] = fx.eventsNamed('user_message');
  assert.deepEqual(userMessage.message.origin, { kind: 'agent', ...ORIGIN });
  const [payloadMessage] = buildConversationMessages({ dbMessages: [fx.messageRow(body.messageId)] });
  assert.deepEqual(payloadMessage.origin, { kind: 'agent', ...ORIGIN });
  assert.equal(payloadMessage.text, text);

  // The composer's draft and preferences stay the user's.
  const conversation = fx.conversationRow();
  assert.equal(conversation.draft_text, DRAFT);
  assert.equal(fx.eventsNamed('conversation_draft_updated').length, 0);
  assert.equal(conversation.preferred_relay_mode, 'ask');
  assert.equal(body.preferredRelayMode, 'ask');
  // The turn itself runs in the mode the agent asked for.
  assert.equal(fx.queueRow(body.messageId).relay_mode, 'autopilot');
});

test('the header alone marks a prompt as an agent\'s: a minimal origin is stored and nothing unlocks', async () => {
  const fx = boot();
  const { status, body } = await fx.send('@linux-test ping', {}, {
    headers: { 'x-oar-remote-origin': 'relay-id-win', 'x-oar-remote-hops': '2' },
  });
  assert.equal(status, 200);
  assert.deepEqual(fx.repository.listUnlocks(CONV), []);
  assert.equal(fx.queueRow(body.messageId).text, '@linux-test ping');
  const origin = fx.repository.getMessageOrigin(body.messageId);
  assert.equal(origin.relayId, 'relay-id-win');
  assert.equal(origin.hops, 2);
  assert.equal(fx.conversationRow().draft_text, DRAFT);
});

test('an agent\'s prompt that opens a new conversation is not titled after its header line', async () => {
  const fx = boot();
  const text = withRemotePromptHeader('Summarise the sidebar polish work', ORIGIN);
  const { status, body } = await fx.post('/api/message', {
    text,
    model: 'gpt-5.4-mini',
    relayMode: 'agent',
    origin: ORIGIN,
  }, { headers: agentHeaders });
  assert.equal(status, 200, JSON.stringify(body));
  assert.notEqual(body.conversationId, CONV);
  const conversation = fx.db.prepare(`SELECT title, preferred_relay_mode FROM conversations WHERE id = ?`).get(body.conversationId);
  assert.equal(conversation.title, 'Summarise the sidebar polish work');
  // A conversation the agent itself opened takes its preferences.
  assert.equal(conversation.preferred_relay_mode, 'agent');
  assert.equal(fx.messageRow(body.messageId).text, text);
});

test('without the remote relay deps every step is a no-op: no origin, no unlock, no hint, draft wiped', async () => {
  const fx = boot({ withRemoteRelays: false });
  const { status, body } = await fx.send('@linux-test hello', { origin: ORIGIN }, { headers: agentHeaders });
  assert.equal(status, 200);
  assert.deepEqual(fx.repository.listUnlocks(CONV), []);
  assert.equal(fx.messageRow(body.messageId).origin_json, null);
  assert.equal(fx.queueRow(body.messageId).text, '@linux-test hello');
  assert.equal('origin' in fx.eventsNamed('user_message')[0].message, false);
  assert.equal(fx.conversationRow().draft_text, null);
  assert.equal(fx.conversationRow().preferred_relay_mode, 'agent');
});

test('an agent may repeat a prompt on purpose; a replayed messageId and a human repeat stay duplicates', async () => {
  const fx = boot();
  const text = withRemotePromptHeader('run the tests again', ORIGIN);
  const first = await fx.send(text, { origin: ORIGIN, messageId: 'agent-send-1' }, { headers: agentHeaders });
  const second = await fx.send(text, { origin: ORIGIN, messageId: 'agent-send-2' }, { headers: agentHeaders });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, undefined, 'a fresh messageId is a new prompt');
  assert.ok(fx.queueRow('agent-send-2'));

  const replay = await fx.send(text, { origin: ORIGIN, messageId: 'agent-send-2' }, { headers: agentHeaders });
  assert.ok(replay.status === 409 || replay.body.duplicate === true, JSON.stringify(replay.body));
  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS n FROM queue WHERE text = ?`).get(text).n, 2);

  await fx.send('the same words twice');
  const humanRepeat = await fx.send('the same words twice');
  assert.equal(humanRepeat.body.duplicate, true, 'the user\'s double-send guard is unchanged');
});

// ─── Inbound switch ──────────────────────────────────────────────────────────

test('with the inbound switch off, agent prompts get 403 and nothing is stored', async () => {
  const fx = boot();
  fx.remoteRelayInbound.state.enabled = false;
  const expected = { error: 'This relay does not accept prompts from other relays\' agents', code: 'REMOTE_INBOUND_DISABLED' };

  const withOrigin = await fx.send('from an agent', { origin: ORIGIN });
  assert.equal(withOrigin.status, 403);
  assert.deepEqual(withOrigin.body, expected);

  const withHeader = await fx.send('from an agent', {}, { headers: agentHeaders });
  assert.equal(withHeader.status, 403);
  assert.deepEqual(withHeader.body, expected);

  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n, 0);
  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS n FROM queue`).get().n, 0);

  // The user is never refused.
  const human = await fx.send('from the user');
  assert.equal(human.status, 200);
});

test('with the inbound switch off, an agent cannot stop turns, cancel queued ones or answer questions', async () => {
  const fx = boot();
  const queued = await fx.send('queued by the user');
  assert.equal(queued.status, 200);
  fx.remoteRelayInbound.state.enabled = false;
  const asAgent = { headers: agentHeaders, params: { conversationId: CONV } };

  const stop = await fx.post('/api/conversation/:conversationId/cancel-turn', {}, asAgent);
  assert.equal(stop.status, 403);
  assert.equal(stop.body.code, 'REMOTE_INBOUND_DISABLED');

  const cancel = await fx.post('/api/conversation/:conversationId/cancel-queued-turn', { messageId: queued.body.messageId }, asAgent);
  assert.equal(cancel.status, 403);
  assert.equal(fx.queueRow(queued.body.messageId).status, 'pending', 'the refused cancel leaves the row queued');

  const answer = await fx.post('/api/relay-question/:id/answer', { answer: 'yes' }, { headers: agentHeaders, params: { id: 'question-1' } });
  assert.equal(answer.status, 403);
  assert.equal(answer.body.code, 'REMOTE_INBOUND_DISABLED');

  // The user's own requests pass the switch.
  const userStop = await fx.post('/api/conversation/:conversationId/cancel-turn', {}, { params: { conversationId: CONV } });
  assert.equal(userStop.status, 200);
  const userAnswer = await fx.post('/api/relay-question/:id/answer', { answer: 'yes' }, { params: { id: 'question-1' } });
  assert.equal(userAnswer.status, 404, 'past the switch: the question simply does not exist');
  const userCancel = await fx.post('/api/conversation/:conversationId/cancel-queued-turn', { messageId: queued.body.messageId }, { params: { conversationId: CONV } });
  assert.equal(userCancel.status, 200);
  assert.equal(userCancel.body.cancelled, true);
});

test('with the inbound switch on, an agent may cancel a queued turn', async () => {
  const fx = boot();
  const queued = await fx.send('queued by an agent', { origin: ORIGIN }, { headers: agentHeaders });
  const cancel = await fx.post(
    '/api/conversation/:conversationId/cancel-queued-turn',
    { messageId: queued.body.messageId },
    { headers: agentHeaders, params: { conversationId: CONV } },
  );
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.cancelled, true);
});

// ─── Approval cards ──────────────────────────────────────────────────────────

test('another relay\'s agent can neither see nor answer this relay\'s remote relay approval card', async () => {
  const fx = boot();
  const turn = await fx.send('please ask @linux-test to rebuild the sidebar', { relayMode: 'ask' });
  assert.equal(turn.status, 200);
  assert.equal(deliver(fx).id, turn.body.messageId);
  const asked = await fx.post('/api/relay-question', { queueId: turn.body.messageId, prompt: 'Which theme?', choices: ['Light', 'Dark'] });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const ordinaryId = asked.body.question.id;

  // The card this relay's own dispatcher puts up before a write on linux-test.
  let release = () => {};
  const approvals = createRemoteRelayCallerContext({
    db: fx.db,
    repository: fx.repository,
    uuid: () => 'approval-1',
    sleep: () => new Promise((resolve) => { release = resolve; }),
    logger: { log() {}, warn() {} },
  });
  const decision = approvals.requestApproval({
    conversationId: CONV,
    callerContext: approvals.getCallerContext(CONV),
    relay: { id: 'r-linux', name: 'linux-test', url: 'https://relay-b.example.test' },
    action: 'send',
    args: { session: 'conv-b-1', text: 'Rebuild the sidebar' },
  });
  const pending = { query: { conversationId: CONV, status: 'pending' } };
  const asAgent = { headers: agentHeaders };

  const userList = await fx.get('/api/relay-questions', pending);
  assert.deepEqual(userList.body.questions.map((question) => question.id).sort(), ['approval-1', ordinaryId].sort());
  const agentList = await fx.get('/api/relay-questions', { ...pending, ...asAgent });
  assert.deepEqual(agentList.body.questions.map((question) => question.id), [ordinaryId], 'the card is hidden from other relays');

  assert.equal((await fx.get('/api/relay-question/:id', { ...asAgent, params: { id: 'approval-1' } })).status, 404);
  assert.equal((await fx.get('/api/relay-question/:id', { params: { id: 'approval-1' } })).status, 200);

  const agentAnswer = await fx.post('/api/relay-question/:id/answer', { answer: 'Allow' }, { ...asAgent, params: { id: 'approval-1' } });
  assert.equal(agentAnswer.status, 403);
  const bodyOrigin = await fx.post('/api/relay-question/:id/answer', { answer: 'Allow', origin: ORIGIN }, { params: { id: 'approval-1' } });
  assert.equal(bodyOrigin.status, 403, 'a body origin marks the caller too');
  const agentTimeout = await fx.post('/api/relay-question/:id/timeout', {}, { ...asAgent, params: { id: 'approval-1' } });
  assert.equal(agentTimeout.status, 403);
  assert.equal(fx.stmts.getQuestion.get('approval-1').status, 'pending', 'the refused calls leave the card open');

  // The agent may still answer the remote agent's ordinary questions.
  const ordinary = await fx.post('/api/relay-question/:id/answer', { answer: 'Dark' }, { ...asAgent, params: { id: ordinaryId } });
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body));

  // The user decides.
  const userAnswer = await fx.post('/api/relay-question/:id/answer', { answer: 'Allow' }, { params: { id: 'approval-1' } });
  assert.equal(userAnswer.status, 200, JSON.stringify(userAnswer.body));
  release();
  assert.deepEqual(await decision, { approved: true });
});

// ─── Push ────────────────────────────────────────────────────────────────────

test('a turn an agent started pushes no "reply ready"; the user\'s own turn still does', async () => {
  const fx = boot();
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const agent = await fx.send('agent work', { origin: ORIGIN }, { headers: agentHeaders });
  const agentAttempt = deliver(fx).attemptId;
  const agentReply = await fx.post('/api/response', {
    messageId: agent.body.messageId, conversationId: CONV, text: 'done for the agent', model: MODEL, mode: 'agent', attemptId: agentAttempt,
  });
  assert.equal(agentReply.status, 200);
  await flush();
  assert.equal(fx.pushes.length, 0);

  const human = await fx.send('user work');
  const humanAttempt = deliver(fx).attemptId;
  const humanReply = await fx.post('/api/response', {
    messageId: human.body.messageId, conversationId: CONV, text: 'done for the user', model: MODEL, mode: 'agent', attemptId: humanAttempt,
  });
  assert.equal(humanReply.status, 200);
  await flush();
  assert.equal(fx.pushes.length, 1);
  assert.equal(fx.pushes[0].data.type, 'turnComplete');
});
