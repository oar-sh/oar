import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

import {
  createDeepSeekUsageImportService,
  deepseekKeyFingerprint,
  importDeepSeekUsageFiles,
  parseCsv,
  parseDeepSeekUsageExport,
  readDecimal,
  readIsoWithOffset,
} from './deepseek-usage-import.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '..', '..', 'tests', 'fixtures', 'deepseek-usage-export');
const AMOUNT = fs.readFileSync(path.join(FIXTURES, 'amount.csv'), 'utf8');
const COST = fs.readFileSync(path.join(FIXTURES, 'cost.csv'), 'utf8');

// Invented keys, built at run time so no key-shaped text is in the source.
const fullKey = (head, tail) => `sk-${head}${'x'.repeat(23)}${tail}`;
const KEY_A = fullKey('1a2b3', '9c0d'); // the fixture's key with flash only on 10-24
const KEY_B = fullKey('4e5f6', '7a8b'); // flash and V4 Pro on 10-24
const DURING_25TH = () => new Date('2026-10-25T12:00:00.000Z');
const AFTER_25TH = () => new Date('2026-10-26T12:00:00.000Z');

const AMOUNT_HEADER = 'user_id,start_time_iso,end_time_iso,model,name,api_key_name,api_key,type,price,amount';
const COST_HEADER = 'user_id,start_time_iso,end_time_iso,model,name,wallet_type,cost,currency';
const P = '2026-10-20T00:00:00+01:00,2026-10-21T00:00:00+01:00';
const masked = (head, tail) => `sk-${head}${'*'.repeat(23)}${tail}`;

function service({ key = KEY_A, now = DURING_25TH } = {}) {
  const db = new Database(':memory:');
  return { db, svc: createDeepSeekUsageImportService({ db, getApiKey: () => key, now }) };
}

test('the fingerprint is the five characters after sk- and the last four, masked or not', () => {
  assert.equal(deepseekKeyFingerprint(KEY_A), 'sk-1a2b3…9c0d');
  assert.equal(deepseekKeyFingerprint(masked('1a2b3', '9c0d')), 'sk-1a2b3…9c0d');
  assert.equal(deepseekKeyFingerprint(''), '');
  assert.equal(deepseekKeyFingerprint('not a key'), '');
});

test('the CSV reader takes a BOM, CRLF and quoted fields', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n1,"x, ""y"""\r\n\r\n'), [['a', 'b'], ['1', 'x, "y"']]);
  assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('the export: cost is amount × price per period, model and key; a period not ended yet is left out', () => {
  const parsed = parseDeepSeekUsageExport({ amount: AMOUNT, cost: COST, now: DURING_25TH() });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.skipped, ['2026-10-25T00:00:00+01:00']);
  assert.deepEqual(parsed.rows.map((row) => [row.day, row.model, row.keyFp, row.cost, row.currency]), [
    ['2026-10-24', 'deepseek-flash', 'sk-1a2b3…9c0d', 0.23312956, 'CNY'],
    ['2026-10-24', 'deepseek-flash', 'sk-4e5f6…7a8b', 0.27555468, 'CNY'],
    ['2026-10-24', 'deepseek-v4-pro', 'sk-4e5f6…7a8b', 0.349749, 'CNY'],
  ]);
  const flashA = parsed.rows[0];
  assert.deepEqual(
    { hit: flashA.hitTokens, miss: flashA.missTokens, output: flashA.outputTokens, requests: flashA.requestCount, end: flashA.periodEnd },
    { hit: 1996928, miss: 38383, output: 38702, requests: 39, end: '2026-10-25T00:00:00+01:00' },
  );
  // 1,996,928 × 0.00000002 + 38,383 × 0.000001 + 38,702 × 0.000004
  assert.ok(Math.abs(flashA.cost - (1996928 * 0.00000002 + 38383 * 0.000001 + 38702 * 0.000004)) < 1e-9);
  // Both keys' flash rows come to the cost file's 0.50868424.
  assert.ok(Math.abs(parsed.rows[0].cost + parsed.rows[1].cost - 0.50868424) < 1e-9);

  const later = parseDeepSeekUsageExport({ amount: AMOUNT, cost: COST, now: AFTER_25TH() });
  assert.deepEqual(later.skipped, []);
  assert.equal(later.rows.length, 9);
});

