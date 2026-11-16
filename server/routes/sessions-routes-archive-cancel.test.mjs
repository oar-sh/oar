import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import { createConversationGroupRepository } from '../repositories/conversation-group-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { createUsageLimitPauseService } from '../services/usage-limit-pause-service.mjs';
import { markRemoteRelayLoopbackRequest } from '../services/remote-relay-inbound.mjs';
import { asAgent, asOwner } from '../services/relay-principal-test-harness.mjs';
import { USAGE_LIMIT_KIND } from '../../shared/claude-usage-limit.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';
import { registerConversationGroupRoutes } from './conversation-group-routes.mjs';
import { fakeSessionWorkerSupervisor } from '../feature-flags-test-harness.mjs';

// Archiving a conversation cancels its queued messages, against the REAL
// schema: the pending and parked rows go as the cancel-queued-turn route
// cancels them, a follow-up held at the usage limit as the pause's Cancel
// drops it, in the archive's transaction, so the waker lists nothing for the
// archived chat. One note in the transcript says what was cancelled. A turn
// that runs still refuses the archive. Titles and ids are fictional.

const NOW = '2026-11-02T09:00:00.000Z';
const LATER = '2026-11-02T09:00:05.000Z';
const FAR = '2099-01-01T00:00:00.000Z';
const agentHeaders = { 'x-oar-remote-origin': 'relay-id-north', 'x-oar-remote-hops': '1' };
const LOCAL_ORIGIN = (conversationId) => ({
  relayId: 'relay-id-self',
  relayName: 'lab-relay',
  relayUrl: 'https://relay-self.example.test',
  conversationId,
  conversationTitle: 'Release lead',
  provider: 'github',
  model: 'gpt-5.4-mini',
  hops: 0,
  local: true,
});

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  };
  return {
    routes,
    get: record('GET'),
    post: record('POST'),
    patch: record('PATCH'),
    put: record('PUT'),
    delete: record('DELETE'),
    use() {},
  };
}

