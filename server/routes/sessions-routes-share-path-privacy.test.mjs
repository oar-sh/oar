import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { createSubagentTimelineService, mapSubagentRunHeader } from '../services/subagent-timeline-service.mjs';
import { SHARE_PATH_PLACEHOLDER, SHARE_PREVIEW_MARKS } from '../services/share-path-redaction.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';

// Path privacy on the share routes: a conversation whose workspace, home and
// relay data dir are known serves none of them through a share link unless
// the relay says "show"; attachments lose their host path; the sub-agent
// record opens only for runs the shared view shows a row for.

// platform-agnostic: the redactor reads Windows and Unix paths as plain strings,
// never through the host's `path`, so both shapes are tested on every OS.
const SHA = 'ab'.repeat(32);
const NOW = '2026-10-16T09:00:00.000Z';

const HOSTS = {
  unix: {
    home: '/home/dev',
    workspace: '/home/dev/work/demo',
    dataDir: '/srv/relay/data',
    file: (name) => `/home/dev/work/demo/src/${name}`,
  },
  windows: {
    home: 'C:\\Users\\dev',
    workspace: 'C:\\Users\\dev\\work\\demo',
    dataDir: 'C:\\Users\\dev\\AppData\\Roaming\\oar\\data',
    file: (name) => `C:\\Users\\dev\\work\\demo\\src\\${name}`,
  },
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

function setup({ host = HOSTS.unix, mode = 'filename' } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  const settings = { mode };
  const accesses = [];
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
    // As the runtime does: the host path and an @reference to it.
    hydrateAttachment: (raw) => {
      const path = `${host.dataDir}${host.dataDir.includes('\\') ? '\\uploads\\' : '/uploads/'}${raw.sha256}`;
      return { ...raw, path, reference: `@${path}`, contentUrl: `/api/upload/${raw.sha256}/content` };
    },
    relayActivityForResponse: (messageId) => (messageId === 'reply-1' ? [
      { text: `Read ${host.file('app.js')}`, subagentRunId: null },
      { text: `Ran ls ${host.workspace}`, subagentRunId: null },
    ] : []),
    relayThoughtsForResponse: (messageId) => (messageId === 'reply-1' ? [
      { reasoningId: 'r-1', seq: 1, text: `The config lives under ${host.home}.`, done: true },
    ] : []),
    subagentRunsForResponse: (messageId) => (stmts.listSubagentRunsByResponse.all(messageId, messageId, messageId) || [])
      .map((row) => mapSubagentRunHeader(row))
      .filter(Boolean),
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
    resolveConversationWorkspaceState: ({ conversationId }) => (conversationId === 'conv-demo' ? {
      configuredWorkspaceRootPath: host.workspace,
      runtimeWorkspaceRootPath: host.workspace,
      currentWorkspaceRootPath: host.workspace,
    } : null),
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
    statusEventService: { recordSharedAccess: (entry) => { accesses.push(entry); return { event: null }; } },
    getSharePathPrivacyMode: () => settings.mode,
    setSharePathPrivacyMode: (value) => { settings.mode = value; return { ok: true, mode: value }; },
    sharePathKnownRoots: () => ({ roots: [host.home, host.dataDir], userNames: ['dev'] }),
    isSha256: (value) => /^[a-f0-9]{64}$/.test(String(value || '')),
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

  const timeline = createSubagentTimelineService({ db, stmts, now: () => NOW });
  const insertConversation = (id) => {
    db.prepare(`INSERT INTO conversations (id, title, created_at, status, updated_at) VALUES (?, 'Report builder', ?, 'active', ?)`).run(id, NOW, NOW);
  };
  const insertMessage = (conversationId, id, role, text, timestamp, extra = {}) => {
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, text, attachments, hidden_from_shares, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, role, text, extra.attachments || null, extra.hidden ? 1 : 0, timestamp);
  };
  const insertTurn = (conversationId, queueId, responseId) => {
    db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, response_message_id) VALUES (?, ?, 'prompt', 'done', ?, ?)`)
      .run(queueId, conversationId, NOW, responseId);
  };
  const insertRun = (id, conversationId, queueId, displayName, parent = null, entries = []) => {
    stmts.insertSubagentRun.run(id, queueId, conversationId, parent, displayName, 'completed', NOW, NOW);
    const run = stmts.getSubagentRun.get(id);
    if (entries.length) timeline.applyEntries(run, entries);
  };

  // The conversation: a prompt with an upload, a reply that names the
  // workspace in every channel, and a reply the owner hid from shares.
  insertConversation('conv-demo');
  insertConversation('conv-other');
  insertMessage('conv-demo', 'user-1', 'user', `Look at ${host.file('app.js')} please`, '2026-10-16T09:00:00.000Z', {
    attachments: JSON.stringify([{ sha256: SHA, name: 'screen.png', type: 'image/png', size: 10 }]),
  });
  insertMessage('conv-demo', 'reply-1', 'assistant', [
    `Fixed it in ${host.file('app.js')} (workspace ${host.workspace}).`,
    '```',
    `cat ${host.file('config.json')}`,
    '```',
    'Details: https://example.com/docs/a/b',
  ].join('\n'), '2026-10-16T09:00:05.000Z');
  insertMessage('conv-demo', 'user-2', 'user', 'Another try', '2026-10-16T09:01:00.000Z');
  insertMessage('conv-demo', 'reply-2', 'assistant', 'A reply the owner hid.', '2026-10-16T09:01:05.000Z', { hidden: true });
  insertTurn('conv-demo', 'user-1', 'reply-1');
  insertTurn('conv-demo', 'user-2', 'reply-2');
  insertTurn('conv-other', 'user-x', 'reply-x');
  insertRun('run-1', 'conv-demo', 'user-1', `Survey ${host.workspace}`, null, [
    { key: 'w:1', kind: 'thought', text: `Start in ${host.file('index.js')}` },
    { key: 'w:2', kind: 'tool_call', toolName: 'Read', toolUseId: 'toolu_read_1', text: JSON.stringify({ file_path: host.file('index.js') }) },
    { key: 'w:3', kind: 'tool_result', toolUseId: 'toolu_read_1', text: `contents of ${host.file('index.js')}` },
  ]);
  insertRun('run-1-child', 'conv-demo', 'user-1', 'Child look', 'run-1', [
    { key: 'w:1', kind: 'text', text: `Child read ${host.home}` },
  ]);
  insertRun('run-hidden', 'conv-demo', 'user-2', 'Hidden run');
  insertRun('run-other', 'conv-other', 'user-x', 'Other conversation run');

  return { db, stmts, call, settings, accesses };
}

