import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import { createConversationGroupRepository } from '../repositories/conversation-group-repository.mjs';
import { unarchivedConversationEvent } from '../repositories/queue-insert.mjs';
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
    uuidv4: randomUUID,
    ts: () => NOW,
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
  // A turn a worker claimed: the row is processing and owned by that session.
  const claim = (conversationId, id, { owner = conversationId, at = NOW, text = `prompt ${id}` } = {}) => {
    queue(conversationId, id, { status: 'processing', text, at });
    db.prepare(`UPDATE queue SET owner_sdk_session_id = ?, processing_at = ?, attempt_id = ? WHERE id = ?`)
      .run(owner, at, `attempt-${id}`, id);
  };
  const archive = (id, options = {}) => call('POST /api/conversation/:id/archive', { params: { id }, ...options });
  const queueRowsOf = (conversationId) => db.prepare(`SELECT id, status FROM queue WHERE conversation_id = ? ORDER BY timestamp, rowid`).all(conversationId);
  const messagesOf = (conversationId) => db.prepare(`SELECT id, role, text, kind FROM messages WHERE conversation_id = ? ORDER BY timestamp, rowid`).all(conversationId);
  // What the waker would launch a worker for.
  const wakerSessions = () => stmts.listPendingWorkerOwnerSessionIds.all(25).map((row) => row.sdk_session_id);
  const events = (name) => emitted.filter(([event]) => event === name).map(([, payload]) => payload);
  // The sessions the dead-worker sweep would recover turns of.
  const sweepSessions = () => stmts.listProcessingOwnerSessionIds.all(25).map((row) => row.sdk_session_id);
  return { db, stmts, deps, emitted, events, call, bootstrap, queue, claim, archive, queueRowsOf, messagesOf, wakerSessions, sweepSessions, conversationGroups };
}

// A pid no process has: the registry's worker is gone.
const DEAD_PID = 2_147_483_000;

test('a turn whose worker died ends as failed when its chat is archived: nothing is left for the sweep to requeue', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-orphaned', { text: 'refactor the parser' });
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  assert.deepEqual(fx.sweepSessions(), [conv], 'before the archive the sweep would recover the turn');

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.failedMessageIds, ['msg-orphaned']);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-orphaned', status: 'failed' }]);
  assert.deepEqual(fx.sweepSessions(), [], 'the sweep finds nothing to requeue');
  assert.deepEqual(fx.wakerSessions(), [], 'and the waker nothing to start');
});

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

// ─── Turns left processing with no worker ────────────────────────────────────

const ARCHIVED_REPLY = 'This chat was archived while this reply was not finished. Error code: relay.conversation-archived. Unarchive the chat and send the message again to continue.';

function spies() {
  const pushes = [];
  const relayEvents = [];
  return {
    pushes,
    relayEvents,
    overrides: {
      pushDispatchService: { notifyTurnFailed: (payload) => { pushes.push(payload); return Promise.resolve(); } },
      relayEventService: {
        noteError: (payload) => relayEvents.push(['error', payload]),
        noteTurnEnd: (payload) => relayEvents.push(['turn_end', payload]),
        noteConversationGone: (conversationId) => relayEvents.push(['gone', conversationId]),
      },
      formatQuestionRow: (row) => ({ id: row.id, status: row.status, messageId: row.message_id }),
    },
  };
}

