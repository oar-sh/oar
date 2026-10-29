'use strict';

/**
 * The DeepSeek platform's usage export, imported so the usage card in Check
 * Usage shows what DeepSeek charged instead of the relay's estimate.
 *
 * The platform's usage page exports two CSV files for a date range:
 *  - the amounts: one row per period, model, API key and type
 *    (`input_cache_hit_tokens`, `input_cache_miss_tokens`, `output_tokens`,
 *    `request_count`) with the price per unit and the amount;
 *  - the costs: one row per period, model and wallet with the cost and its
 *    currency, for the whole account.
 *
 * The import keeps one row per export day, model and key in its own table
 * (migrations/0030-deepseek-usage-actuals.mjs) with the key masked as
 * `sk-XXXXX…YYYY`; the day is the date of the period's start in the export's
 * time zone. Its cost is amount × price summed; before anything is written
 * the sum over all keys of each period and model has to match the cost file,
 * or the import is refused whole. A day with a period that has not ended yet
 * (today's, in an export taken during the day) is left out: it would only be
 * part of the day. Importing the same files again changes nothing; a later
 * export replaces each key's rows of the days it covers, also when it was
 * taken in another time zone.
 *
 * The card counts only the rows of the key saved in Settings → Providers →
 * DeepSeek (`readActuals`), so the other keys of the account stay out of it.
 * The relay's own usage tables are never touched.
 *
 * CLI: npm run deepseek:import -- amount.csv cost.csv [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

import { cliDbPath } from './database-file.mjs';
import { DEEPSEEK_API_KEY_SETTING_KEY } from './deepseek-settings-service.mjs';
import { DEEPSEEK_USAGE_ACTUALS_TABLE, migrateDeepSeekUsageActuals } from '../migrations/0030-deepseek-usage-actuals.mjs';

// Per period and model, the amounts' cost and the cost file may differ by
// this much (the prices have up to eight decimals).
export const DEEPSEEK_IMPORT_COST_TOLERANCE = 1e-6;

const AMOUNT_HEADERS = Object.freeze(['start_time_iso', 'end_time_iso', 'model', 'api_key_name', 'api_key', 'type', 'price', 'amount']);
const COST_HEADERS = Object.freeze(['start_time_iso', 'end_time_iso', 'model', 'cost', 'currency']);

// The amount types that are token or request counts, and their columns.
const TYPE_FIELDS = Object.freeze({
  input_cache_hit_tokens: 'hitTokens',
  input_cache_miss_tokens: 'missTokens',
  output_tokens: 'outputTokens',
  request_count: 'requestCount',
});

const MODEL_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/;
// A plain decimal: no sign, exponent, hex or blanks.
const DECIMAL = /^\d+(?:\.\d+)?$/;

const tenDecimals = (value) => Math.round(Number(value) * 1e10) / 1e10;

/**
 * A key as `sk-XXXXX…YYYY`: the five characters after `sk-` and the last
 * four, the same for the export's masked key and the saved one. '' for
 * anything that is not a DeepSeek key.
 */
export function deepseekKeyFingerprint(value) {
  const key = String(value ?? '').trim();
  if (!/^sk-[A-Za-z0-9]{5}/.test(key) || key.length < 12) return '';
  const tail = key.slice(-4);
  if (!/^[A-Za-z0-9]{4}$/.test(tail)) return '';
  return `${key.slice(0, 8)}…${tail}`;
}

/** The rows of a CSV text: a BOM and CRLF line ends are fine, quoted fields too. */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

/** `[{ header: value }]` for a CSV with these headers, or `{ error }`. */
function readTable(text, required, label) {
  const rows = parseCsv(text);
  if (!rows.length) return { error: `The ${label} file is empty.` };
  const headers = rows[0].map((value) => value.trim());
  const missing = required.filter((name) => !headers.includes(name));
  if (missing.length) {
    return { error: `The ${label} file is not a DeepSeek usage export: it lacks the column${missing.length === 1 ? '' : 's'} ${missing.join(', ')}.` };
  }
  return {
    rows: rows.slice(1).map((values, index) => {
      const entry = { line: index + 2 };
      headers.forEach((name, column) => { entry[name] = String(values[column] ?? '').trim(); });
      return entry;
    }),
  };
}

