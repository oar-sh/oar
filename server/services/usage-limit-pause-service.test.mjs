import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createUsageLimitPauseService } from './usage-limit-pause-service.mjs';

// Which conversations a refusal at the Claude usage limit pauses: the ones
// bound to Claude Code, locally or in the cloud. The rest of the service is
// covered by claude-usage-limit.routes-integration.test.mjs.

const NOW = Date.parse('2026-10-02T10:00:00.000Z');

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  return createUsageLimitPauseService({ db, stmts, now: () => NOW, logger: { log() {}, warn() {} } });
}

const refusal = {
  kind: 'claude-usage-limit',
  code: 'claude-usage-limit',
  rateLimitType: 'five_hour',
  resetsAt: '2026-10-02T11:00:00.000Z',
  message: "You've hit your session limit",
};

test('a refusal pauses Claude and Claude Cloud conversations, nothing else', () => {
  const service = setup();
  for (const providerType of ['claude', 'claude-cloud', 'Claude-Cloud ']) {
    const plan = service.planPause({ terminalError: refusal, conversationId: 'conv-1', providerType });
    assert.ok(plan, providerType);
    assert.equal(plan.rateLimitType, 'five_hour');
    assert.equal(plan.auto, true);
    assert.match(plan.noteText, /^⏸ Paused: the Claude 5-hour limit is reached\./);
  }
  for (const providerType of ['cursor', 'github', 'grok', 'openai', '', null]) {
    assert.equal(service.planPause({ terminalError: refusal, conversationId: 'conv-1', providerType }), null, String(providerType));
  }
  assert.equal(service.planPause({ terminalError: { kind: 'other' }, conversationId: 'conv-1', providerType: 'claude-cloud' }), null);
});

// A chat moved to the API key: a turn on the key is never held for the
// subscription's usage limit.
function setupChat({ provider = 'claude' } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const at = new Date(NOW).toISOString();
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'Chat', ?, ?)`).run(at, at);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, provider_model, created_at, last_used_at)
    VALUES ('rs-1', 'conv-1', 'sid-1', 'rs-1', 'claude-sonnet-5-5', ?, 'claude-sonnet-5-5', ?, ?)
  `).run(provider, at, at);
  db.prepare(`
    INSERT INTO queue (id, conversation_id, runtime_session_id, model, text, status, timestamp, provider)
    VALUES ('q-refused', 'conv-1', 'rs-1', 'claude-sonnet-5-5', 'build it', 'processing', ?, 'claude')
  `).run(at);
  const emitted = [];
  const queueChanges = [];
  const service = createUsageLimitPauseService({
    db,
    stmts,
    emit: (event, payload) => emitted.push({ event, payload }),
    onQueueChanged: (reason) => queueChanges.push(reason),
    now: () => NOW,
    logger: { log() {}, warn() {} },
  });
  const queueRow = () => db.prepare(`SELECT * FROM queue WHERE id = 'q-refused'`).get();
  const followUps = () => db.prepare(`SELECT * FROM queue WHERE id != 'q-refused'`).all();
  return { db, service, emitted, queueChanges, queueRow, followUps };
}

test('a subscription turn refused after the chat moved to the key: its follow-up runs on the key at once', () => {
  const app = setupChat({ provider: 'claude-api' });
  const plan = app.service.planPause({
    terminalError: refusal,
    conversationId: 'conv-1',
    providerType: 'claude',
    chatProviderType: 'claude-api',
    queueRow: app.queueRow(),
  });
  assert.equal(plan.onApiKey, true);
  assert.match(plan.noteText, /Stopped at the Claude 5-hour limit\. This chat now runs on the Claude API key/);
  const scheduled = app.service.schedulePause(plan, { queueRow: app.queueRow() });
  assert.equal(scheduled.created, true);
  assert.equal(scheduled.state, null);
  const [followUp] = app.followUps();
  assert.equal(followUp.status, 'pending');
  assert.equal(followUp.next_attempt_at, null);
  assert.equal(followUp.provider, 'claude-api');
  assert.equal(JSON.parse(followUp.usage_limit_pause).onApiKey, true);
  assert.equal(app.service.getPause('conv-1'), null);
  assert.deepEqual(app.queueChanges, ['usage-limit-on-api-key']);
});

test('a turn on the key is never paused', () => {
  const app = setupChat({ provider: 'claude-api' });
  assert.equal(app.service.planPause({ terminalError: refusal, conversationId: 'conv-1', providerType: 'claude-api', chatProviderType: 'claude-api' }), null);
});

test('a switch to the key releases the held turn; the clients hear it after the commit', () => {
  const app = setupChat();
  const plan = app.service.planPause({ terminalError: refusal, conversationId: 'conv-1', providerType: 'claude', chatProviderType: 'claude', queueRow: app.queueRow() });
  assert.equal(plan.onApiKey, undefined);
  app.service.schedulePause(plan, { queueRow: app.queueRow() });
  assert.ok(app.service.getPause('conv-1'));
  app.emitted.length = 0;
  const released = app.service.releaseForBillingSwitch({ conversationId: 'conv-1' });
  assert.ok(released.messageId);
  // Nothing said yet: the switch's transaction has not committed.
  assert.deepEqual(app.emitted, []);
  assert.equal(app.service.getPause('conv-1'), null);
  const [followUp] = app.followUps();
  assert.equal(followUp.next_attempt_at, null);
  assert.equal(JSON.parse(followUp.usage_limit_pause).resumedBy, 'billing-switch');
  released.announce();
  assert.deepEqual(app.emitted.map((entry) => entry.event), ['usage_limit_pause', 'message_status']);
  assert.ok(app.queueChanges.includes('usage-limit-billing-switch'));
  // Nothing held any more: nothing to release.
  assert.equal(app.service.releaseForBillingSwitch({ conversationId: 'conv-1' }), null);
});
