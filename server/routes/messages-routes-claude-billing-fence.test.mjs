import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  buildDequeuedRelayMessage,
  claudeBillingFence,
  dequeuePendingMessage,
  dequeuePendingMessageForWorkerLoop,
  resolveExecutedProviderForResponse,
} from './messages-routes.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';

// The delivery fence of the Claude billing switch: a Claude chat's row is
// claimed only by a worker of the row's billing, against the REAL schema and
// claim statements.

const CONV = 'conv-fence-1';
const SID = 'sid-fence-1';
const NOW = '2026-10-25T12:00:00.000Z';

function boot({ provider = 'claude', switchedAt = null } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES (?, 'Fence', ?, ?, ?)`).run(CONV, SID, NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, provider_model, created_at, last_used_at, billing_switched_at)
    VALUES ('rs-1', ?, ?, 'rs-1', 'claude-sonnet-5-5', ?, 'claude-sonnet-5-5', ?, ?, ?)
  `).run(CONV, SID, provider, NOW, NOW, switchedAt);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const enqueue = (id) => db.prepare(`
    INSERT INTO queue (id, conversation_id, runtime_session_id, text, status, timestamp, owner_sdk_session_id)
    VALUES (?, ?, 'rs-1', 'hello', 'pending', ?, ?)
  `).run(id, CONV, NOW, SID);
  const switchTo = (billing) => {
    db.prepare(`UPDATE runtime_sessions SET provider_type = ?, billing_switched_at = ? WHERE id = 'rs-1'`).run(billing, NOW);
    db.prepare(`UPDATE queue SET provider = ? WHERE conversation_id = ? AND status IN ('pending', 'parked')`).run(billing, CONV);
  };
  const row = (id) => db.prepare(`SELECT * FROM queue WHERE id = ?`).get(id);
  const claim = (workerKind, extra = {}) => {
    const fences = [];
    const message = dequeuePendingMessage({
      db,
      stmts,
      nowIso: NOW,
      routingEnabled: true,
      requesterSessionId: SID,
      workerKind,
      onBillingFence: (fence) => fences.push(fence),
      ...extra,
    });
    return { message, fences };
  };
  return { db, stmts, enqueue, switchTo, row, claim };
}

test('a worker of the row\'s billing claims it', () => {
  const app = boot();
  app.enqueue('q-1');
  assert.equal(app.row('q-1').provider, 'claude');
  const { message, fences } = app.claim('claude');
  assert.equal(message?.id, 'q-1');
  assert.deepEqual(fences, []);
});

test('after a switch, the old kind is refused the row, which stays pending; the new kind takes it', () => {
  const app = boot();
  app.enqueue('q-1');
  app.switchTo('claude-api');
  const refused = app.claim('claude');
  assert.equal(refused.message, null);
  assert.equal(app.row('q-1').status, 'pending');
  assert.equal(app.row('q-1').attempt_id, null);
  assert.deepEqual(refused.fences, [{
    conversationId: CONV,
    messageId: 'q-1',
    rowBilling: 'claude-api',
    workerKind: 'claude',
    reason: 'kind-mismatch',
    requesterSessionId: SID,
  }]);
  const taken = app.claim('claude-api');
  assert.equal(taken.message?.id, 'q-1');
  assert.equal(app.row('q-1').status, 'processing');
});

test('and the other way round', () => {
  const app = boot({ provider: 'claude-api' });
  app.enqueue('q-1');
  app.switchTo('claude');
  assert.equal(app.claim('claude-api').message, null);
  assert.equal(app.claim('claude').message?.id, 'q-1');
});

test('a worker that states no kind: trusted on a chat never switched, refused on one that has', () => {
  const quiet = boot();
  quiet.enqueue('q-1');
  assert.equal(quiet.claim(null).message?.id, 'q-1');

  const switched = boot({ provider: 'claude-api', switchedAt: NOW });
  switched.enqueue('q-1');
  const { message, fences } = switched.claim(null);
  assert.equal(message, null);
  assert.equal(fences[0].reason, 'kind-unknown');
});

