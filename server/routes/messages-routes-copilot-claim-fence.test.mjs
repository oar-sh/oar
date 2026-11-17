import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import {
  copilotSwitchFence,
  dequeuePendingMessage,
  registerMessagesWorkerClaimRoutes,
} from './messages-worker-claim-routes.mjs';
import { captureRoutes, invokeRoute } from './messages-routes-test-harness.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { relayErrorCtaActions } from '../public/app/relay-error-ctas.mjs';

// The claim fence of the Copilot switch: while Copilot is off, a Copilot
// chat's row is failed at the claim with its note, against the REAL schema
// and claim statements. It never reaches the Claude billing fence's handler.

const CONV = 'conv-copilot-1';
const SID = 'sid-copilot-1';
const NOW = '2026-11-16T22:00:00.000Z';

function boot({ provider = 'github', copilotEnabled = 'false' } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES (?, 'Copilot chat', ?, ?, ?)`).run(CONV, SID, NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, created_at, last_used_at)
    VALUES ('rs-1', ?, ?, 'rs-1', 'gpt-5.4-mini', ?, ?, ?)
  `).run(CONV, SID, provider, NOW, NOW);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  if (copilotEnabled !== null) stmts.upsertAppSetting.run('copilot_enabled', copilotEnabled, NOW);
  db.prepare(`
    INSERT INTO queue (id, conversation_id, runtime_session_id, text, status, timestamp, owner_sdk_session_id)
    VALUES ('q-1', ?, 'rs-1', 'hello', 'pending', ?, ?)
  `).run(CONV, NOW, SID);
  const row = (id) => db.prepare(`SELECT * FROM queue WHERE id = ?`).get(id);
  return { db, stmts, row };
}

const refuse = () => ({ code: 'COPILOT_SWITCHED_OFF', error: 'Copilot is switched off on this relay, so this turn did not run.' });

test('copilotSwitchFence: a Copilot row (github or no provider) is fenced while the check refuses', () => {
  for (const provider of ['github', null]) {
    const app = boot();
    app.db.prepare(`UPDATE runtime_sessions SET provider_type = COALESCE(?, provider_type)`).run(provider);
    const stmts = provider === null
      ? { getRuntimeSessionByConversation: { get: () => ({ provider_type: null }) } }
      : app.stmts;
    assert.deepEqual(copilotSwitchFence({ stmts, row: app.row('q-1'), copilotClaimCheck: refuse }), {
      conversationId: CONV,
      messageId: 'q-1',
      reason: 'copilot-switched-off',
      refusal: refuse(),
    }, String(provider));
  }
});

test('copilotSwitchFence: OpenAI and Claude rows, no check, a passing check or a throwing one let the row run', () => {
  for (const provider of ['openai', 'claude', 'claude-api']) {
    const app = boot({ provider });
    assert.equal(copilotSwitchFence({ stmts: app.stmts, row: app.row('q-1'), copilotClaimCheck: refuse }), null, provider);
  }
  const app = boot();
  assert.equal(copilotSwitchFence({ stmts: app.stmts, row: app.row('q-1') }), null);
  assert.equal(copilotSwitchFence({ stmts: app.stmts, row: app.row('q-1'), copilotClaimCheck: () => null }), null);
  assert.equal(copilotSwitchFence({ stmts: app.stmts, row: app.row('q-1'), copilotClaimCheck: () => { throw new Error('locked'); } }), null);
});

test('dequeuePendingMessage: a fenced Copilot row goes to onCopilotFence only, never to the billing fence', () => {
  const app = boot();
  const billing = [];
  const copilot = [];
  const message = dequeuePendingMessage({
    db: app.db,
    stmts: app.stmts,
    nowIso: NOW,
    requesterSessionId: SID,
    onBillingFence: (fence) => billing.push(fence),
    copilotClaimCheck: refuse,
    onCopilotFence: (fence) => copilot.push(fence),
  });
  assert.equal(message, null);
  assert.equal(app.row('q-1').status, 'pending', 'the claim itself fails nothing');
  assert.deepEqual(billing, [], 'no billing swap is asked for');
  assert.deepEqual(copilot, [{ conversationId: CONV, messageId: 'q-1', reason: 'copilot-switched-off', refusal: refuse(), requesterSessionId: SID }]);
});

test('dequeuePendingMessage without a Copilot check claims the row as before', () => {
  const app = boot();
  assert.equal(dequeuePendingMessage({ db: app.db, stmts: app.stmts, nowIso: NOW, requesterSessionId: SID })?.id, 'q-1');
});

function pendingRoutes(app, { onClaudeBillingFence }) {
  const events = [];
  const deps = {
    auth: (_req, _res, next) => next(),
    io: { emit: (event, payload) => events.push({ event, payload }) },
    db: app.db,
    stmts: app.stmts,
    touchCli: () => {},
    ts: () => '00:00:00.000',
    uuidv4: () => crypto.randomUUID(),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    runtimeState: {},
    DEFAULT_MODEL: 'gpt-5.4-mini',
    DEFAULT_RELAY_MODE: 'agent',
    normalizeRelayMode: (value) => String(value || '').trim().toLowerCase() || null,
    sessionWorkerRegistry: null,
    sessionWorkerSupervisor: null,
  };
  const shared = {
    claudeApiClaimCheck: null,
    onClaudeBillingFence,
    workersStateTheirKind: () => false,
    workerReplacementFence: null,
    readBridgeIdentity: () => ({ sessionId: SID }),
    emitSessionWorkerTelemetry: () => {},
    staleAttemptLog: { note() {} },
  };
  const routes = captureRoutes(deps, (expressApp, routeDeps) => registerMessagesWorkerClaimRoutes(expressApp, routeDeps, shared));
  return { routes, events };
}

test('GET /api/pending with Copilot off: the row fails with its note and button; the billing fence is never called', async () => {
  const app = boot();
  const billing = [];
  const { routes, events } = pendingRoutes(app, { onClaudeBillingFence: (fence) => billing.push(fence) });
  const { status, body } = await invokeRoute(routes, 'GET', '/api/pending');
  assert.equal(status, 200);
  assert.equal(body.message, null);
  assert.deepEqual(billing, []);
  const failed = app.row('q-1');
  assert.equal(failed.status, 'failed');
  assert.equal(JSON.parse(failed.response).code, 'COPILOT_SWITCHED_OFF');
  const note = app.db.prepare(`SELECT text FROM messages WHERE conversation_id = ? AND role = 'assistant'`).get(CONV).text;
  assert.equal(note, 'Copilot is switched off on this relay, so this turn did not run. Switch it on in Settings → Providers → Copilot, then send the message again. Error code: relay.copilot-switched-off.');
  assert.deepEqual(relayErrorCtaActions(note), [{ action: 'open-copilot-settings', label: 'Copilot settings' }]);
  assert.ok(events.some((entry) => entry.event === 'message_status' && entry.payload.status === 'failed'));
});

test('GET /api/pending with Copilot on or unset, or on an OpenAI chat: the row is claimed', async () => {
  for (const [provider, copilotEnabled] of [['github', 'true'], ['github', null], ['openai', 'false']]) {
    const app = boot({ provider, copilotEnabled });
    const { routes } = pendingRoutes(app, { onClaudeBillingFence: () => {} });
    const { body } = await invokeRoute(routes, 'GET', '/api/pending');
    assert.equal(body.message?.id, 'q-1', `${provider} ${copilotEnabled}`);
    assert.equal(app.row('q-1').status, 'processing');
  }
});
