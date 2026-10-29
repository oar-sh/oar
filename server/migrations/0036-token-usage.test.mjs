import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  TOKEN_USAGE_DAYS_COLUMNS,
  TURN_TOKEN_USAGE_COLUMNS,
  TURN_TOKEN_USAGE_INDEXES,
  migrateTokenUsage,
  tokenUsageProblem,
} from './0036-token-usage.mjs';
import { migrateClaudeApiUsageTotals } from './0034-claude-api-usage-totals.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
const indexes = (db, table) => db.prepare(`PRAGMA index_list(${table})`).all().map((index) => index.name).filter((name) => !name.startsWith('sqlite_')).sort();
const tableExists = (db, name) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
const NOW = () => '2026-11-02T08:00:00.000Z';

// A 0.9.19 database: the schema as it was, without 0036's tables.
function oldDatabase() {
  const db = new Database(':memory:');
  applySchema(db);
  db.exec(`DROP TABLE token_usage_days; DROP TABLE turn_token_usage;`);
  return db;
}

function seedSources(db) {
  db.prepare(`
    INSERT INTO claude_api_usage_totals (day, model, hit_tokens, miss_tokens, output_tokens, cost_usd, unknown_cost_tokens, turn_count, first_seen_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('2026-10-30', 'claude-sonnet-5-5', 4000, 1200, 300, 0.42, 0, 3, '2026-10-30T09:00:00.000Z', '2026-10-30T17:00:00.000Z', '2026-10-30T17:00:00.000Z');
  db.prepare(`
    INSERT INTO claude_api_usage_totals (day, model, hit_tokens, miss_tokens, output_tokens, cost_usd, unknown_cost_tokens, turn_count, first_seen_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('2026-10-31', 'claude-opus-5-5', 0, 900, 50, 0, 950, 1, '2026-10-31T10:00:00.000Z', '2026-10-31T10:00:00.000Z', '2026-10-31T10:00:00.000Z');
  db.prepare(`
    INSERT INTO deepseek_usage_days (day, model, hit_tokens, miss_tokens, output_tokens, search_requests, fetch_requests, turn_count, cost_usd, cost_cny, tools_cost_usd, tools_cost_cny, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('2026-10-31', 'deepseek-flash', 7000, 2000, 800, 4, 1, 5, 0.012, 0.086, 0.04, 0.29, '2026-10-31T23:30:00.000Z');
}

test('creates both tables with their indexes, once', () => {
  const db = oldDatabase();
  assert.equal(tokenUsageProblem(db), 'no turn_token_usage table');
  assert.deepEqual(migrateTokenUsage(db, { now: NOW }), { applied: true, tablesAdded: 2, backfilled: { claudeApi: 0, deepseek: 0 } });
  assert.deepEqual(columns(db, 'turn_token_usage'), [...TURN_TOKEN_USAGE_COLUMNS]);
  assert.deepEqual(columns(db, 'token_usage_days'), [...TOKEN_USAGE_DAYS_COLUMNS]);
  assert.deepEqual(indexes(db, 'turn_token_usage'), [...TURN_TOKEN_USAGE_INDEXES].sort());
  assert.equal(tokenUsageProblem(db), '');
  assert.deepEqual(migrateTokenUsage(db, { now: NOW }), { applied: false, tablesAdded: 0, backfilled: { claudeApi: 0, deepseek: 0 } });
});

test('one row per turn, run and model; token fields default to NULL, not 0', () => {
  const db = oldDatabase();
  migrateTokenUsage(db, { now: NOW });
  const insert = db.prepare(`
    INSERT INTO turn_token_usage (conversation_id, turn_id, run_id, model, provider, at, day, updated_at)
    VALUES ('c1', 't1', ?, ?, 'cursor', 'a', '2026-11-02', 'a')
  `);
  insert.run('r1', 'composer-2');
  insert.run('r2', 'composer-2');
  insert.run('r1', 'gpt-5.5');
  assert.throws(() => insert.run('r1', 'composer-2'), /UNIQUE/);
  const row = db.prepare(`SELECT * FROM turn_token_usage LIMIT 1`).get();
  assert.equal(row.billing, '');
  for (const field of ['input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'reasoning_tokens', 'cost_usd', 'cost_source']) {
    assert.equal(row[field], null, field);
  }
  assert.equal(row.cost_unknown, 0);
});

test('backfills the Claude API and DeepSeek days with cache writes unknown', () => {
  const db = oldDatabase();
  seedSources(db);
  assert.deepEqual(migrateTokenUsage(db, { now: NOW }).backfilled, { claudeApi: 2, deepseek: 1 });
  const rows = db.prepare(`SELECT * FROM token_usage_days ORDER BY provider, day, model`).all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    {
      day: '2026-10-30', provider: 'claude-api', billing: '', model: 'claude-sonnet-5-5', source: 'backfill',
      input_tokens: 1200, output_tokens: 300, cache_write_tokens: null, cache_read_tokens: 4000, reasoning_tokens: null,
      cost_usd: 0.42, unknown_cost_tokens: 0, turn_count: 3,
      first_seen_at: '2026-10-30T09:00:00.000Z', last_seen_at: '2026-10-30T17:00:00.000Z', updated_at: NOW(),
    },
    {
      day: '2026-10-31', provider: 'claude-api', billing: '', model: 'claude-opus-5-5', source: 'backfill',
      input_tokens: 900, output_tokens: 50, cache_write_tokens: null, cache_read_tokens: 0, reasoning_tokens: null,
      cost_usd: 0, unknown_cost_tokens: 950, turn_count: 1,
      first_seen_at: '2026-10-31T10:00:00.000Z', last_seen_at: '2026-10-31T10:00:00.000Z', updated_at: NOW(),
    },
    // DeepSeek's UTC day as it is; the token estimate only, not the tools.
    {
      day: '2026-10-31', provider: 'deepseek', billing: '', model: 'deepseek-flash', source: 'backfill',
      input_tokens: 2000, output_tokens: 800, cache_write_tokens: null, cache_read_tokens: 7000, reasoning_tokens: null,
      cost_usd: 0.012, unknown_cost_tokens: 0, turn_count: 5,
      first_seen_at: '2026-10-31T00:00:00.000Z', last_seen_at: '2026-10-31T23:59:59.999Z', updated_at: NOW(),
    },
  ]);
});

test('model ids that meet once normalised are summed, and a NULL DeepSeek cost stays NULL', () => {
  const db = oldDatabase();
  const claude = db.prepare(`
    INSERT INTO claude_api_usage_totals (day, model, hit_tokens, miss_tokens, output_tokens, cost_usd, unknown_cost_tokens, turn_count, first_seen_at, last_seen_at, updated_at)
    VALUES ('2026-10-30', ?, ?, 10, 1, ?, 0, 1, ?, ?, 'x')
  `);
  claude.run('claude-opus-5-5', 100, 0.5, '2026-10-30T08:00:00.000Z', '2026-10-30T09:00:00.000Z');
  claude.run('Claude-Opus-5-5[1m]', 50, 0.25, '2026-10-30T07:00:00.000Z', '2026-10-30T12:00:00.000Z');
  const deepseek = db.prepare(`
    INSERT INTO deepseek_usage_days (day, model, hit_tokens, miss_tokens, output_tokens, turn_count, cost_usd, cost_cny, updated_at)
    VALUES ('2026-10-30', ?, 1, 2, 3, 1, ?, 9.9, 'x')
  `);
  deepseek.run('deepseek-pro', null);
  deepseek.run('DeepSeek-Pro', null);
  deepseek.run('deepseek-flash', 0.02);
  migrateTokenUsage(db, { now: NOW });
  const rows = db.prepare(`SELECT provider, model, input_tokens, cache_read_tokens, cost_usd, turn_count, first_seen_at, last_seen_at FROM token_usage_days ORDER BY provider, model`).all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { provider: 'claude-api', model: 'claude-opus-5-5', input_tokens: 20, cache_read_tokens: 150, cost_usd: 0.75, turn_count: 2, first_seen_at: '2026-10-30T07:00:00.000Z', last_seen_at: '2026-10-30T12:00:00.000Z' },
    { provider: 'deepseek', model: 'deepseek-flash', input_tokens: 2, cache_read_tokens: 1, cost_usd: 0.02, turn_count: 1, first_seen_at: '2026-10-30T00:00:00.000Z', last_seen_at: '2026-10-30T23:59:59.999Z' },
    // Never the yuan amount in place of a missing dollar one.
    { provider: 'deepseek', model: 'deepseek-pro', input_tokens: 4, cache_read_tokens: 2, cost_usd: null, turn_count: 2, first_seen_at: '2026-10-30T00:00:00.000Z', last_seen_at: '2026-10-30T23:59:59.999Z' },
  ]);
});

test('the backfill runs once: later source rows are not copied again', () => {
  const db = oldDatabase();
  seedSources(db);
  migrateTokenUsage(db, { now: NOW });
  // Turns after the upgrade still book into the old tables (the plan cards).
  db.prepare(`UPDATE claude_api_usage_totals SET miss_tokens = miss_tokens + 500 WHERE day = '2026-10-30'`).run();
  db.prepare(`
    INSERT INTO claude_api_usage_totals (day, model, miss_tokens, first_seen_at, last_seen_at, updated_at)
    VALUES ('2026-11-02', 'claude-sonnet-5-5', 77, 'a', 'a', 'a')
  `).run();
  assert.equal(migrateTokenUsage(db, { now: NOW }).applied, false);
  assert.deepEqual(
    db.prepare(`SELECT day, input_tokens FROM token_usage_days WHERE provider = 'claude-api' ORDER BY day`).all().map((row) => ({ ...row })),
    [{ day: '2026-10-30', input_tokens: 1200 }, { day: '2026-10-31', input_tokens: 900 }],
  );
});

test('empty sources make empty tables', () => {
  const db = oldDatabase();
  assert.equal(migrateTokenUsage(db, { now: NOW }).applied, true);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM token_usage_days`).get().n, 0);
});