function setup({ withPause = false, overrides = {} } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  const repository = createRemoteRelayRepository(db);
  const conversationGroups = createConversationGroupRepository(db);
  const emitted = [];
  const emit = (event, payload) => { emitted.push([event, payload]); };
  const usageLimitPauseService = withPause
    ? createUsageLimitPauseService({ db, stmts, emit, logger: { log() {}, warn() {} } })
    : null;
  const app = createMockApp();
  const deps = {
    auth: (_req, _res, next) => next(),
    io: { emit },
    db,
    stmts,
    runtimeState: {},
    config: {},
    parseAttachments: () => [],
    hydrateAttachment: (v) => v,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => [],
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({
      models: ['gpt-5.4-mini'],
      currentModel: 'gpt-5.4-mini',
      defaultModel: 'gpt-5.4-mini',
      reasoningByModel: { 'gpt-5.4-mini': ['none'] },
      providersByModel: { 'gpt-5.4-mini': ['github-copilot'] },
    }),
    updateModelCatalog: () => ({}),
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => ({}),
    setEnabledModelVariants: () => ({}),
    SUPPORTED_REASONING_EFFORTS: ['none', 'low', 'medium', 'high'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => ({ recentWorkspaceRoots: [] }),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => null,
    updateConversationConfiguredWorkspaceRoot: () => ({ ok: true }),
    learnConversationWorkspaceRoot: () => ({ ok: true }),
    consumePendingSessionCwd: () => null,
    getPendingSessionCwd: () => null,
    workspaceRootAllowList: [],
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => 'client-1',
    markCliOffline: () => {},
    fetchUsageSummary: () => {},
    ensureRuntimeSessionBinding: () => ({ id: 'runtime-session-1' }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent', 'ask', 'plan', 'autopilot'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: () => null,
    resolveSessionStateRoot: () => null,
    sessionWorkerRegistry: createSessionWorkerRegistry(),
    sessionWorkerSupervisor: fakeSessionWorkerSupervisor(),
    sessionHistoryRefreshService: {
      evaluateRefreshIdleState: () => ({ idle: true }),
      replaceRetrievableHistory: () => {},
    },
    sdkSessionImportService: null,
    statusEventService: { recordSharedAccess: () => ({ event: null }) },
    isSha256: () => false,
    remoteRelayInbound: {
      repository,
      listRelays: () => [],
      selfNames: () => ['lab-relay'],
      inboundEnabled: () => true,
      recordUnlock: (conversationId, relayId, messageId) => repository.recordUnlock(conversationId, relayId, messageId),
      describeRelay: () => null,
    },
    conversationGroups,
    usageLimitPauseService,
    ...overrides,
  };
  registerSessionsRoutes(app, deps);
  registerConversationGroupRoutes(app, deps);

  const call = async (key, { body = {}, headers = {}, params = {}, query = {}, loopback = false } = {}) => {
    const handler = app.routes.get(key);
    assert.ok(handler, `${key} should be registered`);
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      set() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    const req = { body, headers, query, params, socket: {} };
    if (loopback) asAgent(markRemoteRelayLoopbackRequest(req), body?.origin?.conversationId || 'loopback-caller');
    else asOwner(req);
    await handler(req, res);
    return captured;
  };
  const bootstrap = async (body = {}, headers = {}, loopback = false) => {
    const created = await call('POST /api/conversation/bootstrap', {
      body: { title: 'Nightly report', relayMode: 'agent', ...body },
      headers,
      loopback,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body.conversationId;
  };
  // A queued message as a send leaves it: the user's row and its queue row.
  const queue = (conversationId, id, { status = 'pending', text = `prompt ${id}`, at = NOW, kind = null } = {}) => {
    db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp, kind) VALUES (?, ?, 'user', ?, ?, ?)`)
      .run(id, conversationId, text, at, kind);
    db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES (?, ?, ?, ?, ?)`)
      .run(id, conversationId, text, status, at);
  };
  const archive = (id, options = {}) => call('POST /api/conversation/:id/archive', { params: { id }, ...options });
  const queueRowsOf = (conversationId) => db.prepare(`SELECT id, status FROM queue WHERE conversation_id = ? ORDER BY timestamp, rowid`).all(conversationId);
  const messagesOf = (conversationId) => db.prepare(`SELECT id, role, text, kind FROM messages WHERE conversation_id = ? ORDER BY timestamp, rowid`).all(conversationId);
  // What the waker would launch a worker for.
  const wakerSessions = () => stmts.listPendingWorkerOwnerSessionIds.all(25).map((row) => row.sdk_session_id);
  const events = (name) => emitted.filter(([event]) => event === name).map(([, payload]) => payload);
  return { db, stmts, emitted, events, call, bootstrap, queue, archive, queueRowsOf, messagesOf, wakerSessions, conversationGroups };
}

test('archiving cancels the pending and parked rows: nothing is left for the waker, each row says cancelled, one note says how many', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  fx.queue(conv, 'msg-sched-1', { text: 'scheduled sweep' });
  fx.queue(conv, 'msg-parked-1', { status: 'parked', at: LATER });
  assert.deepEqual(fx.wakerSessions(), [conv], 'before the archive the waker would start a worker for it');

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.ok, true);
  assert.deepEqual(archived.body.cancelledMessageIds, ['msg-sched-1', 'msg-parked-1']);
  assert.equal(fx.db.prepare(`SELECT archived FROM conversations WHERE id = ?`).get(conv).archived, 1);

  assert.deepEqual(fx.queueRowsOf(conv), [], 'the queue holds nothing of the archived chat');
  assert.deepEqual(fx.wakerSessions(), [], 'and the waker lists nothing');
  assert.deepEqual(fx.events('message_status'), [
    { messageId: 'msg-sched-1', conversationId: conv, status: 'cancelled' },
    { messageId: 'msg-parked-1', conversationId: conv, status: 'cancelled' },
  ]);

  // The user's messages stay; one note follows them. It is no queue row.
  const messages = fx.messagesOf(conv);
  assert.deepEqual(messages.slice(0, 2).map((row) => [row.id, row.role]), [['msg-sched-1', 'user'], ['msg-parked-1', 'user']]);
  assert.equal(messages.length, 3);
  const note = messages[2];
  assert.equal(note.role, 'assistant');
  assert.equal(note.kind, null, 'the existing [System Message] style, no kind of its own');
  assert.equal(note.text, '[System Message] Archived: cancelled 2 queued messages.');
  assert.deepEqual(fx.events('assistant_message'), [{
    conversationId: conv,
    sourceMessageId: null,
    messageId: note.id,
    message: { role: 'assistant', text: note.text, model: null, mode: null, timestamp: fx.db.prepare(`SELECT timestamp FROM messages WHERE id = ?`).get(note.id).timestamp },
  }]);
  // The archive announces itself before the cancels.
  const order = fx.emitted.map(([event]) => event).filter((event) => ['conversation_archived', 'message_status', 'assistant_message'].includes(event));
  assert.deepEqual(order, ['conversation_archived', 'message_status', 'message_status', 'assistant_message']);
});