test('a row without a stamp (from before the column) takes its chat\'s billing', () => {
  const app = boot();
  app.enqueue('q-1');
  app.db.prepare(`UPDATE queue SET provider = NULL WHERE id = 'q-1'`).run();
  app.db.prepare(`UPDATE runtime_sessions SET provider_type = 'claude-api' WHERE id = 'rs-1'`).run();
  assert.equal(app.claim('claude').message, null);
  assert.equal(app.claim('claude-api').message?.id, 'q-1');
});

test('a Claude API row is fenced, whatever the worker, while the claim check refuses it', () => {
  const app = boot({ provider: 'claude-api' });
  app.enqueue('q-1');
  const refusal = { code: 'CLAUDE_API_NOT_CONFIGURED', error: 'Claude API is switched off.' };
  const { message, fences } = app.claim('claude-api', { claudeApiClaimCheck: () => refusal });
  assert.equal(message, null);
  assert.equal(fences[0].reason, 'claude-api-unavailable');
  assert.deepEqual(fences[0].refusal, refusal);
  // A subscription row is not the check's business.
  const sub = boot();
  sub.enqueue('q-2');
  assert.equal(sub.claim('claude', { claudeApiClaimCheck: () => refusal }).message?.id, 'q-2');
});

test('rows of other providers are never fenced', () => {
  for (const provider of ['deepseek', 'github', 'cursor']) {
    const app = boot({ provider });
    app.enqueue('q-1');
    assert.equal(claudeBillingFence({ stmts: app.stmts, row: app.row('q-1'), workerKind: 'claude' }), null, provider);
  }
});

test('the worker loop says billing-swap when the fence held the row back', async () => {
  const app = boot();
  app.enqueue('q-1');
  app.switchTo('claude-api');
  const fences = [];
  const result = await dequeuePendingMessageForWorkerLoop({
    db: app.db,
    stmts: app.stmts,
    nowIso: NOW,
    routingEnabled: true,
    requesterSessionId: SID,
    workerKind: 'claude',
    onBillingFence: (fence) => fences.push(fence),
  });
  assert.equal(result.message, null);
  assert.equal(result.blockedReason, 'billing-swap');
  assert.equal(fences.length, 1);
});

test('the delivered message names the row\'s billing', () => {
  const app = boot();
  app.enqueue('q-1');
  app.switchTo('claude-api');
  const out = buildDequeuedRelayMessage({
    msg: app.row('q-1'),
    stmts: app.stmts,
    ensureRuntimeSessionBinding: () => null,
    normalizeRelayMode: (value) => value || 'agent',
    defaultRelayMode: 'agent',
    defaultModel: 'claude-sonnet-5-5',
  });
  assert.equal(out.billing, 'claude-api');
  assert.equal(out.providerType, 'claude-api');
});

test('a requeued row takes the chat\'s billing of that moment', () => {
  const app = boot();
  app.enqueue('q-1');
  assert.equal(app.claim('claude').message?.id, 'q-1');
  // Switched while it ran; the turn is then handed back.
  app.switchTo('claude-api');
  assert.equal(app.row('q-1').provider, 'claude');
  app.db.prepare(`UPDATE queue SET status = 'pending', attempt_id = NULL WHERE id = 'q-1'`).run();
  assert.equal(app.row('q-1').provider, 'claude-api');
});

test('what a response ran on: the responding worker\'s kind, not the chat\'s billing of now', () => {
  const app = boot({ provider: 'claude-api' });
  const identity = { sessionId: SID };
  assert.equal(resolveExecutedProviderForResponse({ stmts: app.stmts, responseBridgeIdentity: identity, conversationProvider: 'claude-api', responderKind: 'claude' }), 'claude');
  // Without a kind: today's rule, the runtime row.
  assert.equal(resolveExecutedProviderForResponse({ stmts: app.stmts, responseBridgeIdentity: identity, conversationProvider: 'claude-api' }), 'claude-api');
  // A kind that is no Claude billing changes nothing.
  assert.equal(resolveExecutedProviderForResponse({ stmts: app.stmts, responseBridgeIdentity: identity, conversationProvider: 'claude-api', responderKind: 'deepseek' }), 'claude-api');
});

