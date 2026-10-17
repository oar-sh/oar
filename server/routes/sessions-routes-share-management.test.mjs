import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createShareRepository } from '../repositories/share-repository.mjs';
import { createStatusEventService } from '../services/status-event-service.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';

// Share management: the list, renew, stop, the access log and the IP setting,
// through the real routes on a real schema.

const BROWSER_A = 'Mozilla/5.0 (X11; Linux x86_64) FixtureBrowser/1.0';
const BROWSER_B = 'Mozilla/5.0 (Macintosh) OtherFixtureBrowser/2.0';

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

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const shareRepository = createShareRepository(db);
  const statusEventService = createStatusEventService(db);
  const emitted = [];
  const app = createMockApp();
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emitted.push([event, payload]); } },
    db,
    stmts,
    shareRepository,
    runtimeState: {},
    config: {},
    parseAttachments: (raw) => {
      try { return raw ? JSON.parse(raw) : []; } catch { return []; }
    },
    hydrateAttachment: (value) => value,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    subagentRunsForResponse: () => [],
    listKnownPreviewTokens: () => [],
    listConversationPreviews: () => [],
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
    statusEventService,
    markSharedViewerPresence: () => ({ ok: true, watcherCount: 1 }),
    getSharedWatcherCount: () => 0,
    isSha256: (value) => /^[a-f0-9]{64}$/.test(String(value || '')),
    uploadPathForSha: () => '/home/dev/no-such-upload',
  });

  const call = async (routeKey, {
    params = {},
    body = {},
    query = {},
    ip = '203.0.113.10',
    userAgent = BROWSER_A,
    headers = {},
    trustedPeer = false,
  } = {}) => {
    const handler = app.routes.get(routeKey);
    assert.ok(handler, `${routeKey} should be registered`);
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    const req = {
      body,
      query,
      params,
      ip,
      headers: { 'user-agent': userAgent, host: 'relay.example.test', ...headers },
      socket: { remoteAddress: trustedPeer ? '127.0.0.1' : '198.51.100.200' },
      // Express's compiled `trust proxy` setting: loopback only.
      app: { get: (name) => (name === 'trust proxy fn' ? (address) => address === '127.0.0.1' : undefined) },
      protocol: 'https',
    };
    await handler(req, res);
    return captured;
  };

  const insertConversation = (id, title) => {
    db.prepare(`
      INSERT INTO conversations (id, title, created_at, status, updated_at)
      VALUES (?, ?, '2026-10-01T09:00:00.000Z', 'active', '2026-10-01T09:00:00.000Z')
    `).run(id, title);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, text, timestamp)
      VALUES (?, ?, 'user', 'Build the report builder.', '2026-10-01T09:00:01.000Z')
    `).run(`${id}-m1`, id);
  };
  const opensRows = () => db.prepare(`SELECT * FROM conversation_share_opens ORDER BY id`).all();
  const share = async (id) => (await call('POST /api/conversation/:id/share', { params: { id } })).body;
  const read = (token, options = {}) => call('GET /api/shared/:token', { params: { token }, ...options });
  const list = async () => (await call('GET /api/shares')).body;
  return { db, call, emitted, insertConversation, opensRows, share, read, list };
}

test('the list names every active share with its title, link and counts', async () => {
  const fx = setup();
  fx.insertConversation('conv-a', 'Report builder');
  fx.insertConversation('conv-b', 'Export feature');
  fx.insertConversation('conv-c', 'Not shared');
  assert.deepEqual((await fx.list()).shares, []);

  const first = await fx.share('conv-a');
  assert.equal(first.created, true);
  const again = await fx.share('conv-a');
  assert.equal(again.created, false, 'one active share per conversation');
  assert.equal(again.token, first.token);
  await fx.share('conv-b');
  assert.deepEqual(fx.emitted.filter(([event]) => event === 'share_created').map(([, payload]) => payload.conversationId), ['conv-a', 'conv-b']);

  const body = await fx.list();
  assert.equal(body.storeViewerIp, true, 'IP addresses are stored by default');
  assert.equal(body.accessLog, true);
  const byId = Object.fromEntries(body.shares.map((entry) => [entry.conversationId, entry]));
  assert.deepEqual(Object.keys(byId).sort(), ['conv-a', 'conv-b']);
  assert.equal(byId['conv-a'].title, 'Report builder');
  assert.equal(byId['conv-a'].shareUrl, `https://relay.example.test/shared/${first.token}`);
  assert.equal(byId['conv-a'].openCount, 0);
  assert.equal(byId['conv-a'].viewerCount, 0);
  assert.equal(byId['conv-a'].lastOpenedAt, null);
  assert.equal(byId['conv-a'].renewedAt, null);
  assert.ok(byId['conv-a'].sharedSince);
});