test('the failed turn gets one failure reply, its relay event and the archive note; no push, and the stopped worker is left alone', async () => {
  const spy = spies();
  const markedErrors = [];
  const fx = setup({ overrides: { ...spy.overrides, sessionWorkerSupervisor: { ...fakeSessionWorkerSupervisor(), markError: (sid) => markedErrors.push(sid) } } });
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-orphaned', { text: 'refactor the parser' });
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.cancelledMessageIds, []);
  assert.deepEqual(archived.body.failedMessageIds, ['msg-orphaned']);

  const messages = fx.messagesOf(conv);
  assert.deepEqual(messages.map((row) => [row.role, row.text]), [
    ['user', 'refactor the parser'],
    ['assistant', ARCHIVED_REPLY],
    ['assistant', '[System Message] Archived: ended 1 unfinished reply.'],
  ]);
  const row = fx.db.prepare(`SELECT status, response, response_message_id FROM queue WHERE id = 'msg-orphaned'`).get();
  assert.equal(row.status, 'failed');
  assert.equal(JSON.parse(row.response).code, 'conversation-archived');
  assert.equal(row.response_message_id, messages[1].id);

  assert.deepEqual(fx.events('message_status'), [{ messageId: 'msg-orphaned', conversationId: conv, status: 'failed' }]);
  assert.deepEqual(spy.pushes, [], 'the owner archived it: no turn-failed push');
  assert.deepEqual(spy.relayEvents.filter(([kind]) => kind === 'error').map(([, event]) => [event.kind, event.queueMessageId]), [['turn_failed', 'msg-orphaned']]);
  // The turn fails before the archive ends the chat's subscriptions.
  assert.deepEqual(spy.relayEvents.map(([kind]) => kind), ['error', 'gone']);
  assert.deepEqual(markedErrors, [], 'no restart is scheduled for the stopped worker');
  assert.equal(fx.deps.sessionWorkerRegistry.getWorker(conv), null, 'and no registry entry comes back');
  const order = fx.emitted.map(([event]) => event).filter((event) => ['conversation_archived', 'message_status', 'assistant_message'].includes(event));
  assert.deepEqual(order, ['conversation_archived', 'assistant_message', 'message_status', 'assistant_message']);
});

test('a running turn of a session the registry has not seen still refuses the archive', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-unknown-worker');
  const refused = await fx.archive(conv);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'turn-running');
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-unknown-worker', status: 'processing' }]);
});

test('a row an idle worker claims while the archive stops it ends as failed, not processing', async () => {
  const alive = new Set([process.pid]);
  let fxRef = null;
  let conv = null;
  const fx = setup({
    overrides: {
      sessionWorkerStopOverrides: {
        platform: 'linux',
        // The worker takes the queued row in the instant before it dies.
        killImpl: (pid) => {
          fxRef.db.prepare(`UPDATE queue SET status = 'processing', owner_sdk_session_id = ?, processing_at = ?, attempt_id = 'attempt-late' WHERE id = 'msg-claimed'`).run(conv, NOW);
          alive.delete(pid);
        },
        isPidAliveImpl: (pid) => alive.has(pid),
        killTmuxSessionImpl: () => {},
        sleepImpl: async () => {},
        gracefulTimeoutMs: 5,
        escalationTimeoutMs: 5,
        pollIntervalMs: 1,
      },
      sessionWorkerProcessInspector: { findProcessesForSessionAsync: () => [...alive].map((processId) => ({ processId })) },
    },
  });
  fxRef = fx;
  conv = await fx.bootstrap();
  fx.queue(conv, 'msg-claimed', { text: 'scheduled sweep' });
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'ready', pid: process.pid });

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.workerStopped, true);
  assert.deepEqual(archived.body.cancelledMessageIds, []);
  assert.deepEqual(archived.body.failedMessageIds, ['msg-claimed']);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-claimed', status: 'failed' }]);
  assert.deepEqual(fx.sweepSessions(), []);
});

