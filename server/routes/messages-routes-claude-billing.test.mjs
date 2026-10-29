import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import {
  makeRouteDeps as baseRouteDeps,
  captureRoutes,
  invokeRoute,
} from './messages-routes-test-harness.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createClaudeBillingSwitchService } from '../services/claude-billing-switch-service.mjs';
import { createClaudeApiUsageService } from '../services/claude-api-usage-service.mjs';

// The Claude billing switch on the send path, against the REAL routes, the
// REAL SQLite schema and the real switch service:
//
//   /api/message never switches: the other billing named → 409
//     CLAUDE_BILLING_SWITCH_REQUIRED; a page that showed the other billing
//     → 409 CLAUDE_BILLING_CHANGED (nothing queued either way)
//   POST /api/conversation/:id/billing switches, and with `message` switches
//     and enqueues in one transaction

const CONV = 'conv-billing-1';
const RS = 'rs-billing-1';
const MODEL = 'claude-sonnet-5-5';
const NOW = '2026-10-25T12:00:00.000Z';

function boot({ provider = 'claude', model = MODEL, claudeApi = {}, getClaudeApiCapState = undefined } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at)
    VALUES (?, 'Billing', ?, 'active', ?, ?)
  `).run(CONV, CONV, NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, ?, 'isolated', ?, ?, ?, ?, 'active', ?, ?)
  `).run(RS, CONV, CONV, `key-${RS}`, model, provider, model, NOW, NOW);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  const emitted = [];
  const claudeSettings = { enabled: true, model: MODEL, models: [MODEL, 'claude-haiku-4-5'], availableModels: [MODEL, 'claude-haiku-4-5'], effortsByModel: {} };
  const claudeApiSettings = { enabled: true, configured: true, model: MODEL, models: [MODEL], availableModels: [MODEL], effortsByModel: {}, ...claudeApi };
  const claudeBillingSwitchService = createClaudeBillingSwitchService({
    db,
    stmts,
    emit: (event, payload) => emitted.push({ event, payload }),
    getClaudeProviderSettings: () => claudeSettings,
    getClaudeApiProviderSettings: () => claudeApiSettings,
    ...(getClaudeApiCapState ? { getClaudeApiCapState } : {}),
    logger: { log() {}, warn() {} },
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
    ensureSessionId: () => 'client-1',
    DEFAULT_RELAY_MODE: 'agent',
    configuredConversationSessionMode: 'isolated',
    collectReferenceAttachmentsFromText: () => ({ attachments: [], skipped: 0 }),
    attachmentSummary: () => '',
    linkUploadReferences: () => {},
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
    ensureRuntimeSessionBinding: (conversationId) => stmts.getRuntimeSessionByConversation.get(conversationId) || null,
    getClaudeProviderSettings: () => claudeSettings,
    getClaudeApiProviderSettings: () => claudeApiSettings,
    resolveRequestedReasoningEffort: (_model, effort) => ({ ok: true, effort: effort || null, supported: ['none'] }),
    workspaceRootPayload: () => ({}),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0 }),
    emitToClientsExceptSessionId: (event, payload) => emitted.push({ event, payload }),
    claudeBillingSwitchService,
    claudeApiUsageService: createClaudeApiUsageService({ db, timeZone: 'UTC', logger: { log() {}, warn() {} } }),
    relayBridgeOwnerService: {
      normalizeIdentity: ({ sessionId } = {}) => (String(sessionId || '').trim() ? { sessionId: String(sessionId).trim() } : null),
    },
    runtimeState: { featureFlags: {} },
    // What POST /api/response reads besides the database.
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    relayThoughtsForResponse: () => [],
    relayThoughtsForQueueMessage: () => [],
    sanitizeActivityText: (value) => String(value || ''),
    hydrateAttachment: (attachment) => attachment,
    parseAttachments: () => [],
    inFlightStateForConversation: () => null,
    ...(getClaudeApiCapState ? { getClaudeApiCapState } : {}),
    // Agents' sends are recognised (the X-OAR-Remote-Origin header).
    remoteRelayInbound: { inboundEnabled: () => true },
  });
  const routes = captureRoutes(deps);
  const post = (routePath, body, { params = {}, headers = {} } = {}) => invokeRoute(routes, 'POST', routePath, { body, params, headers });
  const send = (extra = {}) => post('/api/message', {
    clientId: 'client-1',
    conversationId: CONV,
    text: `hello ${crypto.randomUUID()}`,
    model: MODEL,
    relayMode: 'agent',
    ...extra,
  });
  const billing = (body) => post('/api/conversation/:id/billing', body, { params: { id: CONV } });
  const runtime = () => db.prepare(`SELECT * FROM runtime_sessions WHERE id = ?`).get(RS);
  const queueRows = () => db.prepare(`SELECT id, provider, status, text FROM queue ORDER BY timestamp, rowid`).all();
  return { db, stmts, deps, emitted, post, send, billing, runtime, queueRows };
}

test('a send is stamped with the chat\'s billing', async () => {
  const app = boot();
  const { status, body } = await app.send();
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(app.queueRows().map((row) => row.provider), ['claude']);
});

