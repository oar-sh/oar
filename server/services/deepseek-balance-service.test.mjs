import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeepSeekBalanceService } from './deepseek-balance-service.mjs';

const TEST_KEY = 'sk-test-0000000000000000';

function balanceResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const CNY_BODY = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
};

function setup({ settings = { enabled: true, apiKey: TEST_KEY, baseUrl: 'http://127.0.0.1:4011' }, respond } = {}) {
  let clock = Date.parse('2026-10-21T12:00:00.000Z');
  const requests = [];
  const state = { settings };
  const service = createDeepSeekBalanceService({
    getSettings: () => state.settings,
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options?.headers?.Authorization });
      return respond ? respond(requests.length) : balanceResponse(CNY_BODY);
    },
    now: () => clock,
  });
  return { service, requests, state, advance: (ms) => { clock += ms; } };
}

test('reads the balance with the saved key and base URL, and keeps it for a minute', async () => {
  const { service, requests, advance } = setup();
  const first = await service.getBalance();
  assert.deepEqual(first, {
    ok: true,
    isAvailable: true,
    balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }],
    fetchedAt: '2026-10-21T12:00:00.000Z',
    cached: false,
  });
  assert.deepEqual(requests, [{ url: 'http://127.0.0.1:4011/user/balance', authorization: `Bearer ${TEST_KEY}` }]);
  advance(59_000);
  assert.equal((await service.getBalance()).cached, true);
  assert.equal(requests.length, 1);
  advance(2_000);
  assert.equal((await service.getBalance()).cached, false);
  assert.equal(requests.length, 2);
  // force skips the cache.
  await service.getBalance({ force: true });
  assert.equal(requests.length, 3);
});

test('reads nothing while DeepSeek is off, and reads afresh for another key', async () => {
  const { service, requests, state } = setup();
  state.settings = { enabled: false, apiKey: TEST_KEY };
  assert.equal(await service.getBalance(), null);
  state.settings = null;
  assert.equal(await service.getBalance(), null);
  assert.equal(requests.length, 0);
  state.settings = { enabled: true, apiKey: TEST_KEY, baseUrl: 'http://127.0.0.1:4011' };
  await service.getBalance();
  state.settings = { enabled: true, apiKey: 'sk-test-1111111111111111', baseUrl: 'http://127.0.0.1:4011' };
  await service.getBalance();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].authorization, 'Bearer sk-test-1111111111111111');
});

test('peekBalance is the last good answer for the saved key, without a request', async () => {
  const { service, requests, state, advance } = setup({
    respond: (n) => (n === 1 ? balanceResponse(CNY_BODY) : balanceResponse({ error: { message: 'down' } }, 500)),
  });
  assert.equal(service.peekBalance(), null);
  await service.getBalance();
  assert.deepEqual(service.peekBalance().balances, [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }]);
  // A failed read keeps it.
  advance(61_000);
  assert.equal((await service.getBalance()).ok, false);
  assert.equal(service.peekBalance().balances[0].total, 110);
  assert.equal(requests.length, 2);
  // Another key, or DeepSeek off: none.
  state.settings = { enabled: true, apiKey: 'sk-test-1111111111111111', baseUrl: 'http://127.0.0.1:4011' };
  assert.equal(service.peekBalance(), null);
  state.settings = { enabled: false, apiKey: TEST_KEY, baseUrl: 'http://127.0.0.1:4011' };
  assert.equal(service.peekBalance(), null);
  assert.equal(requests.length, 2);
});

test('concurrent reads share one request', async () => {
  const { service, requests } = setup();
  const [a, b] = await Promise.all([service.getBalance(), service.getBalance()]);
  assert.equal(requests.length, 1);
  assert.equal(a.ok && b.ok, true);
});

test('a failure is an answer without the key, kept 15 seconds, with the last good one beside it', async () => {
  const { service, requests, advance } = setup({
    respond: (n) => (n === 1 ? balanceResponse(CNY_BODY) : balanceResponse({ error: { message: `bad key ${TEST_KEY}` } }, 401)),
  });
  await service.getBalance();
  advance(61_000);
  const failed = await service.getBalance();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'unauthorized');
  assert.match(failed.error, /DeepSeek balance check failed \(401\)/);
  assert.equal(JSON.stringify(failed).includes(TEST_KEY), false);
  assert.equal(failed.previous.ok, true);
  assert.equal(failed.previous.balances[0].total, 110);
  advance(10_000);
  const again = await service.getBalance();
  assert.equal(again.cached, true);
  assert.equal(again.previous.ok, true);
  assert.equal(requests.length, 2);
  advance(6_000);
  await service.getBalance();
  assert.equal(requests.length, 3);
});

test('a thrown client, a missing key and a broken settings reader never throw', async () => {
  const thrown = createDeepSeekBalanceService({
    getSettings: () => ({ enabled: true, apiKey: TEST_KEY }),
    createClient: () => ({ getBalance: async () => { throw new Error(`boom ${TEST_KEY}`); } }),
  });
  const answer = await thrown.getBalance();
  assert.deepEqual({ ok: answer.ok, code: answer.code, error: answer.error }, { ok: false, code: 'error', error: 'boom [redacted]' });

  const keyless = createDeepSeekBalanceService({ getSettings: () => ({ enabled: true, apiKey: '' }) });
  assert.equal((await keyless.getBalance()).code, 'not_configured');

  const broken = createDeepSeekBalanceService({ getSettings: () => { throw new Error('settings table gone'); } });
  assert.equal(await broken.getBalance(), null);
});
