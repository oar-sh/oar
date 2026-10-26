import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { makeRouteDeps, invokePost } from './messages-routes-test-harness.mjs';
import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';

const NOW = '2024-01-01T00:00:00.000Z';

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

function insertRuntimeSession(db, { id = 'rs-1', conversationId = 'conv-1', providerType = 'github', providerModel = null } = {}) {
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, 'isolated', ?, ?, ?, ?, 'active', ?, ?)
  `).run(id, conversationId, `key-${id}`, providerModel, providerType, providerModel, NOW, NOW);
}

const CLAUDE_API_SETTINGS = Object.freeze({
  configured: true,
  enabled: true,
  model: 'claude-sonnet-5-5',
  models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]'],
  availableModels: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]'],
  effortsByModel: {
    'claude-sonnet-5-5': ['none', 'low', 'high'],
    'claude-opus-5-5': ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  },
});

function claudeApiDeps(db, overrides = {}) {
  return makeRouteDeps({
    stmts: {
      getRuntimeSessionByConversation: db.prepare('SELECT * FROM runtime_sessions WHERE conversation_id = ?'),
      getRuntimeSessionById: db.prepare('SELECT * FROM runtime_sessions WHERE id = ?'),
      getConvAnyStatus: { get: () => null },
    },
    getClaudeApiProviderSettings: () => CLAUDE_API_SETTINGS,
    // The Claude tab must not be what a Claude API session is checked against.
    getClaudeProviderSettings: () => ({ enabled: true, model: 'claude-sonnet-5', models: ['claude-sonnet-5'], availableModels: ['claude-sonnet-5'], effortsByModel: {} }),
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
    ...overrides,
  });
}

test('an explicit claude-api provider cannot take over another provider\'s conversation', async () => {
  // A Claude chat moves to the key through the billing route only
  // (messages-routes-claude-billing.test.mjs).
  for (const providerType of ['github', 'cursor']) {
    const db = makeDb();
    insertRuntimeSession(db, { conversationId: 'conv-other', providerType, providerModel: providerType === 'github' ? null : 'claude-sonnet-5' });
    const { status, body } = await invokePost('/api/message', claudeApiDeps(db, {
      getCursorProviderSettings: () => ({ enabled: true, model: 'claude-sonnet-5', models: ['claude-sonnet-5'] }),
    }), {
      clientId: 'client-1',
      conversationId: 'conv-other',
      text: 'hello there',
      model: 'claude-sonnet-5-5',
      providerType: 'claude-api',
      relayMode: 'agent',
    });
    assert.equal(status, 409, providerType);
    assert.equal(body.code, 'CLAUDE_API_REQUIRES_NEW_CONVERSATION', providerType);
  }
});

test('creating a Claude API conversation through /api/message is refused', async () => {
  const { status, body } = await invokePost('/api/message', claudeApiDeps(makeDb()), {
    clientId: 'client-1',
    newConversation: true,
    text: 'hello there',
    model: 'claude-sonnet-5-5',
    providerType: 'claude-api',
    relayMode: 'agent',
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'PROVIDER_REQUIRES_BOOTSTRAP');
  assert.match(String(body.error), /Claude API conversation requires POST \/api\/conversation\/bootstrap/);
});

test('a Claude API session takes its own models and efforts between turns', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-api', providerType: 'claude-api', providerModel: 'claude-sonnet-5-5' });
  const { status, body } = await invokePost('/api/message', claudeApiDeps(db), {
    clientId: 'client-1',
    conversationId: 'conv-api',
    text: 'think harder',
    model: 'claude-opus-5-5',
    contextTier: 'long_context',
    reasoningEffort: 'ultracode',
    relayMode: 'agent',
  });
  // Every guard passed: the missing conversation row is what answers.
  assert.equal(status, 404);
  assert.equal(body.error, 'Conversation not found');
});

test('a model id the Copilot catalogue lacks does not push a Claude API session elsewhere', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-api', providerType: 'claude-api', providerModel: 'claude-sonnet-5-5' });
  const { status, body } = await invokePost('/api/message', claudeApiDeps(db, {
    getCursorProviderSettings: () => ({ enabled: true, model: 'claude-opus-5-5', models: ['claude-opus-5-5'] }),
    getOpenAIProviderSettings: () => ({ enabled: false, model: '' }),
  }), {
    clientId: 'client-1',
    conversationId: 'conv-api',
    text: 'hello there',
    model: 'claude-opus-5-5',
    relayMode: 'agent',
  });
  assert.notEqual(body?.code, 'CURSOR_MODEL_REQUIRES_NEW_CONVERSATION');
  assert.equal(status, 404);
});

// ─── worker report routes ────────────────────────────────────────────────────

// The real schema and repositories: the report routes write the runtime
// session's columns.
function makeSchemaDb() {
  const db = new Database(':memory:');
  applySchema(db);
  return { ...createSessionRepository(db), ...createMessageRepository(db) };
}

function seedConversation(stmts, conversationId, providerType, providerModel = 'claude-sonnet-5-5') {
  stmts.insertConv.run(conversationId, 'Fix the slug helper', NOW, NOW);
  stmts.insertRuntimeSession.run(`rs-${conversationId}`, conversationId, 'isolated', `rs-${conversationId}`, providerModel, NOW, NOW, conversationId, providerType, providerModel);
}

function reportDeps(stmts, overrides = {}) {
  return makeRouteDeps({
    stmts,
    uuidv4: () => crypto.randomUUID(),
    ts: () => new Date().toISOString(),
    io: { emit() {}, volatile: { emit() {} } },
    ...overrides,
  });
}

test('a Claude API worker reports its native session, context and own turns as a Claude worker does', async () => {
  const stmts = makeSchemaDb();
  seedConversation(stmts, 'conv-api', 'claude-api');
  const deps = reportDeps(stmts);

  const native = await invokePost('/api/claude-native-session', deps, { conversationId: 'conv-api', claudeNativeSessionId: 'native-1' });
  assert.equal(native.status, 200);
  assert.equal(stmts.getRuntimeSessionByConversation.get('conv-api').claude_native_session_id, 'native-1');

  const context = await invokePost('/api/claude-context-usage', deps, {
    conversationId: 'conv-api',
    model: 'claude-sonnet-5-5',
    contextUsage: { totalTokens: 1200, maxTokens: 200000 },
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 5, outputTokens: 6, costUSD: 0.02 } },
  });
  assert.equal(context.status, 200);
  const stored = JSON.parse(stmts.getRuntimeSessionByConversation.get('conv-api').context_usage_json);
  assert.deepEqual(stored.contextUsage, { totalTokens: 1200, maxTokens: 200000 });

  // A background task's notification starts a turn of its own, as on Claude.
  const continuation = await invokePost('/api/continuation-turn', deps, { conversationId: 'conv-api' });
  assert.equal(continuation.status, 200);
  assert.equal(typeof continuation.body.messageId, 'string');
});

test('a Claude API worker writes neither the Claude plan card nor the subscription\'s usage limit', async () => {
  const stmts = makeSchemaDb();
  seedConversation(stmts, 'conv-api', 'claude-api');
  const saved = [];
  const recorded = [];
  const deps = reportDeps(stmts, {
    planUsageService: { saveSnapshot: (provider) => { saved.push(provider); return true; } },
    usageLimitPauseService: { recordReport: (report) => { recorded.push(report); return {}; } },
  });
  const plan = await invokePost('/api/claude-plan-usage', deps, {
    conversationId: 'conv-api',
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 5, outputTokens: 6, costUSD: 0.07 } },
    totalCostUsd: 0.07,
  });
  assert.equal(plan.status, 409);
  const limit = await invokePost('/api/claude-usage-limit', deps, { conversationId: 'conv-api', report: { status: 'rejected' } });
  assert.equal(limit.status, 409);
  assert.deepEqual(saved, []);
  assert.deepEqual(recorded, []);
});