test('the partial output, the question cards and the sub-agent runs of the failed turn end with it', async () => {
  const spy = spies();
  const fx = setup({ overrides: spy.overrides });
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-orphaned');
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  const insertStream = fx.db.prepare(`INSERT INTO relay_stream_events (queue_message_id, conversation_id, seq, text, created_at) VALUES ('msg-orphaned', ?, ?, ?, ?)`);
  insertStream.run(conv, 1, 'Reading the parser', NOW);
  insertStream.run(conv, 2, ' and its tests', NOW);
  const insertQuestion = fx.db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, prompt, status, created_at, expires_at, attempt_id)
    VALUES (?, 'msg-orphaned', ?, 'msg-orphaned', ?, 'pending', ?, ?, ?)
  `);
  insertQuestion.run('question-earlier', conv, 'Which branch?', NOW, FAR, 'attempt-old');
  insertQuestion.run('question-current', conv, 'Proceed?', NOW, FAR, 'attempt-msg-orphaned');
  const insertRun = fx.db.prepare(`INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at) VALUES (?, 'msg-orphaned', ?, ?, 'running', ?, ?)`);
  insertRun.run('toolu_review', conv, 'Review the parser', NOW, NOW);

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  const replyId = fx.db.prepare(`SELECT response_message_id FROM queue WHERE id = 'msg-orphaned'`).get().response_message_id;
  assert.ok(replyId);
  assert.deepEqual(fx.db.prepare(`SELECT seq, response_message_id FROM relay_stream_events WHERE queue_message_id = 'msg-orphaned' ORDER BY seq`).all(),
    [{ seq: 1, response_message_id: replyId }, { seq: 2, response_message_id: replyId }], 'the partial output belongs to the failure reply');
  assert.deepEqual(fx.db.prepare(`SELECT id, status FROM relay_questions ORDER BY id`).all(),
    [{ id: 'question-current', status: 'cancelled' }, { id: 'question-earlier', status: 'cancelled' }]);
  assert.deepEqual(fx.events('relay_question_updated').map((event) => event.question.id).sort(), ['question-current', 'question-earlier']);
  // Announced after the commit: the archive's own event comes first.
  const names = fx.emitted.map(([event]) => event);
  assert.ok(names.indexOf('conversation_archived') < names.indexOf('relay_question_updated'));
  assert.equal(fx.db.prepare(`SELECT status FROM subagent_runs WHERE id = 'toolu_review'`).get().status, 'failed');
  assert.deepEqual(fx.events('subagent_status').map((event) => [event.status, event.queueMessageId]), [['failed', 'msg-orphaned']]);
});

test('queued rows are cancelled and the dead turn failed: one note counts both', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-orphaned');
  fx.queue(conv, 'msg-next-1', { at: LATER });
  fx.queue(conv, 'msg-next-2', { status: 'parked', at: LATER });
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'error', pid: DEAD_PID });

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.cancelledMessageIds, ['msg-next-1', 'msg-next-2']);
  assert.deepEqual(archived.body.failedMessageIds, ['msg-orphaned']);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-orphaned', status: 'failed' }]);
  const notes = fx.messagesOf(conv).filter((row) => row.text.startsWith('[System Message]'));
  assert.deepEqual(notes.map((row) => row.text), ['[System Message] Archived: ended 1 unfinished reply; cancelled 2 queued messages.']);
  assert.equal(fx.messagesOf(conv).at(-1).text, notes[0].text, 'the note follows the failure reply');
});

// A process list that holds a worker for each session in `live`.
function processList(live) {
  const find = async (sessionId) => (live.has(sessionId) ? [{ processId: 4242 }] : []);
  return {
    findProcessesForSessionAsync: find,
    findProcessForSessionAsync: async (sessionId) => (await find(sessionId))[0] || null,
  };
}

test('a chat that shares its dead worker with another chat fails only its own turn', async () => {
  // The archive leaves the shared worker running: the process probe shows it dead.
  const fx = setup({ overrides: { sessionWorkerProcessInspector: processList(new Set()) } });
  const conv = await fx.bootstrap({ title: 'Parser work' });
  const other = await fx.bootstrap({ title: 'Parser review' });
  fx.db.prepare(`UPDATE conversations SET sdk_session_id = 'sdk-shared' WHERE id IN (?, ?)`).run(conv, other);
  fx.claim(conv, 'msg-own', { owner: 'sdk-shared' });
  fx.claim(other, 'msg-other', { owner: 'sdk-shared' });
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: 'sdk-shared', status: 'processing', pid: DEAD_PID });

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.failedMessageIds, ['msg-own']);
  assert.equal(archived.body.workerStopped, false, 'the worker another chat uses is not stopped');
  assert.deepEqual(fx.queueRowsOf(other), [{ id: 'msg-other', status: 'processing' }], 'the other chat\'s turn is the sweep\'s, as before');
  assert.deepEqual(fx.sweepSessions(), ['sdk-shared']);
});

test('one turn whose failure throws is still marked failed, and the next one fails normally', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-a', { text: 'first' });
  fx.claim(conv, 'msg-b', { text: 'second', at: LATER });
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  // The first failure reply cannot be written: its transaction rolls back.
  const insertMsg = fx.stmts.insertMsg;
  let thrown = 0;
  fx.stmts.insertMsg = { run: (...args) => {
    if (String(args[3]).startsWith('This chat was archived') && thrown === 0) {
      thrown += 1;
      throw new Error('disk I/O error');
    }
    return insertMsg.run(...args);
  } };
  const warnings = [];
  const warn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  let archived;
  try {
    archived = await fx.archive(conv);
  } finally {
    console.warn = warn;
  }
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.failedMessageIds, ['msg-a', 'msg-b']);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-a', status: 'failed' }, { id: 'msg-b', status: 'failed' }]);
  assert.equal(JSON.parse(fx.db.prepare(`SELECT response FROM queue WHERE id = 'msg-a'`).get().response).code, 'conversation-archived');
  assert.deepEqual(fx.messagesOf(conv).filter((row) => row.role === 'assistant').map((row) => row.text),
    [ARCHIVED_REPLY, '[System Message] Archived: ended 2 unfinished replies.'], 'only the second turn has a failure reply');
  assert.deepEqual(fx.events('message_status').map((event) => [event.messageId, event.status]), [['msg-a', 'failed'], ['msg-b', 'failed']]);
  assert.ok(warnings.some((line) => /^\[archive\] Failing the turn msg-a… of .+ threw: disk I\/O error$/.test(line)), warnings.join('\n'));
  assert.deepEqual(fx.sweepSessions(), []);
});

test('unarchive leaves the failed turn failed; a message sent after it is woken and claimed as usual', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-orphaned');
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  await fx.archive(conv);
  const unarchived = await fx.call('POST /api/conversation/:id/unarchive', { params: { id: conv } });
  assert.equal(unarchived.status, 200);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-orphaned', status: 'failed' }]);
  assert.deepEqual(fx.wakerSessions(), []);
  assert.deepEqual(fx.sweepSessions(), []);

  fx.queue(conv, 'msg-after', { text: 'try again', at: LATER });
  assert.deepEqual(fx.wakerSessions(), [conv]);
  assert.equal(fx.stmts.findPendingForWorker.get(FAR, conv)?.id, 'msg-after');
});

test('a group archive ends a member\'s dead turn the same way', async () => {
  const fx = setup();
  const lead = await fx.bootstrap({ title: 'Release lead' });
  const child = await fx.bootstrap({ title: 'Docs pass', origin: LOCAL_ORIGIN(lead) }, { 'x-oar-remote-origin': 'self', 'x-oar-remote-hops': '0' }, true);
  const groupId = fx.conversationGroups.groupOfConversation(lead).id;
  fx.claim(child, 'msg-child-orphaned');
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: child, status: 'processing', pid: DEAD_PID });

  const archived = await fx.call('POST /api/conversation-groups/:id/archive', { params: { id: groupId } });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.archived.sort(), [child, lead].sort());
  assert.deepEqual(archived.body.skipped, []);
  assert.deepEqual(fx.queueRowsOf(child), [{ id: 'msg-child-orphaned', status: 'failed' }]);
  assert.deepEqual(fx.sweepSessions(), []);
});

// Each turn is listed once and announced once, whatever throws on the way.
function captureWarnings() {
  const warnings = [];
  const warn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  return { warnings, restore: () => { console.warn = warn; } };
}

test('a question card whose announce throws lists the failed turn once, and the note counts one', async () => {
  const spy = spies();
  const fx = setup({ overrides: { ...spy.overrides, formatQuestionRow: (row) => { if (row.id === 'question-current') throw new Error('bad request JSON'); return { id: row.id }; } } });
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-orphaned');
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  fx.db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, prompt, status, created_at, expires_at, attempt_id)
    VALUES ('question-current', 'msg-orphaned', ?, 'msg-orphaned', 'Proceed?', 'pending', ?, ?, 'attempt-msg-orphaned')
  `).run(conv, NOW, FAR);
  const captured = captureWarnings();
  let archived;
  try { archived = await fx.archive(conv); } finally { captured.restore(); }
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.failedMessageIds, ['msg-orphaned']);
  assert.equal(fx.messagesOf(conv).at(-1).text, '[System Message] Archived: ended 1 unfinished reply.');
  assert.deepEqual(fx.events('message_status'), [{ messageId: 'msg-orphaned', conversationId: conv, status: 'failed' }]);
  assert.ok(captured.warnings.some((line) => /^\[archive\] The question cards of the turn msg-orph… of .+ were not cancelled: bad request JSON$/.test(line)), captured.warnings.join('\n'));
});

