import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createSdkMessageNormalizer } from './sdk-message-normalizer.mjs';
import { createClaudeTurnPublisher } from './claude-turn-publisher.mjs';
import {
  makeRouteDeps as baseRouteDeps,
  captureRoutes,
  makeApi,
} from '../routes/messages-routes-test-harness.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { applySchema } from '../db-schema.mjs';
import {
  compactBoundaryFromActivities,
  isCompactBoundaryActivityEntry,
  normalizeRelayActivityEntry,
} from '../public/app/activity-replay-state.mjs';

// End-to-end for the compaction break's data path: the SDK's compact_boundary
// message → the normalizer's structured activity payload → the turn publisher's
// POST → the REAL /api/activity handler against a REAL database (production
// schema and migrations via applySchema) → the persisted row and the socket
// payload → the client-side entry the transcript reads to place the break row.
//
// The token counts were computed and dropped on the floor before this pass
// (claude-turn-publisher only forwarded text + subagentRunId), so every leg
// here is load-bearing.

const CONV = 'conv-compact-1';
const QUEUE_ID = 'queue-compact-1';
const RESPONSE_ID = 'msg-compact-response-1';
const NOW = '2026-08-20T10:00:00.000Z';

function bootRelay() {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(CONV, 'Compaction', CONV, NOW, NOW);
  db.prepare(`
    INSERT INTO queue (id, conversation_id, relay_mode, text, status, timestamp, response_message_id)
    VALUES (?, ?, 'agent', 'hello', 'processing', ?, ?)
  `).run(QUEUE_ID, CONV, NOW, RESPONSE_ID);

  const stmts = {
    ...createSessionRepository(db),
    ...createMessageRepository(db),
    ...createQuestionRepository(db),
  };
  const emitted = [];
  const deps = baseRouteDeps({
    db,
    stmts,
    io: {
      emit: (event, payload) => emitted.push({ event, payload }),
      volatile: { emit: () => {} },
    },
    DEFAULT_RELAY_MODE: 'agent',
    sanitizeActivityText: (value) => String(value || '').trim().slice(0, 4000),
  });
  const api = makeApi(captureRoutes(deps));
  return { db, stmts, emitted, api };
}

function compactBoundaryMessage(preTokens, postTokens) {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { pre_tokens: preTokens, post_tokens: postTokens },
  };
}

test('a compaction boundary reaches the client as structured metadata, not just prose', async () => {
  const { db, stmts, emitted, api } = bootRelay();
  const normalizer = createSdkMessageNormalizer();
  const publisher = createClaudeTurnPublisher({ api });

  const actions = normalizer.normalize(compactBoundaryMessage(120000, 40000));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].channel, 'activity');
  assert.equal(actions[0].payload.text, 'Context compacted (120k → 40k tokens)');
  assert.deepEqual(actions[0].payload.metadata, {
    kind: 'compact_boundary',
    preTokens: 120000,
    postTokens: 40000,
  });

  const message = { id: QUEUE_ID, conversationId: CONV, relayMode: 'agent' };
  for (const action of actions) await publisher.dispatchAction(message, action, {});

  // Persisted: the structured payload lands in relay_activity.metadata_json and
  // comes back out of the same selects the transcript load path uses.
  const rows = stmts.listActivityByQueueMessage.all(QUEUE_ID);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].metadata_json), {
    kind: 'compact_boundary',
    preTokens: 120000,
    postTokens: 40000,
  });
  const linkedRows = stmts.listActivityByResponse.all(RESPONSE_ID);
  assert.equal(linkedRows.length, 1);
  assert.equal(linkedRows[0].metadata_json, rows[0].metadata_json);

  // Live: the socket payload carries it too, so the break appears without a
  // reload once the assistant row exists.
  const activityEvents = emitted.filter((entry) => entry.event === 'relay_activity');
  assert.equal(activityEvents.length, 1);
  assert.deepEqual(activityEvents[0].payload.metadata, {
    kind: 'compact_boundary',
    preTokens: 120000,
    postTokens: 40000,
  });

  // Client: both shapes normalize to an entry the transcript recognizes, and
  // the boundary the separator pass stamps on the message node.
  for (const source of [
    activityEvents[0].payload,
    { text: rows[0].text, subagentRunId: rows[0].subagent_run_id, metadata: JSON.parse(rows[0].metadata_json) },
  ]) {
    const entry = normalizeRelayActivityEntry(source);
    assert.equal(isCompactBoundaryActivityEntry(entry), true);
    assert.deepEqual(compactBoundaryFromActivities([{ text: 'Tool (bash)' }, entry]), {
      preTokens: 120000,
      postTokens: 40000,
    });
  }
  db.close();
});

test('ordinary activity rows stay metadata-free and are not mistaken for breaks', async () => {
  const { db, stmts, emitted, api } = bootRelay();
  const publisher = createClaudeTurnPublisher({ api });

  await publisher.dispatchAction(
    { id: QUEUE_ID, conversationId: CONV, relayMode: 'agent' },
    { channel: 'activity', payload: { text: 'Tool (bash) ls', subagentRunId: null } },
    {},
  );

  const rows = stmts.listActivityByQueueMessage.all(QUEUE_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].metadata_json, null);
  assert.equal(emitted.find((entry) => entry.event === 'relay_activity').payload.metadata, undefined);
  assert.equal(isCompactBoundaryActivityEntry({ text: 'Tool (bash) ls' }), false);
  assert.equal(compactBoundaryFromActivities([{ text: 'Tool (bash) ls' }]), null);
  db.close();
});

test('the route refuses metadata that is not a small tagged object', async () => {
  const { db, stmts, api } = bootRelay();

  await api('POST', '/api/activity', {
    messageId: QUEUE_ID,
    conversationId: CONV,
    mode: 'agent',
    text: 'first',
    metadata: { preTokens: 1 },
  });
  await api('POST', '/api/activity', {
    messageId: QUEUE_ID,
    conversationId: CONV,
    mode: 'agent',
    text: 'second',
    metadata: { kind: 'compact_boundary', blob: 'x'.repeat(4096) },
  });
  await api('POST', '/api/activity', {
    messageId: QUEUE_ID,
    conversationId: CONV,
    mode: 'agent',
    text: 'third',
    metadata: 'compact_boundary',
  });

  const rows = stmts.listActivityByQueueMessage.all(QUEUE_ID);
  assert.deepEqual(rows.map((row) => row.metadata_json), [null, null, null]);
  db.close();
});
