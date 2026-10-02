import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { buildDequeuedRelayMessage } from './messages-routes.mjs';
import { makeRouteDeps, invokePost } from './messages-routes-test-harness.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { buildCloudSourceRecord } from '../services/claude-cloud-session-service.mjs';

const NOW = '2026-10-02T10:00:00.000Z';
const REPO_URL = 'https://github.com/example-org/sample-repo';
const SESSION_ID = 'cse_01EXAMPLEaaaaaaaaaaaaaaaa';
const ENVIRONMENT_ID = 'env_01EXAMPLEaaaaaaaaaaaaaaaa';
const OTHER_ENVIRONMENT_ID = 'env_01EXAMPLEbbbbbbbbbbbbbbbb';

const CLOUD_SETTINGS = Object.freeze({
  enabled: true,
  defaultModel: 'claude-sonnet-5-5',
  environmentId: OTHER_ENVIRONMENT_ID,
  models: ['claude-sonnet-5-5', 'claude-opus-5'],
});

// The real schema and session repository: the dequeue builder and the routes
// read the columns migration 0007 adds.
function makeDb() {
  const db = new Database(':memory:');
  applySchema(db);
  return { db, stmts: createSessionRepository(db) };
}

function seedConversation(stmts, {
  conversationId = 'conv-cloud',
  providerType = 'claude-cloud',
  providerModel = 'claude-sonnet-5-5',
  cloudSource = buildCloudSourceRecord({ repoUrl: REPO_URL, branch: 'dev/feature', environmentId: ENVIRONMENT_ID }),
  title = 'Fix the slug helper',
} = {}) {
  stmts.insertConv.run(conversationId, title, NOW, NOW);
  stmts.insertRuntimeSession.run(`rs-${conversationId}`, conversationId, 'isolated', `rs-${conversationId}`, providerModel, NOW, NOW, conversationId, providerType, providerModel);
  if (cloudSource) stmts.updateConvCloudSource.run(JSON.stringify(cloudSource), conversationId);
}

function dequeue(stmts, conversationId, extra = {}) {
  return buildDequeuedRelayMessage({
    msg: {
      id: 'q-1',
      conversation_id: conversationId,
      runtime_session_id: `rs-${conversationId}`,
      is_new_conversation: 0,
      model: 'claude-sonnet-5-5',
      text: 'hello',
      status: 'processing',
      timestamp: NOW,
    },
    stmts,
    normalizeRelayMode: (value) => String(value || '').trim() || null,
    defaultRelayMode: 'agent',
    defaultModel: 'gpt-5',
    getClaudeCloudProviderSettings: () => CLOUD_SETTINGS,
    ...extra,
  });
}

// ─── dequeue ─────────────────────────────────────────────────────────────────

test('a delivered cloud message carries what the worker needs to create the session', () => {
  const { stmts } = makeDb();
  seedConversation(stmts);
  const message = dequeue(stmts, 'conv-cloud');
  assert.equal(message.providerType, 'claude-cloud');
  assert.deepEqual(message.claudeCloud, {
    sessionId: null,
    lastSequence: null,
    repoUrl: REPO_URL,
    branch: 'dev/feature',
    environmentId: ENVIRONMENT_ID,
    title: 'Fix the slug helper',
  });
  // Nothing of the Claude provider's rides along.
  assert.equal(message.claudeNativeSessionId, null);
});

test('a delivered cloud message carries the binding the worker reported', () => {
  const { stmts } = makeDb();
  seedConversation(stmts, { cloudSource: buildCloudSourceRecord({ repoUrl: REPO_URL }) });
  stmts.updateRuntimeSessionClaudeCloudSession.run(SESSION_ID, '57', 0.2, NOW, 'conv-cloud');
  assert.deepEqual(dequeue(stmts, 'conv-cloud').claudeCloud, {
    sessionId: SESSION_ID,
    lastSequence: '57',
    repoUrl: REPO_URL,
    branch: null,
    // Stored without an environment: the tab's current one is used.
    environmentId: OTHER_ENVIRONMENT_ID,
    title: 'Fix the slug helper',
  });
});

test('a cloud conversation without a stored repository delivers a null field, not a guess', () => {
  const { stmts } = makeDb();
  seedConversation(stmts, { cloudSource: null });
  const message = dequeue(stmts, 'conv-cloud');
  assert.equal('claudeCloud' in message, true);
  assert.equal(message.claudeCloud, null);
});

test('no other provider gets the cloud field', () => {
  const { stmts } = makeDb();
  for (const providerType of ['claude', 'github', 'cursor', 'grok', 'openai']) {
    seedConversation(stmts, { conversationId: `conv-${providerType}`, providerType });
    const message = dequeue(stmts, `conv-${providerType}`);
    assert.equal(message.providerType, providerType);
    assert.equal('claudeCloud' in message, false, providerType);
  }
});