test('a failure that throws after its own commit is announced as failed exactly once', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-orphaned');
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  // The sub-agent reconcile runs after the failure committed, before its events.
  fx.stmts.listRunningSubagentRunsByQueueMessage = { all: () => { throw new Error('database is locked'); } };
  const captured = captureWarnings();
  let archived;
  try { archived = await fx.archive(conv); } finally { captured.restore(); }
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.failedMessageIds, ['msg-orphaned']);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-orphaned', status: 'failed' }]);
  assert.deepEqual(fx.events('message_status'), [{ messageId: 'msg-orphaned', conversationId: conv, status: 'failed' }]);
  assert.equal(fx.messagesOf(conv).filter((row) => row.text === ARCHIVED_REPLY).length, 1, 'the committed failure reply stays');
  assert.equal(fx.messagesOf(conv).at(-1).text, '[System Message] Archived: ended 1 unfinished reply.');
  assert.ok(captured.warnings.some((line) => /threw: database is locked$/.test(line)), captured.warnings.join('\n'));
});

test('an archive note that cannot be written leaves the archive standing and its subscriptions ended', async () => {
  const spy = spies();
  const fx = setup({ overrides: spy.overrides });
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-orphaned');
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  const insertMsg = fx.stmts.insertMsg;
  fx.stmts.insertMsg = { run: (...args) => {
    if (String(args[3]).startsWith('[System Message] Archived')) throw new Error('disk full');
    return insertMsg.run(...args);
  } };
  const captured = captureWarnings();
  let archived;
  try { archived = await fx.archive(conv); } finally { captured.restore(); }
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.failedMessageIds, ['msg-orphaned']);
  assert.equal(fx.db.prepare(`SELECT archived FROM conversations WHERE id = ?`).get(conv).archived, 1);
  assert.deepEqual(spy.relayEvents.map(([kind]) => kind), ['error', 'gone'], 'its subscriptions still end');
  assert.ok(captured.warnings.some((line) => /^\[archive\] The archive note of .+ was not written: disk full$/.test(line)), captured.warnings.join('\n'));
});

