import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';

import {
  crossesPlanBoundaryOfLiveTurn,
  dequeuePendingMessage,
} from './messages-worker-claim-routes.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository, PLAN_BOUNDARY_HOLD_MARK } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { applySchema } from '../db-schema.mjs';

// A message is steered into a running turn when the worker takes it while
// that turn is live, and the worker then switches the turn's mode to the
// message's. Across plan mode that changes what the running turn may do, so
// the claim holds such a message until the live turn has ended (a
// click on "Approve plan" while the plan turn still runs). The hold is part of
// every claim query: other conversations' rows are claimed meanwhile, and the
// held conversation keeps its order.

const X = 'conv-boundary-x';
const Y = 'conv-boundary-y';
const WORKER = 'worker-1';
const NOW = '2026-01-01T00:00:00.000Z';
const LATER = new Date(Date.parse(NOW) + 3_600_000).toISOString();

function boot() {
  const db = new Database(':memory:');
  applySchema(db);
  for (const id of [X, Y]) {
    db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`)
      .run(id, 'Boundary', id, NOW, NOW);
  }
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  let clock = 0;
  const queue = (id, relayMode, { conversationId = X, status = 'pending', owner = null } = {}) => {
    clock += 1;
    const at = new Date(Date.parse(NOW) + clock * 1000).toISOString();
    db.prepare(`INSERT INTO queue (id, conversation_id, text, relay_mode, status, timestamp, processing_at, owner_sdk_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, conversationId, `text of ${id}`, relayMode, status, at, status === 'processing' ? at : null, owner);
  };
  // The claim of conversation X's worker (its session id is X's own id),
  // unless the test names another session.
  const claim = (options = {}) => dequeuePendingMessage({ db, stmts, nowIso: LATER, requesterSessionId: X, ...options })?.id || null;
  const status = (id) => stmts.findQById.get(id)?.status;
  return { db, stmts, queue, claim, status };
}

// The claim of a worker that owns rows of both conversations.
const claimAsWorker = (fx) => fx.claim({ requesterSessionId: WORKER });

test('an "Approve plan" follow-up waits for the running plan turn instead of steering into it', () => {
  const fx = boot();
  fx.queue('plan-turn', 'plan', { status: 'processing' });
  fx.queue('approve-followup', 'agent');
  assert.equal(fx.claim(), null, 'held while the plan turn runs');
  assert.equal(fx.status('approve-followup'), 'pending');
  fx.stmts.setDone.run('{}', 'plan-turn');
  assert.equal(fx.claim(), 'approve-followup', 'its own turn once the plan turn ended');
});

test('a plan message waits for a running write turn instead of flipping it to plan', () => {
  const fx = boot();
  fx.queue('approve-turn', 'agent', { status: 'processing' });
  fx.queue('owner-plan', 'plan');
  assert.equal(fx.claim(), null);
  fx.stmts.setDone.run('{}', 'approve-turn');
  assert.equal(fx.claim(), 'owner-plan');
});

test('a message on the same side of plan mode steers as before', () => {
  const fx = boot();
  fx.queue('agent-turn', 'agent', { status: 'processing' });
  fx.queue('autopilot-steer', 'autopilot');
  assert.equal(fx.claim(), 'autopilot-steer');

  const plan = boot();
  plan.queue('plan-turn', 'plan', { status: 'processing' });
  plan.queue('plan-steer', 'plan');
  assert.equal(plan.claim(), 'plan-steer');
});

test('(a) while one conversation\'s row is held, another\'s is claimed', () => {
  const fx = boot();
  fx.queue('x-plan-turn', 'plan', { status: 'processing', owner: WORKER });
  fx.queue('x-held', 'agent', { owner: WORKER });
  fx.queue('y-row', 'agent', { conversationId: Y, owner: WORKER });
  assert.equal(claimAsWorker(fx), 'y-row');
  assert.equal(fx.status('x-held'), 'pending');
});

test('(b) a later row of the held conversation does not overtake the held one, whatever its mode', () => {
  const fx = boot();
  fx.queue('x-plan-turn', 'plan', { status: 'processing', owner: WORKER });
  fx.queue('x-held', 'agent', { owner: WORKER });
  fx.queue('x-later-plan', 'plan', { owner: WORKER });
  assert.equal(claimAsWorker(fx), null);
  fx.stmts.setDone.run('{}', 'x-plan-turn');
  assert.equal(claimAsWorker(fx), 'x-held', 'the order is kept');
});

test('(c) the held row is claimed once the live turn ends, however it ends', () => {
  const ends = {
    finalized: (fx) => fx.stmts.setDone.run('{}', 'x-plan-turn'),
    stopped: (fx) => fx.stmts.setFailed.run('{"kind":"turn-aborted"}', 'x-plan-turn'),
    cancelled: (fx) => fx.db.prepare(`UPDATE queue SET status = 'cancelled' WHERE id = ?`).run('x-plan-turn'),
    'stuck-turn recovery': (fx) => fx.stmts.recoverStale.run(null, LATER),
  };
  for (const [name, end] of Object.entries(ends)) {
    const fx = boot();
    fx.queue('x-plan-turn', 'plan', { status: 'processing' });
    fx.queue('x-held', 'agent');
    assert.equal(fx.claim(), null, name);
    end(fx);
    // A recovered turn goes back into the queue ahead of the held row.
    if (fx.status('x-plan-turn') === 'pending') {
      assert.equal(fx.claim(), 'x-plan-turn', `${name}: the older turn first`);
      fx.stmts.setDone.run('{}', 'x-plan-turn');
    }
    assert.equal(fx.claim(), 'x-held', name);
  }
});

