import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import {
  makeRouteDeps as baseRouteDeps,
  captureRoutes,
  invokeRoute,
} from './messages-routes-test-harness.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import { applySchema } from '../db-schema.mjs';

// POST /api/message to an EXISTING Copilot (github) conversation that leaves
// out the model, the effort or both, against the real route and the real
// SQLite schema. Such a send runs with the conversation's own model and
// effort, never the catalog's first model and effort 'none', and it never
// writes a filled-in value back as the conversation's preference.
//
// The catalog is a fake with the runtime's resolver semantics
// (server-runtime.mjs resolveRequestedModel / resolveRequestedReasoningEffort):
// its first model is NOT the conversation's.

const CONV = 'conv-fallback-1';
const RUNTIME_SESSION_ID = 'rs-fallback-1';
const NOW = '2026-01-01T00:00:00.000Z';

const CATALOG_FIRST = 'gpt-6-orbit';
const SESSION_MODEL = 'claude-opus-5';
const EFFORTS = {
  'gpt-6-orbit': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['none', 'low', 'medium', 'high'],
};

function makeCatalog() {
  const catalog = { models: Object.keys(EFFORTS) };
  const resolveRequestedModel = (model) => {
    const requested = String(model || '').trim().toLowerCase();
    if (!requested) {
      return { ok: true, model: CATALOG_FIRST, modelVariantId: CATALOG_FIRST, reasoningEffort: null, warning: null };
    }
    if (requested === 'auto') return { ok: true, model: 'auto', modelVariantId: 'auto', reasoningEffort: null, warning: null };
    if (catalog.models.includes(requested)) {
      return { ok: true, model: requested, modelVariantId: requested, reasoningEffort: null, warning: null };
    }
    // A variant id: "<model>-<effort>".
    const cut = requested.lastIndexOf('-');
    const base = requested.slice(0, cut);
    const effort = requested.slice(cut + 1);
    if (cut > 0 && catalog.models.includes(base) && EFFORTS[base].includes(effort)) {
      return { ok: true, model: base, modelVariantId: requested, reasoningEffort: effort, warning: null };
    }
    return { ok: false, error: 'Unsupported model', available: [...catalog.models] };
  };
  const resolveRequestedReasoningEffort = (model, effort) => {
    const modelId = String(model || '').trim().toLowerCase();
    if (modelId === 'auto') return { ok: true, effort: null, supported: [] };
    const supported = catalog.models.includes(modelId) ? EFFORTS[modelId] : [];
    const requested = String(effort || '').trim().toLowerCase();
    if (!supported.length) return { ok: false, error: 'Reasoning metadata unavailable for model', supported };
    if (!requested) return { ok: false, error: 'Reasoning effort is required', supported };
    if (!supported.includes(requested)) return { ok: false, error: 'Unsupported reasoning effort', supported };
    return { ok: true, effort: requested, supported };
  };
  return { catalog, resolveRequestedModel, resolveRequestedReasoningEffort };
}

function boot({
  preferredModel = SESSION_MODEL,
  preferredEffort = 'high',
  preferredMode = 'agent',
  runtimeModel = SESSION_MODEL,
  providerType = 'github',
  providerModel = null,
  providerDeps = {},
} = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at, preferred_relay_mode, preferred_model, preferred_reasoning_effort)
    VALUES (?, 'Fallback', ?, 'active', ?, ?, ?, ?, ?)
  `).run(CONV, CONV, NOW, NOW, preferredMode, preferredModel, preferredEffort);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, ?, 'isolated', ?, ?, ?, ?, 'active', ?, ?)
  `).run(RUNTIME_SESSION_ID, CONV, CONV, `runtime-key-${RUNTIME_SESSION_ID}`, runtimeModel, providerType, providerModel, NOW, NOW);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const { catalog, resolveRequestedModel, resolveRequestedReasoningEffort } = makeCatalog();
  const remoteRelayInbound = {
    repository: createRemoteRelayRepository(db),
    listRelays: () => [],
    selfNames: () => [],
    inboundEnabled: () => true,
    recordUnlock: () => {},
    describeRelay: () => null,
  };
  const deps = baseRouteDeps({
    db,
    stmts,
    io: { emit: () => {}, volatile: { emit: () => {} } },
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
    getOrCreateConversation: (id, firstLine) => {
      stmts.insertConv.run(id, String(firstLine || 'Untitled').slice(0, 80), NOW, NOW);
      return stmts.getConv.get(id);
    },
    resolveRequestedModel,
    resolveRequestedReasoningEffort,
    workspaceRootPayload: () => ({}),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0 }),
    emitToClientsExceptSessionId: () => {},
    runtimeState: { featureFlags: {} },
    remoteRelayInbound,
    ...providerDeps,
  });
  const routes = captureRoutes(deps);
  const send = (body, { headers = {} } = {}) => invokeRoute(routes, 'POST', '/api/message', {
    body: { clientId: 'client-1', conversationId: CONV, relayMode: 'agent', ...body },
    headers,
  });
  const queueRow = (id) => stmts.findQById.get(id);
  const conversationRow = () => db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(CONV);
  const queueCount = () => db.prepare(`SELECT COUNT(*) AS n FROM queue`).get().n;
  return { db, stmts, catalog, send, queueRow, conversationRow, queueCount };
}