test('files that do not match are refused whole', () => {
  const amount = [
    AMOUNT_HEADER,
    `u,${P},deepseek-flash,deepseek-flash,K,${masked('1a2b3', '9c0d')},output_tokens,0.000004,1000`,
  ].join('\r\n');
  const cost = [COST_HEADER, `u,${P},deepseek-flash,deepseek-flash,Paid,0.005,CNY`].join('\r\n');
  const parsed = parseDeepSeekUsageExport({ amount, cost, now: AFTER_25TH() });
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /do not match for deepseek-flash/);

  const { db, svc } = service({ now: AFTER_25TH });
  assert.equal(svc.importExport({ amount, cost }).ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deepseek_usage_actuals').get().n, 0);

  // A model in the cost file with no amounts is a mismatch too.
  const costOnly = [COST_HEADER, `u,${P},deepseek-v4-pro,deepseek-v4-pro,Paid,0.1,CNY`].join('\r\n');
  assert.equal(parseDeepSeekUsageExport({ amount: AMOUNT_HEADER, cost: costOnly, now: AFTER_25TH() }).ok, false);
});

test('a file without the export\'s columns is refused; so are swapped files', () => {
  assert.match(parseDeepSeekUsageExport({ amount: 'a,b\r\n1,2', cost: COST }).error, /amount file is not a DeepSeek usage export/);
  assert.match(parseDeepSeekUsageExport({ amount: COST, cost: AMOUNT }).error, /amount file .* lacks the columns? api_key_name/);
  assert.match(parseDeepSeekUsageExport({ amount: AMOUNT, cost: '' }).error, /cost file is empty/);
  const badPrice = [AMOUNT_HEADER, `u,${P},deepseek-flash,deepseek-flash,K,${masked('1a2b3', '9c0d')},output_tokens,abc,10`].join('\n');
  assert.match(parseDeepSeekUsageExport({ amount: badPrice, cost: COST_HEADER }).error, /Line 2 of the amount file/);
});

