'use strict';

/**
 * Migration: relay schedules (services/relay-schedule-service.mjs).
 *
 * `relay_schedules`: one row per schedule an agent set with remote_relay's
 * `schedule`.
 *
 * - `conversation_id`: the session the prompt goes to.
 * - `created_by_conversation_id`: the conversation whose agent set it (the
 *   same one for a schedule of its own).
 * - `at`: the first time asked for, or NULL; `every_minutes`: the interval
 *   of a repeating schedule, or NULL; `once`: 1 when it ends after firing.
 * - `next_fire_at`: when it fires next. Written in the same transaction as
 *   the queue row a firing creates, so a restart neither loses a firing nor
 *   repeats it; the timers are rebuilt from it at boot.
 * - `last_fired_at`, `fired_count`, `last_message_id` (the message its last
 *   firing queued: a repeat waits while that one is still pending),
 *   `skipped_count`.
 * - `origin_json`: the provenance its messages carry (the turn that set it,
 *   with that turn's hops), so a schedule cannot reset the hop count;
 *   NULL when a user's own turn set it for its own conversation.
 * - `held_since`: a firing into another session waits for the user (the
 *   agents' loop guard of the conversation that set it is used up).
 * - `ended_at`, `end_reason`: unscheduled, fired (once), archived, deleted.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0022-relay-schedules.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

export const RELAY_SCHEDULE_COLUMNS = Object.freeze([
  'id',
  'conversation_id',
  'created_by_conversation_id',
  'title',
  'text',
  'at',
  'every_minutes',
  'once',
  'next_fire_at',
  'last_fired_at',
  'fired_count',
  'skipped_count',
  'last_message_id',
  'created_at',
  'ended_at',
  'end_reason',
  'origin_json',
  'held_since',
]);

// Added after the table's first form: added by ALTER where it lacks them.
const LATER_COLUMNS = Object.freeze([['origin_json', 'TEXT'], ['held_since', 'TEXT']]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

/** What keeps the service from using the table: '' when nothing does. */
export function relaySchedulesTableProblem(db) {
  if (!tableExists(db, 'relay_schedules')) return 'no relay_schedules table';
  const present = new Set(db.prepare(`PRAGMA table_info(relay_schedules)`).all().map((column) => column.name));
  const missing = RELAY_SCHEDULE_COLUMNS.filter((name) => !present.has(name));
  return missing.length ? `relay_schedules lacks ${missing.join(', ')}` : '';
}

export function migrateRelaySchedules(db) {
  let tablesAdded = 0;
  if (!tableExists(db, 'relay_schedules')) {
    db.exec(`
      CREATE TABLE relay_schedules (
        id                          TEXT PRIMARY KEY,
        conversation_id             TEXT NOT NULL,
        created_by_conversation_id  TEXT NOT NULL,
        title                       TEXT,
        text                        TEXT NOT NULL,
        at                          TEXT,
        every_minutes               INTEGER CHECK (every_minutes IS NULL OR every_minutes > 0),
        once                        INTEGER NOT NULL DEFAULT 1 CHECK (once IN (0, 1)),
        next_fire_at                TEXT,
        last_fired_at               TEXT,
        fired_count                 INTEGER NOT NULL DEFAULT 0,
        skipped_count               INTEGER NOT NULL DEFAULT 0,
        last_message_id             TEXT,
        created_at                  TEXT NOT NULL,
        ended_at                    TEXT,
        end_reason                  TEXT,
        origin_json                 TEXT,
        held_since                  TEXT,
        CHECK (once = 1 OR every_minutes IS NOT NULL)
      )
    `);
    tablesAdded += 1;
  }
  const present = new Set(db.prepare(`PRAGMA table_info(relay_schedules)`).all().map((column) => column.name));
  let columnsAdded = 0;
  for (const [name, type] of LATER_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE relay_schedules ADD COLUMN ${name} ${type}`);
    columnsAdded += 1;
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_schedules_active ON relay_schedules(ended_at, next_fire_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_schedules_conversation ON relay_schedules(conversation_id, ended_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_schedules_creator ON relay_schedules(created_by_conversation_id, ended_at)`);
  return { applied: tablesAdded > 0 || columnsAdded > 0, tablesAdded, columnsAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateRelaySchedules(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    // The given path, else the database in server/data (oar.db, else the
    // name before 0.9.20); never a new one.
    const dbPath = cliDbPath(process.argv[2], new URL('..', import.meta.url));
    const result = migrate(dbPath);
    console.log(`Migration 0022 on ${dbPath}`);
    console.log(result.applied ? `  relay schedules: tables added ${result.tablesAdded}, columns added ${result.columnsAdded}` : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0022 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
