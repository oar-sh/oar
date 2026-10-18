import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';
import { createPreviewRegistry, normalizePreviewsConfig } from '../services/preview-registry-service.mjs';
import { createSqlitePreviewStore } from '../services/preview-store.mjs';

// A preview card pinned to a reply is a public link to a dev server or a
// folder, and the link outlives the turn and a relay restart. The owner's
// payload carries it whole; a shared transcript keeps only the label.

const PREVIEW_TOKEN = '0123456789abcdef0123456789abcdef';
const PREVIEW_SNAPSHOT = {
  token: PREVIEW_TOKEN,
  conversationId: 'conv-1',
  label: 'docs site',
  mode: 'static',
  targetHost: null,
  targetPort: null,
  rootDir: '/home/dev/project/site',
  url: `https://preview.example.com/test_${PREVIEW_TOKEN}/`,
  basePath: `/test_${PREVIEW_TOKEN}/`,
  createdAt: 1_000,
  online: true,
  hits: 0,
};

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

// A second live preview of the conversation that no card names; a tool line
// quotes its bare token (the preview tool's list output).
const LISTED_TOKEN = 'fedcba9876543210fedcba9876543210';
// 32 hex characters that are no preview token must stay as they are.
const UNRELATED_HEX = '00112233445566778899aabbccddeeff';
const LINK = PREVIEW_SNAPSHOT.url;
// Every length a link can be cut at: the path prefix alone up to all but the
// last character of the token.
const CUT_LINKS = Array.from({ length: 32 }, (_, length) => `https://preview.example.com/test_${PREVIEW_TOKEN.slice(0, length)}`);
// An activity line is capped at 200 characters; this one's cap falls inside
// the link, 20 characters into the token.
const CAPPED_LINE = `${'preview create -> '.padEnd(200 - CUT_LINKS[20].length, 'x')}${LINK}`.slice(0, 200);
const ENCODED_LINK = `https://preview.example.com/test%5F${PREVIEW_TOKEN}/`;

// The reply in flight: its text so far ends inside the link, at `cut`
// characters of the token.
function inFlightAt(cut) {
  const soFar = `Published: ${CUT_LINKS[cut]}`;
  return {
    messageId: 'queue-2',
    status: 'processing',
    mode: 'agent',
    timestamp: '2026-10-05T10:01:00.000Z',
    processingAt: '2026-10-05T10:01:00.000Z',
    activities: [
      { text: CAPPED_LINE, subagentRunId: null },
      { text: `preview list -> [{"token":"${LISTED_TOKEN.slice(0, 14)}`, subagentRunId: null },
      { text: `Read ${ENCODED_LINK}index.html`, subagentRunId: null },
      { text: `fetched https://preview.example.com/test_${PREVIEW_TOKEN.slice(0, 11)}… (cut)`, subagentRunId: null },
    ],
    thoughts: [
      { reasoningId: 'r-1', seq: 1, text: `I will open ${CUT_LINKS[Math.min(31, cut + 3)]}`, done: false },
      // A thought that arrives in pieces: the link runs across two of them.
      { reasoningId: null, seq: 2, text: `The link is https://preview.example.com/test_${PREVIEW_TOKEN.slice(0, 12)}`, done: true },
      { reasoningId: null, seq: 3, text: `${PREVIEW_TOKEN.slice(12)}/ and it loads.`, done: true },
    ],
    streamEvents: [{ seq: 4, text: soFar, done: false, timestamp: null, subagentRunId: null }],
    streamDone: false,
    lastStreamSeq: 4,
    subagentRuns: [],
  };
}

// A live preview of another conversation: the preview tool's list names it.
const FOREIGN_TOKEN = '5a4b3c2d1e0f98766789f0e1d2c3b4a5';