test('the import is idempotent and a later export replaces the periods it covers', () => {
  const { db, svc } = service({ now: DURING_25TH });
  const first = svc.importExport({ amount: AMOUNT, cost: COST });
  assert.equal(first.ok, true);
  assert.equal(svc.importExport({ amount: AMOUNT, cost: COST }).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deepseek_usage_actuals').get().n, 3);
  const before = svc.readActuals();

  // The next day's export brings the 25th in full; the 24th stays as it was.
  const later = createDeepSeekUsageImportService({ db, getApiKey: () => KEY_A, now: AFTER_25TH });
  assert.equal(later.importExport({ amount: AMOUNT, cost: COST }).summary.rows, 9);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deepseek_usage_actuals').get().n, 9);
  const after = later.readActuals();
  assert.deepEqual(after.rows[0], before.rows[0]);
  assert.equal(after.through, '2026-10-26T00:00:00+01:00');
});

test('the summary names the keys and whether the saved one is among them', () => {
  const { svc } = service({ key: KEY_B });
  const { summary } = svc.importExport({ amount: AMOUNT, cost: COST });
  assert.deepEqual(summary, {
    rows: 3,
    days: ['2026-10-24'],
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    keys: [
      { keyFp: 'sk-1a2b3…9c0d', keyName: 'OAR', rows: 1 },
      { keyFp: 'sk-4e5f6…7a8b', keyName: 'OAR', rows: 2 },
    ],
    skippedPeriods: ['2026-10-25T00:00:00+01:00'],
    through: '2026-10-25T00:00:00+01:00',
    savedKeyFp: 'sk-4e5f6…7a8b',
    savedKeyMatched: true,
    currencies: ['CNY'],
    cardCurrency: null,
    currencyMatched: null,
  });
  // With the card's currency known, the summary says whether the card uses the rows.
  const inUsd = service({ key: KEY_B }).svc.importExport({ amount: AMOUNT, cost: COST, cardCurrency: 'usd' }).summary;
  assert.equal(inUsd.cardCurrency, 'USD');
  assert.equal(inUsd.currencyMatched, false);
  const inCny = service({ key: KEY_B }).svc.importExport({ amount: AMOUNT, cost: COST, cardCurrency: 'CNY' }).summary;
  assert.equal(inCny.currencyMatched, true);
  const other = service({ key: fullKey('9z9z9', '0000') }).svc.importExport({ amount: AMOUNT, cost: COST }).summary;
  assert.equal(other.savedKeyMatched, false);
  assert.equal(service({ key: '' }).svc.importExport({ amount: AMOUNT, cost: COST }).summary.savedKeyFp, null);
});

test('the card reads only the saved key\'s rows, and nothing without a saved key', () => {
  const db = new Database(':memory:');
  let key = KEY_B;
  const svc = createDeepSeekUsageImportService({ db, getApiKey: () => key, now: DURING_25TH });
  svc.importExport({ amount: AMOUNT, cost: COST });
  assert.deepEqual(svc.readActuals(), {
    keyFp: 'sk-4e5f6…7a8b',
    through: '2026-10-25T00:00:00+01:00',
    rows: [
      { day: '2026-10-24', model: 'deepseek-flash', hitTokens: 297984, missTokens: 263711, outputTokens: 1471, requestCount: 30, cost: 0.27555468, currency: 'CNY' },
      { day: '2026-10-24', model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 77506, outputTokens: 72, requestCount: 7, cost: 0.349749, currency: 'CNY' },
    ],
    coveredDays: [{ day: '2026-10-24', currency: 'CNY' }],
  });
  key = KEY_A;
  assert.deepEqual(svc.readActuals().rows.map((row) => row.model), ['deepseek-flash']);
  key = fullKey('9z9z9', '0000');
  assert.equal(svc.readActuals(), null);
  key = '';
  assert.equal(svc.readActuals(), null);
});

test('the CLI\'s import reads the files and the saved key from the database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-deepseek-import-'));
  const dbPath = path.join(dir, 'copilot.db');
  const setup = new Database(dbPath);
  setup.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  setup.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run('deepseek_api_key', KEY_A, 'now');
  setup.close();
  try {
    const result = importDeepSeekUsageFiles({
      amountPath: path.join(FIXTURES, 'amount.csv'),
      costPath: path.join(FIXTURES, 'cost.csv'),
      dbPath,
      now: AFTER_25TH,
    });
    assert.equal(result.ok, true);
    assert.equal(result.summary.rows, 9);
    assert.equal(result.summary.savedKeyMatched, true);
    const check = new Database(dbPath, { readonly: true });
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM deepseek_usage_actuals').get().n, 9);
    check.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const oneDay = (start, end, { tokens = 1000, price = '0.000004', key = masked('1a2b3', '9c0d') } = {}) => ({
  amount: [AMOUNT_HEADER, `u,${start},${end},deepseek-flash,deepseek-flash,K,${key},output_tokens,${price},${tokens}`].join('\r\n'),
  cost: [COST_HEADER, `u,${start},${end},deepseek-flash,deepseek-flash,Paid,${tokens * Number(price)},CNY`].join('\r\n'),
});

test('a re-export of a day at another offset replaces that day instead of adding to it', () => {
  const { db, svc } = service({ now: AFTER_25TH });
  assert.equal(svc.importExport(oneDay('2026-10-20T00:00:00+01:00', '2026-10-21T00:00:00+01:00', { tokens: 1000 })).ok, true);
  assert.equal(svc.importExport(oneDay('2026-10-20T00:00:00+02:00', '2026-10-21T00:00:00+02:00', { tokens: 1500 })).ok, true);
  assert.equal(svc.importExport(oneDay('2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', { tokens: 2000 })).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deepseek_usage_actuals').get().n, 1);
  const { rows } = svc.readActuals();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outputTokens, 2000);
  assert.equal(rows[0].cost, 0.008);
});

test('a day with a period not ended yet is left out whole', () => {
  const amount = [
    AMOUNT_HEADER,
    `u,2026-10-25T00:00:00Z,2026-10-25T12:00:00Z,deepseek-flash,deepseek-flash,K,${masked('1a2b3', '9c0d')},output_tokens,0.000004,1000`,
    `u,2026-10-25T12:00:00Z,2026-10-26T00:00:00Z,deepseek-flash,deepseek-flash,K,${masked('1a2b3', '9c0d')},output_tokens,0.000004,1000`,
  ].join('\n');
  const cost = [
    COST_HEADER,
    'u,2026-10-25T00:00:00Z,2026-10-25T12:00:00Z,deepseek-flash,deepseek-flash,Paid,0.004,CNY',
    'u,2026-10-25T12:00:00Z,2026-10-26T00:00:00Z,deepseek-flash,deepseek-flash,Paid,0.004,CNY',
  ].join('\n');
  const during = parseDeepSeekUsageExport({ amount, cost, now: new Date('2026-10-25T18:00:00Z') });
  assert.equal(during.ok, true);
  assert.deepEqual(during.rows, []);
  const after = parseDeepSeekUsageExport({ amount, cost, now: AFTER_25TH() });
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0].outputTokens, 2000);
  assert.equal(after.rows[0].periodStart, '2026-10-25T00:00:00Z');
  assert.equal(after.rows[0].periodEnd, '2026-10-26T00:00:00Z');
});

