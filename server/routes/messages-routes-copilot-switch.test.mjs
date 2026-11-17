import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { makeRouteDeps, invokePost } from './messages-routes-test-harness.mjs';

const NOW = '2026-11-16T22:00:00.000Z';

// Minimal replica of the runtime_sessions schema: only the columns the send
// path reads.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE runtime_sessions (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE,
      sdk_session_id  TEXT,
      strategy        TEXT NOT NULL DEFAULT 'isolated',
      runtime_key     TEXT NOT NULL,
      model           TEXT,
      provider_type   TEXT NOT NULL DEFAULT 'github',
      provider_model  TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TEXT NOT NULL,
      last_used_at    TEXT NOT NULL
    );
  `);
  return db;
}

/** Send-path deps with the Copilot switch stored as `copilotEnabled` ('true', 'false', null = unset). */
function switchDeps(db, { copilotEnabled = null, ...overrides } = {}) {
  return makeRouteDeps({
    stmts: {
      getRuntimeSessionByConversation: db.prepare('SELECT * FROM runtime_sessions WHERE conversation_id = ?'),
      getRuntimeSessionById: db.prepare('SELECT * FROM runtime_sessions WHERE id = ?'),
      getConvAnyStatus: { get: () => null },
      getAppSetting: { get: (key) => (key === 'copilot_enabled' && copilotEnabled !== null ? { key, value: copilotEnabled, updated_at: NOW } : undefined) },
    },
    // Copilot's catalogue lists gpt-5.4-mini.
    resolveRequestedModel: (model) => (String(model || '').trim().toLowerCase() === 'gpt-5.4-mini'
      ? { ok: true, model: 'gpt-5.4-mini' }
      : { ok: false, error: `Model "${model}" is not supported`, available: ['gpt-5.4-mini'] }),
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
    uuidv4: () => crypto.randomUUID(),
    ...overrides,
  });
}

// Past every refusal the send creates its conversation: the stand-in stops there.
const reachedCreate = () => { throw new Error('reached create'); };

const firstSend = (extra = {}) => ({ clientId: 'client-1', newConversation: true, text: 'hello there', relayMode: 'agent', ...extra });

test('Copilot off: a first send naming nothing is refused with PROVIDER_REQUIRED', async () => {
  const { status, body } = await invokePost('/api/message', switchDeps(makeDb(), { copilotEnabled: 'false' }), firstSend());
  assert.equal(status, 400);
  assert.equal(body.code, 'PROVIDER_REQUIRED');
  assert.equal(body.error, 'Name a provider: Copilot is switched off on this relay.');
});

test('Copilot off: a first send naming Copilot or one of its models is refused with COPILOT_NOT_ENABLED', async () => {
  for (const extra of [{ providerType: 'github' }, { model: 'gpt-5.4-mini' }, { provider: 'copilot' }]) {
    const { status, body } = await invokePost('/api/message', switchDeps(makeDb(), { copilotEnabled: 'false' }), firstSend(extra));
    assert.equal(status, 400, JSON.stringify(extra));
    assert.equal(body.code, 'COPILOT_NOT_ENABLED');
  }
});

test('Copilot on or unset: the first send passes the switch', async () => {
  for (const copilotEnabled of ['true', null]) {
    // The model checks after the switch answer (this stand-in has no reasoning metadata).
    const { status, body } = await invokePost('/api/message', switchDeps(makeDb(), { copilotEnabled, getOrCreateConversation: reachedCreate }), firstSend({ model: 'gpt-5.4-mini' }));
    assert.deepEqual({ status, error: body?.error }, { status: 400, error: 'Reasoning metadata unavailable' }, String(copilotEnabled));
  }
});

test('Copilot off: a first send on OpenAI is not the switch\'s to refuse', async () => {
  await assert.rejects(invokePost('/api/message', switchDeps(makeDb(), {
    copilotEnabled: 'false',
    getOpenAIProviderSettings: () => ({ configured: true, enabled: true, model: 'gpt-4o', models: ['gpt-4o'] }),
    getOrCreateConversation: reachedCreate,
  }), firstSend({ providerType: 'openai', model: 'gpt-4o' })), /reached create/);
});

function insertRuntimeSession(db, { conversationId, providerType }) {
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, strategy, runtime_key, provider_type, status, created_at, last_used_at)
    VALUES (?, ?, 'isolated', ?, ?, 'active', ?, ?)
  `).run(`rs-${conversationId}`, conversationId, `key-${conversationId}`, providerType, NOW, NOW);
}

const sendTo = (conversationId, extra = {}) => ({ clientId: 'client-1', conversationId, text: 'next step', relayMode: 'agent', ...extra });

test('Copilot off: a send to a Copilot chat is refused with COPILOT_SWITCHED_OFF, nothing queued', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-copilot', providerType: 'github' });
  for (const conversationId of ['conv-copilot', 'conv-before-providers']) {
    const { status, body } = await invokePost('/api/message', switchDeps(db, { copilotEnabled: 'false' }), sendTo(conversationId, { model: 'gpt-5.4-mini' }));
    assert.equal(status, 409, conversationId);
    assert.deepEqual(body, {
      error: 'Copilot is switched off on this relay, so this message was not sent. Switch it on in Settings → Providers → Copilot.',
      code: 'COPILOT_SWITCHED_OFF',
      conversationId,
    });
  }
});

test('Copilot off: OpenAI and Claude chats are not refused by the switch', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-openai', providerType: 'openai' });
  insertRuntimeSession(db, { conversationId: 'conv-claude', providerType: 'claude' });
  for (const conversationId of ['conv-openai', 'conv-claude']) {
    const { body } = await invokePost('/api/message', switchDeps(db, {
      copilotEnabled: 'false',
      getOpenAIProviderSettings: () => ({ configured: true, enabled: true, model: 'gpt-4o', models: ['gpt-4o'] }),
      getClaudeProviderSettings: () => ({ enabled: true, model: 'claude-sonnet-5', models: ['claude-sonnet-5'], availableModels: ['claude-sonnet-5'], effortsByModel: {} }),
    }), sendTo(conversationId));
    assert.notEqual(body?.code, 'COPILOT_SWITCHED_OFF', conversationId);
  }
});

test('Copilot on or unset: a send to a Copilot chat passes the switch', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-copilot', providerType: 'github' });
  for (const copilotEnabled of ['true', null]) {
    const { body } = await invokePost('/api/message', switchDeps(db, { copilotEnabled }), sendTo('conv-copilot', { model: 'gpt-5.4-mini' }));
    assert.notEqual(body?.code, 'COPILOT_SWITCHED_OFF', String(copilotEnabled));
  }
});
