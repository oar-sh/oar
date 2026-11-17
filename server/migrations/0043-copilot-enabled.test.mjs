import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { BARE_START_SETTING_KEYS, migrateCopilotEnabled } from './0043-copilot-enabled.mjs';
import { applySchema } from '../db-schema.mjs';
import { STARTUP_SETTING_KEYS } from '../services/database-file.mjs';

const NOW = Date.parse('2026-11-16T22:40:00.000Z');
const STAMP = '2026-11-16T21:00:00.000Z';

const switchRow = (db) => db.prepare(`SELECT value, updated_at FROM app_settings WHERE key = 'copilot_enabled'`).get() || null;
const putSetting = (db, key, value) => db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`).run(key, value, STAMP);

/** What a bare start writes after applySchema, with no one's action. */
function simulateStartWrites(db) {
  for (const key of BARE_START_SETTING_KEYS) {
    if (key === 'copilot_enabled') continue;
    putSetting(db, key, '{}');
  }
}

test('a new database stays unset through its first and second boot', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(switchRow(db), null, 'first boot');
  simulateStartWrites(db);
  assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM app_settings`).get().n >= STARTUP_SETTING_KEYS.length);
  applySchema(db);
  assert.equal(switchRow(db), null, 'second boot: the keys a start wrote are no one\'s use');
  assert.deepEqual(migrateCopilotEnabled(db, { now: NOW }), { applied: false, reason: 'new' });
});

test('a database with a conversation gets copilot_enabled = true', () => {
  const db = new Database(':memory:');
  applySchema(db);
  simulateStartWrites(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'old chat', ?, ?)`).run(STAMP, STAMP);
  assert.deepEqual(migrateCopilotEnabled(db, { now: NOW }), { applied: true, reason: 'conversations' });
  assert.deepEqual(switchRow(db), { value: 'true', updated_at: new Date(NOW).toISOString() });
  assert.deepEqual(migrateCopilotEnabled(db, { now: NOW + 1000 }), { applied: false, reason: 'set' });
  assert.equal(switchRow(db).updated_at, new Date(NOW).toISOString(), 'a second run changes nothing');
});

test('a database with a setting someone made (no conversation) gets copilot_enabled = true', () => {
  const db = new Database(':memory:');
  applySchema(db);
  simulateStartWrites(db);
  putSetting(db, 'claude_enabled', 'true');
  assert.deepEqual(migrateCopilotEnabled(db, { now: NOW }), { applied: true, reason: 'settings' });
  assert.equal(switchRow(db).value, 'true');
});

test('a key already set is left as it is', () => {
  for (const value of ['false', 'true']) {
    const db = new Database(':memory:');
    applySchema(db);
    putSetting(db, 'copilot_enabled', value);
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'old chat', ?, ?)`).run(STAMP, STAMP);
    applySchema(db);
    assert.deepEqual(switchRow(db), { value, updated_at: STAMP });
  }
});

test('the bare-start keys: the start-up allowlist (copilot_enabled among them), db_last_run, the SDK store status, the relay id', () => {
  assert.ok(STARTUP_SETTING_KEYS.includes('copilot_enabled'));
  assert.deepEqual(
    [...BARE_START_SETTING_KEYS].sort(),
    [...STARTUP_SETTING_KEYS, 'db_last_run', 'agent_sdk_status', 'relay_instance_id'].sort(),
  );
});

test('without app_settings it fails, and the boot goes on (applySchema logs it)', () => {
  const db = new Database(':memory:');
  assert.throws(() => migrateCopilotEnabled(db), /app_settings is missing/);
});
