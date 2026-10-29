import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

import { createDeepSeekUsageImportService } from '../services/deepseek-usage-import.mjs';
import { DEEPSEEK_USAGE_IMPORT_CURRENCY_WAIT_MS, DEEPSEEK_USAGE_IMPORT_MAX_BYTES, registerDeepSeekUsageImportRoutes } from './deepseek-usage-import-routes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '..', '..', 'tests', 'fixtures', 'deepseek-usage-export');
const AMOUNT = fs.readFileSync(path.join(FIXTURES, 'amount.csv'), 'utf8');
const COST = fs.readFileSync(path.join(FIXTURES, 'cost.csv'), 'utf8');
const KEY = `sk-4e5f6${'x'.repeat(23)}7a8b`; // invented; one of the fixture's keys

function createMockApp() {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers);
  return { routes, get: register('GET'), post: register('POST') };
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  const request = Object.assign(req, { body: req.body || {}, headers: req.headers || {} });
  for (const handler of handlers) {
    let next = false;
    await handler(request, response, () => { next = true; });
    if (!next) break;
  }
  return response;
}

function setup({ withService = true, service = null, getCardCurrency = undefined, logError = () => {} } = {}) {
  const db = new Database(':memory:');
  const svc = service || createDeepSeekUsageImportService({ db, getApiKey: () => KEY, now: () => new Date('2026-10-26T12:00:00Z') });
  const app = createMockApp();
  registerDeepSeekUsageImportRoutes(app, {
    auth: (_req, _res, next) => next(),
    ...(withService ? { deepseekUsageImportService: svc } : {}),
    remoteRelayInbound: { listRelays: () => [], inboundEnabled: () => true },
    ...(getCardCurrency !== undefined ? { getCardCurrency } : {}),
    logError,
  });
  return { db, route: app.routes.get('POST /api/deepseek-usage-import') };
}

test('the relay\'s user imports the export and gets the summary', async () => {
  const { db, route } = setup();
  const res = await callRoute(route, { body: { amount: AMOUNT, cost: COST } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.summary.rows, 9);
  assert.equal(res.body.summary.savedKeyMatched, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deepseek_usage_actuals').get().n, 9);
});

test('another relay\'s agent is refused and nothing is stored', async () => {
  const { db, route } = setup();
  const res = await callRoute(route, {
    headers: { 'x-oar-remote-origin': 'relay-fixture-b', 'x-oar-remote-hops': '1' },
    body: { amount: AMOUNT, cost: COST },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deepseek_usage_actuals').get().n, 0);
});

test('missing files, files too large and a bad export are refused', async () => {
  const { route } = setup();
  assert.equal((await callRoute(route, { body: { amount: AMOUNT } })).statusCode, 400);
  const big = 'x'.repeat(DEEPSEEK_USAGE_IMPORT_MAX_BYTES);
  assert.equal((await callRoute(route, { body: { amount: big, cost: COST } })).statusCode, 413);
  const swapped = await callRoute(route, { body: { amount: COST, cost: AMOUNT } });
  assert.equal(swapped.statusCode, 400);
  assert.match(swapped.body.error, /amount file/);
});

test('without the service the route answers 501', async () => {
  const { route } = setup({ withService: false });
  assert.equal((await callRoute(route, { body: { amount: AMOUNT, cost: COST } })).statusCode, 501);
});

test('the summary has the export\'s and the card\'s currency', async () => {
  const usd = await callRoute(setup({ getCardCurrency: async () => 'USD' }).route, { body: { amount: AMOUNT, cost: COST } });
  assert.deepEqual([usd.body.summary.currencies, usd.body.summary.cardCurrency, usd.body.summary.currencyMatched], [['CNY'], 'USD', false]);
  const cny = await callRoute(setup({ getCardCurrency: () => 'CNY' }).route, { body: { amount: AMOUNT, cost: COST } });
  assert.equal(cny.body.summary.currencyMatched, true);
  // A balance that cannot be read leaves the card's currency open; the import still runs.
  const failing = await callRoute(setup({ getCardCurrency: async () => { throw new Error('offline'); } }).route, { body: { amount: AMOUNT, cost: COST } });
  assert.equal(failing.statusCode, 200);
  assert.equal(failing.body.summary.cardCurrency, null);
});

test('a failure is logged on the relay and answered with a generic message', async () => {
  const logged = [];
  const service = { importExport: () => { throw new Error('SQLITE_FULL: /secret/path/oar.db'); } };
  const { route } = setup({ service, logError: (message, err) => logged.push([message, err.message]) });
  const res = await callRoute(route, { body: { amount: AMOUNT, cost: COST } });
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body.error, /SQLITE|secret/);
  assert.match(res.body.error, /nothing was imported/);
  assert.equal(logged.length, 1);
  assert.match(logged[0][1], /SQLITE_FULL/);
});

test('a balance that does not answer holds the import up for 5 s at most', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { route } = setup({ getCardCurrency: () => new Promise(() => {}) });
  let settled = false;
  const pending = callRoute(route, { body: { amount: AMOUNT, cost: COST } }).then((res) => { settled = true; return res; });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(DEEPSEEK_USAGE_IMPORT_CURRENCY_WAIT_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const res = await pending;
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.summary.cardCurrency, null);
  assert.equal(res.body.summary.currencyMatched, null);
});