async function shareToken(fx) {
  const share = await fx.call('POST /api/conversation/:id/share', { params: { id: 'conv-demo' } });
  assert.equal(share.status, 200);
  return share.body.token;
}

async function sharedPayload(fx) {
  const token = await shareToken(fx);
  const shared = await fx.call('GET /api/shared/:token', { params: { token }, query: {} });
  assert.equal(shared.status, 200);
  return { token, body: shared.body };
}

function absolutePathsOf(host) {
  return [host.workspace, host.home, host.dataDir, host.file('app.js'), host.file('config.json'), host.file('index.js')];
}

for (const [hostName, host] of Object.entries(HOSTS)) {
  for (const mode of ['filename', 'hide']) {
    test(`${hostName} host, ${mode} mode: no absolute path of the host survives in the shared payload`, async () => {
      const fx = setup({ host, mode });
      const { body, token } = await sharedPayload(fx);
      const json = JSON.stringify(body);
      for (const value of absolutePathsOf(host)) {
        assert.ok(!json.includes(JSON.stringify(value).slice(1, -1)), `${value} survived`);
      }
      assert.ok(!/\\\\Users\\\\dev|\/home\/dev/i.test(json), 'no trace of the home');
      const user = body.messages.find((message) => message.id === 'user-1');
      const [attachment] = user.attachments;
      assert.equal(attachment.path, undefined, 'no host path on an attachment');
      assert.equal(attachment.reference, undefined, 'no @reference on an attachment');
      assert.equal(attachment.contentUrl, `/api/shared/${token}/upload/${SHA}/content`, 'the share URL is intact');
      assert.equal(attachment.name, mode === 'hide' ? SHARE_PATH_PLACEHOLDER : 'screen.png');
      const reply = body.messages.find((message) => message.id === 'reply-1');
      assert.ok(reply.text.includes('https://example.com/docs/a/b'), 'URLs are untouched');
      assert.ok(reply.text.includes('```\ncat '), 'code fences keep their structure');
      if (mode === 'filename') {
        assert.ok(reply.text.startsWith('Fixed it in app.js (workspace demo).'), reply.text);
        assert.equal(reply.activities[0].text, 'Read app.js');
        assert.equal(reply.subagentRuns[0].displayName, 'Survey demo');
      } else {
        assert.ok(reply.text.startsWith(`Fixed it in ${SHARE_PATH_PLACEHOLDER} (workspace ${SHARE_PATH_PLACEHOLDER}).`), reply.text);
      }
      assert.equal(JSON.stringify(body).includes(SHARE_PREVIEW_MARKS.redactedStart), false, 'a share link carries no preview marks');
    });
  }

  test(`${hostName} host, show mode: every path survives, and only the attachment's host path goes`, async () => {
    const fx = setup({ host, mode: 'show' });
    const { body } = await sharedPayload(fx);
    const json = JSON.stringify(body);
    for (const value of [host.workspace, host.home, host.file('app.js'), host.file('config.json')]) {
      assert.ok(json.includes(JSON.stringify(value).slice(1, -1)), `${value} is missing`);
    }
    const [attachment] = body.messages.find((message) => message.id === 'user-1').attachments;
    assert.equal(attachment.path, undefined);
    assert.equal(attachment.reference, undefined);
  });
}

test('shared pagination pages are filtered too', async () => {
  const fx = setup({ mode: 'filename' });
  const token = await shareToken(fx);
  const page = await fx.call('GET /api/shared/:token', { params: { token }, query: { limit: '1', beforeMessageId: 'user-2' } });
  assert.equal(page.status, 200);
  assert.equal(page.body.messages.length, 1);
  assert.ok(!JSON.stringify(page.body).includes('/home/dev'));
});

