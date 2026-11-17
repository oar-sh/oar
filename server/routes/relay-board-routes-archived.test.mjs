import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { registerRelayBoardRoutes } from './relay-board-routes.mjs';
import { makeRouteDeps, captureRoutes, invokeRoute } from './messages-routes-test-harness.mjs';
import { dequeuePendingMessage } from './messages-worker-claim-routes.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';

// A board card outlives its chat's archive, so a press from the Inbox can
// queue a follow-up into an archived chat: the press brings the chat back,
// says so once, and the follow-up is claimed. The message and its row are
// one write.

const CONV = 'conv-board-archived-1';
const NOW = '2026-11-16T09:00:00.000Z';

function boot({ insertQ = null } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, archived, created_at, updated_at)
    VALUES (?, 'Board', ?, 'active', 1, ?, ?)
  `).run(CONV, CONV, NOW, NOW);
  const real = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  const stmts = insertQ ? { ...real, insertQ } : real;
  // The plan turn that posted the card, done before the archive.
  db.prepare(`INSERT INTO queue (id, conversation_id, text, relay_mode, status, timestamp) VALUES ('q-plan', ?, 'plan it', 'plan', 'done', ?)`).run(CONV, NOW);
  stmts.insertBoard.run(
    'board-1', 'q-plan', CONV, 'q-plan', 'plan_ready', 'plan', 'Plan ready for review', '1. Rename the module',
    JSON.stringify([{ id: 'autopilot', label: 'Implement in autopilot', mode: 'autopilot' }, { id: 'exit_only', label: 'Stop here' }]),
    null, null, NOW, NOW,
  );
  const emitted = [];
  const cloudUnarchives = [];
  const deps = makeRouteDeps({
    db,
    stmts,
    io: { emit: (event, payload) => emitted.push({ event, payload }) },
    uuidv4: () => 'follow-up-1',
    DEFAULT_RELAY_MODE: 'agent',
    DEFAULT_MODEL: 'model-a',
    normalizeRelayMode: (value) => {
      const mode = String(value || '').trim().toLowerCase();
      return ['plan', 'ask', 'agent', 'autopilot'].includes(mode) ? mode : null;
    },
    resolveRequestedModel: (model) => ({ ok: true, model, modelVariantId: model, reasoningEffort: null }),
    formatRelayBoardRow: (row) => (row ? {
      id: row.id,
      conversationId: row.conversation_id,
      boardType: row.board_type,
      mode: row.relay_mode,
      title: row.title,
      status: row.status,
      actions: JSON.parse(row.actions_json || '[]'),
    } : null),
    claudeCloudSessionService: {
      unarchiveSessionInBackground: (args) => { cloudUnarchives.push(args); return false; },
    },
  });
  const routes = captureRoutes(deps, registerRelayBoardRoutes);
  const act = (actionId) => invokeRoute(routes, 'POST', '/api/relay-board/:id/action', {
    params: { id: 'board-1' },
    body: { actionId, clientId: 'page-1' },
  });
  const archivedFlag = () => db.prepare(`SELECT archived FROM conversations WHERE id = ?`).get(CONV).archived;
  const unarchiveEvents = () => emitted.filter((entry) => entry.event === 'conversation_archived');
  const followUpMessage = () => db.prepare(`SELECT id FROM messages WHERE id = 'follow-up-1'`).get() || null;
  const claim = () => dequeuePendingMessage({ db, stmts, nowIso: new Date().toISOString(), requesterSessionId: CONV });
  return { db, stmts, emitted, cloudUnarchives, act, archivedFlag, unarchiveEvents, followUpMessage, claim };
}

test('a press on the card of an archived chat unarchives it, says so once, and the follow-up is claimed', async () => {
  const app = boot();
  const { status, body } = await app.act('autopilot');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.queuedMessageId, 'follow-up-1');
  assert.equal(app.archivedFlag(), 0);
  assert.deepEqual(app.unarchiveEvents().map((entry) => entry.payload), [{ conversationId: CONV, archived: false }]);
  const events = app.emitted.map((entry) => entry.event);
  assert.ok(events.indexOf('conversation_archived') < events.indexOf('user_message'), events.join(','));
  assert.equal(app.cloudUnarchives.length, 1);
  assert.equal(app.cloudUnarchives[0].conversationId, CONV);
  assert.equal(app.claim()?.id, 'follow-up-1');
});

test('"Stop here" queues nothing and leaves the chat archived', async () => {
  const app = boot();
  const { status } = await app.act('exit_only');
  assert.equal(status, 200);
  assert.equal(app.archivedFlag(), 1);
  assert.deepEqual(app.unarchiveEvents(), []);
  assert.equal(app.claim(), null);
});

test('a queue insert that fails leaves neither the follow-up message nor an unarchived chat', async () => {
  const app = boot({ insertQ: { run: () => { throw new Error('queue insert failed'); } } });
  await assert.rejects(() => app.act('autopilot'), /queue insert failed/);
  assert.equal(app.followUpMessage(), null);
  assert.equal(app.archivedFlag(), 1);
  assert.deepEqual(app.unarchiveEvents(), []);
  assert.deepEqual(app.cloudUnarchives, []);
});

test('a queue write that fails leaves the card pending, and the next press queues the follow-up', async () => {
  const failing = { run: () => { throw new Error('queue insert failed'); } };
  const app = boot({ insertQ: failing });
  const cardStatus = () => app.db.prepare(`SELECT status FROM relay_boards WHERE id = 'board-1'`).get().status;
  await assert.rejects(() => app.act('autopilot'), /queue insert failed/);
  assert.equal(cardStatus(), 'pending');
  assert.equal(app.emitted.filter((entry) => entry.event.startsWith('relay_board')).length, 0);

  app.stmts.insertQ = createMessageRepository(app.db).insertQ;
  const { status, body } = await app.act('autopilot');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.queuedMessageId, 'follow-up-1');
  assert.equal(cardStatus(), 'acted');
  assert.equal(app.claim()?.id, 'follow-up-1');
});
