import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { buildDequeuedRelayMessage } from './messages-routes.mjs';
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

test('cursor-agent-id rejects a missing conversationId with 400', async () => {
  const db = makeDb();
  const deps = baseRouteDeps(makeStmts(db));
  const { status, body } = await invokePost('/api/cursor-agent-id', deps, { cursorAgentId: 'agent-1' });
  assert.equal(status, 400);
  assert.equal(body.error, 'Missing conversationId or cursorAgentId');
});

test('cursor-agent-id rejects a missing cursorAgentId with 400', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-1', providerType: 'cursor' });
  const deps = baseRouteDeps(makeStmts(db));
  const { status, body } = await invokePost('/api/cursor-agent-id', deps, { conversationId: 'conv-1' });
  assert.equal(status, 400);
  assert.equal(body.error, 'Missing conversationId or cursorAgentId');
});

test('cursor-agent-id returns 404 when the conversation has no runtime session', async () => {
  const db = makeDb();
  const deps = baseRouteDeps(makeStmts(db));
  const { status, body } = await invokePost('/api/cursor-agent-id', deps, {
    conversationId: 'conv-missing',
    cursorAgentId: 'agent-1',
  });
  assert.equal(status, 404);
  assert.equal(body.error, 'Runtime session not found for conversation');
});

test('cursor-agent-id returns 409 for a conversation bound to another provider', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-gh', providerType: 'github' });
  const deps = baseRouteDeps(makeStmts(db));
  const { status, body } = await invokePost('/api/cursor-agent-id', deps, {
    conversationId: 'conv-gh',
    cursorAgentId: 'agent-1',
  });
  assert.equal(status, 409);
  assert.equal(body.error, 'Conversation is not bound to the Cursor provider');
});

test('cursor-agent-id returns 500 when the column-gated statement is unavailable', async () => {
  const db = makeDb({ withCursorAgentIdColumn: false });
  insertRuntimeSession(db, { conversationId: 'conv-1', providerType: 'cursor' });
  const deps = baseRouteDeps(makeStmts(db, { hasCursorAgentIdColumn: false }));
  const { status, body } = await invokePost('/api/cursor-agent-id', deps, {
    conversationId: 'conv-1',
    cursorAgentId: 'agent-1',
  });
  assert.equal(status, 500);
  assert.equal(body.error, 'Cursor agent id storage is unavailable');
});

test('cursor-agent-id persists the agent id and touches last_used_at', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-1', providerType: 'cursor' });
  const deps = baseRouteDeps(makeStmts(db));
  const { status, body } = await invokePost('/api/cursor-agent-id', deps, {
    conversationId: 'conv-1',
    cursorAgentId: 'agent-abc-123',
  });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  const row = db.prepare(`SELECT cursor_agent_id, last_used_at FROM runtime_sessions WHERE conversation_id = ?`).get('conv-1');
  assert.equal(row.cursor_agent_id, 'agent-abc-123');
  assert.notEqual(row.last_used_at, NOW);
});

test('cursor-context-usage rejects a missing conversationId with 400', async () => {
  const db = makeDb();
  const deps = baseRouteDeps(makeStmts(db));
  const { status, body } = await invokePost('/api/cursor-context-usage', deps, {
    contextUsage: { used: 1 },
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'Missing conversationId');
});

test('cursor-context-usage rejects a payload without contextUsage and modelUsage with 400', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-1', providerType: 'cursor' });
  const deps = baseRouteDeps(makeStmts(db));
  const { status, body } = await invokePost('/api/cursor-context-usage', deps, {
    conversationId: 'conv-1',
    model: 'composer-1',
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'Missing contextUsage or modelUsage');
});

test('cursor-context-usage returns 404 when the conversation has no runtime session', async () => {
  const db = makeDb();
  const deps = baseRouteDeps(makeStmts(db));
  const { status, body } = await invokePost('/api/cursor-context-usage', deps, {
    conversationId: 'conv-missing',
    contextUsage: { used: 1 },
  });
  assert.equal(status, 404);
  assert.equal(body.error, 'Runtime session not found for conversation');
});

test('cursor-context-usage returns 409 for a conversation bound to another provider', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-gh', providerType: 'github' });
  const deps = baseRouteDeps(makeStmts(db));
  const { status, body } = await invokePost('/api/cursor-context-usage', deps, {
    conversationId: 'conv-gh',
    contextUsage: { used: 1 },
  });
  assert.equal(status, 409);
  assert.equal(body.error, 'Conversation is not bound to the Cursor provider');
});