/**
 * An ISO time with its offset whose fields are a real date and time
 * (2026-02-30 or 25:00 is not): `{ date, ms }`, or null.
 */
export function readIsoWithOffset(value) {
  const match = ISO_WITH_OFFSET.exec(String(value ?? ''));
  if (!match) return null;
  const [, year, month, dayOfMonth, hours, minutes, seconds = '00', zone, zoneHours = '00', zoneMinutes = '00'] = match;
  const fields = [year, month, dayOfMonth, hours, minutes, seconds].map(Number);
  const local = new Date(Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5]));
  const sameFields = local.getUTCFullYear() === fields[0]
    && local.getUTCMonth() === fields[1] - 1
    && local.getUTCDate() === fields[2]
    && local.getUTCHours() === fields[3]
    && local.getUTCMinutes() === fields[4]
    && local.getUTCSeconds() === fields[5];
  if (!sameFields || Number(zoneHours) > 14 || Number(zoneMinutes) > 59) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return { date: `${year}-${month}-${dayOfMonth}`, ms, zone };
}

function period(entry, label) {
  const start = readIsoWithOffset(entry.start_time_iso);
  const end = readIsoWithOffset(entry.end_time_iso);
  if (!start || !end || end.ms <= start.ms) {
    return { error: `Line ${entry.line} of the ${label} file has no readable period.` };
  }
  return { start: entry.start_time_iso, end: entry.end_time_iso, endMs: end.ms, day: start.date };
}