test('a background sub-agent run of the dead worker is closed with the archive', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-orphaned');
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  fx.db.prepare(`INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background) VALUES ('toolu_watch', 'msg-earlier', ?, 'Watch the build', 'running', ?, ?, 1)`)
    .run(conv, NOW, NOW);

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(fx.db.prepare(`SELECT status FROM subagent_runs WHERE id = 'toolu_watch'`).get().status, 'failed');
  assert.deepEqual(fx.events('subagent_status').map((event) => [event.status, event.queueMessageId, event.reconciled, event.stoppable]),
    [['failed', 'msg-earlier', true, false]]);
});

// Only a new send brings an archived chat back (queue-insert.mjs): the
// archive still cancels what was queued, and its cancel unarchives nothing.
test('archiving still cancels the queued messages and leaves the chat archived', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  fx.queue(conv, 'msg-a');
  fx.queue(conv, 'msg-b', { at: LATER });
  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.cancelledMessageIds, ['msg-a', 'msg-b']);
  assert.deepEqual(fx.queueRowsOf(conv), []);
  assert.equal(fx.stmts.getConvAnyStatus.get(conv).archived, 1);
  assert.deepEqual(fx.events('conversation_archived'), [{ conversationId: conv, archived: true }]);
});

// A row left pending in an archived chat (none is written by a send) waits:
// the waker starts nothing and no worker claims it until the chat is
// unarchived; the unarchive then wakes the queue itself
// (conversation-lifecycle-unarchive-wake.test.mjs).
test('a stranded row waits in the archived chat and is woken and claimed after the unarchive', async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  fx.queue(conv, 'msg-stranded');
  const session = String(fx.stmts.getConvAnyStatus.get(conv).sdk_session_id || conv);
  assert.deepEqual(fx.wakerSessions(), []);
  assert.equal(fx.stmts.findPendingForWorker.get(LATER, session), undefined);
  const back = await fx.call('POST /api/conversation/:id/unarchive', { params: { id: conv } });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(fx.wakerSessions(), [session]);
  assert.equal(fx.stmts.findPendingForWorker.get(LATER, session)?.id, 'msg-stranded');
});

test("the unarchive route's event is byte-identical to the one a send announces", async () => {
  const fx = setup();
  const conv = await fx.bootstrap();
  await fx.archive(conv);
  fx.emitted.length = 0;
  const back = await fx.call('POST /api/conversation/:id/unarchive', { params: { id: conv } });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const fromRoute = fx.emitted.filter(([event]) => event === 'conversation_archived');
  assert.equal(fromRoute.length, 1);
  assert.equal(JSON.stringify(fromRoute[0]), JSON.stringify(unarchivedConversationEvent(conv)));
});

