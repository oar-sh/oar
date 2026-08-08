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
