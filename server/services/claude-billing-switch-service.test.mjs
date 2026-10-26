import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import {
  CLAUDE_BILLING_NOTE_KIND,
  createClaudeBillingSwitchService,
  normalizeClaudeBilling,
} from './claude-billing-switch-service.mjs';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const at = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

function setup({
  provider = 'claude',
  model = 'claude-sonnet-5-5',
  claude = {},
  claudeApi = {},
  cap = { reached: false },
  historyRule = undefined,
  releaseUsageLimitPause = null,
} = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'Chat', ?, ?)`).run(at(), at());
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, provider_model, created_at, last_used_at)
    VALUES ('rs-1', 'conv-1', 'sid-1', 'rs-1', ?, ?, ?, ?, ?)
  `).run(model, provider, model, at(), at());
  const events = [];
  const queueChanges = [];
  const service = createClaudeBillingSwitchService({
    db,
    stmts,
    emit: (name, payload) => events.push({ name, payload }),
    getClaudeProviderSettings: () => ({ enabled: true, model: 'claude-sonnet-5-5', availableModels: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]'], ...claude }),
    getClaudeApiProviderSettings: () => ({ enabled: true, configured: true, model: 'claude-sonnet-5-5', availableModels: ['claude-sonnet-5-5', 'claude-opus-5-5'], ...claudeApi }),
    getClaudeApiCapState: () => cap,
    ...(historyRule ? { historyRule } : {}),
    releaseUsageLimitPause,
    onQueueChanged: (reason) => queueChanges.push(reason),
    now: () => NOW,
    logger: { log() {}, warn() {} },
  });
  const queue = (id, status, provider = null) => db.prepare(`
    INSERT INTO queue (id, conversation_id, runtime_session_id, text, status, timestamp, provider)
    VALUES (?, 'conv-1', 'rs-1', 'hello', ?, ?, ?)
  `).run(id, status, at(), provider);
  const message = (id, role, { kind = null, executedProvider = null, offsetMs = 0 } = {}) => {
    db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, 'conv-1', ?, 'x', ?)`).run(id, role, at(offsetMs));
    if (kind) db.prepare(`UPDATE messages SET kind = ? WHERE id = ?`).run(kind, id);
    if (executedProvider) db.prepare(`UPDATE messages SET executed_provider = ? WHERE id = ?`).run(executedProvider, id);
  };
  const runtime = () => db.prepare(`SELECT * FROM runtime_sessions WHERE id = 'rs-1'`).get();
  const providers = () => Object.fromEntries(db.prepare(`SELECT id, provider FROM queue ORDER BY id`).all().map((row) => [row.id, row.provider]));
  const notes = () => db.prepare(`SELECT id, text FROM messages WHERE kind = ? ORDER BY timestamp`).all(CLAUDE_BILLING_NOTE_KIND);
  return { db, service, events, queueChanges, queue, message, runtime, providers, notes };
}

test('normalizes the two billings and nothing else', () => {
  assert.equal(normalizeClaudeBilling(' Claude-API '), 'claude-api');
  assert.equal(normalizeClaudeBilling('claude'), 'claude');
  for (const value of ['claude-cloud', 'deepseek', 'github', '', null]) assert.equal(normalizeClaudeBilling(value), '');
});

test('subscription → API key: billing, who and when, unstarted rows re-stamped, one note, the event', () => {
  const s = setup();
  s.queue('q-pending', 'pending', 'claude');
  s.queue('q-parked', 'parked', 'claude');
  s.queue('q-running', 'processing', 'claude');
  s.queue('q-done', 'done', 'claude');
  const result = s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api', by: 'user' });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.provider, 'claude-api');
  assert.equal(result.from, 'claude');
  const runtime = s.runtime();
  assert.equal(runtime.provider_type, 'claude-api');
  assert.equal(runtime.billing_switched_at, at());
  assert.equal(runtime.billing_switched_by, 'user');
  // A running row finishes on what it started with.
  assert.deepEqual(s.providers(), { 'q-done': 'claude', 'q-parked': 'claude-api', 'q-pending': 'claude-api', 'q-running': 'claude' });
  assert.equal(s.notes().length, 1);
  assert.match(s.notes()[0].text, /Claude API key from the next turn.*no prompt cache/);
  assert.deepEqual(s.events.map((event) => event.name), ['assistant_message', 'conversation_billing']);
  const billing = s.events[1].payload.billing;
  assert.equal(billing.provider, 'claude-api');
  assert.deepEqual(billing.switchable, { to: 'claude', allowed: true, code: null, reason: null });
  assert.deepEqual(s.queueChanges, ['claude-billing-switch']);
});

test('API key → subscription is the way out: no key, Claude API off or the cap reached do not stop it', () => {
  for (const variant of [
    { claudeApi: { enabled: false, configured: false } },
    { claudeApi: { enabled: false, configured: true } },
    { cap: { reached: true } },
  ]) {
    const s = setup({ provider: 'claude-api', ...variant });
    const result = s.service.switchBilling({ conversationId: 'conv-1', to: 'claude' });
    assert.equal(result.ok, true, JSON.stringify(variant));
    assert.equal(s.runtime().provider_type, 'claude');
  }
});

test('to the billing it already has: nothing changes', () => {
  const s = setup({ provider: 'claude-api' });
  s.queue('q-pending', 'pending', 'claude-api');
  const result = s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api' });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(s.runtime().billing_switched_at, null);
  assert.equal(s.notes().length, 0);
  assert.deepEqual(s.events, []);
  assert.deepEqual(s.queueChanges, []);
});

test('only Claude chats switch, and only to the two billings', () => {
  for (const provider of ['github', 'openai', 'cursor', 'grok', 'deepseek', 'claude-cloud']) {
    const s = setup({ provider });
    const result = s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api' });
    assert.equal(result.ok, false, provider);
    assert.equal(result.status, 409);
    assert.equal(result.code, 'CLAUDE_BILLING_NOT_CLAUDE');
    assert.equal(s.runtime().provider_type, provider);
  }
  const s = setup();
  for (const to of ['claude-cloud', 'deepseek', '', null]) {
    const result = s.service.switchBilling({ conversationId: 'conv-1', to });
    assert.equal(result.code, 'CLAUDE_BILLING_INVALID', String(to));
    assert.equal(result.status, 400);
  }
  assert.equal(s.service.switchBilling({ conversationId: 'conv-gone', to: 'claude-api' }).status, 404);
});

test('a switch to the key is refused, with nothing written, for each reason', () => {
  const cases = [
    [{ claudeApi: { enabled: false, configured: false } }, 'CLAUDE_API_NOT_CONFIGURED', /has no key/],
    [{ claudeApi: { enabled: false, configured: true } }, 'CLAUDE_API_NOT_CONFIGURED', /switched off/],
    [{ cap: { reached: true } }, 'CLAUDE_API_CAP_REACHED', /cap/],
    [{ cap: { reached: true, error: 'The cap of $20 is reached.' } }, 'CLAUDE_API_CAP_REACHED', /\$20/],
    [{ model: 'claude-haiku-4-5' }, 'CLAUDE_BILLING_MODEL_UNAVAILABLE', /claude-haiku-4-5 is not in the Claude API model list/],
    // The 1M tier needs its own entry in the target's list.
    [{ model: 'claude-opus-5-5[1m]' }, 'CLAUDE_BILLING_MODEL_UNAVAILABLE', /claude-opus-5-5\[1m\]/],
  ];
  for (const [options, code, text] of cases) {
    const s = setup(options);
    s.queue('q-pending', 'pending', 'claude');
    const result = s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api' });
    assert.equal(result.ok, false, code);
    assert.equal(result.status, 409);
    assert.equal(result.code, code);
    assert.match(result.error, text);
    assert.equal(s.runtime().provider_type, 'claude');
    assert.equal(s.runtime().billing_switched_at, null);
    assert.deepEqual(s.providers(), { 'q-pending': 'claude' });
    assert.equal(s.notes().length, 0);
    assert.deepEqual(s.events, []);
  }
});

test('the subscription is refused while the Claude provider is off', () => {
  const s = setup({ provider: 'claude-api', claude: { enabled: false } });
  const result = s.service.switchBilling({ conversationId: 'conv-1', to: 'claude' });
  assert.equal(result.code, 'CLAUDE_NOT_CONFIGURED');
  assert.equal(s.runtime().provider_type, 'claude-api');
});

test('a model asked for with the switch is checked against the target list and becomes the chat\'s', () => {
  const s = setup({ model: 'claude-haiku-4-5' });
  assert.equal(s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api', model: 'claude-fable-5-1' }).code, 'CLAUDE_BILLING_MODEL_UNAVAILABLE');
  const result = s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api', model: 'claude-opus-5-5' });
  assert.equal(result.ok, true);
  assert.equal(s.runtime().provider_model, 'claude-opus-5-5');
  assert.equal(s.runtime().model, 'claude-opus-5-5');
});

test('decision 23 blocked: refused once the chat has turns on the other billing, with its reason', () => {
  const historyRule = { 'claude-api': 'blocked', claude: 'allowed' };
  const fresh = setup({ historyRule });
  // A relay note is no turn.
  fresh.message('note-1', 'assistant', { kind: 'worker-launch-started' });
  assert.equal(fresh.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api' }).ok, true);

  // A reply from before the provider was recorded names none: no turn.
  const legacy = setup({ historyRule });
  legacy.message('u-0', 'user');
  legacy.message('a-0', 'assistant');
  assert.equal(legacy.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api' }).ok, true);

  for (const turn of [{ executedProvider: 'claude' }, { executedProvider: 'Claude' }]) {
    const s = setup({ historyRule });
    s.message('u-1', 'user');
    s.message('a-1', 'assistant', turn);
    const result = s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api' });
    assert.equal(result.code, 'CLAUDE_BILLING_HISTORY', JSON.stringify(turn));
    assert.match(result.error, /subscription turns.*new Claude API chat/);
    assert.deepEqual(s.service.billingState('conv-1').switchable, {
      to: 'claude-api',
      allowed: false,
      code: 'CLAUDE_BILLING_HISTORY',
      reason: result.error,
    });
  }
  // A chat whose turns all ran on the key can come back to it.
  const s = setup({ provider: 'claude', historyRule });
  s.message('a-1', 'assistant', { executedProvider: 'claude-api' });
  assert.equal(s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api' }).ok, true);
});

test('there and back before the next turn leaves one note, telling the billing it ended on', () => {
  const s = setup();
  s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api' });
  s.service.switchBilling({ conversationId: 'conv-1', to: 'claude' });
  assert.equal(s.notes().length, 1);
  assert.match(s.notes()[0].text, /Claude subscription from the next turn/);
  assert.deepEqual(s.events.map((event) => event.name), ['assistant_message', 'conversation_billing', 'message_updated', 'conversation_billing']);
  // After a turn, the next switch writes a note of its own.
  s.message('a-1', 'assistant', { executedProvider: 'claude', offsetMs: 1000 });
  s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api', by: 'agent' });
  assert.equal(s.notes().length, 2);
  assert.match(s.notes()[1].text, /switched by an agent/);
  assert.equal(s.runtime().billing_switched_by, 'agent');
});

test('a switch to the key releases a held usage-limit turn inside the transaction', () => {
  const calls = [];
  const s = setup({ releaseUsageLimitPause: (args) => { calls.push(args); return { messageId: 'held-1' }; } });
  const result = s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api', by: 'usage-limit' });
  assert.deepEqual(calls, [{ conversationId: 'conv-1', by: 'billing-switch' }]);
  assert.deepEqual(result.released, { messageId: 'held-1' });
  assert.match(s.notes()[0].text, /switched at the usage limit/);
  // Back to the subscription releases nothing.
  s.service.switchBilling({ conversationId: 'conv-1', to: 'claude' });
  assert.equal(calls.length, 1);
});

test('enqueue runs inside the transaction: a throw undoes the switch', () => {
  const s = setup();
  s.queue('q-pending', 'pending', 'claude');
  assert.throws(() => s.service.switchBilling({
    conversationId: 'conv-1',
    to: 'claude-api',
    by: 'agent',
    enqueue: () => { throw new Error('busy'); },
  }), /busy/);
  assert.equal(s.runtime().provider_type, 'claude');
  assert.deepEqual(s.providers(), { 'q-pending': 'claude' });
  assert.equal(s.notes().length, 0);
  assert.deepEqual(s.events, []);

  const result = s.service.switchBilling({
    conversationId: 'conv-1',
    to: 'claude-api',
    by: 'agent',
    enqueue: ({ billing }) => ({ messageId: 'm-1', billing }),
  });
  assert.deepEqual(result.enqueued, { messageId: 'm-1', billing: 'claude-api' });
  // A refused switch never reaches enqueue.
  let reached = false;
  const refused = s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-cloud', enqueue: () => { reached = true; } });
  assert.equal(refused.ok, false);
  assert.equal(reached, false);
});

test('billingState: null for a chat that is no Claude one', () => {
  assert.equal(setup({ provider: 'deepseek' }).service.billingState('conv-1'), null);
  const s = setup({ claudeApi: { enabled: false, configured: false } });
  assert.deepEqual(s.service.billingState('conv-1').switchable, {
    to: 'claude-api',
    allowed: false,
    code: 'CLAUDE_API_NOT_CONFIGURED',
    reason: 'Claude API has no key. Save one in Settings → Providers → Claude API.',
  });
});

test('a cap that cannot be read refuses the switch to the key', () => {
  const s = setup({ cap: null });
  const service = createClaudeBillingSwitchService({
    db: s.db,
    stmts: { ...createSessionRepository(s.db), ...createMessageRepository(s.db) },
    getClaudeProviderSettings: () => ({ enabled: true, availableModels: ['claude-sonnet-5-5'] }),
    getClaudeApiProviderSettings: () => ({ enabled: true, configured: true, availableModels: ['claude-sonnet-5-5'] }),
    getClaudeApiCapState: () => { throw new Error('totals unreadable'); },
    logger: { log() {}, warn() {} },
  });
  assert.equal(service.switchBilling({ conversationId: 'conv-1', to: 'claude-api' }).code, 'CLAUDE_API_CAP_REACHED');
});

test('inside a caller\'s transaction the switch says nothing until the caller announces it', () => {
  const s = setup();
  const result = s.service.switchBilling({ conversationId: 'conv-1', to: 'claude-api', deferAnnounce: true });
  assert.equal(result.ok, true);
  assert.deepEqual(s.events, []);
  assert.deepEqual(s.queueChanges, []);
  result.announce();
  assert.deepEqual(s.events.map((event) => event.name), ['assistant_message', 'conversation_billing']);
  assert.deepEqual(s.queueChanges, ['claude-billing-switch']);
});