/** A plain decimal, null for an empty field, NaN for anything else. */
export function readDecimal(value) {
  if (value === '') return null;
  if (!DECIMAL.test(value)) return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

const number = readDecimal;

/**
 * The two files, checked against each other: `{ ok: true, rows, skipped }`
 * with one row per export day, model and key, or `{ ok: false, error }`.
 * `rows` leaves out the days with a period that ends after `now`; `skipped`
 * names those periods.
 */
export function parseDeepSeekUsageExport({ amount, cost, now = new Date() } = {}) {
  const amounts = readTable(amount, AMOUNT_HEADERS, 'amount');
  if (amounts.error) return { ok: false, error: amounts.error };
  const costs = readTable(cost, COST_HEADERS, 'cost');
  if (costs.error) return { ok: false, error: costs.error };
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);

  const rows = new Map();
  const computed = new Map();
  const skipped = new Set();
  const unfinishedDays = new Set();
  for (const entry of amounts.rows) {
    const when = period(entry, 'amount');
    if (when.error) return { ok: false, error: when.error };
    const model = entry.model.toLowerCase();
    if (!MODEL_PATTERN.test(model)) return { ok: false, error: `Line ${entry.line} of the amount file has no readable model.` };
    const keyFp = deepseekKeyFingerprint(entry.api_key);
    if (!keyFp) return { ok: false, error: `Line ${entry.line} of the amount file has no readable API key.` };
    const price = number(entry.price);
    const quantity = number(entry.amount);
    if (Number.isNaN(price) || quantity === null || Number.isNaN(quantity)) {
      return { ok: false, error: `Line ${entry.line} of the amount file has no readable price or amount.` };
    }
    if (when.endMs > nowMs) {
      skipped.add(when.start);
      unfinishedDays.add(when.day);
      continue;
    }
    const periodKey = `${when.start}\u0000${model}`;
    const rowKey = `${when.day}\u0000${model}\u0000${keyFp}`;
    const row = rows.get(rowKey) || {
      periodStart: when.start,
      periodEnd: when.end,
      day: when.day,
      model,
      keyFp,
      keyName: entry.api_key_name,
      hitTokens: 0,
      missTokens: 0,
      outputTokens: 0,
      requestCount: 0,
      cost: 0,
      currency: '',
    };
    if (when.start < row.periodStart) row.periodStart = when.start;
    if (when.end > row.periodEnd) row.periodEnd = when.end;
    const field = TYPE_FIELDS[entry.type];
    if (field) row[field] += Math.round(quantity);
    const rowCost = price === null ? 0 : quantity * price;
    row.cost += rowCost;
    rows.set(rowKey, row);
    computed.set(periodKey, (computed.get(periodKey) || 0) + rowCost);
  }

  const charged = new Map();
  const currencies = new Map();
  const allCurrencies = new Set();
  for (const entry of costs.rows) {
    const when = period(entry, 'cost');
    if (when.error) return { ok: false, error: when.error };
    if (when.endMs > nowMs) continue;
    const model = entry.model.toLowerCase();
    const value = number(entry.cost);
    if (value === null || Number.isNaN(value)) return { ok: false, error: `Line ${entry.line} of the cost file has no readable cost.` };
    const currency = entry.currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: `Line ${entry.line} of the cost file has no readable currency.` };
    const periodKey = `${when.start}\u0000${model}`;
    charged.set(periodKey, (charged.get(periodKey) || 0) + value);
    const seen = currencies.get(periodKey) || new Set();
    seen.add(currency);
    currencies.set(periodKey, seen);
    allCurrencies.add(currency);
  }

  // Every period and model of either file: the amounts' cost has to be what
  // DeepSeek charged.
  for (const periodKey of new Set([...computed.keys(), ...charged.keys()])) {
    const [start, model] = periodKey.split('\u0000');
    const fromAmounts = computed.get(periodKey) || 0;
    const fromCosts = charged.get(periodKey) || 0;
    if (Math.abs(fromAmounts - fromCosts) > DEEPSEEK_IMPORT_COST_TOLERANCE) {
      return {
        ok: false,
        error: `The files do not match for ${model} from ${start}: the amounts come to ${tenDecimals(fromAmounts)}, the cost file says ${tenDecimals(fromCosts)}. Export both files for the same range and import them together.`,
      };
    }
    if ((currencies.get(periodKey)?.size || 0) > 1) {
      return { ok: false, error: `The cost file has more than one currency for ${model} from ${start}.` };
    }
  }

  const soleCurrency = allCurrencies.size === 1 ? [...allCurrencies][0] : '';
  // A day's periods share their currency (a day is one period in the
  // platform's export); one with two is refused.
  const dayCurrencies = new Map();
  for (const [periodKey, seen] of currencies) {
    const [start, model] = periodKey.split('\u0000');
    const when = readIsoWithOffset(start);
    const dayKey = `${when.date}\u0000${model}`;
    const all = dayCurrencies.get(dayKey) || new Set();
    for (const value of seen) all.add(value);
    if (all.size > 1) return { ok: false, error: `The cost file has more than one currency for ${model} on ${when.date}.` };
    dayCurrencies.set(dayKey, all);
  }
  const list = [...rows.values()]
    .filter((row) => !unfinishedDays.has(row.day))
    .map((row) => {
      const seen = dayCurrencies.get(`${row.day}\u0000${row.model}`);
      const currency = seen ? [...seen][0] : soleCurrency;
      return { ...row, cost: tenDecimals(row.cost), currency };
    });
  list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : a.keyFp < b.keyFp ? -1 : a.keyFp > b.keyFp ? 1 : 0));
  return { ok: true, rows: list, skipped: [...skipped].sort() };
}

/**
 * @param {object} options
 * @param {object} options.db           better-sqlite3 database
 * @param {Function} [options.getApiKey] the saved DeepSeek key, or ''
 * @param {Function} [options.now]
 */