test('cursor-context-usage stores the usage payload and stamps captured_at', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-1', providerType: 'cursor' });
  const deps = baseRouteDeps(makeStmts(db));
  const contextUsage = { usedTokens: 1200, maxTokens: 200000 };
  const modelUsage = { 'composer-1': { inputTokens: 900, outputTokens: 300 } };
  const { status, body } = await invokePost('/api/cursor-context-usage', deps, {
    conversationId: 'conv-1',
    model: 'composer-1',
    contextUsage,
    modelUsage,
  });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  const row = db.prepare(`SELECT context_usage_json, context_usage_captured_at FROM runtime_sessions WHERE conversation_id = ?`).get('conv-1');
  assert.deepEqual(JSON.parse(row.context_usage_json), {
    model: 'composer-1',
    contextUsage,
    modelUsage,
  });
  assert.ok(row.context_usage_captured_at, 'captured_at should be stamped');
});

test('buildDequeuedRelayMessage carries the persisted cursor agent id', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  insertRuntimeSession(db, {
    id: 'rs-1',
    conversationId: 'conv-1',
    providerType: 'cursor',
    providerModel: 'composer-1',
    cursorAgentId: 'agent-9',
  });
  const message = buildDequeuedRelayMessage({
    msg: {
      id: 'q-1',
      conversation_id: 'conv-1',
      runtime_session_id: 'rs-1',
      is_new_conversation: 0,
      model: 'composer-1',
      text: 'hello',
      status: 'processing',
      timestamp: NOW,
    },
    stmts,
    normalizeRelayMode: (value) => String(value || '').trim() || null,
    defaultRelayMode: 'default',
    defaultModel: 'gpt-5',
  });
  assert.equal(message.cursorAgentId, 'agent-9');
  assert.equal(message.providerType, 'cursor');
});

test('buildDequeuedRelayMessage delivers the enabled cursor models as the subagent roster', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  insertRuntimeSession(db, { id: 'rs-1', conversationId: 'conv-1', providerType: 'cursor' });
  const msg = {
    id: 'q-1',
    conversation_id: 'conv-1',
    runtime_session_id: 'rs-1',
    is_new_conversation: 0,
    model: 'composer-1',
    text: 'hello',
    status: 'processing',
    timestamp: NOW,
  };
  const base = {
    msg,
    stmts,
    normalizeRelayMode: (value) => String(value || '').trim() || null,
    defaultRelayMode: 'default',
    defaultModel: 'gpt-5',
  };

  const message = buildDequeuedRelayMessage({
    ...base,
    getCursorProviderSettings: () => ({ enabledModels: ['grok-4.5', ' claude-opus-5 ', ''] }),
  });
  assert.deepEqual(message.cursorSubagentModels, ['grok-4.5', 'claude-opus-5']);

  // A provider without the field (the registerMessagesRoutes default stub) must
  // not throw or emit junk — the worker just gets no subagents.
  assert.deepEqual(
    buildDequeuedRelayMessage({ ...base, getCursorProviderSettings: () => ({ enabled: false }) }).cursorSubagentModels,
    [],
  );
  assert.deepEqual(buildDequeuedRelayMessage(base).cursorSubagentModels, []);
});

test('buildDequeuedRelayMessage leaves the subagent roster empty for non-cursor providers', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  insertRuntimeSession(db, { id: 'rs-1', conversationId: 'conv-1', providerType: 'claude' });
  let settingsReads = 0;
  const message = buildDequeuedRelayMessage({
    msg: {
      id: 'q-1',
      conversation_id: 'conv-1',
      runtime_session_id: 'rs-1',
      is_new_conversation: 0,
      model: 'claude-opus-5',
      text: 'hello',
      status: 'processing',
      timestamp: NOW,
    },
    stmts,
    normalizeRelayMode: (value) => String(value || '').trim() || null,
    defaultRelayMode: 'default',
    defaultModel: 'gpt-5',
    getCursorProviderSettings: () => {
      settingsReads += 1;
      return { enabledModels: ['grok-4.5'] };
    },
  });
  assert.deepEqual(message.cursorSubagentModels, []);
  assert.equal(settingsReads, 0, 'cursor settings are not read on a non-cursor dequeue');
});