function setup({
  inFlight = null,
  knownTokens = [PREVIEW_TOKEN, LISTED_TOKEN, FOREIGN_TOKEN],
  // (db) => registry: the real registry on the test database instead of stubs.
  makeRegistry = null,
  // The preview_cards statements of the question repository, for cards
  // written to the test database itself.
  previewCardStatements = false,
} = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const registry = makeRegistry ? makeRegistry(db) : null;
  const stmts = {
    ...createSessionRepository(db),
    ...createMessageRepository(db),
    ...(previewCardStatements ? createQuestionRepository(db) : {}),
  };
  const emitted = [];
  const app = createMockApp();
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emitted.push([event, payload]); } },
    db,
    stmts,
    runtimeState: {},
    config: {},
    parseAttachments: (raw) => {
      try { return raw ? JSON.parse(raw) : []; } catch { return []; }
    },
    hydrateAttachment: (v) => v,
    relayActivityForResponse: (messageId) => (messageId === 'reply-1' ? [
      { id: 'act-1', kind: 'tool', text: `preview create -> ${LINK}` },
      { id: 'act-2', kind: 'tool', text: `preview list -> [{"token":"${LISTED_TOKEN}","label":"api"}]` },
    ] : []),
    relayThoughtsForResponse: (messageId) => (messageId === 'reply-1' ? [
      { id: 'th-1', text: `The link is ${LINK.toUpperCase()}; checksum ${UNRELATED_HEX}.` },
    ] : []),
    subagentRunsForResponse: (messageId) => (messageId === 'reply-1' ? [
      { id: 'run-1', title: 'check the site', result: { summary: `Opened /test_${PREVIEW_TOKEN}/index.html fine.` } },
    ] : []),
    listKnownPreviewTokens: () => (registry ? registry.knownTokens() : knownTokens),
    listConversationPreviews: (conversationId) => (registry ? registry.listForConversation(conversationId) : conversationId === 'conv-1'
      ? [PREVIEW_SNAPSHOT, { ...PREVIEW_SNAPSHOT, token: LISTED_TOKEN, label: 'api' }]
      : []),
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => [],
    inFlightStateForConversation: () => inFlight,
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
    previewCardsForResponse: (messageId) => (messageId === 'reply-1' ? [PREVIEW_SNAPSHOT] : []),
  });

  const call = async (routeKey, { params = {}, body = {}, query = {} } = {}) => {
    const handler = app.routes.get(routeKey);
    assert.ok(handler, `${routeKey} should be registered`);
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await handler({ body, headers: {}, query, params, socket: {}, protocol: 'http', get: () => 'relay.example.test' }, res);
    return captured;
  };

  const insertConversation = (id, status = 'active') => {
    db.prepare(`
      INSERT INTO conversations (id, title, created_at, status, updated_at)
      VALUES (?, 'Preview share test', '2026-10-05T09:00:00.000Z', ?, '2026-10-05T09:00:00.000Z')
    `).run(id, status);
  };
  const insertMessage = (conversationId, id, role, text, timestamp, extra = {}) => {
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, text, attachments, hidden_from_shares, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, role, text, extra.attachments || null, extra.hidden ? 1 : 0, timestamp);
  };
  return { db, call, insertConversation, insertMessage, emitted, registry };
}


function seed(fx) {
  fx.insertConversation('conv-1');
  fx.insertMessage('conv-1', 'user-1', 'user', 'Publish the docs.', '2026-10-05T10:00:00.000Z');
  fx.insertMessage('conv-1', 'reply-1', 'assistant', `Published: ${LINK} (token ${PREVIEW_TOKEN}).`, '2026-10-05T10:00:05.000Z');
}

test('the owner payload keeps the whole preview card', async () => {
  const fx = setup();
  seed(fx);
  const owner = await fx.call('GET /api/conversation/:id', { params: { id: 'conv-1' }, query: { limit: '20' } });
  assert.equal(owner.status, 200);
  const reply = owner.body.messages.find((message) => message.id === 'reply-1');
  assert.equal(reply.previewCards[0].token, PREVIEW_TOKEN);
  assert.equal(reply.previewCards[0].url, PREVIEW_SNAPSHOT.url);
});