test('a send that names the other billing is refused in both directions, and nothing is queued', async () => {
  for (const [provider, named] of [['claude', 'claude-api'], ['claude-api', 'claude']]) {
    const app = boot({ provider });
    for (const key of ['provider', 'providerType']) {
      const { status, body } = await app.send({ [key]: named });
      assert.equal(status, 409, `${provider} ${key}`);
      assert.equal(body.code, 'CLAUDE_BILLING_SWITCH_REQUIRED');
      assert.equal(body.billing, provider);
    }
    assert.deepEqual(app.queueRows(), []);
    assert.equal(app.runtime().provider_type, provider);
    // Naming its own billing is an ordinary send.
    assert.equal((await app.send({ provider })).status, 200);
  }
});

test('a page that showed the other billing gets CLAUDE_BILLING_CHANGED; one that showed this one or none sends', async () => {
  const app = boot({ provider: 'claude-api' });
  const stale = await app.send({ billing: 'claude' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CLAUDE_BILLING_CHANGED');
  assert.equal(stale.body.billing, 'claude-api');
  assert.match(stale.body.error, /now runs on the Claude API key/);
  assert.equal(stale.body.keptInDraft, true);
  assert.deepEqual(app.queueRows(), []);
  // The text is kept in the chat's draft (a replay from the outbox included),
  // once, after what was there.
  const draft = () => app.db.prepare(`SELECT draft_text FROM conversations WHERE id = ?`).get(CONV).draft_text;
  assert.match(draft(), /^hello /);
  const firstText = draft();
  app.db.prepare(`UPDATE conversations SET draft_text = ? WHERE id = ?`).run(`typed meanwhile`, CONV);
  await app.send({ billing: 'claude', text: firstText });
  await app.send({ billing: 'claude', text: firstText });
  assert.equal(draft(), `typed meanwhile\n\n${firstText}`);
  assert.ok(app.emitted.some((entry) => entry.event === 'conversation_draft_updated'));
  // The draft's attachments go out as they are, never cleared.
  const attachment = { id: 'up-1', name: 'plan.png', type: 'image/png', sha256: 'a'.repeat(64) };
  app.db.prepare(`UPDATE conversations SET draft_text = '', draft_attachments = ? WHERE id = ?`).run(JSON.stringify([attachment]), CONV);
  await app.send({ billing: 'claude', text: 'one more' });
  const update = app.emitted.filter((entry) => entry.event === 'conversation_draft_updated').at(-1).payload;
  assert.deepEqual(update.draftAttachments, [attachment]);
  assert.equal(update.draftText, 'one more');
  assert.equal((await app.send({ billing: 'claude-api' })).status, 200);
  assert.equal((await app.send()).status, 200);
  assert.deepEqual(app.queueRows().map((row) => row.provider), ['claude-api', 'claude-api']);
});

test('the billing route switches, re-stamps the queued rows and answers the state', async () => {
  const app = boot();
  await app.send();
  const { status, body } = await app.billing({ to: 'claude-api' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.changed, true);
  assert.equal(body.provider, 'claude-api');
  assert.equal(body.billing.provider, 'claude-api');
  assert.equal(app.runtime().provider_type, 'claude-api');
  assert.equal(app.runtime().billing_switched_by, 'user');
  assert.deepEqual(app.queueRows().map((row) => row.provider), ['claude-api']);
  assert.ok(app.emitted.some((entry) => entry.event === 'conversation_billing'));
});

test('the billing route refuses with the switch\'s reason, and the usage-limit button only goes to the key', async () => {
  const app = boot({ claudeApi: { enabled: false, configured: false } });
  const refused = await app.billing({ to: 'claude-api' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'CLAUDE_API_NOT_CONFIGURED');
  const other = boot({ provider: 'claude-api' });
  const wrongWay = await other.billing({ to: 'claude', by: 'usage-limit' });
  assert.equal(wrongWay.status, 400);
  assert.equal(other.runtime().provider_type, 'claude-api');
});

test('an agent\'s send with a provider: switch and enqueue in one transaction', async () => {
  const app = boot();
  const { status, body } = await app.billing({
    to: 'claude-api',
    by: 'agent',
    message: { clientId: 'agent-1', text: 'continue on the key', model: MODEL, relayMode: 'agent', provider: 'claude' },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.runtimeProviderType, 'claude-api');
  assert.equal(body.billingSwitched, true);
  assert.equal(app.runtime().provider_type, 'claude-api');
  assert.equal(app.runtime().billing_switched_by, 'agent');
  const rows = app.queueRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'claude-api');
  assert.equal(rows[0].text, 'continue on the key');
});

test('a send the route refuses after the switch check leaves the billing as it was', async () => {
  const app = boot();
  // An empty message passes the switch check and is refused by the send.
  const { status, body } = await app.billing({ to: 'claude-api', by: 'agent', message: { clientId: 'agent-1', text: '', model: MODEL } });
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(app.runtime().provider_type, 'claude');
  assert.equal(app.runtime().billing_switched_at, null);
  assert.deepEqual(app.queueRows(), []);
});

test('an agent\'s switch refused by the target model leaves billing and queue untouched', async () => {
  const app = boot({ model: 'claude-haiku-4-5' });
  const { status, body } = await app.billing({
    to: 'claude-api',
    by: 'agent',
    message: { clientId: 'agent-1', text: 'go', relayMode: 'agent' },
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'CLAUDE_BILLING_MODEL_UNAVAILABLE');
  assert.equal(app.runtime().provider_type, 'claude');
  assert.deepEqual(app.queueRows(), []);
});

test('a chat that is no Claude one cannot switch, with or without a message', async () => {
  const app = boot({ provider: 'deepseek', model: 'deepseek-flash' });
  for (const body of [{ to: 'claude-api' }, { to: 'claude', message: { text: 'x' } }]) {
    const answer = await app.billing(body);
    assert.equal(answer.status, 409);
    assert.equal(answer.body.code, 'CLAUDE_BILLING_NOT_CLAUDE');
  }
  assert.equal(app.runtime().provider_type, 'deepseek');
});

test('a continuation is stamped with the kind of the worker that started it, not the chat\'s billing of now', async () => {
  const app = boot({ provider: 'claude-api' });
  // The subscription worker, still finishing background work after the switch.
  const routes = captureRoutes({
    ...app.deps,
    sessionWorkerRegistry: { getWorker: (sid) => (sid === CONV ? { sdkSessionId: CONV, kind: 'claude' } : null), upsertWorker() {} },
  });
  const { status, body } = await invokeRoute(routes, 'POST', '/api/continuation-turn', {
    body: { conversationId: CONV, sdkSessionId: CONV, operationId: 'op-1' },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(app.db.prepare(`SELECT provider FROM queue WHERE id = ?`).get(body.messageId).provider, 'claude');
});

const usageBody = (extra = {}) => ({
  conversationId: CONV,
  claudeNativeSessionId: 'native-1',
  runId: 'run-1',
  turnId: 'q-1',
  at: '2026-10-25T10:00:00.000Z',
  firstResultOfRun: true,
  runCounts: [{ model: MODEL, hitTokens: 0, missTokens: 1000, outputTokens: 100, costUsd: 0.04 }],
  sessionTotals: [{ model: MODEL, hitTokens: 0, missTokens: 1000, outputTokens: 100, costUsd: 0.04 }],
  ...extra,
});

test('the usage route books a report on the key by the posting worker\'s registered kind', async () => {
  const app = boot({ provider: 'claude' });
  const routes = captureRoutes({
    ...app.deps,
    sessionWorkerRegistry: { getWorker: (sid) => (sid === 'sid-api' ? { sdkSessionId: 'sid-api', kind: 'claude-api' } : null) },
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    // The body says subscription; the worker is registered as the API one.
    const { status, body } = await invokeRoute(routes, 'POST', '/api/claude-api-usage', {
      body: usageBody({ billing: 'claude' }),
      headers: { 'x-relay-session-id': 'sid-api' },
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.billing, 'claude-api');
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some((line) => /BILLING FENCE FAILURE usage/.test(line)));
  assert.equal(app.db.prepare(`SELECT SUM(miss_tokens) AS n FROM claude_api_usage_totals`).get().n, 1000);
});

test('the usage route: a subscription report books nothing; a chat that is no Claude one is refused', async () => {
  const app = boot({ provider: 'claude' });
  const routes = captureRoutes(app.deps);
  const sub = await invokeRoute(routes, 'POST', '/api/claude-api-usage', { body: usageBody({ billing: 'claude' }) });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.billing, 'claude');
  assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM claude_api_usage_totals`).get().n, 0);
  assert.equal((await invokeRoute(routes, 'POST', '/api/claude-api-usage', { body: usageBody({ billing: '' }) })).status, 400);
  const cloud = boot({ provider: 'claude-cloud' });
  const refused = await invokeRoute(captureRoutes(cloud.deps), 'POST', '/api/claude-api-usage', { body: usageBody({ billing: 'claude' }) });
  assert.equal(refused.status, 409);
});

test('a send that fails after the switch rolls the switch back, and nobody hears of it', async () => {
  const app = boot();
  const first = await app.billing({ to: 'claude', message: { clientId: 'agent-1', messageId: 'm-dup', text: 'first', model: MODEL, relayMode: 'agent' } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  app.emitted.length = 0;
  // The same message id again: the insert fails after the switch ran.
  const again = await app.billing({ to: 'claude-api', by: 'agent', message: { clientId: 'agent-1', messageId: 'm-dup', text: 'second', model: MODEL, relayMode: 'agent' } });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, 'DUPLICATE_MESSAGE_ID');
  assert.equal(app.runtime().provider_type, 'claude');
  assert.equal(app.emitted.some((entry) => entry.event === 'conversation_billing'), false);
  assert.equal(app.emitted.some((entry) => entry.payload?.message?.kind === 'billing-switch'), false);
});

// The monthly cap on the send path (plan decision 12), with the REAL cap
// service over the REAL booking: an agent's send to a chat on the key is
// refused before anything is stored; a page's send is queued (the claim
// refuses it, with its note); a switch to the key is refused by the switch.

const AGENT_HEADERS = { 'x-oar-remote-origin': 'relay-fixture-b', 'x-oar-remote-hops': '1' };

async function bootAtCap({ provider = 'claude-api', capUsd = 1, spentUsd = 1.5 } = {}) {
  const { createClaudeApiPlanUsage } = await import('../services/plan-usage-claude-api.mjs');
  const { createClaudeApiUsageService: createUsage, normalizeClaudeApiUsageReport } = await import('../services/claude-api-usage-service.mjs');
  const holder = {};
  const app = boot({ provider, getClaudeApiCapState: () => holder.planUsage.getCapState() });
  const usage = createUsage({ db: app.db, timeZone: 'UTC', logger: { log() {}, warn() {} } });
  holder.planUsage = createClaudeApiPlanUsage({
    usageService: usage,
    getSettings: () => ({ configured: true, enabled: true, monthlyCapUsd: capUsd }),
  });
  if (spentUsd > 0) {
    const counts = [{ model: MODEL, hitTokens: 0, missTokens: 1000, outputTokens: 100, costUsd: spentUsd }];
    usage.recordReport({
      conversationId: CONV,
      billing: 'claude-api',
      report: normalizeClaudeApiUsageReport({
        claudeNativeSessionId: 'native-cap', runId: 'run-cap', at: new Date().toISOString(), firstResultOfRun: true,
        runCounts: counts, sessionTotals: counts,
      }).report,
    });
  }
  return app;
}

test('at the cap: an agent\'s send to a chat on the key is refused with CLAUDE_API_CAP_REACHED, and nothing is stored', async () => {
  const app = await bootAtCap();
  const messagesBefore = app.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n;
  const { status, body } = await app.post('/api/message', {
    clientId: 'agent-1', conversationId: CONV, text: 'go on', model: MODEL, relayMode: 'agent',
  }, { headers: AGENT_HEADERS });
  assert.equal(status, 409, JSON.stringify(body));
  assert.equal(body.code, 'CLAUDE_API_CAP_REACHED');
  assert.equal(body.billing, 'claude-api');
  assert.match(body.error, /\$1\.50, has reached the monthly cap of \$1\.00/);
  assert.match(body.error, /Nothing was queued\. Send with provider "claude"/);
  assert.deepEqual(app.queueRows(), []);
  assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n, messagesBefore);
});

test('at the cap: a page\'s send is queued for the claim to refuse; an agent\'s send to a subscription chat runs', async () => {
  const onKey = await bootAtCap();
  assert.equal((await onKey.send()).status, 200);
  assert.deepEqual(onKey.queueRows().map((row) => row.provider), ['claude-api']);
  const onSubscription = await bootAtCap({ provider: 'claude' });
  const agent = await onSubscription.post('/api/message', {
    clientId: 'agent-1', conversationId: CONV, text: 'go on', model: MODEL, relayMode: 'agent',
  }, { headers: AGENT_HEADERS });
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  assert.deepEqual(onSubscription.queueRows().map((row) => row.provider), ['claude']);
});

test('below the cap an agent\'s send to a chat on the key is queued', async () => {
  const app = await bootAtCap({ capUsd: 2 });
  const { status, body } = await app.post('/api/message', {
    clientId: 'agent-1', conversationId: CONV, text: 'go on', model: MODEL, relayMode: 'agent',
  }, { headers: AGENT_HEADERS });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(app.queueRows().map((row) => row.provider), ['claude-api']);
});

test('at the cap: a switch to the key is refused (page and agent), a switch away from it with a message goes through', async () => {
  const app = await bootAtCap({ provider: 'claude' });
  const page = await app.billing({ to: 'claude-api' });
  assert.equal(page.status, 409);
  assert.equal(page.body.code, 'CLAUDE_API_CAP_REACHED');
  assert.match(page.body.error, /has reached the monthly cap of \$1\.00/);
  const agent = await app.post('/api/conversation/:id/billing', {
    to: 'claude-api', by: 'agent', message: { clientId: 'agent-1', text: 'on the key', model: MODEL, relayMode: 'agent' },
  }, { params: { id: CONV }, headers: AGENT_HEADERS });
  assert.equal(agent.status, 409);
  assert.equal(agent.body.code, 'CLAUDE_API_CAP_REACHED');
  assert.equal(app.runtime().provider_type, 'claude');
  assert.deepEqual(app.queueRows(), []);
  // The way out: an agent moves a chat on the key back to the subscription.
  const onKey = await bootAtCap();
  const away = await onKey.post('/api/conversation/:id/billing', {
    to: 'claude', by: 'agent', message: { clientId: 'agent-1', text: 'on the subscription', model: MODEL, relayMode: 'agent' },
  }, { params: { id: CONV }, headers: AGENT_HEADERS });
  assert.equal(away.status, 200, JSON.stringify(away.body));
  assert.equal(onKey.runtime().provider_type, 'claude');
  assert.deepEqual(onKey.queueRows().map((row) => row.provider), ['claude']);
});

test('a cap that cannot be read refuses an agent\'s send to a chat on the key', async () => {
  const app = boot({ provider: 'claude-api', getClaudeApiCapState: () => { throw new Error('totals unreadable'); } });
  const { status, body } = await app.post('/api/message', {
    clientId: 'agent-1', conversationId: CONV, text: 'go on', model: MODEL, relayMode: 'agent',
  }, { headers: AGENT_HEADERS });
  assert.equal(status, 409);
  assert.equal(body.code, 'CLAUDE_API_CAP_REACHED');
  assert.deepEqual(app.queueRows(), []);
});

test('at the cap: an agent\'s send that names the key for a chat already on it is refused, and nothing is queued', async () => {
  const app = await bootAtCap();
  const { status, body } = await app.post('/api/conversation/:id/billing', {
    to: 'claude-api', by: 'agent', message: { clientId: 'agent-1', text: 'still on the key', model: MODEL, relayMode: 'agent' },
  }, { params: { id: CONV }, headers: AGENT_HEADERS });
  assert.equal(status, 409, JSON.stringify(body));
  assert.equal(body.code, 'CLAUDE_API_CAP_REACHED');
  assert.deepEqual(app.queueRows(), []);
  assert.equal(app.runtime().provider_type, 'claude-api');
});

// A turn the CLI starts by itself (a background task's notification) passes
// no claim: at the cap its row is minted with a stop the worker's control
// poller picks up, and the stop's result leaves the cap's note.
async function continuationAtCap(app, { kind = 'claude-api', routes: given = null, extra = {} } = {}) {
  const routes = given || captureRoutes({
    ...app.deps,
    sessionWorkerRegistry: { getWorker: (sid) => (sid === CONV ? { sdkSessionId: CONV, kind } : null), upsertWorker() {} },
    ...extra,
  });
  const registered = await invokeRoute(routes, 'POST', '/api/continuation-turn', {
    body: { conversationId: CONV, sdkSessionId: CONV, operationId: `op-${crypto.randomUUID()}` },
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  const controls = app.db.prepare(`SELECT * FROM relay_control_requests WHERE queue_message_id = ?`).all(registered.body.messageId);
  return { routes, messageId: registered.body.messageId, controls };
}

test('at the cap: a continuation on the key gets the note and a stop at once; the stop\'s result fails the row quietly', async () => {
  const app = await bootAtCap();
  const { routes, messageId, controls } = await continuationAtCap(app);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].type, 'abort_turn');
  assert.equal(controls[0].status, 'pending');
  assert.equal(JSON.parse(controls[0].request).source, 'claude-api-cap');
  // The note is there before any poll.
  const notes = app.db.prepare(`SELECT text FROM messages WHERE conversation_id = ? AND role = 'assistant'`).all(CONV).map((row) => row.text);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /has reached the monthly cap of \$1\.00/);
  assert.match(notes[0], /raise the monthly cap in Settings → Providers → Claude API\. Error code: relay\.claude-api-cap-reached\.$/);
  // The worker's control poller (it starts with the row's id) gets the stop.
  const polled = await invokeRoute(routes, 'GET', '/api/control/active', { query: { sdkSessionId: CONV, queueMessageId: messageId } });
  assert.equal(polled.status, 200, JSON.stringify(polled.body));
  assert.equal(polled.body.control?.id, controls[0].id);
  // The worker interrupted the turn: the row fails, with no second note.
  const result = await invokeRoute(routes, 'POST', '/api/control/:controlId/result', { params: { controlId: controls[0].id }, body: { ok: true } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(app.db.prepare(`SELECT status FROM queue WHERE id = ?`).get(messageId).status, 'failed');
  assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'assistant'`).get(CONV).n, 1);
});

test('a continuation gets no stop below the cap, nor on the subscription worker of a chat now on the key', async () => {
  const below = await bootAtCap({ capUsd: 2 });
  assert.deepEqual((await continuationAtCap(below)).controls, []);
  const subscription = await bootAtCap();
  assert.deepEqual((await continuationAtCap(subscription, { kind: 'claude' })).controls, []);
});

test('a booked report asks whether the cap flipped; one that books nothing does not', async () => {
  const app = boot({ provider: 'claude' });
  const checks = [];
  const routes = captureRoutes({ ...app.deps, checkClaudeApiCap: (reason) => checks.push(reason) });
  const onKey = await invokeRoute(routes, 'POST', '/api/claude-api-usage', { body: usageBody({ billing: 'claude-api' }) });
  assert.equal(onKey.status, 200, JSON.stringify(onKey.body));
  assert.deepEqual(checks, ['usage']);
  // The subscription's report books nothing on the key.
  await invokeRoute(routes, 'POST', '/api/claude-api-usage', { body: usageBody({ billing: 'claude', runId: 'run-2', turnId: 'q-2' }) });
  assert.deepEqual(checks, ['usage']);
});

// The wake loop at the cap: a key worker's background task keeps reporting,
// and each report starts a turn. The first stop also stops the worker's
// background tasks and leaves the note; a turn that still slips in during
// the same episode is stopped quietly; a switch to the subscription goes
// through, and nothing holds it on the relay's side any more.
function keyWorkerWithTasks(app, tasks) {
  const sent = [];
  const routes = captureRoutes({
    ...app.deps,
    sessionWorkerRegistry: { getWorker: (sid) => (sid === CONV ? { sdkSessionId: CONV, kind: 'claude-api' } : null), upsertWorker() {} },
    backgroundTaskStore: { get: (key) => (key === CONV ? tasks : []) },
    sendWorkerControl: (sessionId, control) => { sent.push({ sessionId, ...control }); return true; },
  });
  return { routes, sent };
}

async function stopContinuation(app, routes) {
  const { messageId, controls } = await continuationAtCap(app, { routes });
  assert.equal(controls.length, 1, 'a stop for every continuation on the key at the cap');
  const result = await invokeRoute(routes, 'POST', '/api/control/:controlId/result', { params: { controlId: controls[0].id }, body: { ok: true } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return messageId;
}

const assistantNotes = (app) => app.db.prepare(`SELECT text FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY timestamp, rowid`).all(CONV).map((row) => row.text);

test('the wake loop at the cap: the first stop stops the background tasks and leaves one note; later ones are quiet; the switch goes through', async () => {
  const app = await bootAtCap();
  const tasks = [
    { taskId: 'task-monitor', taskType: 'monitor', description: 'Monitor build log', stoppable: true },
    { taskId: 'task-shell', taskType: 'shell', command: 'npm run watch', stoppable: true },
    { taskId: 'task-fixed', taskType: 'shell', description: 'cannot stop', stoppable: false },
  ];
  const { routes, sent } = keyWorkerWithTasks(app, tasks);
  const first = await stopContinuation(app, routes);
  assert.deepEqual(sent, [
    { sessionId: CONV, type: 'stop_background_task', taskId: 'task-monitor' },
    { sessionId: CONV, type: 'stop_background_task', taskId: 'task-shell' },
  ]);
  assert.equal(app.db.prepare(`SELECT status FROM queue WHERE id = ?`).get(first).status, 'failed');
  let notes = assistantNotes(app);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Claude Code started this turn by itself when a background task reported back\. It is being stopped, but its first request may already be billed, and a short turn can end first\./);
  assert.match(notes[0], /Background tasks stopped: Monitor build log, npm run watch\./);
  assert.match(notes[0], /Still running \(stop them in the task panel\): cannot stop\./);
  assert.match(notes[0], /Error code: relay\.claude-api-cap-reached\.$/);
  assert.doesNotMatch(notes[0], /This turn did not run/);
  // A report that was already on its way starts one more turn: stopped quietly.
  const second = await stopContinuation(app, routes);
  assert.equal(app.db.prepare(`SELECT status FROM queue WHERE id = ?`).get(second).status, 'failed');
  notes = assistantNotes(app);
  assert.equal(notes.length, 1, 'one note per chat per cap episode');
  // The way out the note names: the switch to the subscription is taken.
  const switched = await app.billing({ to: 'claude' });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(app.runtime().provider_type, 'claude');
});

test('a new cap episode gets its note again: after a continuation passes the check, or in a new month or with a new cap', async () => {
  const app = boot({ provider: 'claude-api' });
  const cap = { reached: true, episode: '2026-10:1' };
  const routes = captureRoutes({
    ...app.deps,
    sessionWorkerRegistry: { getWorker: (sid) => (sid === CONV ? { sdkSessionId: CONV, kind: 'claude-api' } : null), upsertWorker() {} },
    getClaudeApiCapState: () => (cap.reached
      ? { reached: true, episode: cap.episode, error: 'This month\'s estimated Claude API spend, $1.20, has reached the monthly cap of $1.00 set in Settings → Providers → Claude API.' }
      : { reached: false }),
  });
  await stopContinuation(app, routes);
  await stopContinuation(app, routes);
  assert.equal(assistantNotes(app).length, 1);
  // The cap raised: a continuation runs, which ends the episode for the chat.
  cap.reached = false;
  assert.deepEqual((await continuationAtCap(app, { routes })).controls, []);
  cap.reached = true;
  await stopContinuation(app, routes);
  assert.equal(assistantNotes(app).length, 2);
  // A new month (or another cap) is another episode, even without a turn between.
  cap.episode = '2026-11:1';
  await stopContinuation(app, routes);
  assert.equal(assistantNotes(app).length, 3);
});

test('a continuation on the key is stopped when Claude API is switched off too, with that refusal\'s code and way out', async () => {
  const app = boot({ provider: 'claude-api' });
  const routes = captureRoutes({
    ...app.deps,
    sessionWorkerRegistry: { getWorker: (sid) => (sid === CONV ? { sdkSessionId: CONV, kind: 'claude-api' } : null), upsertWorker() {} },
    claudeApiClaimCheck: () => ({ code: 'CLAUDE_API_NOT_CONFIGURED', error: 'Claude API is switched off, so this turn did not run.', switchedOff: true }),
  });
  const { controls } = await continuationAtCap(app, { routes });
  assert.equal(controls.length, 1);
  assert.equal(JSON.parse(controls[0].request).code, 'CLAUDE_API_NOT_CONFIGURED');
  await invokeRoute(routes, 'POST', '/api/control/:controlId/result', { params: { controlId: controls[0].id }, body: { ok: true } });
  const [note] = assistantNotes(app);
  assert.match(note, /^Claude API is switched off\. Claude Code started this turn by itself/);
  // Switched off: the way out is to switch it on, not to set it up.
  assert.match(note, /switch Claude API on in Settings → Providers → Claude API\. Error code: relay\.claude-api-not-configured\.$/);
  assert.doesNotMatch(note, /set Claude API up/);
  // A claim check that throws stops it as well (fail closed).
  const broken = boot({ provider: 'claude-api' });
  const brokenRoutes = captureRoutes({
    ...broken.deps,
    sessionWorkerRegistry: { getWorker: (sid) => (sid === CONV ? { sdkSessionId: CONV, kind: 'claude-api' } : null), upsertWorker() {} },
    claudeApiClaimCheck: () => { throw new Error('settings unreadable'); },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(JSON.parse((await continuationAtCap(broken, { routes: brokenRoutes })).controls[0].request).code, 'CLAUDE_API_NOT_CONFIGURED');
  } finally {
    console.warn = originalWarn;
  }
});

test('a turn that ends before the poll still stops the background tasks and gets its note, once', async () => {
  const app = await bootAtCap();
  const { routes, sent } = keyWorkerWithTasks(app, [{ taskId: 'task-monitor', description: 'Monitor build log', stoppable: true }]);
  for (let wake = 0; wake < 2; wake += 1) {
    const { messageId, controls } = await continuationAtCap(app, { routes });
    // The short turn answers before the worker's control poller looks.
    const answered = await invokeRoute(routes, 'POST', '/api/response', {
      body: { messageId, conversationId: CONV, text: `short turn ${wake}`, model: MODEL, mode: 'agent' },
      headers: { 'x-relay-session-id': CONV },
    });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    // The stop came too late: settled with the answer, nothing left to poll.
    const polled = await invokeRoute(routes, 'GET', '/api/control/active', { query: { sdkSessionId: CONV } });
    assert.equal(polled.body.control, null);
    assert.notEqual(app.db.prepare(`SELECT status FROM relay_control_requests WHERE id = ?`).get(controls[0].id).status, 'pending');
  }
  // The tasks were stopped at each registration, without waiting for a poll.
  assert.deepEqual(sent.map((entry) => entry.taskId), ['task-monitor', 'task-monitor']);
  const notes = assistantNotes(app).filter((text) => /Error code: relay\.claude-api-cap-reached\.$/.test(text));
  assert.equal(notes.length, 1);
});

test('off, on, off: the second refusal gets its own note (a claimed turn on the key, or a saved setting, ends the episode)', async () => {
  const { createClaudeApiStopNoteLedger } = await import('../services/plan-usage-claude-api.mjs');
  const app = boot({ provider: 'claude-api' });
  const ledger = createClaudeApiStopNoteLedger();
  const claude = { on: false };
  const routes = captureRoutes({
    ...app.deps,
    claudeApiStopLedger: ledger,
    sessionWorkerRegistry: { getWorker: (sid) => (sid === CONV ? { sdkSessionId: CONV, kind: 'claude-api' } : null), upsertWorker() {} },
    claudeApiClaimCheck: () => (claude.on ? null : { code: 'CLAUDE_API_NOT_CONFIGURED', error: 'Claude API is switched off, so this turn did not run.' }),
  });
  const offNotes = () => assistantNotes(app).filter((text) => /relay\.claude-api-not-configured\.$/.test(text)).length;
  await continuationAtCap(app, { routes });
  await continuationAtCap(app, { routes });
  assert.equal(offNotes(), 1);
  // On again: the user's own turn runs on the key and answers.
  claude.on = true;
  const sent = await invokeRoute(routes, 'POST', '/api/message', { body: { clientId: 'client-1', conversationId: CONV, text: 'normal turn', model: MODEL, relayMode: 'agent' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const answered = await invokeRoute(routes, 'POST', '/api/response', {
    body: { messageId: sent.body.messageId, conversationId: CONV, text: 'done', model: MODEL, mode: 'agent' },
    headers: { 'x-relay-session-id': CONV },
  });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  // Off again, with no continuation between: a new note.
  claude.on = false;
  await continuationAtCap(app, { routes });
  assert.equal(offNotes(), 2);
  // A saved setting (or the cap clearing) ends the episode for every chat.
  await continuationAtCap(app, { routes });
  assert.equal(offNotes(), 2);
  ledger.clearAll();
  await continuationAtCap(app, { routes });
  assert.equal(offNotes(), 3);
});

test('tasks no stop reaches are named: not stoppable, or a worker without a socket', async () => {
  const app = await bootAtCap();
  const routes = captureRoutes({
    ...app.deps,
    sessionWorkerRegistry: { getWorker: (sid) => (sid === CONV ? { sdkSessionId: CONV, kind: 'claude-api' } : null), upsertWorker() {} },
    backgroundTaskStore: { get: (key) => (key === CONV ? [
      { taskId: 'task-a', description: 'Monitor deploy', stoppable: true },
      { taskId: 'task-b', command: 'tail -f build.log', stoppable: false },
    ] : []) },
    sendWorkerControl: () => false,
  });
  await continuationAtCap(app, { routes });
  const [note] = assistantNotes(app);
  assert.doesNotMatch(note, /Background tasks stopped/);
  assert.match(note, /Still running \(stop them in the task panel\): Monitor deploy, tail -f build\.log\./);
});

// The note stays a failure note however many tasks it names: its lead (the
// text before "Error code:") is within FAILURE_NOTE_LEAD_MAX, so the
// transcript's buttons and the failure-note readers find its code.
test('the stop note keeps its lead within the failure-note limit: 5 stopped and 5 unreached tasks with long labels', async () => {
  const { buildClaudeApiStopNoteText } = await import('./messages-routes.mjs');
  const { FAILURE_NOTE_LEAD_MAX, matchFailureNote, isFailureNoteText } = await import('../../shared/failure-note-text.mjs');
  const { relayErrorCodeFromText } = await import('../public/app/relay-error-ctas.mjs');
  const long = (prefix, index) => ({ label: `${prefix} ${index} ${'watch the deploy log and report each new line '.repeat(2)}`.slice(0, 80) });
  const many = { stopped: [0, 1, 2, 3, 4].map((i) => long('stopped', i)), unreached: [0, 1, 2, 3, 4].map((i) => long('unreached', i)) };
  const one = { stopped: [{ label: 'Monitor build log' }], unreached: [] };
  const refusals = [
    { code: 'CLAUDE_API_CAP_REACHED', error: 'This month\'s estimated Claude API spend, $123,456.78, has reached the monthly cap of $100,000.00 set in Settings → Providers → Claude API. This turn did not run.', stable: 'relay.claude-api-cap-reached' },
    { code: 'CLAUDE_API_NOT_CONFIGURED', error: 'Claude API is switched off, so this turn did not run.', switchedOff: true, stable: 'relay.claude-api-not-configured' },
    { code: 'CLAUDE_API_NOT_CONFIGURED', error: 'The relay could not check Claude API (key, switch, cap), so this turn did not run.', stable: 'relay.claude-api-not-configured' },
  ];
  for (const refusal of refusals) {
    for (const tasks of [one, many, { stopped: [], unreached: many.unreached }, { stopped: [], unreached: [] }]) {
      const note = buildClaudeApiStopNoteText({ refusal, tasks });
      const matched = matchFailureNote(note);
      assert.ok(matched, note);
      assert.ok(matched.lead.length <= FAILURE_NOTE_LEAD_MAX, `${matched.lead.length}: ${note}`);
      assert.equal(matched.stableCode, refusal.stable);
      assert.equal(isFailureNoteText(note), true);
      assert.equal(relayErrorCodeFromText(note), refusal.stable.replace(/^relay\./, ''));
      assert.match(note, /It is being stopped, but its first request may already be billed, and a short turn can end first\./);
      assert.doesNotMatch(note, /did not run/);
    }
  }
  // At most two labels per list, cut to 40 characters; then only the counts.
  const capMany = buildClaudeApiStopNoteText({ refusal: refusals[0], tasks: many });
  assert.match(capMany, /Background tasks stopped: .+ and 4 more\. Still running \(stop them in the task panel\): .+ and 4 more\./);
  const longReason = { ...refusals[0], error: `${refusals[0].error.replace(/ This turn did not run\.$/, '')} ${'The cap was set to keep the month in budget. '.repeat(2)}This turn did not run.` };
  const countsOnly = buildClaudeApiStopNoteText({ refusal: longReason, tasks: many });
  assert.match(countsOnly, /5 background tasks stopped\. 5 more still running \(stop them in the task panel\)\./);
  assert.ok(matchFailureNote(countsOnly).lead.length <= FAILURE_NOTE_LEAD_MAX);
  const offMany = buildClaudeApiStopNoteText({ refusal: refusals[1], tasks: many });
  // The shorter note fits two labels per list here.
  const stoppedLabel = /Background tasks stopped: (.+?), .+? and 3 more\./.exec(offMany)?.[1] || '';
  const unreachedLabel = /stop them in the task panel\): (.+?), .+? and 3 more\./.exec(offMany)?.[1] || '';
  for (const label of [stoppedLabel, unreachedLabel]) {
    assert.ok(label.endsWith('…') && label.length === 40, `${label.length}: ${label}`);
  }
  assert.ok(stoppedLabel.startsWith('stopped 0 ') && unreachedLabel.startsWith('unreached 0 '));
  assert.match(buildClaudeApiStopNoteText({ refusal: refusals[1], tasks: { stopped: [], unreached: [{ label: 'x' }, { label: 'y' }, { label: 'z' }] } }), /Still running \(stop them in the task panel\): x, y and 1 more\./);
});

test('the way out a Claude API note names follows the refusal: the cap, switched off, or no key', async () => {
  const { claudeApiRemedyText } = await import('./messages-routes.mjs');
  assert.equal(claudeApiRemedyText({ code: 'CLAUDE_API_CAP_REACHED' }), 'Switch this chat to the subscription, or raise the monthly cap in Settings → Providers → Claude API');
  assert.equal(claudeApiRemedyText({ code: 'CLAUDE_API_NOT_CONFIGURED', switchedOff: true }), 'Switch this chat to the subscription, or switch Claude API on in Settings → Providers → Claude API');
  assert.equal(claudeApiRemedyText({ code: 'CLAUDE_API_NOT_CONFIGURED' }), 'Switch this chat to the subscription, or set Claude API up in Settings → Providers → Claude API');
});

test('a plan-only chat: an agent\'s billing switch with a message that names another mode is refused before the switch', async () => {
  const app = boot({ provider: 'claude' });
  app.db.prepare(`UPDATE conversations SET plan_only = 1, preferred_relay_mode = 'plan' WHERE id = ?`).run(CONV);
  const refused = await app.post('/api/conversation/:id/billing', {
    to: 'claude-api', by: 'agent', message: { clientId: 'agent-1', text: 'implement on the key', model: MODEL, relayMode: 'agent' },
  }, { params: { id: CONV }, headers: AGENT_HEADERS });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'plan_only');
  assert.equal(app.runtime().provider_type, 'claude', 'the billing is as it was');
  assert.deepEqual(app.queueRows(), []);
  // A message that stays in plan switches and queues as before.
  const planned = await app.post('/api/conversation/:id/billing', {
    to: 'claude-api', by: 'agent', message: { clientId: 'agent-1', text: 'plan on the key', model: MODEL },
  }, { params: { id: CONV }, headers: AGENT_HEADERS });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.equal(app.runtime().provider_type, 'claude-api');
  assert.deepEqual(app.queueRows().map((row) => row.provider), ['claude-api']);
});