// ─── POST /api/message ───────────────────────────────────────────────────────

function messageDeps(stmts, overrides = {}) {
  return makeRouteDeps({
    // The guards run before the conversation is looked up: a missing row is
    // the first check after them, so 404 means "every guard let it through".
    stmts: { ...stmts, getConvAnyStatus: { get: () => null } },
    getClaudeCloudProviderSettings: () => CLOUD_SETTINGS,
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
    ...overrides,
  });
}

const send = (deps, body) => invokePost('/api/message', deps, { clientId: 'client-1', text: 'hello there', relayMode: 'agent', ...body });

test('a cloud conversation cannot be created through /api/message', async () => {
  const { stmts } = makeDb();
  const { status, body } = await send(messageDeps(stmts), { newConversation: true, providerType: 'claude-cloud', model: 'claude-sonnet-5-5' });
  assert.equal(status, 409);
  assert.equal(body.code, 'PROVIDER_REQUIRES_BOOTSTRAP');
  assert.match(body.error, /Creating a Claude Cloud conversation requires POST \/api\/conversation\/bootstrap/);
});

test('an existing conversation of another provider cannot cross into the cloud', async () => {
  const { stmts } = makeDb();
  for (const providerType of ['github', 'claude']) {
    seedConversation(stmts, { conversationId: `conv-${providerType}`, providerType, providerModel: 'claude-opus-5', cloudSource: null });
    const { status, body } = await send(messageDeps(stmts, {
      getClaudeProviderSettings: () => ({ enabled: true, model: 'claude-opus-5', models: ['claude-opus-5'] }),
    }), { conversationId: `conv-${providerType}`, providerType: 'claude-cloud', model: 'claude-opus-5' });
    assert.equal(status, 409, providerType);
    assert.equal(body.code, 'CLAUDE_CLOUD_REQUIRES_NEW_CONVERSATION', providerType);
  }
});

test('a Claude conversation is not mistaken for a cloud one by its model id', async () => {
  const { stmts } = makeDb();
  seedConversation(stmts, { conversationId: 'conv-claude', providerType: 'claude', providerModel: 'claude-opus-5', cloudSource: null });
  const { status, body } = await send(messageDeps(stmts, {
    getClaudeProviderSettings: () => ({ enabled: true, model: 'claude-opus-5', models: ['claude-opus-5'] }),
  }), { conversationId: 'conv-claude', model: 'claude-opus-5' });
  assert.equal(body?.code, undefined);
  assert.equal(status, 404);
});