test('a shared transcript carries the preview card without token, link or folder', async () => {
  const fx = setup();
  seed(fx);
  const share = await fx.call('POST /api/conversation/:id/share', { params: { id: 'conv-1' } });
  assert.equal(share.status, 200);
  const shared = await fx.call('GET /api/shared/:token', { params: { token: share.body.token }, query: {} });
  assert.equal(shared.status, 200);
  const reply = shared.body.messages.find((message) => message.id === 'reply-1');
  assert.deepEqual(reply.previewCards, [{ label: 'docs site', mode: 'static', redacted: true }]);
  const body = JSON.stringify(shared.body);
  for (const token of [PREVIEW_TOKEN, LISTED_TOKEN]) {
    assert.ok(!body.toLowerCase().includes(token), 'the shared payload carries a preview token');
  }
  assert.ok(!/test_[0-9a-f]{32}/i.test(body), 'the shared payload carries a preview path');
  assert.ok(!body.includes('/home/dev/project/site'));
  // Reply text, tool lines, thoughts and sub-agent runs all went through it.
  assert.match(reply.text, /^Published: https:\/\/preview\.example\.com\/\[preview link removed\]\/ \(token \[preview link removed\]\)\.$/);
  assert.ok(body.includes('[{\\"token\\":\\"[preview link removed]\\"'), 'the bare listed token is redacted');
  assert.ok(body.includes('preview create -> https://preview.example.com/[preview link removed]/'));
  assert.ok(body.includes('The link is HTTPS://PREVIEW.EXAMPLE.COM/[preview link removed]/'));
  assert.ok(body.includes('Opened /[preview link removed]/index.html fine.'));
  assert.ok(body.includes(UNRELATED_HEX), 'other hex strings are left alone');
  assert.ok(body.includes('check the site'));
});

test('the owner payload keeps the link in the reply text', async () => {
  const fx = setup();
  seed(fx);
  const owner = await fx.call('GET /api/conversation/:id', { params: { id: 'conv-1' }, query: { limit: '20' } });
  const reply = owner.body.messages.find((message) => message.id === 'reply-1');
  assert.ok(reply.text.includes(LINK));
});

// No piece of a preview token that a reader could build on: no run of 8 or
// more of its characters anywhere, so at most 7 of the 32 behind a path prefix.
function assertNoTokenPiece(body, label) {
  const lower = body.toLowerCase();
  for (const token of [PREVIEW_TOKEN, LISTED_TOKEN, FOREIGN_TOKEN]) {
    for (let start = 0; start + 8 <= token.length; start += 1) {
      assert.ok(!lower.includes(token.slice(start, start + 8)), `${label}: the payload carries a piece of a preview token`);
    }
  }
  assert.ok(!/test(?:_|%(?:25)*5f)[0-9a-f]{8}/i.test(body), `${label}: the payload carries a preview path`);
}

async function sharedPayload(fx) {
  const share = await fx.call('POST /api/conversation/:id/share', { params: { id: 'conv-1' } });
  const shared = await fx.call('GET /api/shared/:token', { params: { token: share.body.token }, query: {} });
  assert.equal(shared.status, 200);
  return shared.body;
}

test('a shared transcript of a reply in flight carries no part of a preview link, wherever the text ends', async () => {
  for (let cut = 0; cut < CUT_LINKS.length; cut += 1) {
    const fx = setup({ inFlight: inFlightAt(cut) });
    seed(fx);
    const share = await fx.call('POST /api/conversation/:id/share', { params: { id: 'conv-1' } });
    const shared = await fx.call('GET /api/shared/:token', { params: { token: share.body.token }, query: {} });
    assert.equal(shared.status, 200);
    const body = JSON.stringify(shared.body);
    assertNoTokenPiece(body, `cut at ${cut}`);
    // Under eight characters the text stays as it streams, so a name such as
    // test_add does not flicker in a live shared view.
    assert.equal(shared.body.inFlight.streamEvents[0].text, cut < 8
      ? `Published: ${CUT_LINKS[cut]}`
      : 'Published: https://preview.example.com/[preview link removed]');
    assert.ok(shared.body.inFlight.activities[0].text.endsWith('https://preview.example.com/[preview link removed]'));
    assert.equal(shared.body.inFlight.activities[1].text, 'preview list -> [{"token":"[preview link removed]');
    assert.equal(shared.body.inFlight.activities[2].text, 'Read https://preview.example.com/[preview link removed]/index.html');
    assert.equal(shared.body.inFlight.activities[3].text, 'fetched https://preview.example.com/[preview link removed]… (cut)');
    assert.equal(shared.body.inFlight.thoughts[2].text, '[preview link removed]/ and it loads.');
    assert.ok(body.includes(UNRELATED_HEX), 'other hex strings are left alone');
  }
});

