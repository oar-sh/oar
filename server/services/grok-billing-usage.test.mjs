'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGrokBillingUsageFetcher,
  normalizeGrokBillingCredits,
  readGrokCliAuthKey,
} from './grok-billing-usage.mjs';

// Live fixture (2026-08-08): GET cli-chat-proxy.grok.com/v1/billing?format=credits
// for an OIDC subscription login showing 25% weekly SuperGrok usage.
const LIVE_BILLING_PAYLOAD = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-08-04T15:53:24.625338+00:00',
      end: '2026-08-11T15:53:24.625338+00:00',
    },
    creditUsagePercent: 25.0,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [{ product: 'GrokBuild', usagePercent: 25.0 }],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    billingPeriodStart: '2026-08-04T15:53:24.625338+00:00',
    billingPeriodEnd: '2026-08-11T15:53:24.625338+00:00',
  },
};

test('normalizeGrokBillingCredits reads the live proxy payload', () => {
  const billing = normalizeGrokBillingCredits(LIVE_BILLING_PAYLOAD);
  assert.ok(billing);
  assert.equal(billing.usagePercent, 25);
  assert.equal(billing.periodType, 'weekly');
  assert.equal(billing.periodEnd, '2026-08-11T15:53:24.625Z');
  assert.deepEqual(billing.products, [{ product: 'GrokBuild', usagePercent: 25 }]);
});

test('normalizeGrokBillingCredits returns null for unusable payloads', () => {
  assert.equal(normalizeGrokBillingCredits(null), null);
  assert.equal(normalizeGrokBillingCredits({}), null);
  assert.equal(normalizeGrokBillingCredits({ config: { creditUsagePercent: -5 } }), null);
});

test('readGrokCliAuthKey picks the newest entry and never throws', () => {
  const fsImpl = {
    readFileSync: () => JSON.stringify({
      'https://auth.x.ai::old': { key: 'old-key', create_time: '2026-08-01T00:00:00Z' },
      'https://auth.x.ai::new': { key: 'new-key', create_time: '2026-08-08T00:00:00Z', expires_at: '2026-08-08T06:00:00Z' },
    }),
  };
  const auth = readGrokCliAuthKey({ homeDir: 'X:/nope', fsImpl });
  assert.equal(auth.key, 'new-key');
  assert.equal(auth.expiresAt, '2026-08-08T06:00:00Z');
  assert.equal(readGrokCliAuthKey({ homeDir: 'X:/definitely-missing', fsImpl: { readFileSync: () => { throw new Error('ENOENT'); } } }), null);
});

test('fetcher degrades to null on missing login, HTTP errors, and throwing fetch', async () => {
  const noLogin = createGrokBillingUsageFetcher({
    fetchImpl: async () => { throw new Error('should not be called'); },
    readAuthKeyImpl: () => null,
  });
  assert.equal(await noLogin(), null);

  const httpError = createGrokBillingUsageFetcher({
    fetchImpl: async () => ({ ok: false, status: 401 }),
    readAuthKeyImpl: () => ({ key: 'k' }),
  });
  assert.equal(await httpError(), null);

  const throwing = createGrokBillingUsageFetcher({
    fetchImpl: async () => { throw new Error('network down'); },
    readAuthKeyImpl: () => ({ key: 'k' }),
  });
  assert.equal(await throwing(), null);
});

test('fetcher normalizes a successful response and sends the bearer key', async () => {
  let seenAuth = null;
  const fetcher = createGrokBillingUsageFetcher({
    fetchImpl: async (_url, options) => {
      seenAuth = options?.headers?.Authorization || null;
      return { ok: true, json: async () => LIVE_BILLING_PAYLOAD };
    },
    readAuthKeyImpl: () => ({ key: 'cli-key' }),
  });
  const billing = await fetcher();
  assert.equal(billing.usagePercent, 25);
  assert.equal(seenAuth, 'Bearer cli-key');
});

const FAKE_KEY = 'fake-bearer-0123456789';
const FIXED_NOW = Date.parse('2026-03-14T09:26:00Z');

async function outcomeOf(options) {
  let seen = null;
  const fetcher = createGrokBillingUsageFetcher({ now: () => FIXED_NOW, ...options });
  const usage = await fetcher({ onResult: (result) => { seen = result; } });
  return { usage, seen };
}

function assertNoSecret(result) {
  const text = JSON.stringify(result);
  assert.ok(!text.includes(FAKE_KEY), 'outcome must not carry the bearer key');
  assert.ok(!text.includes('billing?format'), 'outcome must not carry the request URL');
  assert.ok(!text.includes('secret-value'), 'outcome must not carry answer values');
}

