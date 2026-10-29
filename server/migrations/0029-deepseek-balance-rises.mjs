'use strict';

/**
 * Migration: the DeepSeek balance reference notes when the balance last rose
 * (services/plan-usage-service.mjs, the DeepSeek card's balance bar). Builds
 * on 0025.
 *
 * `deepseek_balance_reference` gains these columns:
 * - `rose_at`: when a read last found the balance above the read before it
 *   (a top-up or a grant); NULL while no rise was seen. `reference_at` cannot
 *   tell: it is also set by the first read of a currency. A starting balance
 *   set on the DeepSeek tab counts until the balance rises after it was set
 *   (plan-usage-deepseek.mjs).
 * - `last_read_at`: when `last_total` was read; NULL for a row from before.
 * - `rose_from_at`: when the balance before that rise was read; NULL when
 *   unknown. A rise the relay first sees after the starting balance was set
 *   may be a top-up from before it, unless the balance before the rise was
 *   read after it too.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0029-deepseek-balance-rises.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

import { DEEPSEEK_BALANCE_REFERENCE_TABLE, migrateDeepSeekUsageRequestsDaily } from './0025-deepseek-usage-requests-daily.mjs';
import { cliDbPath } from '../services/database-file.mjs';

// Added to deepseek_balance_reference, with their DDL.
export const DEEPSEEK_BALANCE_RISE_COLUMNS = Object.freeze([
  ['rose_at', 'TEXT'],
  ['last_read_at', 'TEXT'],
  ['rose_from_at', 'TEXT'],
]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

/** What keeps the service from using the column: '' when nothing does. */
export function deepseekBalanceRisesProblem(db) {
  if (!tableExists(db, DEEPSEEK_BALANCE_REFERENCE_TABLE)) return `no ${DEEPSEEK_BALANCE_REFERENCE_TABLE} table`;
  const present = columnNames(db, DEEPSEEK_BALANCE_REFERENCE_TABLE);
  const missing = DEEPSEEK_BALANCE_RISE_COLUMNS.map(([name]) => name).filter((name) => !present.has(name));
  if (missing.length) return `${DEEPSEEK_BALANCE_REFERENCE_TABLE} lacks ${missing.join(', ')}`;
  return '';
}

export function migrateDeepSeekBalanceRises(db) {
  // The column goes on 0025's table: a database that skipped 0025 gets it first.
  migrateDeepSeekUsageRequestsDaily(db);
  let columnsAdded = 0;
  const present = columnNames(db, DEEPSEEK_BALANCE_REFERENCE_TABLE);
  for (const [name, ddl] of DEEPSEEK_BALANCE_RISE_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE ${DEEPSEEK_BALANCE_REFERENCE_TABLE} ADD COLUMN ${name} ${ddl}`);
    columnsAdded += 1;
  }
  return { applied: columnsAdded > 0, columnsAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateDeepSeekBalanceRises(db);
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
    console.log(`Migration 0029 on ${dbPath}`);
    console.log(result.applied
      ? `  deepseek balance rises: columns added ${result.columnsAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0029 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