test('a page load counts as one open, its polls do not, and viewers are counted apart', async () => {
  const fx = setup();
  fx.insertConversation('conv-a', 'Report builder');
  const { token } = await fx.share('conv-a');

  assert.equal((await fx.read(token, { query: { open: '1' } })).status, 200);
  for (let poll = 0; poll < 5; poll += 1) {
    assert.equal((await fx.read(token, { query: {} })).status, 200);
  }
  // A paging fetch carries no flag either.
  assert.equal((await fx.read(token, { query: { beforeMessageId: 'conv-a-m1' } })).status, 200);
  assert.equal(fx.opensRows().length, 1);
  assert.equal(fx.emitted.filter(([event]) => event === 'share_opened').length, 1);

  // A second browser on the same address, and a third reader elsewhere.
  await fx.read(token, { query: { open: '1' }, userAgent: BROWSER_B });
  await fx.read(token, { query: { open: '1' }, ip: '192.0.2.44' });
  // A reload of the first browser within a few seconds is the same open.
  await fx.read(token, { query: { open: '1' } });

  const [entry] = (await fx.list()).shares;
  assert.equal(entry.openCount, 3);
  assert.equal(entry.viewerCount, 3);
  assert.ok(entry.lastOpenedAt);

  const log = (await fx.call('GET /api/conversation/:id/share/opens', { params: { id: 'conv-a' } })).body;
  assert.equal(log.total, 3);
  assert.equal(log.opens.length, 3);
  assert.deepEqual(log.opens.map((open) => open.ip).sort(), ['192.0.2.44', '203.0.113.10', '203.0.113.10']);
  assert.ok(log.opens.every((open) => open.userAgent && open.openedAt && /^[a-f0-9]{8}$/.test(open.viewer)));
  assert.equal(new Set(log.opens.map((open) => open.viewer)).size, 3);
});

test('the country is taken from the edge header only through a trusted proxy', async () => {
  const fx = setup();
  fx.insertConversation('conv-a', 'Report builder');
  const { token } = await fx.share('conv-a');
  await fx.read(token, { query: { open: '1' }, headers: { 'cf-ipcountry': 'DE' } });
  await fx.read(token, { query: { open: '1' }, headers: { 'cf-ipcountry': 'fr' }, trustedPeer: true, userAgent: BROWSER_B });
  await fx.read(token, { query: { open: '1' }, headers: { 'cf-ipcountry': '<script>' }, trustedPeer: true, ip: '192.0.2.44' });
  assert.deepEqual(fx.opensRows().map((row) => row.country), [null, 'FR', null]);
});

