import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { makeRouteDeps, invokePost } from './messages-routes-test-harness.mjs';

const NOW = '2024-01-01T00:00:00.000Z';

// Minimal replica of the runtime_sessions schema: only the columns the cursor
// routes and the dequeue payload builder touch. The cursor_agent_id column is
// optional so the column-gated 500 path can be exercised.
function makeDb({ withCursorAgentIdColumn = true } = {}) {
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
      last_used_at    TEXT NOT NULL,
      claude_native_session_id TEXT,
      context_usage_json TEXT,
      context_usage_captured_at TEXT
      ${withCursorAgentIdColumn ? ', cursor_agent_id TEXT' : ''}
    );
  `);
  return db;
}

// Mirrors the session-repository statements the routes rely on, including the
// column gate that leaves the cursor statement null on un-migrated databases.
function makeStmts(db, { hasCursorAgentIdColumn = true } = {}) {
  return {
    getRuntimeSessionByConversation: db.prepare(`SELECT * FROM runtime_sessions WHERE conversation_id = ?`),
    getRuntimeSessionById: db.prepare(`SELECT * FROM runtime_sessions WHERE id = ?`),
    updateRuntimeSessionCursorAgentId: hasCursorAgentIdColumn
      ? db.prepare(`
          UPDATE runtime_sessions
          SET cursor_agent_id = ?, last_used_at = ?
          WHERE conversation_id = ?
        `)
      : null,
    updateRuntimeSessionContextUsage: db.prepare(`
      UPDATE runtime_sessions
      SET context_usage_json = ?, context_usage_captured_at = ?
      WHERE conversation_id = ?
    `),
  };
}

function insertRuntimeSession(db, {
  id = 'rs-1',
  conversationId = 'conv-1',
  providerType = 'cursor',
  providerModel = null,
  cursorAgentId = null,
} = {}) {
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, 'isolated', ?, ?, ?, ?, 'active', ?, ?)
  `).run(id, conversationId, `key-${id}`, providerModel, providerType, providerModel, NOW, NOW);
  if (cursorAgentId) {
    db.prepare(`UPDATE runtime_sessions SET cursor_agent_id = ? WHERE id = ?`).run(cursorAgentId, id);
  }
}

// Deps come from the shared harness baseline; this suite only supplies its
// session-repository statement mirrors (and per-test provider settings).
function baseRouteDeps(stmts, overrides = {}) {
  return makeRouteDeps({ stmts, ...overrides });
}


const DEEPSEEK_SETTINGS = Object.freeze({
  configured: true,
  enabled: true,
  model: 'deepseek-flash',
  models: ['deepseek-flash', 'deepseek-v4-pro'],
});

function deepseekDeps(db, overrides = {}) {
  return baseRouteDeps({
    ...makeStmts(db),
    getConvAnyStatus: { get: () => null },
  }, {
    getDeepSeekProviderSettings: () => DEEPSEEK_SETTINGS,
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
    ...overrides,
  });
}

// A github conversation is never moved by a model id: a DeepSeek id is a model
// Copilot lacks.
test('a DeepSeek model on an existing github conversation is refused as unknown to Copilot', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-gh', providerType: 'github' });
  const copilotModels = ['gpt-5.4-mini', 'claude-opus-5.5'];
  const { status, body } = await invokePost('/api/message', deepseekDeps(db, {
    resolveRequestedModel: () => ({ ok: false, error: 'Unsupported model', available: [...copilotModels] }),
  }), {
    clientId: 'client-1',
    conversationId: 'conv-gh',
    text: 'hello there',
    model: 'deepseek-flash',
    relayMode: 'default',
  });
  assert.equal(status, 400);
  assert.equal(body.code, 'COPILOT_MODEL_UNAVAILABLE');
  assert.match(body.error, /^Unknown model 'deepseek-flash' for Copilot/);
  assert.deepEqual(body.supportedModels, copilotModels);
});