test('question cards with no attempt are cancelled with the queued row and with the failed turn', async () => {
  const spy = spies();
  const fx = setup({ overrides: spy.overrides });
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-orphaned');
  fx.queue(conv, 'msg-next', { at: LATER });
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  // Cards asked before attempts were stamped on them.
  const insertQuestion = fx.db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, prompt, status, created_at, expires_at, attempt_id)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
  `);
  insertQuestion.run('question-turn', 'msg-orphaned', conv, 'msg-orphaned', 'Which branch?', NOW, FAR);
  insertQuestion.run('question-queued', 'msg-next', conv, 'msg-next', 'Proceed?', NOW, FAR);

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  // The queued row's card went with its row (the foreign key cascades).
  assert.deepEqual(fx.db.prepare(`SELECT id, status FROM relay_questions ORDER BY id`).all(), [{ id: 'question-turn', status: 'cancelled' }]);
  assert.deepEqual(fx.events('relay_question_updated').map((event) => [event.question.id, event.question.status]).sort(),
    [['question-queued', 'cancelled'], ['question-turn', 'cancelled']]);
});

test('a group archive answers with each archived member\'s failed turns', async () => {
  const fx = setup();
  const lead = await fx.bootstrap({ title: 'Release lead' });
  const child = await fx.bootstrap({ title: 'Docs pass', origin: LOCAL_ORIGIN(lead) }, { 'x-oar-remote-origin': 'self', 'x-oar-remote-hops': '0' }, true);
  const busy = await fx.bootstrap({ title: 'Tests pass', origin: LOCAL_ORIGIN(lead) }, { 'x-oar-remote-origin': 'self', 'x-oar-remote-hops': '0' }, true);
  const groupId = fx.conversationGroups.groupOfConversation(lead).id;
  fx.claim(child, 'msg-child-orphaned');
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: child, status: 'processing', pid: DEAD_PID });
  fx.queue(busy, 'msg-busy-run', { status: 'processing' });

  const archived = await fx.call('POST /api/conversation-groups/:id/archive', { params: { id: groupId } });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.archived.sort(), [child, lead].sort());
  // Like the single archive's answer, per member; a skipped member has none.
  assert.deepEqual(archived.body.failedMessageIds, { [lead]: [], [child]: ['msg-child-orphaned'] });
  assert.deepEqual(archived.body.skipped.map((member) => member.id), [busy]);
});

test('a card of an earlier attempt whose announce throws leaves one failed status, and the next card is still announced', async () => {
  const spy = spies();
  const fx = setup({ overrides: { ...spy.overrides, formatQuestionRow: (row) => { if (row.id === 'question-first') throw new Error('bad request JSON'); return { id: row.id, status: row.status }; } } });
  const conv = await fx.bootstrap();
  fx.claim(conv, 'msg-orphaned');
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  const insertQuestion = fx.db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, prompt, status, created_at, expires_at, attempt_id)
    VALUES (?, 'msg-orphaned', ?, 'msg-orphaned', ?, 'pending', ?, ?, 'attempt-old')
  `);
  insertQuestion.run('question-first', conv, 'Secret plan for the parser?', NOW, FAR);
  insertQuestion.run('question-second', conv, 'Which branch?', NOW, FAR);
  const captured = captureWarnings();
  let archived;
  try { archived = await fx.archive(conv); } finally { captured.restore(); }
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.failedMessageIds, ['msg-orphaned']);
  assert.deepEqual(fx.events('message_status'), [{ messageId: 'msg-orphaned', conversationId: conv, status: 'failed' }]);
  assert.equal(fx.messagesOf(conv).filter((row) => row.text === ARCHIVED_REPLY).length, 1);
  assert.deepEqual(fx.db.prepare(`SELECT id, status FROM relay_questions ORDER BY id`).all(),
    [{ id: 'question-first', status: 'cancelled' }, { id: 'question-second', status: 'cancelled' }]);
  assert.deepEqual(fx.events('relay_question_updated'), [{ question: { id: 'question-second', status: 'cancelled' } }]);
  // The warning names the card and the error, never the card's text.
  const cardWarnings = captured.warnings.filter((line) => line.includes('question-first'));
  assert.deepEqual(cardWarnings, ['[questions] The cancelled card question-first was not announced: bad request JSON']);
  assert.ok(!captured.warnings.some((line) => line.includes('Secret plan')), captured.warnings.join('\n'));
});

