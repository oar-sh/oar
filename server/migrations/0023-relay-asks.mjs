'use strict';

/**
 * Migration: questions that don't block (services/relay-ask-service.mjs).
 *
 * `relay_asks`: one row per question an agent asked the owner with
 * remote_relay's `ask`. Not a `relay_questions` row: those belong to a turn
 * (queue_id) that waits on them; an ask belongs to a session and blocks
 * nothing.
 *
 * - `relay_id`: 'self' for an ask kept here (its session lives on this
 *   relay); a paired relay's registry id for this relay's copy of an ask its
 *   agent put on that relay (a mirror: `remote_id` is the ask's id there, and
 *   this relay looks for the answer until it has it).
 * - `conversation_id`: the session the ask is in (on that relay for a
 *   mirror, `conversation_title` its title there).
 * - `created_by`: the conversation here whose agent asked (NULL when a paired
 *   relay's agent did; `creator_json` then names that relay and its
 *   conversation, `{ relayId, relayName, conversationId, conversationTitle }`).
 * - `question`, `options_json`, `recommendation`, `detail`, `urgency`
 *   ('normal' | 'now'): as the agent wrote them, checked
 *   (shared/relay-asks.mjs).
 * - `status`: pending, answered, dismissed, withdrawn (by the agent that
 *   asked), cancelled (its session was archived or deleted); `answer`,
 *   `choice`, `answered_at`, `answered_via` (the relay whose Inbox it came
 *   from, NULL for this relay's own UI).
 * - `notified_at`: when the asking side was told the outcome (for a mirror:
 *   when its creator here got question_answered).
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0023-relay-asks.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

export const RELAY_ASK_COLUMNS = Object.freeze([
  'id',
  'relay_id',
  'remote_id',
  'conversation_id',
  'conversation_title',
  'created_by',
  'creator_json',
  'question',
  'options_json',
  'recommendation',
  'detail',
  'urgency',
  'status',
  'answer',
  'choice',
  'answered_at',
  'answered_via',
  'notified_at',
  'created_at',
  'updated_at',
]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

/** What keeps the service from using the table: '' when nothing does. */
export function relayAsksTableProblem(db) {
  if (!tableExists(db, 'relay_asks')) return 'no relay_asks table';
  const present = new Set(db.prepare(`PRAGMA table_info(relay_asks)`).all().map((column) => column.name));
  const missing = RELAY_ASK_COLUMNS.filter((name) => !present.has(name));
  return missing.length ? `relay_asks lacks ${missing.join(', ')}` : '';
}

export function migrateRelayAsks(db) {
  let tablesAdded = 0;
  if (!tableExists(db, 'relay_asks')) {
    db.exec(`
      CREATE TABLE relay_asks (
        id                  TEXT PRIMARY KEY,
        relay_id            TEXT NOT NULL DEFAULT 'self',
        remote_id           TEXT,
        conversation_id     TEXT NOT NULL,
        conversation_title  TEXT,
        created_by          TEXT,
        creator_json        TEXT,
        question            TEXT NOT NULL,
        options_json        TEXT,
        recommendation      TEXT,
        detail              TEXT,
        urgency             TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal', 'now')),
        status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'answered', 'dismissed', 'withdrawn', 'cancelled')),
        answer              TEXT,
        choice              TEXT,
        answered_at         TEXT,
        answered_via        TEXT,
        notified_at         TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        CHECK (relay_id = 'self' OR remote_id IS NOT NULL)
      )
    `);
    tablesAdded += 1;
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_asks_status ON relay_asks(relay_id, status, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_asks_conversation ON relay_asks(conversation_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_asks_creator ON relay_asks(created_by, status)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_asks_remote ON relay_asks(relay_id, remote_id) WHERE remote_id IS NOT NULL`);
  return { applied: tablesAdded > 0, tablesAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateRelayAsks(db);
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
    console.log(`Migration 0023 on ${dbPath}`);
    console.log(result.applied ? `  relay asks: tables added ${result.tablesAdded}` : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0023 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