test('a worker that states a non-Claude kind never claims a Claude chat\'s row', () => {
  const app = boot();
  app.enqueue('q-1');
  assert.equal(app.claim('http-poller').message, null);
  assert.equal(app.row('q-1').status, 'pending');
});

// GET /api/pending as tests/usage-limit-pause-routes.spec.mjs drives it: a
// chat queued as a Copilot one (its row unstamped), then made a Claude chat,
// dequeued by a poller that names its session but states no kind.
async function pendingAs(app, sessionId, { routing = true, claudeApiClaimCheck = null, onClaudeBillingFence = null, registry = null } = {}) {
  const { makeRouteDeps, captureRoutes, invokeRoute } = await import('./messages-routes-test-harness.mjs');
  const deps = makeRouteDeps({
    db: app.db,
    stmts: app.stmts,
    io: { emit() {}, volatile: { emit() {} } },
    featureFlags: { SESSION_WORKER_ROUTING_ENABLED: routing },
    queueCounts: () => ({ pendingCount: 1, processingCount: 0, parkedCount: 0 }),
    parseAttachments: () => [],
    hydrateAttachment: (value) => value,
    ensureRuntimeSessionBinding: (conversationId) => app.stmts.getRuntimeSessionByConversation.get(conversationId) || null,
    configuredConversationSessionMode: 'isolated',
    DEFAULT_RELAY_MODE: 'agent',
    relayBridgeOwnerService: {
      normalizeIdentity: ({ sessionId: sid } = {}) => (String(sid || '').trim() ? { sessionId: String(sid).trim() } : null),
      observe: () => ({ accepted: true }),
    },
    sessionWorkerRegistry: registry || { getWorker: () => null, upsertWorker() {} },
    claudeApiClaimCheck,
    onClaudeBillingFence,
    runtimeState: { featureFlags: {}, relayPaused: false },
    ts: () => NOW,
    uuidv4: () => 'uuid-1',
    addMsIso: (ms) => new Date(Date.now() + Math.max(0, Number(ms) || 0)).toISOString(),
    computeRetryDelayMs: () => 0,
    normalizeRelayMode: (value) => String(value || '').trim().toLowerCase() || 'agent',
    getCursorProviderSettings: () => ({ enabledModels: [] }),
    getClaudeCloudProviderSettings: () => null,
    emitSessionWorkerTelemetry: () => {},
  });
  const routes = captureRoutes(deps);
  return invokeRoute(routes, 'GET', '/api/pending', { headers: { 'x-relay-session-id': sessionId } });
}

test('GET /api/pending hands a Claude chat\'s row to a poller of unknown kind while the chat never switched (the usage-limit spec\'s worker)', async () => {
  for (const routing of [true, false]) {
    const app = boot({ provider: 'github' });
    app.enqueue('q-seed');
    assert.equal(app.row('q-seed').provider, null, 'queued while the chat was a Copilot one');
    app.db.prepare(`UPDATE runtime_sessions SET provider_type = 'claude' WHERE id = 'rs-1'`).run();
    const fences = [];
    const { status, body } = await pendingAs(app, SID, { routing, onClaudeBillingFence: (fence) => fences.push(fence) });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.message?.id, 'q-seed', `routing ${routing}: ${JSON.stringify(body)}`);
    assert.deepEqual(fences, []);
  }
});

test('GET /api/pending: a switched chat is fenced (kind unknown) and asks for the swap; a stated kind is taken at its word', async () => {
  const app = boot({ provider: 'claude' });
  app.enqueue('q-1');
  app.switchTo('claude-api');
  const fences = [];
  const unknown = await pendingAs(app, SID, { onClaudeBillingFence: (fence) => fences.push(fence) });
  assert.equal(unknown.body.message ?? null, null);
  assert.equal(fences.length, 1);
  assert.equal(fences[0].reason, 'kind-unknown');
  const stated = await pendingAs(app, SID, { registry: { getWorker: () => ({ sdkSessionId: SID, kind: 'claude-api' }), upsertWorker() {} } });
  assert.equal(stated.body.message?.id, 'q-1');
});

