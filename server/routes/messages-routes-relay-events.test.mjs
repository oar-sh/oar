// Relay events in the message routes: an event row reaches the worker marked
// as one, the background-task routes feed the activity tracker, and a turn's
// end, failure and stop reach the event service.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { RELAY_EVENT_MESSAGE_KIND } from '../../shared/relay-events.mjs';
import { RELAY_SCHEDULE_MESSAGE_KIND } from '../../shared/relay-schedules.mjs';
import { buildDequeuedRelayMessage } from './messages-routes.mjs';
import { captureRoutes, invokeRoute, makeRouteDeps } from './messages-routes-test-harness.mjs';

const NOW = '2026-03-02T10:00:00.000Z';

function setupDb() {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-fixture-watcher', 'watcher', ?, ?)`).run(NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, created_at, last_used_at)
    VALUES ('rs-1', 'conv-fixture-watcher', 'sdk-fixture-watcher', 'key-1', 'claude-sonnet-5', 'claude', ?, ?)
  `).run(NOW, NOW);
  return { db, stmts };
}

function dequeue(stmts, id) {
  return buildDequeuedRelayMessage({
    msg: { id, conversation_id: 'conv-fixture-watcher', runtime_session_id: 'rs-1', is_new_conversation: 0, model: 'claude-sonnet-5', text: 'x', status: 'processing', timestamp: NOW },
    stmts,
    normalizeRelayMode: (value) => String(value || '').trim() || null,
    defaultRelayMode: 'agent',
    defaultModel: 'claude-sonnet-5',
  });
}

test('an event row is delivered marked as one; a message of the user is not', () => {
  const { db, stmts } = setupDb();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp, kind) VALUES ('q-event', 'conv-fixture-watcher', 'user', 'x', ?, ?)`).run(NOW, RELAY_EVENT_MESSAGE_KIND);
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('q-user', 'conv-fixture-watcher', 'user', 'x', ?)`).run(NOW);
  assert.equal(dequeue(stmts, 'q-event').messageKind, RELAY_EVENT_MESSAGE_KIND);
  assert.equal('messageKind' in dequeue(stmts, 'q-user'), false);
});

test('a scheduled prompt is delivered marked as the relay\'s, like an event; other kinds are not named', () => {
  const { db, stmts } = setupDb();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp, kind) VALUES ('q-schedule', 'conv-fixture-watcher', 'user', 'x', ?, ?)`).run(NOW, RELAY_SCHEDULE_MESSAGE_KIND);
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp, kind) VALUES ('q-limit', 'conv-fixture-watcher', 'user', 'x', ?, 'claude-usage-limit')`).run(NOW);
  assert.equal(dequeue(stmts, 'q-schedule').messageKind, RELAY_SCHEDULE_MESSAGE_KIND);
  assert.equal('messageKind' in dequeue(stmts, 'q-limit'), false);
});

test('the task routes feed the tracker by conversation, with how a task ended', async () => {
  const sets = [];
  const settled = [];
  const changes = [];
  const routes = captureRoutes(makeRouteDeps({
    backgroundTaskStore: { replace() {}, get: () => [] },
    io: { emit() {} },
    resolveConversationRecord: ({ sdkSessionId }) => (sdkSessionId === 'sdk-fixture-watcher' ? { id: 'conv-fixture-watcher' } : null),
    sessionActivityTracker: {
      noteTaskSet: (conversationId, tasks) => sets.push({ conversationId, tasks }),
      noteTaskSettled: (conversationId, detail) => settled.push({ conversationId, ...detail }),
      noteSubagentRun() {},
      touch() {},
    },
    relayEventService: { afterStateChange: (id) => changes.push(id) },
  }));
  const posted = await invokeRoute(routes, 'POST', '/api/background-tasks', {
    body: { conversationId: 'sdk-fixture-watcher', tasks: [{ taskId: 'task-1', taskType: 'local_bash', description: 'npm test' }] },
  });
  assert.equal(posted.status, 200);
  assert.equal(sets[0].conversationId, 'conv-fixture-watcher');
  assert.equal(sets[0].tasks[0].description, 'npm test');
  const done = await invokeRoute(routes, 'POST', '/api/background-task-settled', {
    body: { conversationId: 'sdk-fixture-watcher', taskId: 'task-1', status: 'failed', summary: 'Exit code 2', toolUseId: 'toolu_fixture_shell' },
  });
  assert.equal(done.status, 200);
  assert.deepEqual(settled[0], { conversationId: 'conv-fixture-watcher', taskId: 'task-1', toolUseId: 'toolu_fixture_shell', status: 'failed', summary: 'Exit code 2', exitCode: null });
  assert.deepEqual(changes, ['conv-fixture-watcher', 'conv-fixture-watcher']);
  const missing = await invokeRoute(routes, 'POST', '/api/background-task-settled', { body: { conversationId: 'sdk-fixture-watcher' } });
  assert.equal(missing.status, 400);
});