test('a cloud conversation sends with its pinned model, a tier suffix dropped, past every other guard', async () => {
  const { stmts } = makeDb();
  seedConversation(stmts);
  // The other providers list the same id: none of their guards may fire.
  const deps = messageDeps(stmts, {
    getOpenAIProviderSettings: () => ({ configured: true, enabled: true, model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'] }),
    getCursorProviderSettings: () => ({ enabled: true, model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'] }),
    getGrokProviderSettings: () => ({ enabled: true, model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'] }),
    getClaudeProviderSettings: () => { throw new Error('a cloud conversation never reads the Claude provider settings'); },
  });
  for (const model of ['claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', '', 'auto']) {
    const { status, body } = await send(deps, { conversationId: 'conv-cloud', model, text: `hello ${model}` });
    assert.equal(body?.code, undefined, model);
    assert.equal(status, 404, model);
    assert.equal(body.error, 'Conversation not found', model);
  }
});

test('a model the cloud does not offer is refused with the list', async () => {
  const { stmts } = makeDb();
  seedConversation(stmts);
  const { status, body } = await send(messageDeps(stmts), { conversationId: 'conv-cloud', model: 'gpt-5.4-mini' });
  assert.equal(status, 400);
  assert.equal(body.code, 'CLAUDE_CLOUD_MODEL_UNAVAILABLE');
  assert.deepEqual(body.supportedModels, ['claude-sonnet-5-5', 'claude-opus-5']);
});

test('the model can change until the cloud session exists, and is locked afterwards', async () => {
  const { stmts } = makeDb();
  seedConversation(stmts);
  const before = await send(messageDeps(stmts), { conversationId: 'conv-cloud', model: 'claude-opus-5' });
  assert.equal(before.body?.code, undefined);
  assert.equal(before.status, 404);

  stmts.updateRuntimeSessionClaudeCloudSession.run(SESSION_ID, '4', null, NOW, 'conv-cloud');
  const after = await send(messageDeps(stmts), { conversationId: 'conv-cloud', model: 'claude-opus-5' });
  assert.equal(after.status, 409);
  assert.equal(after.body.code, 'CLAUDE_CLOUD_MODEL_REQUIRES_NEW_CONVERSATION');
  const same = await send(messageDeps(stmts), { conversationId: 'conv-cloud', model: 'claude-sonnet-5-5' });
  assert.equal(same.status, 404);
});

// ─── worker report routes ────────────────────────────────────────────────────

function fakePlanUsageService() {
  const saved = [];
  return {
    saved,
    saveSnapshot: (provider, payload, meta) => { saved.push({ provider, payload, meta }); return true; },
  };
}

const CONTEXT_BODY = Object.freeze({
  model: 'claude-sonnet-5-5',
  contextUsage: { totalTokens: 1200, maxTokens: 200000 },
  modelUsage: { 'claude-sonnet-5-5': { inputTokens: 5, outputTokens: 6, costUSD: 0.02 } },
});

test('claude-context-usage takes a cloud conversation and still refuses the others', async () => {
  const { stmts } = makeDb();
  seedConversation(stmts);
  seedConversation(stmts, { conversationId: 'conv-claude', providerType: 'claude', cloudSource: null });
  seedConversation(stmts, { conversationId: 'conv-github', providerType: 'github', cloudSource: null });
  const deps = makeRouteDeps({ stmts });

  const cloud = await invokePost('/api/claude-context-usage', deps, { conversationId: 'conv-cloud', ...CONTEXT_BODY });
  assert.equal(cloud.status, 200);
  const stored = JSON.parse(stmts.getRuntimeSessionByConversation.get('conv-cloud').context_usage_json);
  assert.equal(stored.model, 'claude-sonnet-5-5');
  assert.deepEqual(stored.contextUsage, CONTEXT_BODY.contextUsage);

  assert.equal((await invokePost('/api/claude-context-usage', deps, { conversationId: 'conv-claude', ...CONTEXT_BODY })).status, 200);
  const github = await invokePost('/api/claude-context-usage', deps, { conversationId: 'conv-github', ...CONTEXT_BODY });
  assert.equal(github.status, 409);
  assert.equal(stmts.getRuntimeSessionByConversation.get('conv-github').context_usage_json, null);
});

test('claude-plan-usage keeps a cloud report under its own key, away from the Claude card', async () => {
  const { stmts } = makeDb();
  seedConversation(stmts);
  seedConversation(stmts, { conversationId: 'conv-claude', providerType: 'claude', cloudSource: null });
  seedConversation(stmts, { conversationId: 'conv-grok', providerType: 'grok', cloudSource: null });
  const planUsageService = fakePlanUsageService();
  const deps = makeRouteDeps({ stmts, planUsageService });
  const report = {
    usage: null,
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 5, outputTokens: 6, costUSD: 0.07 } },
    totalCostUsd: 0.07,
  };

  assert.equal((await invokePost('/api/claude-plan-usage', deps, { conversationId: 'conv-cloud', ...report })).status, 200);
  assert.equal((await invokePost('/api/claude-plan-usage', deps, { conversationId: 'conv-claude', ...report })).status, 200);
  assert.deepEqual(planUsageService.saved.map((entry) => entry.provider), ['claude-cloud', 'claude']);
  assert.equal(planUsageService.saved[0].payload.session.totalCostUsd, 0.07);

  const grok = await invokePost('/api/claude-plan-usage', deps, { conversationId: 'conv-grok', ...report });
  assert.equal(grok.status, 409);
  assert.equal(planUsageService.saved.length, 2);
});

test('the routes that are the Claude provider\'s own stay closed to a cloud conversation, except the usage limit', async () => {
  const { stmts } = makeDb();
  seedConversation(stmts);
  const recorded = [];
  const deps = makeRouteDeps({
    stmts,
    usageLimitPauseService: { recordReport: (report) => { recorded.push(report); return {}; } },
  });

  const native = await invokePost('/api/claude-native-session', deps, { conversationId: 'conv-cloud', claudeNativeSessionId: 'native-1' });
  assert.equal(native.status, 409);
  assert.equal(stmts.getRuntimeSessionByConversation.get('conv-cloud').claude_native_session_id, null);

  // The usage limit is the account's: a cloud chat runs on the same account
  // and reports the same limit, so its worker may write it.
  const limit = await invokePost('/api/claude-usage-limit', deps, { conversationId: 'conv-cloud', report: { status: 'rejected' } });
  assert.equal(limit.status, 200);
  assert.deepEqual(recorded, [{ report: { status: 'rejected' } }]);

  const continuation = await invokePost('/api/continuation-turn', deps, { conversationId: 'conv-cloud' });
  assert.equal(continuation.status, 409);
  assert.match(continuation.body.error, /not supported for claude-cloud conversations/);
});