test('buildDequeuedRelayMessage yields a null cursorAgentId when the column is empty', () => {
  const db = makeDb();
  const stmts = makeStmts(db);
  insertRuntimeSession(db, { id: 'rs-1', conversationId: 'conv-1', providerType: 'cursor' });
  const message = buildDequeuedRelayMessage({
    msg: {
      id: 'q-1',
      conversation_id: 'conv-1',
      runtime_session_id: 'rs-1',
      is_new_conversation: 0,
      model: 'composer-1',
      text: 'hello',
      status: 'processing',
      timestamp: NOW,
    },
    stmts,
    normalizeRelayMode: (value) => String(value || '').trim() || null,
    defaultRelayMode: 'default',
    defaultModel: 'gpt-5',
  });
  assert.equal(message.cursorAgentId, null);
});

test('a cursor-only model on an existing github conversation requires a new Cursor conversation', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-gh', providerType: 'github' });
  const deps = baseRouteDeps(makeStmts(db), {
    getCursorProviderSettings: () => ({ enabled: true, model: 'composer-1', models: ['composer-1', 'cursor-fast'] }),
  });
  const { status, body } = await invokePost('/api/message', deps, {
    clientId: 'client-1',
    conversationId: 'conv-gh',
    text: 'hello there',
    model: 'composer-1',
    relayMode: 'default',
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'CURSOR_MODEL_REQUIRES_NEW_CONVERSATION');
  assert.equal(body.error, 'Cursor model selection requires creating a new Cursor conversation');
});

test('an explicit cursor providerType on an existing github conversation requires a new Cursor conversation', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-gh', providerType: 'github' });
  const deps = baseRouteDeps(makeStmts(db), {
    getCursorProviderSettings: () => ({ enabled: true, model: 'composer-1', models: ['composer-1'] }),
  });
  const { status, body } = await invokePost('/api/message', deps, {
    clientId: 'client-1',
    conversationId: 'conv-gh',
    text: 'hello there',
    model: 'composer-1',
    providerType: 'cursor',
    relayMode: 'default',
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'CURSOR_MODEL_REQUIRES_NEW_CONVERSATION');
});

// Grok model ids can also appear in the Cursor catalog (Cursor resells Grok).
// A bound Grok session must not be 409'd as "needs a new Cursor conversation".
test('a Grok session keeps sending a model the Cursor catalog also lists', async () => {
  const db = makeDb();
  insertRuntimeSession(db, {
    conversationId: 'conv-grok',
    providerType: 'grok',
    providerModel: 'grok-4.5',
  });
  const deps = baseRouteDeps({
    ...makeStmts(db),
    getConvAnyStatus: { get: () => null },
  }, {
    getCursorProviderSettings: () => ({ enabled: true, model: 'composer-1', models: ['composer-1', 'grok-4.5'] }),
    getGrokProviderSettings: () => ({
      enabled: true,
      model: 'grok-4.5',
      models: ['grok-4.5'],
      effortsByModel: { 'grok-4.5': ['none', 'low', 'medium', 'high'] },
    }),
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
  });
  const { status, body } = await invokePost('/api/message', deps, {
    clientId: 'client-1',
    conversationId: 'conv-grok',
    text: 'tell me a joke',
    model: 'grok-4.5',
    relayMode: 'agent',
  });
  assert.notEqual(body?.code, 'CURSOR_MODEL_REQUIRES_NEW_CONVERSATION');
  assert.notEqual(body?.code, 'GROK_MODEL_REQUIRES_NEW_CONVERSATION');
  assert.notEqual(body?.code, 'OPENAI_MODEL_REQUIRES_NEW_CONVERSATION');
  // Guard path only — conversation row is intentionally missing → 404 after guards.
  assert.equal(status, 404);
  assert.equal(body.error, 'Conversation not found');
});