test('the owner payload of a reply in flight keeps the text as it is', async () => {
  const fx = setup({ inFlight: inFlightAt(20) });
  seed(fx);
  const owner = await fx.call('GET /api/conversation/:id', { params: { id: 'conv-1' }, query: { limit: '20' } });
  assert.equal(owner.body.inFlight.streamEvents[0].text, `Published: ${CUT_LINKS[20]}`);
});

// A turn that failed or was interrupted inside the link is stored with a note
// below the partial reply, and shared like that for good.
const AFTER_A_CUT = [
  '\n\n_The turn was interrupted before the reply was complete._',
  '\n\n---\nUsage limit reached; the reply continues later.',
  '"',
  '")',
  ').',
  '.',
  '` and more',
  '</a>',
];

test('a stored reply cut inside the link carries no usable part of it, whatever stands after the cut', async () => {
  for (let cut = 8; cut < 32; cut += 1) {
    const fx = setup();
    fx.insertConversation('conv-1');
    fx.insertMessage('conv-1', 'user-1', 'user', 'Publish the docs.', '2026-10-05T10:00:00.000Z');
    AFTER_A_CUT.forEach((after, index) => {
      fx.insertMessage('conv-1', `cut-${index}`, 'assistant', `Published: ${CUT_LINKS[cut]}${after}`, `2026-10-05T10:00:${String(10 + index).padStart(2, '0')}.000Z`);
    });
    const body = await sharedPayload(fx);
    assertNoTokenPiece(JSON.stringify(body), `cut at ${cut}`);
    AFTER_A_CUT.forEach((after, index) => {
      const message = body.messages.find((entry) => entry.id === `cut-${index}`);
      assert.equal(message.text, `Published: https://preview.example.com/[preview link removed]${after}`, `cut at ${cut}, ${JSON.stringify(after)}`);
    });
  }
});

test('a shared transcript carries no token glued to more hex or to an escape', async () => {
  const fx = setup();
  seed(fx);
  const glued = [
    `test_${PREVIEW_TOKEN}a`,
    `test_${PREVIEW_TOKEN}0`,
    `https%3A%2F%2Fpreview.example.com%2Ftest%5F${PREVIEW_TOKEN}%2F`,
    `%2F${LISTED_TOKEN}`,
    `%22${LISTED_TOKEN}%22`,
    `"${LISTED_TOKEN}"`,
    `7${LISTED_TOKEN}`,
    `${LISTED_TOKEN}f`,
  ];
  fx.insertMessage('conv-1', 'reply-2', 'assistant', glued.join('\n'), '2026-10-05T10:00:20.000Z');
  const body = await sharedPayload(fx);
  assertNoTokenPiece(JSON.stringify(body), 'glued');
  assert.equal(body.messages.find((entry) => entry.id === 'reply-2').text, [
    '[preview link removed]',
    '[preview link removed]',
    'https%3A%2F%2Fpreview.example.com%2F[preview link removed]%2F',
    '%2F[preview link removed]',
    '%22[preview link removed]%22',
    '"[preview link removed]"',
    '7[preview link removed]',
    '[preview link removed]f',
  ].join('\n'));
});

test('a shared transcript carries no bare token of another conversation\'s preview', async () => {
  const fx = setup();
  seed(fx);
  fx.insertMessage('conv-1', 'reply-2', 'assistant', [
    'Open previews:',
    '| token | label | link |',
    `| ${PREVIEW_TOKEN} | docs site | ${LINK} |`,
    `| ${FOREIGN_TOKEN} | billing app | https://preview.example.com/test_${FOREIGN_TOKEN}/ |`,
  ].join('\n'), '2026-10-05T10:00:20.000Z');
  const body = await sharedPayload(fx);
  assertNoTokenPiece(JSON.stringify(body), 'another conversation');
  assert.ok(body.messages.find((entry) => entry.id === 'reply-2').text.includes(
    '| [preview link removed] | billing app | https://preview.example.com/[preview link removed]/ |',
  ));
});