test('a renewed link keeps the access log, and the old token is a 404 everywhere', async () => {
  const fx = setup();
  fx.insertConversation('conv-a', 'Report builder');
  const { token: oldToken } = await fx.share('conv-a');
  await fx.read(oldToken, { query: { open: '1' } });
  await fx.read(oldToken, { query: { open: '1' }, userAgent: BROWSER_B });

  const renewed = await fx.call('POST /api/conversation/:id/share/renew', { params: { id: 'conv-a' } });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.renewed, true);
  const newToken = renewed.body.token;
  assert.match(newToken, /^[a-f0-9]{64}$/);
  assert.notEqual(newToken, oldToken);
  assert.equal(renewed.body.shareUrl, `https://relay.example.test/shared/${newToken}`);
  assert.deepEqual(fx.emitted.filter(([event]) => event === 'share_renewed').map(([, payload]) => payload), [{ conversationId: 'conv-a' }]);

  assert.equal((await fx.read(oldToken)).status, 404);
  assert.equal((await fx.call('POST /api/shared/:token/presence', { params: { token: oldToken }, body: { viewerId: 'viewer-fixture' } })).status, 404);
  assert.equal((await fx.call('GET /api/shared/:token/upload/:sha256/content', { params: { token: oldToken, sha256: 'a'.repeat(64) } })).status, 404);
  assert.equal((await fx.call('GET /api/shared/:token/generated-image/:messageId/:imageId/content', { params: { token: oldToken, messageId: 'conv-a-m1', imageId: 'img-1' } })).status, 404);
  assert.equal((await fx.call('POST /api/shared/:token/presence', { params: { token: newToken }, body: { viewerId: 'viewer-fixture' } })).status, 200);

  assert.equal((await fx.read(newToken, { query: { open: '1' }, ip: '192.0.2.44' })).status, 200);
  const [entry] = (await fx.list()).shares;
  assert.equal(entry.token, newToken);
  assert.equal(entry.openCount, 3, 'the opens of the old link carry over');
  assert.equal(entry.viewerCount, 3);
  assert.ok(entry.renewedAt, 'the list says the link is a renewed one');
  // Asking for the link again returns the renewed one.
  assert.equal((await fx.share('conv-a')).token, newToken);
  // Only one token of the conversation is live.
  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS n FROM conversation_shares WHERE conversation_id = 'conv-a' AND revoked_at IS NULL`).get().n, 1);
});

test('renewing needs an active share', async () => {
  const fx = setup();
  fx.insertConversation('conv-a', 'Report builder');
  assert.equal((await fx.call('POST /api/conversation/:id/share/renew', { params: { id: 'conv-a' } })).status, 404);
  assert.equal((await fx.call('POST /api/conversation/:id/share/renew', { params: { id: 'conv-missing' } })).status, 404);
});

test('stop sharing revokes the link and deletes its access log', async () => {
  const fx = setup();
  fx.insertConversation('conv-a', 'Report builder');
  fx.insertConversation('conv-b', 'Export feature');
  const { token } = await fx.share('conv-a');
  const { token: otherToken } = await fx.share('conv-b');
  await fx.read(token, { query: { open: '1' } });
  await fx.read(otherToken, { query: { open: '1' } });
  await fx.call('POST /api/conversation/:id/share/renew', { params: { id: 'conv-a' } });
  assert.equal(fx.opensRows().length, 2);

  const stopped = await fx.call('DELETE /api/conversation/:id/share', { params: { id: 'conv-a' } });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.opensDeleted, 1);
  assert.deepEqual(fx.emitted.filter(([event]) => event === 'share_revoked').map(([, payload]) => payload), [{ conversationId: 'conv-a' }]);
  assert.deepEqual(fx.opensRows().map((row) => row.conversation_id), ['conv-b'], 'only the other share keeps its log');
  assert.deepEqual((await fx.list()).shares.map((entry) => entry.conversationId), ['conv-b']);
  assert.equal((await fx.call('GET /api/conversation/:id/share/opens', { params: { id: 'conv-a' } })).status, 404);
  assert.equal((await fx.call('DELETE /api/conversation/:id/share', { params: { id: 'conv-a' } })).status, 404);

  // Sharing again starts a new link with an empty log.
  const fresh = await fx.share('conv-a');
  assert.equal(fresh.created, true);
  assert.equal((await fx.read(token)).status, 404);
  const entry = (await fx.list()).shares.find((item) => item.conversationId === 'conv-a');
  assert.equal(entry.openCount, 0);
});

test('with IP storage off new log rows and status events carry no address', async () => {
  const fx = setup();
  fx.insertConversation('conv-a', 'Report builder');
  const { token } = await fx.share('conv-a');
  await fx.read(token, { query: { open: '1' } });

  assert.equal((await fx.call('POST /api/settings/shares', { body: { storeViewerIp: 'no' } })).status, 400);
  const saved = await fx.call('POST /api/settings/shares', { body: { storeViewerIp: false } });
  assert.deepEqual(saved.body, { storeViewerIp: false });
  assert.deepEqual(fx.emitted.find(([event]) => event === 'share_settings_changed')?.[1], { storeViewerIp: false });
  assert.deepEqual((await fx.call('GET /api/settings/shares')).body, { storeViewerIp: false });
  assert.equal((await fx.list()).storeViewerIp, false);

  await fx.read(token, { query: { open: '1' }, ip: '192.0.2.44' });
  await fx.read(token, { query: { open: '1' }, ip: '192.0.2.45' });
  const rows = fx.opensRows();
  assert.deepEqual(rows.map((row) => row.ip), ['203.0.113.10', null, null], 'rows logged before keep theirs');
  // Distinct viewers still count apart without the address.
  assert.equal(new Set(rows.map((row) => row.viewer_key)).size, 3);
  assert.equal((await fx.list()).shares[0].viewerCount, 3);

  const events = fx.db.prepare(`SELECT payload_json FROM status_events WHERE type = 'shared-access-opened' ORDER BY timestamp`).all()
    .map((row) => JSON.parse(row.payload_json));
  assert.equal(events.length, 3, 'one event per viewer, not one for all address-less reads');
  assert.equal(events[0].viewerIp, '203.0.113.10');
  assert.ok(events.slice(1).every((details) => !('viewerIp' in details)));
  assert.ok(!JSON.stringify(events.slice(1)).includes('192.0.2.4'));
});

test('the addresses stored before can be counted and removed; viewers still count apart', async () => {
  const fx = setup();
  fx.insertConversation('conv-a', 'Report builder');
  fx.insertConversation('conv-b', 'Export feature');
  const a = await fx.share('conv-a');
  const b = await fx.share('conv-b');
  await fx.read(a.token, { query: { open: '1' }, ip: '192.0.2.10' });
  await fx.read(a.token, { query: { open: '1' }, ip: '192.0.2.11' });
  // The same address on the other share is one address, not two.
  await fx.read(b.token, { query: { open: '1' }, ip: '192.0.2.10' });
  fx.db.prepare(`INSERT INTO status_events (id, timestamp, type, source, payload_json) VALUES (?, ?, ?, 'server', ?)`)
    .run('status-other', 1, 'relay-started', JSON.stringify({ viewerIp: '192.0.2.99' }));
  fx.db.prepare(`INSERT INTO status_events (id, timestamp, type, source, payload_json) VALUES (?, ?, ?, 'server', ?)`)
    .run('status-broken', 2, 'shared-access-opened', 'not json');

  const counted = await fx.call('GET /api/settings/shares/stored-viewer-ips');
  assert.deepEqual(counted.body, { count: 2 });
  const viewersBefore = (await fx.list()).shares.map((entry) => [entry.conversationId, entry.viewerCount]);

  // Switching storage off alone keeps them.
  await fx.call('POST /api/settings/shares', { body: { storeViewerIp: false } });
  assert.equal((await fx.call('GET /api/settings/shares/stored-viewer-ips')).body.count, 2);

  const removed = await fx.call('DELETE /api/settings/shares/stored-viewer-ips');
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { ok: true, cleared: { opens: 3, events: 3 }, count: 0 });
  assert.deepEqual(fx.emitted.find(([event]) => event === 'share_viewer_ips_forgotten')?.[1], { opens: 3, events: 3 });
  const rows = fx.opensRows();
  assert.equal(rows.length, 3, 'the log keeps its rows');
  assert.ok(rows.every((row) => row.ip === null));
  assert.ok(rows.every((row) => row.viewer_key), 'viewer keys stay');
  assert.deepEqual((await fx.list()).shares.map((entry) => [entry.conversationId, entry.viewerCount]), viewersBefore);
  const shared = fx.db.prepare(`SELECT payload_json FROM status_events WHERE type = 'shared-access-opened' AND payload_json <> 'not json'`).all()
    .map((row) => JSON.parse(row.payload_json));
  assert.equal(shared.length, 3);
  assert.ok(shared.every((details) => !('viewerIp' in details) && details.shareId));
  assert.equal(JSON.parse(fx.db.prepare(`SELECT payload_json FROM status_events WHERE id = 'status-other'`).get().payload_json).viewerIp, '192.0.2.99', 'other events are not touched');
  assert.equal(fx.db.prepare(`SELECT payload_json FROM status_events WHERE id = 'status-broken'`).get().payload_json, 'not json');
  assert.deepEqual((await fx.call('GET /api/settings/shares/stored-viewer-ips')).body, { count: 0 });
});

test('a forwarded address from an untrusted peer is not taken as the viewer address', async () => {
  const fx = setup();
  fx.insertConversation('conv-a', 'Report builder');
  const { token } = await fx.share('conv-a');
  // req.ip is what Express derived through `trust proxy`; the raw header is
  // what a direct client can write itself.
  await fx.read(token, { query: { open: '1' }, ip: '::ffff:198.51.100.200', headers: { 'x-forwarded-for': '192.0.2.99' } });
  assert.equal(fx.opensRows()[0].ip, '198.51.100.200');
});

test('deleting the conversation deletes its access log', async () => {
  const fx = setup();
  fx.insertConversation('conv-a', 'Report builder');
  const { token } = await fx.share('conv-a');
  await fx.read(token, { query: { open: '1' } });
  const deleted = await fx.call('DELETE /api/conversation/:id', { params: { id: 'conv-a' } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(fx.opensRows().length, 0);
  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS n FROM conversation_shares`).get().n, 0);
  assert.ok(fx.emitted.some(([event, payload]) => event === 'share_revoked' && payload.conversationId === 'conv-a'));
  assert.deepEqual((await fx.list()).shares, []);
});