test('a pending question of an earlier attempt is cancelled with its row and announced once', async () => {
  const fx = setup({ overrides: { formatQuestionRow: (row) => ({ id: row.id, status: row.status, messageId: row.message_id }) } });
  const conv = await fx.bootstrap();
  fx.queue(conv, 'msg-requeued', { text: 'run the migration' });
  const insertQuestion = fx.db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, prompt, status, created_at, expires_at, attempt_id)
    VALUES (?, 'msg-requeued', ?, 'msg-requeued', ?, ?, ?, ?, 'attempt-old')
  `);
  // Asked on the attempt before the row went back to pending; one answered.
  insertQuestion.run('question-open', conv, 'Which database?', 'pending', NOW, FAR);
  insertQuestion.run('question-done', conv, 'Proceed?', 'answered', NOW, FAR);

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(fx.events('relay_question_updated'), [{ question: { id: 'question-open', status: 'cancelled', messageId: 'msg-requeued' } }]);
  // The row's delete takes its questions along (the foreign key cascades).
  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS count FROM relay_questions WHERE queue_id = 'msg-requeued'`).get().count, 0);
});

test('one cancelled message reads in the singular; an archive with nothing queued writes no note', async () => {
  const fx = setup();
  const one = await fx.bootstrap();
  fx.queue(one, 'msg-event-1', { text: 'Relay events: turn_end of Docs pass', kind: 'relay-event' });
  const single = await fx.archive(one);
  assert.deepEqual(single.body.cancelledMessageIds, ['msg-event-1']);
  assert.equal(fx.messagesOf(one).at(-1).text, '[System Message] Archived: cancelled 1 queued message.');

  const idle = await fx.bootstrap({ title: 'Idle chat' });
  const quiet = await fx.archive(idle);
  assert.equal(quiet.status, 200);
  assert.deepEqual(quiet.body.cancelledMessageIds, []);
  assert.deepEqual(fx.messagesOf(idle), []);
  assert.equal(fx.events('assistant_message').length, 1, 'only the first archive wrote a note');
});

test('a running turn still refuses the archive and its queued rows stay queued', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  fx.queue(conv, 'msg-running', { status: 'processing' });
  fx.queue(conv, 'msg-next', { at: LATER });

  const refused = await fx.archive(conv);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'turn-running');
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-running', status: 'processing' }, { id: 'msg-next', status: 'pending' }]);
  assert.equal(fx.db.prepare(`SELECT archived FROM conversations WHERE id = ?`).get(conv).archived, 0);
  assert.deepEqual(fx.events('message_status'), []);
  assert.equal(fx.messagesOf(conv).length, 2, 'no note');
});

test('unarchive leaves the cancelled rows cancelled and starts nothing; a message sent after it is queued as usual', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  fx.queue(conv, 'msg-before', { text: 'board follow-up' });
  await fx.archive(conv);
  const statusEvents = fx.events('message_status').length;

  const unarchived = await fx.call('POST /api/conversation/:id/unarchive', { params: { id: conv } });
  assert.equal(unarchived.status, 200);
  assert.equal(fx.db.prepare(`SELECT archived FROM conversations WHERE id = ?`).get(conv).archived, 0);
  assert.deepEqual(fx.queueRowsOf(conv), []);
  assert.deepEqual(fx.wakerSessions(), [], 'nothing to relaunch, the note included');
  assert.equal(fx.events('message_status').length, statusEvents);

  fx.queue(conv, 'msg-after', { text: 'new question', at: LATER });
  assert.deepEqual(fx.wakerSessions(), [conv]);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-after', status: 'pending' }]);
});

