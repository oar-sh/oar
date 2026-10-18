import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';

// GET /api/conversation/:id on long conversations: the page is selected in
// SQL and only its replies are hydrated, so the work per request does not
// grow with the conversation. Two conversations of different length get the
// same number of statement runs per page, a 5,000-message one loads within a
// loose time bound, and every response equals the one the in-memory path
// (every row loaded, the page cut afterwards) builds.

const LONG = 'conv-long-fixture';
const SHORT = 'conv-short-fixture';

function fixtureId(prefix, index) {
  const hex = ((index * 2654435761) >>> 0).toString(16).padStart(8, '0');
  return `${hex}-${prefix}-4000-8000-${String(index).padStart(12, '0')}`;
}

const LONG_MARKDOWN = [
  '## Findings',
  '',
  'The parser keeps the **first** match and drops the rest; `normalize()` runs twice.',
  '',
  '```js',
  'export function normalize(value) {',
  '  return String(value || "").trim().toLowerCase();',
  '}',
  '```',
  '',
  '- one point about the cache',
  '- another point about the index',
  '',
].join('\n').repeat(6);

// Wraps every prepared statement so each run is counted.
function countStatementRuns(db) {
  const counter = { runs: 0 };
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = realPrepare(sql);
    return new Proxy(statement, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        if (prop === 'get' || prop === 'all' || prop === 'run' || prop === 'iterate') {
          return (...args) => { counter.runs += 1; return value.apply(target, args); };
        }
        return value.bind(target);
      },
    });
  };
  return counter;
}

function seedConversation(db, conversationId, messageCount) {
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'Long chat', ?, ?)`)
    .run(conversationId, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z');
  const tag = conversationId === LONG ? 'aaaa' : 'bbbb';
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, text, mode, timestamp, source_message_id, kind, resend_of_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertActivity = db.prepare(`
    INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertThought = db.prepare(`
    INSERT INTO relay_thought (queue_message_id, response_message_id, conversation_id, seq, text, done, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `);
  const insertQueue = db.prepare(`
    INSERT INTO queue (id, conversation_id, text, status, timestamp, response_message_id, reasoning_effort)
    VALUES (?, ?, ?, ?, ?, ?, 'high')
  `);
  const insertUsage = db.prepare(`
    INSERT INTO message_usage_snapshots (response_message_id, queue_message_id, conversation_id, premium_remaining, captured_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const base = Date.UTC(2026, 2, 1);
  const ids = [];
  db.transaction(() => {
    for (let index = 0; index < messageCount; index += 1) {
      const id = fixtureId(tag, index);
      ids.push(id);
      const timestamp = new Date(base + index * 1000).toISOString();
      if (index % 2 === 0) {
        const text = index % 10 === 0
          ? `[Relay mode: agent] Please look at step ${index} of the plan.`
          : `Question ${index}: what does the cache do here?`;
        insertMessage.run(id, conversationId, 'user', text, 'agent', timestamp, null, null, null);
        // The queue keeps only the newest rows, as the relay prunes it.
        if (index >= messageCount - 300) {
          insertQueue.run(id, conversationId, text, 'done', timestamp, fixtureId(tag, index + 1));
        }
      } else {
        const sourceId = ids[index - 1];
        insertMessage.run(id, conversationId, 'assistant', `Reply ${index}\n\n${LONG_MARKDOWN}`, 'agent', timestamp, sourceId, null, null);
        for (let step = 0; step < 3; step += 1) {
          insertActivity.run(sourceId, id, conversationId, `Ran tool ${step} for reply ${index}`, timestamp);
        }
        for (let seq = 0; seq < 2; seq += 1) {
          insertThought.run(sourceId, id, conversationId, seq, `Thinking about part ${seq} of reply ${index}.`, timestamp);
        }
        if (index % 3 === 0) insertUsage.run(id, sourceId, conversationId, 100 - (index % 50), timestamp);
      }
    }
  })();
  return ids;
}

// A steer stopped near the end, and its Resend further on: the stopped
// marker shows "Resent" even when the Resend is not on the same page.
function seedStoppedSteer(db, conversationId, ids) {
  const original = ids[ids.length - 40];
  const markerTimestamp = new Date(Date.UTC(2026, 2, 1) + (ids.length - 39) * 1000 + 500).toISOString();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, text, mode, timestamp, source_message_id, kind)
    VALUES (?, ?, 'assistant', 'Stopped with the turn', 'agent', ?, ?, 'stopped')
  `).run(`${original.slice(0, 30)}stopped`, conversationId, markerTimestamp, original);
  const resendTimestamp = new Date(Date.UTC(2026, 2, 1) + (ids.length + 5) * 1000).toISOString();
  const resendId = `${original.slice(0, 30)}resend0`;
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, text, mode, timestamp, resend_of_message_id)
    VALUES (?, ?, 'user', 'Question again', 'agent', ?, ?)
  `).run(resendId, conversationId, resendTimestamp, original);
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES (?, ?, 'Question again', 'pending', ?)`)
    .run(resendId, conversationId, resendTimestamp);
  return { markerId: `${original.slice(0, 30)}stopped`, resendId };
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
  const counter = countStatementRuns(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  const longIds = seedConversation(db, LONG, 5000);
  const shortIds = seedConversation(db, SHORT, 400);
  const stopped = seedStoppedSteer(db, SHORT, shortIds);
  const get = registerApp(db, stmts);
  // The in-memory path: the same routes without the SQL page statements.
  const { conversationHistoryPage: _pager, ...stmtsWithoutPager } = stmts;
  const getInMemory = registerApp(db, stmtsWithoutPager);
  return { db, counter, get, getInMemory, longIds, shortIds, stopped };
}