test('a share link names the forwarded host only when a trusted proxy sent it', async () => {
  const fx = setup();
  fx.insertConversation('conv-a', 'Report builder');
  fx.insertConversation('conv-b', 'Export feature');
  const forged = await fx.call('POST /api/conversation/:id/share', {
    params: { id: 'conv-a' },
    headers: { 'x-forwarded-host': 'evil.example.test', 'x-forwarded-proto': 'http' },
  });
  assert.equal(forged.body.shareUrl, `https://relay.example.test/shared/${forged.body.token}`);
  const proxied = await fx.call('POST /api/conversation/:id/share', {
    params: { id: 'conv-b' },
    headers: { 'x-forwarded-host': 'relay-b.example.test' },
    trustedPeer: true,
  });
  assert.equal(proxied.body.shareUrl, `https://relay-b.example.test/shared/${proxied.body.token}`);
});

test('the presence limit keys on req.ip, so a forged X-Forwarded-For does not open new buckets', async () => {
  const fx = setup();
  fx.insertConversation('conv-a', 'Report builder');
  const { token } = await fx.share('conv-a');
  const statuses = [];
  for (let index = 0; index < 25; index += 1) {
    const result = await fx.call('POST /api/shared/:token/presence', {
      params: { token },
      body: { viewerId: 'viewer-fixture' },
      headers: { 'x-forwarded-for': `192.0.2.${index + 1}`, 'x-real-ip': `198.51.100.${index + 1}` },
    });
    statuses.push(result.status);
  }
  assert.deepEqual(statuses.slice(0, 24), Array(24).fill(200));
  assert.equal(statuses[24], 429);
});