test('a follow-up held at the usage limit goes as the pause banner\'s Cancel drops it, with the other rows', async () => {
  const fx = setup({ withPause: true });
  const conv = await fx.bootstrap();
  fx.queue(conv, 'msg-paused', { text: 'Automatic message from OAR: the work was paused at the Claude usage limit.', kind: USAGE_LIMIT_KIND });
  fx.db.prepare(`UPDATE queue SET usage_limit_pause = ?, next_attempt_at = ? WHERE id = 'msg-paused'`)
    .run(JSON.stringify({ rateLimitType: 'five_hour', resetsAt: FAR, auto: true, pausedAt: NOW }), FAR);
  fx.queue(conv, 'msg-queued', { at: LATER });

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.cancelledMessageIds, ['msg-queued', 'msg-paused']);
  assert.deepEqual(fx.queueRowsOf(conv), []);
  // The relay's own follow-up was never sent: it leaves the transcript.
  assert.deepEqual(fx.messagesOf(conv).map((row) => [row.id, row.role]), [['msg-queued', 'user'], [fx.messagesOf(conv)[1].id, 'assistant']]);
  assert.equal(fx.messagesOf(conv)[1].text, '[System Message] Archived: cancelled 1 queued message and the usage-limit follow-up.');
  assert.deepEqual(fx.events('usage_limit_pause'), [{ conversationId: conv, pause: null }]);
  assert.deepEqual(fx.events('message_status').map((event) => event.messageId), ['msg-paused', 'msg-queued'], 'each row announced once');
});

test('the pause alone makes a note of its own', async () => {
  const fx = setup({ withPause: true });
  const conv = await fx.bootstrap();
  fx.queue(conv, 'msg-paused', { text: 'Automatic message from OAR: the work was paused at the Claude usage limit.', kind: USAGE_LIMIT_KIND });
  fx.db.prepare(`UPDATE queue SET usage_limit_pause = ?, next_attempt_at = ? WHERE id = 'msg-paused'`)
    .run(JSON.stringify({ rateLimitType: 'seven_day', resetsAt: FAR, auto: false, pausedAt: NOW }), '9999-12-31T00:00:00.000Z');

  const archived = await fx.archive(conv);
  assert.deepEqual(archived.body.cancelledMessageIds, ['msg-paused']);
  assert.deepEqual(fx.messagesOf(conv).map((row) => row.text), ['[System Message] Archived: cancelled the usage-limit follow-up.']);
});

test('an agent archiving through a paired relay cancels the same way', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  fx.queue(conv, 'msg-remote-1', { text: 'sent by an agent' });
  const archived = await fx.archive(conv, { headers: agentHeaders });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.cancelledMessageIds, ['msg-remote-1']);
  assert.deepEqual(fx.queueRowsOf(conv), []);
  assert.deepEqual(fx.wakerSessions(), []);
});

test('a group archive cancels the queued rows of each member it archives, and keeps those of the member it skips', async () => {
  const fx = setup();
  const lead = await fx.bootstrap({ title: 'Release lead' });
  const child = await fx.bootstrap({ title: 'Docs pass', origin: LOCAL_ORIGIN(lead) }, { 'x-oar-remote-origin': 'self', 'x-oar-remote-hops': '0' }, true);
  const busy = await fx.bootstrap({ title: 'Tests pass', origin: LOCAL_ORIGIN(lead) }, { 'x-oar-remote-origin': 'self', 'x-oar-remote-hops': '0' }, true);
  const groupId = fx.conversationGroups.groupOfConversation(lead).id;
  fx.queue(lead, 'msg-lead-1');
  fx.queue(child, 'msg-child-1');
  fx.queue(busy, 'msg-busy-run', { status: 'processing' });
  fx.queue(busy, 'msg-busy-next', { at: LATER });

  const archived = await fx.call('POST /api/conversation-groups/:id/archive', { params: { id: groupId } });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.archived.sort(), [child, lead].sort());
  assert.deepEqual(fx.queueRowsOf(lead), []);
  assert.deepEqual(fx.queueRowsOf(child), []);
  assert.deepEqual(fx.queueRowsOf(busy), [{ id: 'msg-busy-run', status: 'processing' }, { id: 'msg-busy-next', status: 'pending' }]);
  assert.deepEqual(fx.events('message_status').map((event) => event.messageId).sort(), ['msg-child-1', 'msg-lead-1']);
  assert.deepEqual(fx.wakerSessions(), [busy]);
});