test('numbers are plain decimals and dates real ones', () => {
  assert.equal(readDecimal('0.00000002'), 0.00000002);
  assert.equal(readDecimal('17'), 17);
  assert.equal(readDecimal(''), null);
  for (const bad of ['0x10', '1e3', '-1', '+1', ' 1', '1.', '.5', 'Infinity', 'NaN']) assert.ok(Number.isNaN(readDecimal(bad)), bad);
  assert.deepEqual(readIsoWithOffset('2026-10-24T00:00:00+01:00')?.date, '2026-10-24');
  for (const bad of ['2026-02-30T00:00:00+01:00', '2026-13-01T00:00:00Z', '2026-10-24T24:00:00Z', '2026-10-24T10:61:00Z', '2026-10-24T00:00:00+25:00', '2026-10-24']) {
    assert.equal(readIsoWithOffset(bad), null, bad);
  }

  const hex = oneDay('2026-10-20T00:00:00+01:00', '2026-10-21T00:00:00+01:00');
  const hexAmount = hex.amount.replace(/,1000$/, ',0x10');
  assert.match(parseDeepSeekUsageExport({ amount: hexAmount, cost: hex.cost, now: AFTER_25TH() }).error, /Line 2 of the amount file has no readable price or amount/);
  const expCost = hex.cost.replace(/,0\.004,CNY$/, ',4e-3,CNY');
  assert.match(parseDeepSeekUsageExport({ amount: hex.amount, cost: expCost, now: AFTER_25TH() }).error, /Line 2 of the cost file has no readable cost/);
  const feb30 = oneDay('2026-02-30T00:00:00+01:00', '2026-03-01T00:00:00+01:00');
  assert.match(parseDeepSeekUsageExport({ ...feb30, now: AFTER_25TH() }).error, /Line 2 of the amount file has no readable period/);
});