test('a shared transcript keeps ordinary names that look like the start of a preview path', async () => {
  const fx = setup();
  seed(fx);
  const text = [
    'Fixed test_add',
    'Ran pytest_',
    'Then test_1 and test_cafe, with TEST_DB set.',
    'See test_add... and test_',
  ].join('\n');
  fx.insertMessage('conv-1', 'reply-2', 'assistant', text, '2026-10-05T10:00:20.000Z');
  for (const partial of ['Fixed test_add', 'Ran pytest_', 'TEST_DB', 'test_', 'test_1']) {
    const live = setup({ inFlight: { ...inFlightAt(20), streamEvents: [{ seq: 4, text: partial, done: false, timestamp: null, subagentRunId: null }] } });
    seed(live);
    assert.equal((await sharedPayload(live)).inFlight.streamEvents[0].text, partial);
  }
  const body = await sharedPayload(fx);
  assert.equal(body.messages.find((entry) => entry.id === 'reply-2').text, text);
});

// ─── Through the real registry and its store ────────────────────────────────

const LANE_ON = normalizePreviewsConfig(
  { enabled: true, publicBaseUrl: 'https://preview.example.com' },
  { env: {}, relayPort: 3333, relayHostnames: ['relay.example.test'] },
);
const LANE_OFF = normalizePreviewsConfig({}, { env: {}, relayPort: 3333, relayHostnames: ['relay.example.test'] });
const quiet = { log() {}, warn() {} };

function tokenTable(previews) {
  return ['| token | label |', ...previews.map((preview) => `| ${preview.token} | ${preview.label} |`)].join('\n');
}

function assertNoneOf(body, previews, label) {
  const text = JSON.stringify(body).toLowerCase();
  for (const preview of previews) {
    for (let start = 0; start + 8 <= 32; start += 1) {
      assert.ok(!text.includes(preview.token.slice(start, start + 8)), `${label}: a piece of the token of "${preview.label}"`);
    }
  }
}

test('the real registry names live, kept and half-deleted previews of every conversation to the share route', async () => {
  const state = { unreadable: false, locked: false };
  const fx = setup({
    makeRegistry: (db) => {
      const store = createSqlitePreviewStore(db, { logger: quiet });
      const guarded = { ...store, remove: (token) => { if (state.locked) throw new Error('database is locked'); return store.remove(token); } };
      // What an earlier run left in the table: one folder cannot be read now.
      const earlier = createPreviewRegistry({ config: LANE_ON, store, logger: quiet });
      earlier.createStatic({ conversationId: 'conv-9', rootDir: '/home/dev/unreadable', label: 'kept' });
      return createPreviewRegistry({
        config: LANE_ON,
        store: guarded,
        logger: quiet,
        checkConversation: () => true,
        checkStaticRoot: (rootDir) => (rootDir === '/home/dev/unreadable'
          ? { ok: false, error: 'EIO', transient: true } : { ok: true, rootDir }),
      });
    },
  });
  const { registry } = fx;
  const kept = registry.list().find((entry) => entry.unverified);
  assert.equal(kept.label, 'kept');
  const own = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/project/site', label: 'own' }).preview;
  const foreign = registry.create({ conversationId: 'conv-2', port: 5173, label: 'foreign' }).preview;
  const closing = registry.create({ conversationId: 'conv-3', port: 5174, label: 'closing' }).preview;
  state.locked = true;
  assert.equal(registry.close(closing.token).ok, true);
  assert.equal(registry.get(closing.token), null);
  const all = [kept, own, foreign, closing];

  fx.insertConversation('conv-1');
  fx.insertMessage('conv-1', 'user-1', 'user', 'Which previews are open?', '2026-10-05T10:00:00.000Z');
  fx.insertMessage('conv-1', 'reply-2', 'assistant', tokenTable(all), '2026-10-05T10:00:20.000Z');
  const body = await sharedPayload(fx);
  assertNoneOf(body, all, 'shared');
  assert.equal(body.messages.find((entry) => entry.id === 'reply-2').text, tokenTable(all.map((preview) => ({ ...preview, token: '[preview link removed]' }))));
});

