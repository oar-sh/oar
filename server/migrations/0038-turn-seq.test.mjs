import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateTurnSeq, hasTurnSeqColumn } from './0038-turn-seq.mjs';
import { applySchema, SCHEMA_SQL } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => `${column.name}:${column.type}`).sort();
const indexes = (db, table) => db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`).all(table);

// The two tables as a database from before 0038 has them (the columns the
// queries name; the rest of the schema does not matter here).
function legacyTables(db) {
  db.exec(`
    CREATE TABLE relay_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, queue_message_id TEXT NOT NULL, response_message_id TEXT,
      conversation_id TEXT NOT NULL, relay_mode TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL,
      subagent_run_id TEXT, metadata_json TEXT
    );
    CREATE TABLE relay_thought (
      id INTEGER PRIMARY KEY AUTOINCREMENT, queue_message_id TEXT NOT NULL, response_message_id TEXT,
      conversation_id TEXT NOT NULL, relay_mode TEXT, reasoning_id TEXT, seq INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, subagent_run_id TEXT
    );
  `);
}

test('adds turn_seq and a partial index to both tables once; old rows read null', () => {
  const db = new Database(':memory:');
  legacyTables(db);
  db.prepare(`INSERT INTO relay_activity (queue_message_id, conversation_id, text, created_at) VALUES ('q-fixture', 'conv-fixture', 'Tool (view): a.js', '2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO relay_thought (queue_message_id, conversation_id, reasoning_id, seq, text, created_at) VALUES ('q-fixture', 'conv-fixture', 'r-1', 1, 'Thinking', '2026-01-01T00:00:00.000Z')`).run();
  assert.equal(hasTurnSeqColumn(db, 'relay_activity'), false);

  assert.deepEqual(migrateTurnSeq(db), { applied: true, columnsAdded: 2, indexesAdded: 2 });
  assert.deepEqual(migrateTurnSeq(db), { applied: false, columnsAdded: 0, indexesAdded: 0 });
  for (const table of ['relay_activity', 'relay_thought']) {
    assert.ok(hasTurnSeqColumn(db, table), table);
    assert.equal(db.prepare(`SELECT turn_seq FROM ${table}`).get().turn_seq, null);
    const index = indexes(db, table).find((row) => row.name === `idx_${table}_queue_turn_seq`);
    assert.ok(index, `${table} index`);
    assert.match(index.sql, /\(queue_message_id, turn_seq\) WHERE turn_seq IS NOT NULL$/);
  }
});

test('nothing to do without the tables', () => {
  const db = new Database(':memory:');
  assert.deepEqual(migrateTurnSeq(db), { applied: false, columnsAdded: 0, indexesAdded: 0 });
});

test('SCHEMA_SQL does not name the column: it runs before the migrations on an existing database', () => {
  assert.doesNotMatch(SCHEMA_SQL, /turn_seq/);
});

test('a fresh database and an upgraded one end with the same columns and indexes', () => {
  const fresh = new Database(':memory:');
  applySchema(fresh);

  // An existing database from before 0038: the full schema, then the column
  // and the indexes taken away again (SQLite 3.35+ drops a column).
  const upgraded = new Database(':memory:');
  applySchema(upgraded);
  for (const table of ['relay_activity', 'relay_thought']) {
    upgraded.exec(`DROP INDEX idx_${table}_queue_turn_seq`);
    upgraded.exec(`ALTER TABLE ${table} DROP COLUMN turn_seq`);
    assert.equal(hasTurnSeqColumn(upgraded, table), false);
  }
  // Booting it again (SCHEMA_SQL first, then the migrations) works and
  // brings the column back.
  applySchema(upgraded);

  for (const table of ['relay_activity', 'relay_thought']) {
    assert.deepEqual(columns(upgraded, table), columns(fresh, table), `${table} columns`);
    assert.deepEqual(indexes(upgraded, table), indexes(fresh, table), `${table} indexes`);
    assert.ok(columns(fresh, table).includes('turn_seq:INTEGER'));
  }
  // A second boot changes nothing.
  applySchema(fresh);
  assert.deepEqual(migrateTurnSeq(fresh), { applied: false, columnsAdded: 0, indexesAdded: 0 });
});

test('the CLI entry point migrates a database file', async () => {
  const { migrate } = await import('./0038-turn-seq.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-0038-'));
  try {
    const file = path.join(dir, 'fixture.db');
    const db = new Database(file);
    legacyTables(db);
    db.close();
    assert.deepEqual(migrate(file), { applied: true, columnsAdded: 2, indexesAdded: 2 });
    assert.deepEqual(migrate(file), { applied: false, columnsAdded: 0, indexesAdded: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