const fx = setup();

function runsFor(fn) {
  const before = fx.counter.runs;
  fn();
  return fx.counter.runs - before;
}

async function timed(fn) {
  const startedAt = performance.now();
  const body = await fn();
  return { body, ms: performance.now() - startedAt };
}

test('statement runs per page do not grow with the conversation', async (t) => {
  for (const limit of [20, 100]) {
    let longRuns = 0;
    let shortRuns = 0;
    const before = fx.counter.runs;
    await fx.get(LONG, { limit: String(limit), beforeMessageId: fx.longIds[3000] });
    longRuns = fx.counter.runs - before;
    const mid = fx.counter.runs;
    await fx.get(SHORT, { limit: String(limit), beforeMessageId: fx.shortIds[200] });
    shortRuns = fx.counter.runs - mid;
    t.diagnostic(`limit ${limit}: ${longRuns} statement runs on 5,000 messages, ${shortRuns} on 400`);
    assert.equal(longRuns, shortRuns, `limit ${limit}`);
    // Six lookups per reply on the page plus a fixed number for the page.
    assert.ok(longRuns <= limit * 4 + 40, `limit ${limit}: ${longRuns} runs`);
  }
  assert.equal(runsFor(() => {}), 0);
});

test('a page of a 5,000-message conversation loads fast, and so does scrolling back', async (t) => {
  await fx.get(LONG, { limit: '20' });
  const first = await timed(() => fx.get(LONG, { limit: '20' }));
  const wide = await timed(() => fx.get(LONG, { limit: '100' }));
  const cursor = wide.body.pageInfo.olderCursor;
  const back = await timed(() => fx.get(LONG, { limit: '20', ...cursor }));
  const around = await timed(() => fx.get(LONG, { limit: '20', aroundMessageId: fx.longIds[1234] }));
  // For comparison only: every row loaded and hydrated, the page cut after.
  const inMemory = await timed(() => fx.getInMemory(LONG, { limit: '20' }));
  t.diagnostic(`5,000 messages: limit 20 ${first.ms.toFixed(1)} ms, limit 100 ${wide.ms.toFixed(1)} ms, `
    + `scroll back ${back.ms.toFixed(1)} ms, around ${around.ms.toFixed(1)} ms; `
    + `in-memory path ${inMemory.ms.toFixed(1)} ms`);
  assert.deepEqual(inMemory.body.messages.map((message) => message.id), first.body.messages.map((message) => message.id));
  assert.equal(first.body.messages.length, 20);
  assert.equal(wide.body.messages.length, 100);
  assert.equal(back.body.messages.length, 20);
  assert.equal(back.body.messages.at(-1).id, fx.longIds[4899]);
  assert.equal(back.body.pageInfo.hasMoreOlder, true);
  assert.equal(back.body.pageInfo.hasMoreNewer, true);
  assert.equal(around.body.messages[9].id, fx.longIds[1234]);
  for (const { ms } of [first, wide, back, around]) assert.ok(ms < 1000, `${ms} ms`);
  const prompt = first.body.messages.find((message) => message.id === fx.longIds[4990]);
  assert.equal(prompt.text, 'Please look at step 4990 of the plan.', 'the mode marker is stripped');
  const reply = first.body.messages.find((message) => message.id === fx.longIds[4991]);
  assert.equal(reply.activities.length, 3);
  assert.equal(reply.thoughts.length, 2);
  assert.equal(reply.sourceMessageId, fx.longIds[4990]);
});

test('every page equals the one the in-memory path builds', async () => {
  const { shortIds, stopped } = fx;
  const queries = [
    {},
    { limit: '20' },
    { limit: '100' },
    { limit: '7', beforeMessageId: shortIds[300] },
    { limit: '20', beforeMessageId: shortIds[50], beforeTimestamp: '2026-03-01T00:00:50.000Z' },
    { limit: '20', beforeTimestamp: '2026-03-01T00:05:00.000Z' },
    { limit: '20', afterMessageId: shortIds[350] },
    { limit: '20', afterMessageId: shortIds[399] },
    { limit: '20', afterMessageId: 'not-in-this-chat' },
    { limit: '20', afterTimestamp: '2030-01-01T00:00:00.000Z' },
    { limit: '20', aroundMessageId: shortIds[3] },
    { limit: '20', aroundMessageId: shortIds[398] },
    { limit: '20', aroundMessageId: 'not-in-this-chat' },
    { limit: '5', aroundMessageId: stopped.markerId },
    { limit: 'many' },
  ];
  // The revisions are clock readings, not page content.
  const comparable = ({ pinsRevision: _p, hiddenMessagesRevision: _h, ...body }) => body;
  for (const query of queries) {
    const paged = await fx.get(SHORT, query);
    const inMemory = await fx.getInMemory(SHORT, query);
    assert.deepEqual(comparable(paged), comparable(inMemory), JSON.stringify(query));
  }
  const page = await fx.get(SHORT, { limit: '5', aroundMessageId: stopped.markerId });
  const marker = page.messages.find((message) => message.id === stopped.markerId);
  assert.equal(marker.resentAs, stopped.resendId, 'the Resend outside the page still marks the stop');
  assert.ok(!page.messages.some((message) => message.id === stopped.resendId));
  const tail = await fx.get(SHORT, { limit: '20' });
  assert.ok(tail.messages.some((message) => message.role === 'assistant' && message.usage), 'usage snapshots on the page');
});