function assertPreferences(fx, model, effort) {
  const row = fx.conversationRow();
  assert.equal(row.preferred_model, model);
  assert.equal(row.preferred_reasoning_effort, effort);
}

test('no model and no effort: the conversation keeps its own model and effort, not the catalog\'s first', async () => {
  const fx = boot();
  const { status, body } = await fx.send({ text: 'carry on' });
  assert.equal(status, 200, JSON.stringify(body));
  const queued = fx.queueRow(body.messageId);
  assert.equal(queued.model, SESSION_MODEL);
  assert.equal(queued.reasoning_effort, 'high');
  assert.equal(body.selectedBaseModel, SESSION_MODEL);
  assert.equal(body.selectedReasoningEffort, 'high');
  assertPreferences(fx, SESSION_MODEL, 'high');
  assert.equal(body.preferredModel, SESSION_MODEL);
});

test('only an effort: the conversation\'s model runs with it, and the effort is saved as asked', async () => {
  const fx = boot();
  const { status, body } = await fx.send({ text: 'look again', reasoningEffort: 'medium' });
  assert.equal(status, 200, JSON.stringify(body));
  const queued = fx.queueRow(body.messageId);
  assert.equal(queued.model, SESSION_MODEL);
  assert.equal(queued.reasoning_effort, 'medium');
  assertPreferences(fx, SESSION_MODEL, 'medium');
});

test('a saved model the catalog no longer lists is refused with 409, and nothing is queued or saved', async () => {
  const fx = boot({ preferredModel: 'gpt-4.9-retired', preferredEffort: 'high' });
  const { status, body } = await fx.send({ text: 'carry on' });
  assert.equal(status, 409);
  assert.equal(body.code, 'CONVERSATION_MODEL_UNAVAILABLE');
  assert.equal(body.model, 'gpt-4.9-retired');
  assert.match(body.error, /no longer available/);
  assert.ok(body.supportedModels.includes(SESSION_MODEL));
  assert.equal(fx.queueCount(), 0);
  assertPreferences(fx, 'gpt-4.9-retired', 'high');
});

