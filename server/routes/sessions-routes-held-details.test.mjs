import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { HELD_DETAILS_MAX_IDS } from '../public/app/held-details.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';

// The live poll's diet on GET /api/conversation/:id: every finished reply
// carries `detailsVersion`; a poll that names a reply with the version the
// relay still has (`heldDetails=id~version`) gets it back as `detailsHeld`
// without its tool lines and thoughts; a changed version, a reply it does
// not name, a param too big or junk, and a request without the param get the
// full payload. The versions are one grouped query per table.

const CONV = 'conv-held-fixture';
const at = (n) => new Date(Date.UTC(2026, 2, 1) + n * 1000).toISOString();

function seed(db) {
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'Widget cache plan', ?, ?)`).run(CONV, at(0), at(0));
  const ids = [];
  for (let turn = 0; turn < 4; turn += 1) {
    const ask = `ask-${turn}`;
    const reply = `reply-${turn}`;
    ids.push(reply);
    db.prepare(`INSERT INTO messages (id, conversation_id, role, text, mode, timestamp) VALUES (?, ?, 'user', ?, 'agent', ?)`).run(ask, CONV, `Step ${turn} of the widget plan`, at(turn * 10));
    db.prepare(`INSERT INTO messages (id, conversation_id, role, text, mode, timestamp, source_message_id) VALUES (?, ?, 'assistant', ?, 'agent', ?, ?)`).run(reply, CONV, `Done with step ${turn}.`, at(turn * 10 + 5), ask);
    db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, response_message_id) VALUES (?, ?, 'prompt', 'done', ?, ?)`).run(ask, CONV, at(turn * 10), reply);
    for (let n = 0; n < 5; n += 1) {
      db.prepare(`INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, text, created_at, turn_seq) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(ask, reply, CONV, `Tool (view): widget-${turn}-${n}.js`, at(turn * 10 + 1), n * 2 + 2);
    }
    db.prepare(`INSERT INTO relay_thought (queue_message_id, response_message_id, conversation_id, reasoning_id, seq, text, done, created_at, turn_seq) VALUES (?, ?, ?, ?, 1, ?, 1, ?, 1)`)
      .run(ask, reply, CONV, `r-${turn}`, `Planning step ${turn}`, at(turn * 10 + 1));
  }
  return ids;
}

// Counts statement runs whose SQL names the version query.
function countVersionQueries(db) {
  const counter = { runs: 0 };
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = realPrepare(sql);
    if (!/FROM relay_(activity|thought)\s+WHERE response_message_id IN \(SELECT value FROM json_each/.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, prop) {
        const value = target[prop];
        if (prop === 'all') return (...args) => { counter.runs += 1; return value.apply(target, args); };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return counter;
}
function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  };
  return { routes, get: record('GET'), post: record('POST'), patch: record('PATCH'), put: record('PUT'), delete: record('DELETE'), use() {} };
}

function registerApp(db, stmts) {
  const app = createMockApp();
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db,
    stmts,
    runtimeState: {},
    config: {},
    parseAttachments: (raw) => {
      try { return raw ? JSON.parse(raw) : []; } catch { return []; }
    },
    hydrateAttachment: (v) => v,
    relayActivityForResponse: (id) => stmts.listActivityByResponse.all(id),
    relayThoughtsForResponse: (id) => stmts.listThoughtsByResponse.all(id),
    subagentRunsForResponse: (id) => stmts.listSubagentRunsByResponse.all(id, id, id),
    workflowRunsForResponse: (id) => stmts.listWorkflowRunsByResponse?.all(id) || [],
    previewCardsForResponse: (id) => stmts.listPreviewCardsByResponse?.all(id) || [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => [],
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pending: 0, processing: 0 }),
    getModelCatalogState: () => ({}),
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
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    getPendingSessionCwd: () => null,
    workspaceRootAllowList: [],
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => true,
    touchCli: () => {},
    markCliOffline: () => {},
    fetchUsageSummary: () => {},
    readSessionTranscriptMessages: () => [],
    ensureRuntimeSessionBinding: () => ({ ok: true }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent', 'plan'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: '',
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    resolveSessionStateRoot: () => null,
    sessionWorkerRegistry: createSessionWorkerRegistry(),
    sessionHistoryRefreshService: {
      evaluateRefreshIdleState: () => ({ idle: true }),
      replaceRetrievableHistory: () => {},
    },
    sdkSessionImportService: null,
    statusEventService: { recordSharedAccess: () => ({ event: null }) },
  });
  const handler = app.routes.get('GET /api/conversation/:id');
  assert.ok(handler);
  return async (id, query = {}) => {
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await handler({ body: {}, headers: {}, query, params: { id }, socket: {}, protocol: 'http', get: () => 'relay.example.test' }, res);
    assert.equal(captured.status, 200);
    return captured.body;
  };
}

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const versionQueries = countVersionQueries(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  const replies = seed(db);
  return { db, stmts, replies, versionQueries, get: registerApp(db, stmts) };
}

const assistants = (body) => body.messages.filter((message) => message.role === 'assistant');
const heldParam = (body, ids) => assistants(body).filter((m) => ids.includes(m.id)).map((m) => `${m.id}~${m.detailsVersion}`).join(',');

test('a full payload carries detailsVersion on every finished reply, and nothing is held without the param', async () => {
  const fx = setup();
  const body = await fx.get(CONV, { limit: '20' });
  const replies = assistants(body);
  assert.equal(replies.length, 4);
  for (const reply of replies) {
    assert.match(reply.detailsVersion, /^s1\.5\.\d+\.1\.\d+\.[0-9a-f]{8}$/, '5 tool lines, 1 thought and its fingerprint');
    assert.equal(reply.detailsHeld, undefined);
    assert.equal(reply.activities.length, 5);
    assert.equal(reply.thoughts.length, 1);
  }
});

test('held replies with the same version come back without their details; the others in full', async () => {
  const fx = setup();
  const full = await fx.get(CONV, { limit: '20' });
  const held = heldParam(full, ['reply-0', 'reply-1', 'reply-2']);
  const before = fx.versionQueries.runs;
  const poll = await fx.get(CONV, { limit: '20', heldDetails: held });
  assert.equal(fx.versionQueries.runs - before, 2, 'one grouped version query per table');
  const byId = new Map(assistants(poll).map((m) => [m.id, m]));
  for (const id of ['reply-0', 'reply-1', 'reply-2']) {
    assert.equal(byId.get(id).detailsHeld, true, id);
    assert.deepEqual(byId.get(id).activities, []);
    assert.deepEqual(byId.get(id).thoughts, []);
    assert.equal(byId.get(id).detailsVersion, undefined);
    assert.equal(byId.get(id).text, assistants(full).find((m) => m.id === id).text, 'the rest stays');
  }
  assert.equal(byId.get('reply-3').detailsHeld, undefined, 'not named: in full');
  assert.equal(byId.get('reply-3').activities.length, 5);
  assert.ok(JSON.stringify(poll).length < JSON.stringify(full).length);
});

test('a row added after the reply was held changes its version: the next poll brings it in full', async () => {
  const fx = setup();
  const full = await fx.get(CONV, { limit: '20' });
  const held = heldParam(full, ['reply-1']);
  fx.db.prepare(`INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, text, created_at, subagent_run_id) VALUES ('ask-1', 'reply-1', ?, 'Tool (grep): late widget line', ?, 'toolu_fixture_late')`).run(CONV, at(99));
  const poll = await fx.get(CONV, { limit: '20', heldDetails: held });
  const reply = assistants(poll).find((m) => m.id === 'reply-1');
  assert.equal(reply.detailsHeld, undefined);
  assert.equal(reply.activities.length, 6);
  assert.notEqual(reply.detailsVersion, assistants(full).find((m) => m.id === 'reply-1').detailsVersion);
});

test('a thought updated in place after the reply was held (text and done): the next poll brings it in full', async () => {
  const fx = setup();
  const full = await fx.get(CONV, { limit: '20' });
  const held = heldParam(full, ['reply-1']);
  // A trailing chunk and the done flip of the reply's thought, as the
  // thought route writes them (an UPDATE in place: same row, same count).
  fx.db.prepare(`UPDATE relay_thought SET done = 0 WHERE response_message_id = 'reply-1'`).run();
  const reheld = heldParam(await fx.get(CONV, { limit: '20' }), ['reply-1']);
  fx.stmts.updateThoughtByQueueAndReasoning.run('reply-1', CONV, 'agent', 'Planning step 1, and the eviction too.', 1, at(98), null, 'ask-1', 'r-1');
  const poll = await fx.get(CONV, { limit: '20', heldDetails: reheld });
  const reply = assistants(poll).find((m) => m.id === 'reply-1');
  assert.equal(reply.detailsHeld, undefined, 'not held: its thought changed');
  assert.equal(reply.thoughts[0].text, 'Planning step 1, and the eviction too.');
  assert.equal(Boolean(reply.thoughts[0].done), true, 'done (a raw row here: 1)');
  assert.notEqual(reply.detailsVersion, assistants(full).find((m) => m.id === 'reply-1').detailsVersion);
  assert.ok(held);
});

test('two thought updates with the same created_at still change the version', async () => {
  const fx = setup();
  const update = (text) => fx.stmts.updateThoughtByQueueAndReasoning.run('reply-2', CONV, 'agent', text, 0, at(97), null, 'ask-2', 'r-2');
  fx.db.prepare(`UPDATE relay_thought SET done = 0 WHERE response_message_id = 'reply-2'`).run();
  update('Checking the widget cache');
  const first = heldParam(await fx.get(CONV, { limit: '20' }), ['reply-2']);
  // Same moment, same length, other text.
  update('Checking the widget cachf');
  const poll = await fx.get(CONV, { limit: '20', heldDetails: first });
  const reply = assistants(poll).find((m) => m.id === 'reply-2');
  assert.equal(reply.detailsHeld, undefined);
  assert.equal(reply.thoughts[0].text, 'Checking the widget cachf');
});

test('the versions are one query per table on the response index', async () => {
  const fx = setup();
  const before = fx.versionQueries.runs;
  await fx.get(CONV, { limit: '20' });
  assert.equal(fx.versionQueries.runs - before, 2);
  for (const table of ['relay_activity', 'relay_thought']) {
    const plan = fx.db.prepare(`EXPLAIN QUERY PLAN SELECT response_message_id, rowid FROM ${table} WHERE response_message_id IN (SELECT value FROM json_each(?))`).all('["reply-1"]')
      .map((row) => row.detail).join(' | ');
    assert.match(plan, /USING (COVERING )?INDEX idx_relay_\w+_response/, `${table}: ${plan}`);
  }
});

test('junk ids are dropped; a param over 200 entries or 8 KB is ignored (the full payload)', async () => {
  const fx = setup();
  const full = await fx.get(CONV, { limit: '20' });
  const good = heldParam(full, ['reply-0']);
  const fine = assistants(full)[0].detailsVersion;
  const junk = [`x'; DROP TABLE messages; --~${fine}`, 'reply-1~notaversion', `${'a'.repeat(65)}~${fine}`, `~${fine}`, 'reply-2', 'reply-3~6.30'].join(',');
  const mixed = await fx.get(CONV, { limit: '20', heldDetails: `${junk},${good}` });
  assert.deepEqual(assistants(mixed).filter((m) => m.detailsHeld).map((m) => m.id), ['reply-0']);
  assert.ok(fx.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n > 0);

  const many = [good, ...Array.from({ length: HELD_DETAILS_MAX_IDS }, (_, i) => `fixture-${i}~1.1`)].join(',');
  assert.equal(assistants(await fx.get(CONV, { limit: '20', heldDetails: many })).some((m) => m.detailsHeld), false, 'over 200 entries');
  const big = `${good},${Array.from({ length: 150 }, (_, i) => `${'b'.repeat(60)}${String(i).padStart(4, '0')}~1.1`).join(',')}`;
  assert.ok(big.length > 8192);
  assert.equal(assistants(await fx.get(CONV, { limit: '20', heldDetails: big })).some((m) => m.detailsHeld), false, 'over 8 KB');
});