test('an explicit deepseek providerType cannot cross into another provider\'s session', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-cursor', providerType: 'cursor', providerModel: 'composer-2.5' });
  const { status, body } = await invokePost('/api/message', deepseekDeps(db, {
    getCursorProviderSettings: () => ({ enabled: true, model: 'composer-2.5', models: ['composer-2.5'] }),
  }), {
    clientId: 'client-1',
    conversationId: 'conv-cursor',
    text: 'hello there',
    model: 'deepseek-flash',
    providerType: 'deepseek',
    relayMode: 'default',
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'DEEPSEEK_MODEL_REQUIRES_NEW_CONVERSATION');
});

test('a switched-off DeepSeek does not pull an unknown model into its refusal', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-gh', providerType: 'github' });
  const { status, body } = await invokePost('/api/message', deepseekDeps(db, {
    getDeepSeekProviderSettings: () => ({ ...DEEPSEEK_SETTINGS, enabled: false }),
  }), {
    clientId: 'client-1',
    conversationId: 'conv-gh',
    text: 'hello there',
    model: 'deepseek-flash',
    relayMode: 'default',
  });
  assert.equal(status, 400);
  assert.notEqual(body?.code, 'DEEPSEEK_MODEL_REQUIRES_NEW_CONVERSATION');
});

test('a DeepSeek session may switch to another DeepSeek model between turns', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-ds', providerType: 'deepseek', providerModel: 'deepseek-flash' });
  const { status, body } = await invokePost('/api/message', deepseekDeps(db), {
    clientId: 'client-1',
    conversationId: 'conv-ds',
    text: 'think harder',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'medium',
    relayMode: 'agent',
  });
  // Every guard passed: the missing conversation row is what answers.
  assert.equal(status, 404);
  assert.equal(body.error, 'Conversation not found');
});

test('a model DeepSeek does not offer is refused in a DeepSeek session', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-ds', providerType: 'deepseek', providerModel: 'deepseek-flash' });
  const { status, body } = await invokePost('/api/message', deepseekDeps(db), {
    clientId: 'client-1',
    conversationId: 'conv-ds',
    text: 'hello there',
    model: 'deepseek-ghost',
    relayMode: 'agent',
  });
  assert.equal(status, 400);
  assert.equal(body.code, 'DEEPSEEK_MODEL_UNAVAILABLE');
  assert.deepEqual(body.supportedModels, ['deepseek-flash', 'deepseek-v4-pro']);
});

test('creating a DeepSeek conversation through /api/message is refused', async () => {
  const db = makeDb();
  const { status, body } = await invokePost('/api/message', deepseekDeps(db), {
    clientId: 'client-1',
    newConversation: true,
    text: 'hello there',
    model: 'deepseek-flash',
    providerType: 'deepseek',
    relayMode: 'default',
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'PROVIDER_REQUIRES_BOOTSTRAP');
  assert.match(String(body.error), /DeepSeek conversation requires POST \/api\/conversation\/bootstrap/);
});

function dbWithImageHistory(hasImage) {
  return {
    prepare: (sql) => ({
      run() {},
      all: () => [],
      get: () => (/attachments LIKE/.test(String(sql)) && hasImage ? { 1: 1 } : null),
    }),
  };
}

test('a switch to a text-only DeepSeek model is refused once the conversation holds images', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-ds', providerType: 'deepseek', providerModel: 'deepseek-flash' });
  const { status, body } = await invokePost('/api/message', deepseekDeps(db, { db: dbWithImageHistory(true) }), {
    clientId: 'client-1',
    conversationId: 'conv-ds',
    text: 'think harder',
    model: 'deepseek-v4-pro',
    relayMode: 'agent',
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'DEEPSEEK_MODEL_TEXT_ONLY');
  assert.match(body.error, /DeepSeek V4 Pro takes no images/);
  assert.match(body.error, /Stay on DeepSeek Flash/);
});

test('without images in the history the same switch goes through', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-ds', providerType: 'deepseek', providerModel: 'deepseek-flash' });
  const { status, body } = await invokePost('/api/message', deepseekDeps(db, { db: dbWithImageHistory(false) }), {
    clientId: 'client-1',
    conversationId: 'conv-ds',
    text: 'think harder',
    model: 'deepseek-v4-pro',
    relayMode: 'agent',
  });
  assert.notEqual(body?.code, 'DEEPSEEK_MODEL_TEXT_ONLY');
  assert.equal(status, 404);
});
