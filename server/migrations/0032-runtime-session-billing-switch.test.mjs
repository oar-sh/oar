import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  RUNTIME_SESSION_BILLING_SWITCH_COLUMNS,
  migrateRuntimeSessionBillingSwitch,
  runtimeSessionBillingSwitchProblem,
} from './0032-runtime-session-billing-switch.mjs';
import { applySchema } from '../db-schema.mjs';

test('adds the two columns once; an existing session has never switched', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE runtime_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, provider_type TEXT NOT NULL DEFAULT 'github')`);
  db.prepare(`INSERT INTO runtime_sessions (id, conversation_id, provider_type) VALUES ('rs-1', 'conv-1', 'claude')`).run();
  assert.equal(runtimeSessionBillingSwitchProblem(db), 'runtime_sessions lacks billing_switched_at, billing_switched_by');
  assert.deepEqual(migrateRuntimeSessionBillingSwitch(db), { applied: true, columnsAdded: 2 });
  assert.equal(runtimeSessionBillingSwitchProblem(db), '');
  const row = db.prepare(`SELECT ${RUNTIME_SESSION_BILLING_SWITCH_COLUMNS.map(([name]) => name).join(', ')} FROM runtime_sessions`).get();
  assert.deepEqual({ ...row }, { billing_switched_at: null, billing_switched_by: null });
  assert.deepEqual(migrateRuntimeSessionBillingSwitch(db), { applied: false, columnsAdded: 0 });
});

test('a database without runtime_sessions is left alone', () => {
  const db = new Database(':memory:');
  assert.equal(runtimeSessionBillingSwitchProblem(db), 'no runtime_sessions table');
  assert.deepEqual(migrateRuntimeSessionBillingSwitch(db), { applied: false, columnsAdded: 0 });
});

test('the schema boot applies the migration', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(runtimeSessionBillingSwitchProblem(db), '');
});