// ─── Sessions the archive does not stop: the process probe decides ───────────

test('a turn of another session whose process is gone ends with the archive, with that session\'s background runs', async () => {
  const fx = setup({ overrides: { sessionWorkerProcessInspector: processList(new Set()) } });
  const conv = await fx.bootstrap();
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  // The registry has no entry for one session, and one without a pid that
  // still reads 'ready' for the other.
  fx.claim(conv, 'msg-unseen', { owner: 'sdk-unseen' });
  fx.claim(conv, 'msg-stale', { owner: 'sdk-stale', at: LATER });
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: 'sdk-stale', status: 'ready' });
  // A chat of the first session ran a background agent.
  const helper = await fx.bootstrap({ title: 'Build watch' });
  fx.db.prepare(`UPDATE conversations SET sdk_session_id = 'sdk-unseen' WHERE id = ?`).run(helper);
  fx.db.prepare(`INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background) VALUES ('toolu_watch', 'msg-earlier', ?, 'Watch the build', 'running', ?, ?, 1)`)
    .run(helper, NOW, NOW);

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.failedMessageIds, ['msg-unseen', 'msg-stale']);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-unseen', status: 'failed' }, { id: 'msg-stale', status: 'failed' }]);
  assert.deepEqual(fx.sweepSessions(), [], 'the sweep finds nothing to requeue');
  assert.equal(fx.db.prepare(`SELECT status FROM subagent_runs WHERE id = 'toolu_watch'`).get().status, 'failed');
});

test('a turn of a session the archive leaves running stays processing while its process lives, whatever the registry says', async () => {
  const fx = setup({ overrides: { sessionWorkerProcessInspector: processList(new Set(['sdk-shared', 'sdk-respawned'])) } });
  const conv = await fx.bootstrap({ title: 'Parser work' });
  const other = await fx.bootstrap({ title: 'Parser review' });
  fx.db.prepare(`UPDATE conversations SET sdk_session_id = 'sdk-shared' WHERE id IN (?, ?)`).run(conv, other);
  // The registry's pids are gone, but each session's worker runs under another.
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: 'sdk-shared', status: 'processing', pid: DEAD_PID });
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: 'sdk-respawned', status: 'error', pid: DEAD_PID });
  fx.claim(conv, 'msg-shared', { owner: 'sdk-shared' });
  fx.claim(conv, 'msg-respawned', { owner: 'sdk-respawned', at: LATER });
  fx.db.prepare(`INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background) VALUES ('toolu_shared', 'msg-earlier', ?, 'Watch the build', 'running', ?, ?, 1)`)
    .run(other, NOW, NOW);

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.workerStopped, false);
  assert.deepEqual(archived.body.failedMessageIds, []);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-shared', status: 'processing' }, { id: 'msg-respawned', status: 'processing' }]);
  assert.equal(fx.db.prepare(`SELECT status FROM subagent_runs WHERE id = 'toolu_shared'`).get().status, 'running', 'the live worker\'s background run stays');
});

// A Copilot session the relay only imported is not stopped by the archive
// (it belongs to whoever started it in the CLI): its turn is probed like a
// shared session's, the registry's dead pid notwithstanding.
function importedOnlySetup(live) {
  const fx = setup({ overrides: {
    sessionWorkerProcessInspector: processList(live),
    sdkSessionImportService: { isImportedOnly: (sessionId) => sessionId === 'sdk-imported' },
  } });
  return fx;
}

test('an imported-only chat\'s turn stays processing at the archive while its worker process lives', async () => {
  const fx = importedOnlySetup(new Set(['sdk-imported']));
  const conv = await fx.bootstrap({ title: 'Imported parser session' });
  fx.db.prepare(`UPDATE conversations SET sdk_session_id = 'sdk-imported' WHERE id = ?`).run(conv);
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: 'sdk-imported', status: 'processing', pid: DEAD_PID });
  fx.claim(conv, 'msg-imported', { owner: 'sdk-imported' });

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.workerStopped, false, 'the imported session is not stopped');
  assert.deepEqual(archived.body.failedMessageIds, []);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-imported', status: 'processing' }]);
  assert.ok(fx.deps.sessionWorkerRegistry.getWorker('sdk-imported'), 'its registry entry stays');
});

