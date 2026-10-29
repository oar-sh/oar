'use strict';

/**
 * Migration: what an agent's update_session may do to a session group.
 *
 * - `conversation_groups.agent_made` is 1 for a group update_session made
 *   (a name the relay did not have). Only such a group goes once an agent
 *   takes its last member out.
 * - `conversation_groups.kept_empty_at` is set when an agent took the last
 *   member out of a group the owner made: the group stays (empty), the boot
 *   repair and the sweep leave it alone, and agents can still name it. The
 *   mark goes as soon as a member joins again.
 *
 * Additive and idempotent. Safe to run on every boot. Rolling back needs no
 * data change: older code ignores both columns (its boot repair removes an
 * empty group, as it always did).
 *
 * Usage: node server/migrations/0021-conversation-group-agent-marks.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

export function migrateConversationGroupAgentMarks(db) {
  if (!tableExists(db, 'conversation_groups')) {
    throw new Error('conversation_groups is missing (migration 0014 has not run)');
  }
  const present = new Set(db.prepare(`PRAGMA table_info(conversation_groups)`).all().map((column) => column.name));
  let columnsAdded = 0;
  if (!present.has('agent_made')) {
    db.exec(`ALTER TABLE conversation_groups ADD COLUMN agent_made INTEGER`);
    columnsAdded += 1;
  }
  if (!present.has('kept_empty_at')) {
    db.exec(`ALTER TABLE conversation_groups ADD COLUMN kept_empty_at TEXT`);
    columnsAdded += 1;
  }
  return { applied: columnsAdded > 0, columnsAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateConversationGroupAgentMarks(db);
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
    console.log(`Migration 0021 on ${dbPath}`);
    console.log(result.applied
      ? `  group agent marks: columns added ${result.columnsAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0021 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
