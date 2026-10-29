import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  CLAUDE_API_USAGE_TOTALS_COLUMNS,
  claudeApiUsageTotalsProblem,
  migrateClaudeApiUsageTotals,
} from './0034-claude-api-usage-totals.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('creates the table once, with one row per day and model', () => {
  const db = new Database(':memory:');
  assert.equal(claudeApiUsageTotalsProblem(db), 'no claude_api_usage_totals table');
  assert.deepEqual(migrateClaudeApiUsageTotals(db), { applied: true, tablesAdded: 1 });
  assert.deepEqual(columns(db, 'claude_api_usage_totals'), [...CLAUDE_API_USAGE_TOTALS_COLUMNS]);
  assert.equal(claudeApiUsageTotalsProblem(db), '');
  const insert = db.prepare(`
    INSERT INTO claude_api_usage_totals (day, model, first_seen_at, last_seen_at, updated_at)
    VALUES (?, ?, 'a', 'a', 'a')
  `);
  insert.run('2026-10-31', 'claude-sonnet-5-5');
  insert.run('2026-11-01', 'claude-sonnet-5-5');
  assert.throws(() => insert.run('2026-11-01', 'claude-sonnet-5-5'), /UNIQUE/);
  const row = db.prepare(`SELECT cost_usd, unknown_cost_tokens, turn_count FROM claude_api_usage_totals LIMIT 1`).get();
  assert.deepEqual({ ...row }, { cost_usd: 0, unknown_cost_tokens: 0, turn_count: 0 });
  assert.deepEqual(migrateClaudeApiUsageTotals(db), { applied: false, tablesAdded: 0 });
});

test('the schema boot applies the migration', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(claudeApiUsageTotalsProblem(db), '');
});

// Run by hand, as `node server/migrations/0034-….mjs`, in a copy of the
// server tree (never this checkout's server/data): no path finds the
// relay's database, oar.db first, and never creates one.
test('run by hand with no path: no database is refused and none created; oar.db is found before copilot.db', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-0034-cli-'));
  try {
    const serverDir = path.join(root, 'server');
    fs.mkdirSync(path.join(serverDir, 'migrations'), { recursive: true });
    fs.mkdirSync(path.join(serverDir, 'services'), { recursive: true });
    fs.copyFileSync(path.join(here, '0034-claude-api-usage-totals.mjs'), path.join(serverDir, 'migrations', 'm.mjs'));
    fs.copyFileSync(path.join(here, '..', 'services', 'database-file.mjs'), path.join(serverDir, 'services', 'database-file.mjs'));
    fs.symlinkSync(path.join(here, '..', '..', 'node_modules'), path.join(root, 'node_modules'), 'junction');
    const run = () => spawnSync(process.execPath, [path.join(serverDir, 'migrations', 'm.mjs')], { encoding: 'utf8' });
    const dataDir = path.join(serverDir, 'data');

    const none = run();
    assert.equal(none.status, 1);
    assert.match(none.stderr, /No database in .*data \(neither oar\.db nor copilot\.db\)/);
    assert.equal(fs.existsSync(dataDir), false, 'no data folder, no database made');

    fs.mkdirSync(dataDir);
    for (const name of ['copilot.db', 'oar.db']) new Database(path.join(dataDir, name)).close();
    const found = run();
    assert.equal(found.status, 0, found.stderr);
    assert.match(found.stdout, new RegExp(`Migration 0034 on ${path.join(dataDir, 'oar.db').replace(/[\\.]/g, '\\$&')}`));

    const wrong = spawnSync(process.execPath, [path.join(serverDir, 'migrations', 'm.mjs'), path.join(dataDir, 'typo.db')], { encoding: 'utf8' });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /No database at .*typo\.db; a script never creates one/);
    assert.equal(fs.existsSync(path.join(dataDir, 'typo.db')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