test('the setting route reads and writes the mode, and refuses anything else', async () => {
  const fx = setup({ mode: 'filename' });
  const read = await fx.call('GET /api/settings/share-path-privacy');
  assert.equal(read.body.mode, 'filename');
  assert.equal(read.body.defaultMode, 'filename');
  assert.deepEqual(read.body.choices.map((choice) => choice.value), ['show', 'filename', 'hide']);
  const written = await fx.call('POST /api/settings/share-path-privacy', { body: { mode: 'hide' } });
  assert.equal(written.status, 200);
  assert.equal(written.body.mode, 'hide');
  assert.equal(fx.settings.mode, 'hide');
  const refused = await fx.call('POST /api/settings/share-path-privacy', { body: { mode: 'everything' } });
  assert.equal(refused.status, 400);
  assert.equal(fx.settings.mode, 'hide');
});

test('preview as shared: marked, without a share link, without an access record', async () => {
  const fx = setup({ mode: 'filename' });
  const preview = await fx.call('GET /api/conversation/:id/share-preview', { params: { id: 'conv-demo' }, query: {} });
  assert.equal(preview.status, 200);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM conversation_shares WHERE conversation_id = ?').get('conv-demo').n, 0, 'no share link was made');
  assert.equal(fx.accesses.length, 0, 'no shared access was recorded');
  assert.deepEqual(preview.body.shared, { token: null, readOnly: true, preview: true, pathPrivacy: 'filename', watcherCount: 0 });
  const reply = preview.body.messages.find((message) => message.id === 'reply-1');
  const { redactedStart: rs, redactedEnd: re } = SHARE_PREVIEW_MARKS;
  assert.ok(reply.text.startsWith(`Fixed it in ${rs}app.js${re} (workspace ${rs}demo${re}).`), reply.text);
  assert.ok(!JSON.stringify(preview.body).includes('/home/dev'), 'the original is not sent');
  assert.ok(!preview.body.messages.some((message) => message.id === 'reply-2'), 'hidden messages stay hidden');
  const missing = await fx.call('GET /api/conversation/:id/share-preview', { params: { id: 'conv-nope' }, query: {} });
  assert.equal(missing.status, 404);
});

test('shared sub-agent record: filtered, read-only, and only for runs of the shared view', async () => {
  const fx = setup({ mode: 'filename' });
  const token = await shareToken(fx);
  const read = (runId, extra = {}) => fx.call('GET /api/shared/:token/subagent/:subagentRunId', {
    params: { token, subagentRunId: runId, ...extra },
    query: {},
  });

  const record = await read('run-1');
  assert.equal(record.status, 200);
  assert.equal(record.body.run.subagentRunId, 'run-1');
  assert.equal(record.body.run.stoppable, false);
  assert.equal('taskId' in record.body.run, false);
  assert.equal(record.body.run.displayName, 'Survey demo');
  assert.deepEqual(record.body.entries.map((entry) => entry.text), [
    'Start in index.js',
    JSON.stringify({ file_path: 'index.js' }),
    'contents of index.js',
  ]);
  assert.deepEqual(record.body.children.map((child) => child.subagentRunId), ['run-1-child']);
  assert.ok(!JSON.stringify(record.body).includes('/home/dev'));

  const child = await read('run-1-child');
  assert.equal(child.status, 200, 'a child of a shown run opens');
  assert.equal(child.body.entries[0].text, `Child read ${SHARE_PATH_PLACEHOLDER}`);

  assert.equal((await read('run-other')).status, 404, 'a run of another conversation');
  assert.equal((await read('run-hidden')).status, 404, 'a run of a reply hidden from shares');
  assert.equal((await read('run-unknown')).status, 404);
  const wrongToken = await fx.call('GET /api/shared/:token/subagent/:subagentRunId', {
    params: { token: 'f'.repeat(64), subagentRunId: 'run-1' },
    query: {},
  });
  assert.equal(wrongToken.status, 404);

  await fx.call('DELETE /api/conversation/:id/share', { params: { id: 'conv-demo' } });
  assert.equal((await read('run-1')).status, 404, 'a revoked share opens nothing');
});

test('preview of a sub-agent record: marked, same rules', async () => {
  const fx = setup({ mode: 'hide' });
  const read = (id, runId) => fx.call('GET /api/conversation/:id/share-preview/subagent/:subagentRunId', {
    params: { id, subagentRunId: runId },
    query: {},
  });
  const record = await read('conv-demo', 'run-1');
  assert.equal(record.status, 200);
  const { redactedStart: rs, redactedEnd: re } = SHARE_PREVIEW_MARKS;
  assert.equal(record.body.entries[0].text, `Start in ${rs}${SHARE_PATH_PLACEHOLDER}${re}`);
  assert.equal((await read('conv-demo', 'run-other')).status, 404);
  assert.equal((await read('conv-other', 'run-1')).status, 404);
});