test('a restored 0.9.19 database whose 0034 failed: the boot goes on, and the next one backfills', () => {
  const db = oldDatabase();
  seedSources(db);
  // 0034 fails on this boot: a view under its table's name makes its
  // CREATE TABLE throw.
  const kept = db.prepare(`SELECT * FROM claude_api_usage_totals`).all();
  db.exec(`DROP TABLE claude_api_usage_totals; CREATE VIEW claude_api_usage_totals AS SELECT 1 AS day`);
  const warnings = [];
  const warn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    applySchema(db);
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings.some((line) => line.includes('migration 0034 failed')), warnings.join('\n'));
  assert.ok(warnings.some((line) => line.includes('[token-usage] migration 0036 failed; retrying on next boot')), warnings.join('\n'));
  assert.equal(tableExists(db, 'token_usage_days'), false);
  // The next boot: 0034 works again (its rows restored here), then 0036.
  db.exec(`DROP VIEW claude_api_usage_totals`);
  migrateClaudeApiUsageTotals(db);
  const insert = db.prepare(`INSERT INTO claude_api_usage_totals (${Object.keys(kept[0]).join(', ')}) VALUES (${Object.keys(kept[0]).map(() => '?').join(', ')})`);
  for (const row of kept) insert.run(...Object.values(row));
  applySchema(db);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM token_usage_days WHERE source = 'backfill'`).get().n, 3);
});

test('a missing source throws and leaves nothing, so the next boot retries', () => {
  const db = oldDatabase();
  // 0025's tables are there, 0034's is not (its migration failed this boot).
  db.exec(`DROP TABLE claude_api_usage_totals`);
  assert.throws(() => migrateTokenUsage(db, { now: NOW }), /cannot backfill yet: no claude_api_usage_totals table/);
  assert.equal(tableExists(db, 'turn_token_usage'), false);
  assert.equal(tableExists(db, 'token_usage_days'), false);
  migrateClaudeApiUsageTotals(db);
  assert.equal(migrateTokenUsage(db, { now: NOW }).applied, true);
  assert.equal(tokenUsageProblem(db), '');
});

test('a partial source is caught by its own migration\'s check, and a failing copy rolls the tables back', () => {
  const partial = new Database(':memory:');
  migrateClaudeApiUsageTotals(partial);
  // A DeepSeek day table without the token columns, as a half-run 0025 might leave it.
  partial.exec(`CREATE TABLE deepseek_usage_days (day TEXT, model TEXT)`);
  assert.throws(() => migrateTokenUsage(partial, { now: NOW }), /cannot backfill yet: .*deepseek/);
  assert.equal(tableExists(partial, 'turn_token_usage'), false);
  assert.equal(tableExists(partial, 'token_usage_days'), false);

  // A source column missing: 0034's check refuses before anything is made.
  const renamed = oldDatabase();
  renamed.exec(`ALTER TABLE claude_api_usage_totals RENAME COLUMN hit_tokens TO hit_tokens_gone`);
  assert.throws(() => migrateTokenUsage(renamed, { now: NOW }), /lacks hit_tokens/);
  assert.equal(tableExists(renamed, 'token_usage_days'), false);

  // Sources that pass their checks, and a copy that still fails: nothing stays.
  const db = oldDatabase();
  seedSources(db);
  const failingCopy = {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      if (/INSERT INTO token_usage_days/.test(sql) && /FROM deepseek_usage_days/.test(sql)) throw new Error('disk I/O error');
      return db.prepare(sql);
    },
    transaction: (fn) => db.transaction(fn),
  };
  assert.throws(() => migrateTokenUsage(failingCopy, { now: NOW }), /disk I\/O error/);
  assert.equal(tableExists(db, 'turn_token_usage'), false);
  assert.equal(tableExists(db, 'token_usage_days'), false);
});

test('the schema boot applies it, and backfills an upgraded database', () => {
  const fresh = new Database(':memory:');
  applySchema(fresh);
  assert.equal(tokenUsageProblem(fresh), '');

  const db = oldDatabase();
  seedSources(db);
  applySchema(db);
  assert.equal(tokenUsageProblem(db), '');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM token_usage_days WHERE source = 'backfill'`).get().n, 3);
  applySchema(db);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM token_usage_days WHERE source = 'backfill'`).get().n, 3);
});