test('with the lane off the share route redacts the stored previews, and shares nothing while it cannot read them', async () => {
  const state = { unreadable: false };
  let stored;
  const fx = setup({
    makeRegistry: (db) => {
      const store = createSqlitePreviewStore(db, { logger: quiet });
      const on = createPreviewRegistry({ config: LANE_ON, store, logger: quiet });
      stored = [
        on.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/project/site', label: 'own' }).preview,
        on.create({ conversationId: 'conv-2', port: 5173, label: 'foreign' }).preview,
      ];
      return createPreviewRegistry({
        config: LANE_OFF,
        store: { ...store, list: () => { if (state.unreadable) throw new Error('database is locked'); return store.list(); } },
        logger: quiet,
      });
    },
  });
  assert.equal(fx.registry.size, 0);
  fx.insertConversation('conv-1');
  fx.insertMessage('conv-1', 'reply-2', 'assistant', tokenTable(stored), '2026-10-05T10:00:20.000Z');
  const share = await fx.call('POST /api/conversation/:id/share', { params: { id: 'conv-1' } });

  state.unreadable = true;
  const refused = await fx.call('GET /api/shared/:token', { params: { token: share.body.token }, query: {} });
  assert.equal(refused.status, 503);
  assertNoneOf(refused.body, stored, 'refused');

  state.unreadable = false;
  const first = await fx.call('GET /api/shared/:token', { params: { token: share.body.token }, query: {} });
  assert.equal(first.status, 200);
  assertNoneOf(first.body, stored, 'read');

  state.unreadable = true;
  const later = await fx.call('GET /api/shared/:token', { params: { token: share.body.token }, query: {} });
  assert.equal(later.status, 200);
  assertNoneOf(later.body, stored, 'read failed, last list in use');
});

// server-runtime.mjs boots a live server on import, so its one line of wiring
// is pinned by reading the source.
test('the runtime hands the share route the registry\'s known tokens', () => {
  const runtimeSource = fs.readFileSync(new URL('../server-runtime.mjs', import.meta.url), 'utf8');
  assert.match(runtimeSource, /listKnownPreviewTokens: \(\) => previewRegistry\.knownTokens\(\),/);
  assert.match(runtimeSource, /listConversationPreviews: \(conversationId\) => previewRegistry\.listForConversation\(conversationId\),/);
});

// A preview that is closed and forgotten: no registry lists it any more, and
// only its card on an old reply still names the token. A whole link is
// redacted by its shape; a bare token only when it is known, so the reply
// below quotes the bare token.
const DEAD_TOKEN = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';

test('a shared page redacts the link of a card on a reply outside the page', async () => {
  const fx = setup({ previewCardStatements: true });
  fx.insertConversation('conv-1');
  fx.insertMessage('conv-1', 'user-old', 'user', 'Publish the old site.', '2026-10-05T08:00:00.000Z');
  fx.insertMessage('conv-1', 'reply-old', 'assistant', 'Published.', '2026-10-05T08:00:05.000Z');
  fx.db.prepare(`
    INSERT INTO preview_cards (id, queue_message_id, response_message_id, conversation_id, preview_json, created_at)
    VALUES ('card-old', 'user-old', 'reply-old', 'conv-1', ?, '2026-10-05T08:00:04.000Z')
  `).run(JSON.stringify({ ...PREVIEW_SNAPSHOT, token: DEAD_TOKEN, label: 'old site' }));
  for (let index = 0; index < 6; index += 1) {
    fx.insertMessage('conv-1', `filler-${index}`, index % 2 ? 'assistant' : 'user', `Step ${index}.`, `2026-10-05T09:0${index}:00.000Z`);
  }
  fx.insertMessage('conv-1', 'user-new', 'user', 'Where was the old one?', '2026-10-05T10:00:00.000Z');
  fx.insertMessage('conv-1', 'reply-new', 'assistant', `Its token was ${DEAD_TOKEN}.`, '2026-10-05T10:00:05.000Z');
  const share = await fx.call('POST /api/conversation/:id/share', { params: { id: 'conv-1' } });
  const shared = await fx.call('GET /api/shared/:token', { params: { token: share.body.token }, query: { limit: '2' } });
  assert.equal(shared.status, 200);
  assert.deepEqual(shared.body.messages.map((message) => message.id), ['user-new', 'reply-new']);
  assert.ok(!JSON.stringify(shared.body).toLowerCase().includes(DEAD_TOKEN), 'the dead token escaped redaction');
});