test('fetcher reports no-login when the auth store has no usable key', async () => {
  const { usage, seen } = await outcomeOf({
    fetchImpl: async () => { throw new Error('should not be called'); },
    readAuthKeyImpl: () => readGrokCliAuthKey({
      homeDir: '/home/dev',
      fsImpl: { readFileSync: () => JSON.stringify({ 'https://auth.example::a': { key: '  ' } }) },
    }),
  });
  assert.equal(usage, null);
  assert.equal(seen.reason, 'no-login');
  assert.equal(seen.checkedAt, '2026-03-14T09:26:00.000Z');
  assertNoSecret(seen);
});

test('fetcher tells a refused login from an expired one and from other HTTP errors', async () => {
  for (const status of [401, 403]) {
    const { usage, seen } = await outcomeOf({
      fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: 'secret-value' }) }),
      readAuthKeyImpl: () => ({ key: FAKE_KEY, expiresAt: '2026-03-14T12:00:00Z' }),
    });
    assert.equal(usage, null);
    assert.equal(seen.reason, 'not-authorized');
    assert.equal(seen.httpStatus, status);
    assertNoSecret(seen);
  }
  const expired = await outcomeOf({
    fetchImpl: async () => ({ ok: false, status: 401 }),
    readAuthKeyImpl: () => ({ key: FAKE_KEY, expiresAt: '2026-03-14T08:00:00Z' }),
  });
  assert.equal(expired.seen.reason, 'login-expired');
  assertNoSecret(expired.seen);

  const serverError = await outcomeOf({
    fetchImpl: async () => ({ ok: false, status: 503 }),
    readAuthKeyImpl: () => ({ key: FAKE_KEY }),
  });
  assert.equal(serverError.seen.reason, 'http-503');
  assert.equal(serverError.seen.httpStatus, 503);
  assertNoSecret(serverError.seen);
});

test('fetcher tells a timeout from an unreachable host', async () => {
  const timeout = await outcomeOf({
    fetchImpl: async () => { const error = new Error(`timed out for ${FAKE_KEY}`); error.name = 'TimeoutError'; throw error; },
    readAuthKeyImpl: () => ({ key: FAKE_KEY }),
  });
  assert.equal(timeout.usage, null);
  assert.equal(timeout.seen.reason, 'timeout');
  assertNoSecret(timeout.seen);

  const network = await outcomeOf({
    fetchImpl: async () => { throw new Error(`connect refused, Bearer ${FAKE_KEY}`); },
    readAuthKeyImpl: () => ({ key: FAKE_KEY }),
  });
  assert.equal(network.seen.reason, 'network');
  assertNoSecret(network.seen);
});

test('fetcher reports an unknown answer format with capped key names only', async () => {
  const payload = { config: { planState: 'secret-value', 'odd key<b>': 1 } };
  for (let index = 0; index < 20; index += 1) payload.config[`field${index}`] = 'secret-value';
  const { usage, seen } = await outcomeOf({
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
    readAuthKeyImpl: () => ({ key: FAKE_KEY }),
  });
  assert.equal(usage, null);
  assert.equal(seen.reason, 'unknown-format');
  assert.equal(seen.keys.length, 12);
  assert.deepEqual(seen.keys.slice(0, 3), ['planState', 'oddkeyb', 'field0']);
  assertNoSecret(seen);

  const notJson = await outcomeOf({
    fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    readAuthKeyImpl: () => ({ key: FAKE_KEY }),
  });
  assert.equal(notJson.seen.reason, 'unknown-format');
  assert.deepEqual(notJson.seen.keys, []);
});

test('fetcher reports no reason on success and survives a throwing observer', async () => {
  const { usage, seen } = await outcomeOf({
    fetchImpl: async () => ({ ok: true, json: async () => LIVE_BILLING_PAYLOAD }),
    readAuthKeyImpl: () => ({ key: FAKE_KEY }),
  });
  assert.equal(usage.usagePercent, 25);
  assert.equal(seen.reason, null);
  assert.equal(seen.usage, usage);

  const fetcher = createGrokBillingUsageFetcher({
    fetchImpl: async () => ({ ok: false, status: 500 }),
    readAuthKeyImpl: () => ({ key: FAKE_KEY }),
  });
  assert.equal(await fetcher({ onResult: () => { throw new Error('observer broke'); } }), null);
});
