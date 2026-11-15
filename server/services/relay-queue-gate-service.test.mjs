import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createMessageRepository } from '../repositories/message-repository.mjs';
import { applySchema } from '../db-schema.mjs';
import { reportParkedQueueAtBoot } from './relay-queue-gate-service.mjs';

const CONV = 'conv-gate-3b9e';
const CREATED = '2026-01-01T00:00:00.000Z';

function createFixture() {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`
    INSERT INTO conversations (id, title, status, created_at, updated_at)
    VALUES (?, 'Gate report', 'active', ?, ?)
  `).run(CONV, CREATED, CREATED);
  const stmts = createMessageRepository(db);
  const insertRow = db.prepare(`
    INSERT INTO queue (id, conversation_id, text, status, timestamp, parked_at, parked_transaction_id)
    VALUES (?, ?, 'hello', ?, ?, ?, ?)
  `);
  const statusOf = (id) => db.prepare(`SELECT status FROM queue WHERE id = ?`).get(id)?.status;
  return { db, stmts, insertRow, statusOf };
}

test('boot report with no parked rows logs nothing', () => {
  const fx = createFixture();
  fx.insertRow.run('q-gate-pending-1', CONV, 'pending', CREATED, null, null);
  const lines = [];

  const report = reportParkedQueueAtBoot({ stmts: fx.stmts, log: (line) => lines.push(line) });

  assert.deepEqual(report, { count: 0, oldestParkedAt: null });
  assert.deepEqual(lines, []);
  assert.equal(fx.statusOf('q-gate-pending-1'), 'pending');
});

test('boot report counts parked rows, names the oldest and changes no row', () => {
  const fx = createFixture();
  fx.insertRow.run('q-gate-parked-1', CONV, 'parked', '2026-01-03T00:00:00.000Z', '2026-01-04T08:00:00.000Z', 'tx-gate-1');
  // No parked_at: the row's own timestamp stands in.
  fx.insertRow.run('q-gate-parked-2', CONV, 'parked', '2026-01-02T09:30:00.000Z', null, null);
  fx.insertRow.run('q-gate-parked-3', CONV, 'parked', '2026-01-05T00:00:00.000Z', '2026-01-05T12:00:00.000Z', 'tx-gate-2');
  fx.insertRow.run('q-gate-pending-1', CONV, 'pending', '2026-01-01T00:00:00.000Z', null, null);
  const lines = [];

  const report = reportParkedQueueAtBoot({ stmts: fx.stmts, log: (line) => lines.push(line) });

  assert.deepEqual(report, { count: 3, oldestParkedAt: '2026-01-02T09:30:00.000Z' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\b3 parked message/);
  assert.ok(lines[0].includes('2026-01-02T09:30:00.000Z'), lines[0]);
  assert.match(lines[0], /stay parked/);
  for (const id of ['q-gate-parked-1', 'q-gate-parked-2', 'q-gate-parked-3']) {
    assert.equal(fx.statusOf(id), 'parked', `${id} is still parked`);
  }
  assert.equal(fx.statusOf('q-gate-pending-1'), 'pending');
  const kept = fx.db.prepare(`SELECT parked_transaction_id FROM queue WHERE id = ?`).get('q-gate-parked-1');
  assert.equal(kept.parked_transaction_id, 'tx-gate-1');
});

test('boot report without statements or a logger is safe', () => {
  assert.deepEqual(reportParkedQueueAtBoot(), { count: 0, oldestParkedAt: null });
  const fx = createFixture();
  fx.insertRow.run('q-gate-parked-1', CONV, 'parked', CREATED, CREATED, null);
  assert.deepEqual(reportParkedQueueAtBoot({ stmts: fx.stmts }), { count: 1, oldestParkedAt: CREATED });
});