test('an imported-only chat\'s turn whose worker process is gone ends as failed with the archive', async () => {
  const fx = importedOnlySetup(new Set());
  const conv = await fx.bootstrap({ title: 'Imported parser session' });
  fx.db.prepare(`UPDATE conversations SET sdk_session_id = 'sdk-imported' WHERE id = ?`).run(conv);
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: 'sdk-imported', status: 'processing', pid: DEAD_PID });
  fx.claim(conv, 'msg-imported', { owner: 'sdk-imported' });

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.workerStopped, false);
  assert.deepEqual(archived.body.failedMessageIds, ['msg-imported']);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-imported', status: 'failed' }]);
  assert.deepEqual(fx.sweepSessions(), [], 'nothing is left for the sweep to requeue');
});

// The archive's probe is the dead-worker detection's (services/
// worker-session-liveness.mjs): a worker socket heard from lately is alive
// even when the process list finds nothing for the session.
test('a turn whose worker socket is live is left running, though no process is listed for its session', async () => {
  const fx = setup({ overrides: {
    sessionWorkerProcessInspector: processList(new Set()),
    hasLiveWorkerSocket: (sessionId) => sessionId === 'sdk-socket',
  } });
  const conv = await fx.bootstrap();
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  fx.claim(conv, 'msg-socket', { owner: 'sdk-socket' });
  fx.claim(conv, 'msg-gone', { owner: 'sdk-gone', at: LATER });

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.failedMessageIds, ['msg-gone']);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-socket', status: 'processing' }, { id: 'msg-gone', status: 'failed' }]);
});

test('a turn whose worker socket went quiet while its process runs is left running', async () => {
  const fx = setup({ overrides: {
    sessionWorkerProcessInspector: processList(new Set(['sdk-quiet'])),
    hasLiveWorkerSocket: () => false,
  } });
  const conv = await fx.bootstrap();
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  fx.claim(conv, 'msg-quiet', { owner: 'sdk-quiet' });

  const archived = await fx.archive(conv);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.failedMessageIds, []);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-quiet', status: 'processing' }]);
});

test('a turn whose session the process list cannot be read for is left to the sweep', async () => {
  const fx = setup({ overrides: { sessionWorkerProcessInspector: {
    findProcessesForSessionAsync: async () => [],
    findProcessForSessionAsync: async () => { throw new Error('powershell timed out'); },
  } } });
  const conv = await fx.bootstrap();
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  // The registry alone would call this session dead: only the failed read
  // leaves its turn to the sweep.
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: 'sdk-unknown', status: 'processing', pid: DEAD_PID });
  fx.claim(conv, 'msg-unknown', { owner: 'sdk-unknown' });
  const captured = captureWarnings();
  let archived;
  try { archived = await fx.archive(conv); } finally { captured.restore(); }
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.failedMessageIds, []);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-unknown', status: 'processing' }]);
});

test('a process list that never answers holds the archive no longer than the probe\'s limit, and the turns are left to the sweep', async () => {
  const asked = [];
  const fx = setup({ overrides: {
    archiveProcessProbeTimeoutMs: 50,
    sessionWorkerProcessInspector: {
      findProcessesForSessionAsync: async () => [],
      findProcessForSessionAsync: (sessionId) => { asked.push(sessionId); return new Promise(() => {}); },
    },
  } });
  const conv = await fx.bootstrap();
  fx.deps.sessionWorkerRegistry.upsertWorker({ sdkSessionId: conv, status: 'processing', pid: DEAD_PID });
  fx.claim(conv, 'msg-first', { owner: 'sdk-first' });
  fx.claim(conv, 'msg-second', { owner: 'sdk-second', at: LATER });
  const captured = captureWarnings();
  const startedAt = Date.now();
  let archived;
  try { archived = await fx.archive(conv); } finally { captured.restore(); }
  assert.ok(Date.now() - startedAt < 2_000, `answered after ${Date.now() - startedAt} ms`);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.failedMessageIds, []);
  assert.deepEqual(fx.queueRowsOf(conv), [{ id: 'msg-first', status: 'processing' }, { id: 'msg-second', status: 'processing' }]);
  assert.deepEqual(asked.sort(), ['sdk-first', 'sdk-second'], 'each session asked once, together');
  assert.ok(captured.warnings.includes('[archive] The process list did not answer within 50 ms: the turns of 2 sessions are left to the sweep.'), captured.warnings.join('\n'));
});