test('(c) a requeued live turn runs again first, then the held row', () => {
  const fx = boot();
  fx.queue('x-plan-turn', 'plan', { status: 'processing', owner: WORKER });
  fx.queue('x-held', 'agent', { owner: WORKER });
  assert.equal(fx.claim({ requesterSessionId: WORKER }), null);
  fx.stmts.recoverProcessingRowKeepOwner.run(null, 'x-plan-turn');
  assert.equal(fx.claim({ requesterSessionId: WORKER }), 'x-plan-turn');
  assert.equal(fx.claim({ requesterSessionId: WORKER }), null, 'held again behind the re-run');
  fx.stmts.setDone.run('{}', 'x-plan-turn');
  assert.equal(fx.claim({ requesterSessionId: WORKER }), 'x-held');
});

test('another conversation\'s live turn holds nothing', () => {
  const fx = boot();
  fx.queue('y-plan-turn', 'plan', { conversationId: Y, status: 'processing' });
  fx.queue('x-agent', 'agent');
  assert.equal(fx.claim(), 'x-agent');
});

test('every claim query carries the hold', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const repository = createMessageRepository(db);
  const claims = Object.entries(repository)
    .filter(([name, stmt]) => /^findPending/.test(name) && stmt?.source && /FROM queue\b/.test(stmt.source) && /status = 'pending'/.test(stmt.source));
  assert.deepEqual(claims.map(([name]) => name).sort(), ['findPendingForWorker']);
  for (const [name, stmt] of claims) assert.ok(stmt.source.includes(PLAN_BOUNDARY_HOLD_MARK), name);
  // The route files prepare no claim of their own.
  for (const file of [
    './messages-routes.mjs',
    './messages-helpers.mjs',
    './messages-queue-failure.mjs',
    './messages-worker-report-routes.mjs',
    './messages-worker-claim-routes.mjs',
    './messages-worker-output-routes.mjs',
    './messages-intake-routes.mjs',
    './file-routes.mjs',
  ]) {
    const routes = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(routes.includes('planBoundaryHoldSql('), false, file);
  }
});

test('fail closed: a claim statement without the hold still never hands out a held row', () => {
  const fx = boot();
  fx.queue('x-plan-turn', 'plan', { status: 'processing' });
  fx.queue('x-held', 'agent');
  // The worker claim's parameters (time, session), without the hold.
  const unguarded = fx.db.prepare(`SELECT * FROM queue WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND conversation_id = ? ORDER BY timestamp ASC, rowid ASC LIMIT 1`);
  const stmts = { ...fx.stmts, findPendingForWorker: unguarded };
  assert.equal(dequeuePendingMessage({ db: fx.db, stmts, nowIso: LATER, requesterSessionId: X }), null);
  assert.equal(fx.status('x-held'), 'pending');
});

test('the row check needs a conversation and the processing-rows statement', () => {
  assert.equal(crossesPlanBoundaryOfLiveTurn({ stmts: {}, row: { id: 'a', conversation_id: X, relay_mode: 'agent' } }), false);
  assert.equal(crossesPlanBoundaryOfLiveTurn({ stmts: { listProcessingQueueByConversation: { all: () => [{ id: 'b', relay_mode: 'plan' }] } }, row: { id: 'a' } }), false);
  // A row is not held by itself.
  assert.equal(crossesPlanBoundaryOfLiveTurn({
    stmts: { listProcessingQueueByConversation: { all: () => [{ id: 'a', relay_mode: 'plan' }] } },
    row: { id: 'a', conversation_id: X, relay_mode: 'agent' },
  }), false);
});

test('a row without a mode runs as agent, so the hold treats it as a writing mode', () => {
  // queue.relay_mode is NOT NULL DEFAULT 'agent': a row cannot be stored
  // without a mode, and an empty one is delivered as DEFAULT_RELAY_MODE
  // ('agent'), as the hold reads it.
  const live = boot();
  assert.throws(() => live.queue('x-null-turn', null, { status: 'processing' }), /NOT NULL/);
  live.db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, processing_at) VALUES ('x-default-turn', ?, 'go', 'processing', ?, ?)`).run(X, NOW, NOW);
  assert.equal(live.status('x-default-turn'), 'processing');
  assert.equal(live.stmts.findQById.get('x-default-turn').relay_mode, 'agent');
  live.queue('x-plan', 'plan');
  assert.equal(live.claim(), null, 'a plan row waits for a live turn stored without a mode');
  live.stmts.setDone.run('{}', 'x-default-turn');
  live.queue('x-empty-turn', '', { status: 'processing' });
  assert.equal(live.claim(), null, 'or with an empty one');
  live.queue('x-agent-steer', 'agent', { conversationId: Y });
  assert.equal(live.claim({ requesterSessionId: Y }), 'x-agent-steer');

  const pending = boot();
  pending.queue('x-plan-turn', 'plan', { status: 'processing' });
  pending.queue('x-empty', '');
  assert.equal(pending.claim(), null, 'a row with an empty mode waits for a live plan turn');
  pending.stmts.setDone.run('{}', 'x-plan-turn');
  assert.equal(pending.claim(), 'x-empty');

  const same = boot();
  same.queue('x-agent-turn', 'agent', { status: 'processing' });
  same.queue('x-empty', '');
  assert.equal(same.claim(), 'x-empty', 'beside a writing turn it steers as before');
});