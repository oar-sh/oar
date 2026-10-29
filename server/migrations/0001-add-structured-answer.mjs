'use strict';

/**
 * Migration: add structured answer support to relay_questions.
 *
 * Adds two nullable TEXT columns used for multi-field `ask_user` / elicitation
 * forms while preserving the existing single-string `answer` column for
 * backward compatibility:
 *   - structured_answer: JSON object of the user's per-field answers
 *   - request_schema:     JSON of the elicitation requestedSchema (for validation)
 *
 * Safe to run repeatedly (idempotent) and against a live database — ADD COLUMN
 * only takes a brief write lock and new columns default to NULL.
 *
 * Usage: node server/migrations/0001-add-structured-answer.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

const NEW_COLUMNS = [
  { name: 'structured_answer', ddl: 'ALTER TABLE relay_questions ADD COLUMN structured_answer TEXT' },
  { name: 'request_schema', ddl: 'ALTER TABLE relay_questions ADD COLUMN request_schema TEXT' },
];

export function migrate(dbPath) {
  const db = new Database(dbPath);
  try {
    const tableExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relay_questions'`)
      .get();
    if (!tableExists) {
      return { applied: [], skipped: NEW_COLUMNS.map((c) => c.name), reason: 'relay_questions table not found' };
    }
    const existing = new Set(
      db.prepare(`PRAGMA table_info(relay_questions)`).all().map((c) => String(c.name)),
    );
    const applied = [];
    const skipped = [];
    const tx = db.transaction(() => {
      for (const column of NEW_COLUMNS) {
        if (existing.has(column.name)) {
          skipped.push(column.name);
          continue;
        }
        db.exec(column.ddl);
        applied.push(column.name);
      }
    });
    tx();
    return { applied, skipped };
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
    const applied = result.applied.length ? result.applied.join(', ') : '(none)';
    const skipped = result.skipped.length ? result.skipped.join(', ') : '(none)';
    console.log(`Migration 0001 on ${dbPath}`);
    console.log(`  added:   ${applied}`);
    console.log(`  existed: ${skipped}`);
    if (result.reason) console.log(`  note:    ${result.reason}`);
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0001 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