// The Grok ACP surface cannot switch models mid-session, so the model pinned
// at bootstrap is locked: a different Grok model on the same conversation is
// refused instead of being silently relabeled.
test('switching a bound Grok conversation to a different Grok model is refused', async () => {
  const db = makeDb();
  insertRuntimeSession(db, {
    conversationId: 'conv-grok',
    providerType: 'grok',
    providerModel: 'grok-4.5',
  });
  const deps = baseRouteDeps({
    ...makeStmts(db),
    getConvAnyStatus: { get: () => null },
  }, {
    getGrokProviderSettings: () => ({
      enabled: true,
      model: 'grok-4.5',
      models: ['grok-4.5', 'grok-code-fast-1'],
      effortsByModel: {},
    }),
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
  });
  const { status, body } = await invokePost('/api/message', deps, {
    clientId: 'client-1',
    conversationId: 'conv-grok',
    text: 'switch please',
    model: 'grok-code-fast-1',
    relayMode: 'agent',
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'GROK_MODEL_REQUIRES_NEW_CONVERSATION');
  assert.equal(body.error, 'Grok model switching requires creating a new Grok conversation');
});

// Cursor resells models the Claude provider serves under the same id, so the
// id alone must never route a bound Claude session into the cursor rejection.
test('a Claude session keeps sending a model the Cursor catalog also lists', async () => {
  const db = makeDb();
  insertRuntimeSession(db, {
    conversationId: 'conv-claude',
    providerType: 'claude',
    providerModel: 'claude-opus-5',
  });
  const deps = baseRouteDeps({
    ...makeStmts(db),
    // Reached only once the provider guards let the request through; a missing
    // conversation row is the first check after them.
    getConvAnyStatus: { get: () => null },
  }, {
    getCursorProviderSettings: () => ({ enabled: true, model: 'composer-1', models: ['composer-1', 'claude-opus-5'] }),
    getClaudeProviderSettings: () => ({ enabled: true, model: 'claude-opus-5', models: ['claude-opus-5'] }),
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
  });
  const { status, body } = await invokePost('/api/message', deps, {
    clientId: 'client-1',
    conversationId: 'conv-claude',
    text: 'hello there',
    model: 'claude-opus-5',
    relayMode: 'default',
  });
  assert.notEqual(body?.code, 'CURSOR_MODEL_REQUIRES_NEW_CONVERSATION');
  assert.equal(status, 404);
  assert.equal(body.error, 'Conversation not found');
});

test('an explicit cursor providerType still cannot cross into a Claude session', async () => {
  const db = makeDb();
  insertRuntimeSession(db, {
    conversationId: 'conv-claude',
    providerType: 'claude',
    providerModel: 'claude-opus-5',
  });
  const deps = baseRouteDeps(makeStmts(db), {
    getCursorProviderSettings: () => ({ enabled: true, model: 'composer-1', models: ['composer-1', 'claude-opus-5'] }),
    getClaudeProviderSettings: () => ({ enabled: true, model: 'claude-opus-5', models: ['claude-opus-5'] }),
  });
  const { status, body } = await invokePost('/api/message', deps, {
    clientId: 'client-1',
    conversationId: 'conv-claude',
    text: 'hello there',
    model: 'claude-opus-5',
    providerType: 'cursor',
    relayMode: 'default',
  });
  assert.equal(status, 409);
  assert.equal(body.code, 'CURSOR_MODEL_REQUIRES_NEW_CONVERSATION');
});

// The mirror case: an OpenAI BYOK catalog that lists a Cursor model id must not
// push a bound Cursor session into the OpenAI rejection.
test('a Cursor session keeps sending a model the OpenAI catalog also lists', async () => {
  const db = makeDb();
  insertRuntimeSession(db, {
    conversationId: 'conv-cursor',
    providerType: 'cursor',
    providerModel: 'gpt-5.5',
  });
  const deps = baseRouteDeps({
    ...makeStmts(db),
    getConvAnyStatus: { get: () => null },
  }, {
    getOpenAIProviderSettings: () => ({ configured: true, enabled: true, model: 'gpt-5.5', models: ['gpt-5.5'] }),
    getCursorProviderSettings: () => ({ enabled: true, model: 'gpt-5.5', models: ['gpt-5.5'] }),
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
  });
  const { status, body } = await invokePost('/api/message', deps, {
    clientId: 'client-1',
    conversationId: 'conv-cursor',
    text: 'hello there',
    model: 'gpt-5.5',
    relayMode: 'default',
  });
  assert.notEqual(body?.code, 'OPENAI_MODEL_REQUIRES_NEW_CONVERSATION');
  assert.equal(status, 404);
  assert.equal(body.error, 'Conversation not found');
});

// Silently answering with the pinned model is what let a conversation run a
// model the composer never showed.
test('an unavailable Cursor model is refused instead of falling back to the pinned model', async () => {
  const db = makeDb();
  insertRuntimeSession(db, {
    conversationId: 'conv-cursor',
    providerType: 'cursor',
    providerModel: 'composer-2.5',
  });
  const deps = baseRouteDeps({
    ...makeStmts(db),
    getConvAnyStatus: { get: () => null },
  }, {
    getCursorProviderSettings: () => ({ enabled: true, model: 'composer-2.5', models: ['composer-2.5', 'grok-4.5'] }),
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
  });
  const { status, body } = await invokePost('/api/message', deps, {
    clientId: 'client-1',
    conversationId: 'conv-cursor',
    text: 'hello there',
    model: 'ghost-model',
    relayMode: 'default',
  });
  assert.equal(status, 400);
  assert.equal(body.code, 'CURSOR_MODEL_UNAVAILABLE');
  assert.match(String(body.error), /"ghost-model" is not available/);
});

test('a case-variant Cursor model is accepted rather than rejected', async () => {
  const db = makeDb();
  insertRuntimeSession(db, {
    conversationId: 'conv-cursor',
    providerType: 'cursor',
    providerModel: 'composer-2.5',
  });
  const deps = baseRouteDeps({
    ...makeStmts(db),
    getConvAnyStatus: { get: () => null },
  }, {
    getCursorProviderSettings: () => ({ enabled: true, model: 'composer-2.5', models: ['composer-2.5', 'Grok-4.5'] }),
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
  });
  const { status, body } = await invokePost('/api/message', deps, {
    clientId: 'client-1',
    conversationId: 'conv-cursor',
    text: 'hello there',
    model: 'grok-4.5',
    relayMode: 'default',
  });
  assert.notEqual(body?.code, 'CURSOR_MODEL_UNAVAILABLE');
  // Guard path only — the conversation row is intentionally missing, so this
  // reaches the lookup rather than any provider refusal. That the canonical
  // casing ('Grok-4.5') is what gets bound is covered by
  // provider-model-selection.test.mjs and end to end by the bootstrap spec.
  assert.equal(status, 404);
  assert.equal(body.error, 'Conversation not found');
});

test('creating a Cursor or Grok conversation through /api/message is refused', async () => {
  for (const providerType of ['cursor', 'grok']) {
    const db = makeDb();
    const deps = baseRouteDeps(makeStmts(db), {
      getCursorProviderSettings: () => ({ enabled: true, model: 'composer-2.5', models: ['composer-2.5'] }),
      getGrokProviderSettings: () => ({ enabled: true, model: 'grok-4.5', models: ['grok-4.5'] }),
    });
    const { status, body } = await invokePost('/api/message', deps, {
      clientId: 'client-1',
      newConversation: true,
      text: 'hello there',
      model: providerType === 'cursor' ? 'composer-2.5' : 'grok-4.5',
      providerType,
      relayMode: 'default',
    });
    // 409, like the other "this provider needs a new conversation" refusals.
    assert.equal(status, 409, providerType);
    assert.equal(body.code, 'PROVIDER_REQUIRES_BOOTSTRAP', providerType);
    assert.match(String(body.error), /\/api\/conversation\/bootstrap/);
  }
});

test('a disabled Cursor provider does not hijack unknown models into the cursor rejection', async () => {
  const db = makeDb();
  insertRuntimeSession(db, { conversationId: 'conv-gh', providerType: 'github' });
  const deps = baseRouteDeps(makeStmts(db), {
    getCursorProviderSettings: () => ({ enabled: false, model: 'composer-1', models: ['composer-1', 'cursor-fast'] }),
  });
  const { status, body } = await invokePost('/api/message', deps, {
    clientId: 'client-1',
    conversationId: 'conv-gh',
    text: 'hello there',
    model: 'composer-1',
    relayMode: 'default',
  });
  assert.equal(status, 400);
  assert.notEqual(body?.code, 'CURSOR_MODEL_REQUIRES_NEW_CONVERSATION');
  assert.match(String(body.error), /not supported/);
});
