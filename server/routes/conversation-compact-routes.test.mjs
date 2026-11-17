// Both ways to compact a conversation: POST /api/conversation/:id/compact and
// a "/compact" message. A compact its provider refuses answers 409 with the
// reason and emits nothing; a missing conversation answers 404.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { registerConversationLifecycleRoutes } from './conversation-lifecycle-routes.mjs';
import { captureRoutes, invokeRoute, makeRouteDeps, recordingIo } from './messages-routes-test-harness.mjs';

const SOURCE = 'conv-fixture-source';
const TARGET = 'conv-fixture-target';

const REFUSED = Object.freeze({
  ok: false,
  status: 409,
  code: 'COPILOT_SWITCHED_OFF',
  error: 'Copilot is switched off on this relay, so this chat was not compacted. Nothing was changed. Switch it on in Settings → Providers → Copilot.',
  provider: 'github',
});

const COMPACTED = Object.freeze({
  sourceConversationId: SOURCE,
  targetConversationId: TARGET,
  runtimeSessionId: 'runtime-fixture-target',
  summarySeed: 'Conversation title: Release checklist',
  createdAt: '2026-11-17T09:00:00.000Z',
  targetTitle: 'Release checklist (compacted)',
});

// The lifecycle routes prepare their statements when registered.
function schemaDb() {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function compactWith(answer) {
  const calls = [];
  return { calls, createCompactedConversation: (id) => { calls.push(id); return answer; } };
}

async function compactByRoute(answer) {
  const { events, io } = recordingIo();
  const { calls, createCompactedConversation } = compactWith(answer);
  const routes = captureRoutes(makeRouteDeps({ io, db: schemaDb(), createCompactedConversation }), (app, deps) => registerConversationLifecycleRoutes(app, deps, {}));
  const result = await invokeRoute(routes, 'POST', '/api/conversation/:id/compact', { params: { id: SOURCE } });
  return { ...result, events, calls };
}

async function compactByMessage(answer) {
  const { events, io } = recordingIo();
  const { calls, createCompactedConversation } = compactWith(answer);
  const routes = captureRoutes(makeRouteDeps({ io, createCompactedConversation }));
  const result = await invokeRoute(routes, 'POST', '/api/message', { body: { clientId: 'client-1', conversationId: SOURCE, text: '/compact' } });
  return { ...result, events, calls };
}

const REFUSAL_BODY = {
  ok: false,
  code: REFUSED.code,
  error: REFUSED.error,
  provider: 'github',
  conversationId: SOURCE,
  compacted: false,
};

test('the compact route: a refused compact answers 409 with the reason and emits nothing', async () => {
  const { status, body, events, calls } = await compactByRoute(REFUSED);
  assert.equal(status, 409);
  assert.deepEqual(body, REFUSAL_BODY);
  assert.deepEqual(events, []);
  assert.deepEqual(calls, [SOURCE]);
});

test('the "/compact" message: a refused compact answers 409 with the reason and emits nothing', async () => {
  const { status, body, events, calls } = await compactByMessage(REFUSED);
  assert.equal(status, 409);
  assert.deepEqual(body, { ...REFUSAL_BODY, command: 'compact' });
  assert.deepEqual(events, []);
  assert.deepEqual(calls, [SOURCE]);
});

test('the compact route: a compact answers the new conversation and emits it', async () => {
  const { status, body, events } = await compactByRoute(COMPACTED);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.compactedConversationId, TARGET);
  assert.equal(body.conversationId, TARGET);
  assert.equal(body.runtimeSessionId, 'runtime-fixture-target');
  assert.deepEqual(events, [{ event: 'conversation_compacted', payload: COMPACTED }]);
});

test('the "/compact" message: a compact answers the new conversation and emits it', async () => {
  const { status, body, events } = await compactByMessage(COMPACTED);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.compacted, true);
  assert.equal(body.compactedConversationId, TARGET);
  assert.deepEqual(events, [{ event: 'conversation_compacted', payload: COMPACTED }]);
});

test('both: an unknown conversation answers 404 and emits nothing', async () => {
  for (const compact of [compactByRoute, compactByMessage]) {
    const { status, body, events } = await compact(null);
    assert.equal(status, 404);
    assert.deepEqual(body, { error: 'Conversation not found' });
    assert.deepEqual(events, []);
  }
});