test('GET /api/pending: a Claude API row the claim check refuses is fenced for its fail-closed path', async () => {
  const app = boot({ provider: 'claude-api' });
  app.enqueue('q-1');
  const fences = [];
  const refusal = { code: 'CLAUDE_API_NOT_CONFIGURED', error: 'Claude API is switched off.' };
  const { body } = await pendingAs(app, SID, {
    registry: { getWorker: () => ({ sdkSessionId: SID, kind: 'claude-api' }), upsertWorker() {} },
    claudeApiClaimCheck: () => refusal,
    onClaudeBillingFence: (fence) => fences.push(fence),
  });
  assert.equal(body.message ?? null, null);
  assert.equal(fences[0].reason, 'claude-api-unavailable');
  assert.deepEqual(fences[0].refusal, refusal);
});

test('a claim check that throws fails a Claude API row closed, and never touches a subscription row', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    const app = boot({ provider: 'claude-api' });
    app.enqueue('q-1');
    const broken = () => { throw new Error('settings unreadable'); };
    const { message, fences } = app.claim('claude-api', { claudeApiClaimCheck: broken });
    assert.equal(message, null);
    assert.equal(fences[0].reason, 'claude-api-unavailable');
    assert.equal(fences[0].refusal.code, 'CLAUDE_API_NOT_CONFIGURED');
    assert.match(fences[0].refusal.error, /could not check Claude API/);
    assert.ok(warnings.some((line) => /claim check failed/.test(line)));
    const sub = boot();
    sub.enqueue('q-2');
    assert.equal(sub.claim('claude', { claudeApiClaimCheck: broken }).message?.id, 'q-2');
  } finally {
    console.warn = originalWarn;
  }
});

test('a page\'s row on the key is not claimed while this month\'s cap is reached, and is once the cap is raised', async () => {
  const { createClaudeApiUsageService, normalizeClaudeApiUsageReport } = await import('../services/claude-api-usage-service.mjs');
  const { createClaudeApiPlanUsage } = await import('../services/plan-usage-claude-api.mjs');
  const app = boot({ provider: 'claude-api' });
  const usage = createClaudeApiUsageService({ db: app.db, timeZone: 'UTC', logger: { log() {}, warn() {} } });
  const settings = { configured: true, enabled: true, monthlyCapUsd: 1 };
  const cap = createClaudeApiPlanUsage({ usageService: usage, getSettings: () => settings });
  const counts = [{ model: 'claude-sonnet-5-5', hitTokens: 0, missTokens: 100, outputTokens: 10, costUsd: 1.2 }];
  usage.recordReport({
    conversationId: CONV,
    billing: 'claude-api',
    report: normalizeClaudeApiUsageReport({
      claudeNativeSessionId: SID, runId: 'run-1', at: new Date().toISOString(), firstResultOfRun: true, runCounts: counts, sessionTotals: counts,
    }).report,
  });
  // The runtime's claim check, its cap part (server-runtime.mjs claudeApiClaimCheck).
  const claudeApiClaimCheck = () => {
    const state = cap.getCapState();
    return state.reached ? { code: 'CLAUDE_API_CAP_REACHED', error: `${state.error} This turn did not run.` } : null;
  };
  app.enqueue('q-1');
  const refused = app.claim('claude-api', { claudeApiClaimCheck });
  assert.equal(refused.message, null);
  assert.equal(refused.fences[0].reason, 'claude-api-unavailable');
  assert.equal(refused.fences[0].refusal.code, 'CLAUDE_API_CAP_REACHED');
  assert.match(refused.fences[0].refusal.error, /\$1\.20, has reached the monthly cap of \$1\.00/);
  settings.monthlyCapUsd = 2;
  assert.equal(app.claim('claude-api', { claudeApiClaimCheck }).message?.id, 'q-1');
});