test('a turn on the catalog default does not write that default back as the conversation\'s choice', async () => {
  // Nothing to keep: no saved model, no runtime model, no earlier message.
  const fx = boot({ preferredModel: null, preferredEffort: null, runtimeModel: null });
  const { status, body } = await fx.send({ text: 'first words' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(fx.queueRow(body.messageId).model, CATALOG_FIRST);
  assertPreferences(fx, null, null);
});

test('an explicit model without an effort is saved; the clamped effort is not', async () => {
  const fx = boot({ preferredEffort: 'xhigh' });
  const { status, body } = await fx.send({ text: 'smaller model please', model: 'gpt-5.4-mini' });
  assert.equal(status, 200, JSON.stringify(body));
  const queued = fx.queueRow(body.messageId);
  assert.equal(queued.model, 'gpt-5.4-mini');
  // gpt-5.4-mini has no xhigh: the nearest level below it.
  assert.equal(queued.reasoning_effort, 'high');
  assertPreferences(fx, 'gpt-5.4-mini', 'xhigh');
});

test('an effort the model lacks is clamped to the nearest level, never to none', async () => {
  const fx = boot({ preferredEffort: 'max' });
  const { body } = await fx.send({ text: 'think hard' });
  assert.equal(fx.queueRow(body.messageId).reasoning_effort, 'xhigh');

  // No saved effort at all, on a model that lists 'none': its lowest real level.
  const bare = boot({ preferredModel: CATALOG_FIRST, preferredEffort: null });
  const second = await bare.send({ text: 'go' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(bare.queueRow(second.body.messageId).reasoning_effort, 'low');
  assertPreferences(bare, CATALOG_FIRST, null);
});

test('the fallback order: runtime model, then the latest user message, and a saved "auto" is skipped', async () => {
  const runtimeOnly = boot({ preferredModel: 'auto', preferredEffort: null, runtimeModel: 'gpt-5.4-mini' });
  const first = await runtimeOnly.send({ text: 'one' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(runtimeOnly.queueRow(first.body.messageId).model, 'gpt-5.4-mini');

  const messageOnly = boot({ preferredModel: null, preferredEffort: null, runtimeModel: null });
  messageOnly.stmts.insertMsg.run('m-earlier', CONV, 'user', 'earlier', 'claude-opus-5-medium', 'agent', null, NOW, 'claude-opus-5-medium', null, 'manual');
  const second = await messageOnly.send({ text: 'two' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const queued = messageOnly.queueRow(second.body.messageId);
  assert.equal(queued.model, SESSION_MODEL);
  // The variant id carried its effort.
  assert.equal(queued.reasoning_effort, 'medium');
  assertPreferences(messageOnly, null, null);
});

test('another relay\'s agent sending no model keeps the session\'s model and leaves the preferences alone', async () => {
  const fx = boot();
  const { status, body } = await fx.send(
    { text: 'status please' },
    { headers: { 'x-oar-remote-origin': 'relay-id-other', 'x-oar-remote-hops': '1' } },
  );
  assert.equal(status, 200, JSON.stringify(body));
  const queued = fx.queueRow(body.messageId);
  assert.equal(queued.model, SESSION_MODEL);
  assert.equal(queued.reasoning_effort, 'high');
  assertPreferences(fx, SESSION_MODEL, 'high');
});

test('a message whose turn failed is not a duplicate; a pending one still is, and says nothing was queued', async () => {
  const fx = boot();
  const first = await fx.send({ text: 'run the build', model: SESSION_MODEL, reasoningEffort: 'high' });
  assert.equal(first.status, 200);
  const repeat = await fx.send({ text: 'run the build', model: SESSION_MODEL, reasoningEffort: 'high' });
  assert.equal(repeat.body.duplicate, true);
  assert.equal(repeat.body.queued, false);
  assert.equal(repeat.body.duplicateOfMessageId, first.body.messageId);

  fx.db.prepare(`UPDATE queue SET status = 'failed' WHERE id = ?`).run(first.body.messageId);
  const retry = await fx.send({ text: 'run the build', model: SESSION_MODEL, reasoningEffort: 'high' });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.duplicate, undefined);
  assert.ok(fx.queueRow(retry.body.messageId));
});

// The other providers already keep their pinned model; with no effort sent
// they now keep the conversation's effort too, instead of dropping to 'none'.
function bootProvider(providerType, providerModel, settings, { preferredEffort = 'high' } = {}) {
  const getter = {
    claude: 'getClaudeProviderSettings',
    cursor: 'getCursorProviderSettings',
    grok: 'getGrokProviderSettings',
    openai: 'getOpenAIProviderSettings',
  }[providerType];
  return boot({
    preferredModel: providerModel,
    preferredEffort,
    runtimeModel: providerModel,
    providerType,
    providerModel,
    providerDeps: { [getter]: () => settings },
  });
}

test('Claude, Cursor and Grok conversations keep their own effort when none is sent', async () => {
  const claude = bootProvider('claude', 'claude-opus-5', {
    enabled: true,
    model: 'claude-opus-5',
    models: ['claude-opus-5'],
    effortsByModel: { 'claude-opus-5': ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  });
  const cursor = bootProvider('cursor', 'composer-2.5', {
    enabled: true,
    model: 'composer-2.5',
    models: ['composer-2.5'],
    effortsByModel: { 'composer-2.5': ['none', 'low', 'medium', 'high'] },
  });
  const grok = bootProvider('grok', 'grok-4.5', {
    enabled: true,
    model: 'grok-4.5',
    models: ['grok-4.5'],
    effortsByModel: { 'grok-4.5': ['none', 'low', 'medium', 'high'] },
  });
  for (const [name, fx] of [['claude', claude], ['cursor', cursor], ['grok', grok]]) {
    const { status, body } = await fx.send({ text: `go on (${name})` });
    assert.equal(status, 200, `${name}: ${JSON.stringify(body)}`);
    assert.equal(fx.queueRow(body.messageId).reasoning_effort, 'high', name);
    assert.equal(fx.conversationRow().preferred_reasoning_effort, 'high', name);
  }
});

test('a provider conversation\'s effort the model lacks is clamped; an explicit one still wins', async () => {
  const fx = bootProvider('grok', 'grok-4.5', {
    enabled: true,
    model: 'grok-4.5',
    models: ['grok-4.5'],
    effortsByModel: { 'grok-4.5': ['none', 'low', 'medium', 'high'] },
  }, { preferredEffort: 'max' });
  const kept = await fx.send({ text: 'clamp it' });
  assert.equal(fx.queueRow(kept.body.messageId).reasoning_effort, 'high');
  const explicit = await fx.send({ text: 'quick one', reasoningEffort: 'low' });
  assert.equal(fx.queueRow(explicit.body.messageId).reasoning_effort, 'low');
});

test('a send that names no mode runs in the conversation\'s mode and does not flip it', async () => {
  const fx = boot({ preferredMode: 'plan' });
  const { status, body } = await fx.send({ text: 'plan the next step', relayMode: undefined, reasoningEffort: 'medium' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(fx.queueRow(body.messageId).relay_mode, 'plan');
  const row = fx.conversationRow();
  assert.equal(row.preferred_relay_mode, 'plan');
  assert.equal(row.preferred_reasoning_effort, 'medium');
  // A mode the send names still wins, and is saved with what it named.
  const named = await fx.send({ text: 'now build it', relayMode: 'autopilot', reasoningEffort: 'medium' });
  assert.equal(fx.queueRow(named.body.messageId).relay_mode, 'autopilot');
  assert.equal(fx.conversationRow().preferred_relay_mode, 'autopilot');
});

test('an effort alone, to a conversation with no saved model, runs with that effort but saves nothing', async () => {
  const fx = boot({ preferredModel: null, preferredEffort: 'low' });
  const { status, body } = await fx.send({ text: 'go deeper', reasoningEffort: 'high' });
  assert.equal(status, 200, JSON.stringify(body));
  const queued = fx.queueRow(body.messageId);
  assert.equal(queued.model, SESSION_MODEL);
  assert.equal(queued.reasoning_effort, 'high');
  assertPreferences(fx, null, 'low');
});

test('an OpenAI conversation keeps its own effort, clamped, when none is sent', async () => {
  const settings = { configured: true, enabled: true, model: 'gpt-5.4', models: ['gpt-5.4'] };
  const kept = bootProvider('openai', 'gpt-5.4', settings);
  const first = await kept.send({ text: 'carry on' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(kept.queueRow(first.body.messageId).reasoning_effort, 'high');
  const clamped = bootProvider('openai', 'gpt-5.4', settings, { preferredEffort: 'max' });
  const second = await clamped.send({ text: 'carry on' });
  assert.equal(clamped.queueRow(second.body.messageId).reasoning_effort, 'xhigh');
});

test('a Claude effort the model neither has nor clamps to keeps the provider default', async () => {
  const fx = bootProvider('claude', 'claude-sonnet-5', {
    enabled: true,
    model: 'claude-sonnet-5',
    models: ['claude-sonnet-5'],
    effortsByModel: { 'claude-sonnet-5': ['none', 'low', 'medium', 'high'] },
  }, { preferredEffort: 'ultracode' });
  const { status, body } = await fx.send({ text: 'go on' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(fx.queueRow(body.messageId).reasoning_effort, 'none');
});