export function createDeepSeekUsageImportService({ db, getApiKey = () => '', now = () => new Date() } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('createDeepSeekUsageImportService requires a database');
  migrateDeepSeekUsageActuals(db);
  const clearKeyDay = db.prepare(`DELETE FROM ${DEEPSEEK_USAGE_ACTUALS_TABLE} WHERE key_fp = ? AND day = ?`);
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO ${DEEPSEEK_USAGE_ACTUALS_TABLE}
      (period_start, period_end, day, model, key_fp, key_name, hit_tokens, miss_tokens, output_tokens, request_count, cost, currency, imported_at)
    VALUES (@periodStart, @periodEnd, @day, @model, @keyFp, @keyName, @hitTokens, @missTokens, @outputTokens, @requestCount, @cost, @currency, @importedAt)
  `);
  // Each key's days in the export replace what an earlier import had for
  // them, whatever time zone that one was taken in.
  const writeAll = db.transaction((rows, importedAt) => {
    for (const keyDay of new Set(rows.map((row) => `${row.keyFp}\u0000${row.day}`))) {
      clearKeyDay.run(...keyDay.split('\u0000'));
    }
    for (const row of rows) upsert.run({ ...row, importedAt });
  });
  const listForKey = db.prepare(`
    SELECT day, model, currency,
      SUM(hit_tokens) AS hit_tokens, SUM(miss_tokens) AS miss_tokens, SUM(output_tokens) AS output_tokens,
      SUM(request_count) AS request_count, SUM(cost) AS cost, MAX(period_end) AS period_end
    FROM ${DEEPSEEK_USAGE_ACTUALS_TABLE}
    WHERE key_fp = ?
    GROUP BY day, model, currency
    ORDER BY day, model
  `);
  // The days the imports cover, for every key: on them the export has what
  // the account was charged, so the saved key's absence is a day without spend.
  const listCoveredDays = db.prepare(`
    SELECT DISTINCT day, currency FROM ${DEEPSEEK_USAGE_ACTUALS_TABLE} ORDER BY day, currency
  `);

  function savedKeyFp() {
    try {
      return deepseekKeyFingerprint(getApiKey?.() || '');
    } catch {
      return '';
    }
  }

  /**
   * Imports the two CSV texts: `{ ok: true, summary }` or `{ ok: false,
   * error }`. The summary: `{ rows, days, models, keys: [{ keyFp, keyName,
   * rows }], skippedPeriods, through, savedKeyFp, savedKeyMatched,
   * currencies, cardCurrency, currencyMatched }`. `cardCurrency` is the
   * usage card's currency when the caller knows it (null otherwise);
   * `currencyMatched` says whether the card can use the saved key's rows.
   */
  function importExport({ amount, cost, cardCurrency = null } = {}) {
    const clock = now();
    const parsed = parseDeepSeekUsageExport({ amount, cost, now: clock });
    if (!parsed.ok) return parsed;
    writeAll(parsed.rows, (clock instanceof Date ? clock : new Date(clock)).toISOString());
    const keys = new Map();
    for (const row of parsed.rows) {
      const entry = keys.get(row.keyFp) || { keyFp: row.keyFp, keyName: row.keyName, rows: 0 };
      entry.rows += 1;
      keys.set(row.keyFp, entry);
    }
    const saved = savedKeyFp();
    const card = /^[A-Z]{3}$/.test(String(cardCurrency || '').toUpperCase()) ? String(cardCurrency).toUpperCase() : null;
    const savedRows = parsed.rows.filter((row) => row.keyFp === saved);
    const currencies = [...new Set(parsed.rows.map((row) => row.currency).filter(Boolean))].sort();
    return {
      ok: true,
      summary: {
        rows: parsed.rows.length,
        days: [...new Set(parsed.rows.map((row) => row.day))],
        models: [...new Set(parsed.rows.map((row) => row.model))].sort(),
        keys: [...keys.values()],
        skippedPeriods: parsed.skipped,
        through: parsed.rows.reduce((latest, row) => (row.periodEnd > latest ? row.periodEnd : latest), '') || null,
        savedKeyFp: saved || null,
        savedKeyMatched: !!saved && keys.has(saved),
        currencies,
        cardCurrency: card,
        currencyMatched: card ? savedRows.some((row) => row.currency === card) : null,
      },
    };
  }

  /**
   * The saved key's imported figures per export day and model, for the
   * usage card: `{ keyFp, through, rows: [{ day, model, hitTokens,
   * missTokens, outputTokens, requestCount, cost, currency }], coveredDays:
   * [{ day, currency }] }`, or null without a saved key or rows for it.
   * `coveredDays` are the days any import covers, for any key: the card
   * replaces the estimate on those days only.
   */
  function readActuals() {
    const keyFp = savedKeyFp();
    if (!keyFp) return null;
    const rows = listForKey.all(keyFp);
    if (!rows.length) return null;
    return {
      keyFp,
      through: rows.reduce((latest, row) => (row.period_end > latest ? row.period_end : latest), ''),
      rows: rows.map((row) => ({
        day: row.day,
        model: row.model,
        hitTokens: Number(row.hit_tokens) || 0,
        missTokens: Number(row.miss_tokens) || 0,
        outputTokens: Number(row.output_tokens) || 0,
        requestCount: Number(row.request_count) || 0,
        cost: tenDecimals(row.cost || 0),
        currency: row.currency,
      })),
      coveredDays: listCoveredDays.all().map((row) => ({ day: row.day, currency: row.currency })),
    };
  }

  return { importExport, readActuals };
}

/** The CLI's work: reads the files, imports them into the database at `dbPath`. */
export function importDeepSeekUsageFiles({ amountPath, costPath, dbPath = cliDbPath(null, new URL('..', import.meta.url)), now = () => new Date() } = {}) {
  const amount = fs.readFileSync(amountPath, 'utf8');
  const cost = fs.readFileSync(costPath, 'utf8');
  const db = new Database(dbPath);
  try {
    // The saved key, read straight from the app settings table like the relay does.
    const getApiKey = () => {
      try {
        return String(db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(DEEPSEEK_API_KEY_SETTING_KEY)?.value || '').trim();
      } catch {
        return '';
      }
    };
    return createDeepSeekUsageImportService({ db, getApiKey, now }).importExport({ amount, cost });
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [amountArg, costArg, dbArg] = process.argv.slice(2);
  if (!amountArg || !costArg) {
    console.error('Usage: npm run deepseek:import -- amount.csv cost.csv [path/to/oar.db]');
    process.exit(2);
  }
  try {
    // The given path, else the database in server/data; never a new one.
    const dbPath = cliDbPath(dbArg, new URL('..', import.meta.url));
    const result = importDeepSeekUsageFiles({ amountPath: path.resolve(amountArg), costPath: path.resolve(costArg), dbPath });
    if (!result.ok) {
      console.error(`DeepSeek usage import refused: ${result.error}`);
      process.exit(1);
    }
    const { summary } = result;
    console.log(`DeepSeek usage import on ${dbPath}`);
    console.log(`  rows ${summary.rows}, days ${summary.days.join(', ') || 'none'}, models ${summary.models.join(', ') || 'none'}`);
    for (const key of summary.keys) console.log(`  key ${key.keyFp}${key.keyName ? ` (${key.keyName})` : ''}: ${key.rows} rows`);
    if (summary.currencies.length) console.log(`  currency ${summary.currencies.join(', ')}: the usage card uses the rows in its own currency (the balance's) only`);
    if (summary.skippedPeriods.length) console.log(`  left out, not ended yet: ${summary.skippedPeriods.join(', ')}`);
    console.log(summary.savedKeyFp
      ? `  saved key ${summary.savedKeyFp}: ${summary.savedKeyMatched ? 'in the export, the card counts its rows' : 'not in the export, the card is unchanged'}`
      : '  no saved DeepSeek key: the card counts nothing until one is saved');
    process.exit(0);
  } catch (err) {
    console.error(`DeepSeek usage import failed: ${err?.message || err}`);
    process.exit(1);
  }
}
