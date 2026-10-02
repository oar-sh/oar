import test from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeCloudError } from '../../shared/claude-cloud/credentials.mjs';
import { createClaudeAccountUsageService } from './claude-account-usage-service.mjs';

const START_MS = Date.parse('2026-10-02T10:00:00.000Z');
const TOKEN = 'test-token-value';

const USAGE = { five_hour: { utilization: 12, resets_at: '2026-10-02T14:00:00Z' } };
const PREPAID = { amount: 1250, currency: 'USD' };
const OFFER = { available: false, eligible: false, granted: true };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A cloud client that counts its calls; every answer can be a value, an Error or a function. */
function fakeClient(answers = {}) {
  const calls = { getAccountUsage: 0, getOrganizationId: 0, getPrepaidCredits: 0, getCreditGrantOffer: 0 };
  const defaults = {
    getAccountUsage: USAGE,
    getOrganizationId: '00000000-0000-4000-8000-000000000001',
    getPrepaidCredits: PREPAID,
    getCreditGrantOffer: OFFER,
  };
  const client = { calls };
  for (const method of Object.keys(calls)) {
    client[method] = async () => {
      calls[method] += 1;
      const answer = method in answers ? answers[method] : defaults[method];
      const value = typeof answer === 'function' ? await answer() : answer;
      if (value instanceof Error) throw value;
      return value;
    };
  }
  return client;
}

function setup({ answers, enabled = true, cacheMs } = {}) {
  const clock = { ms: START_MS };
  const state = { enabled };
  const cloudClient = fakeClient(answers);
  const service = createClaudeAccountUsageService({
    cloudClient,
    isEnabled: () => state.enabled,
    now: () => clock.ms,
    ...(cacheMs === undefined ? {} : { cacheMs }),
  });
  return { service, cloudClient, calls: cloudClient.calls, clock, state };
}

test('the three reads come back together, stamped with the time of the read', async () => {
  const { service, calls } = setup();
  assert.deepEqual(await service.getAccountUsage(), {
    usage: USAGE,
    prepaid: PREPAID,
    offer: OFFER,
    fetchedAt: '2026-10-02T10:00:00.000Z',
    error: null,
  });
  assert.deepEqual(calls, { getAccountUsage: 1, getOrganizationId: 1, getPrepaidCredits: 1, getCreditGrantOffer: 1 });
});

test('nothing is read while the provider is off', async () => {
  const { service, calls, state } = setup({ enabled: false });
  assert.equal(await service.getAccountUsage(), null);
  assert.equal(await service.getAccountUsage({ timeoutMs: 50 }), null);
  assert.deepEqual(calls, { getAccountUsage: 0, getOrganizationId: 0, getPrepaidCredits: 0, getCreditGrantOffer: 0 });

  state.enabled = true;
  assert.equal((await service.getAccountUsage()).usage, USAGE);
  assert.equal(calls.getAccountUsage, 1);
});

test('switching the provider off drops what was read before', async () => {
  const { service, calls, state } = setup();
  await service.getAccountUsage();
  state.enabled = false;
  assert.equal(await service.getAccountUsage(), null);
  state.enabled = true;
  await service.getAccountUsage();
  assert.equal(calls.getAccountUsage, 2);
});

test('an isEnabled that throws counts as off', async () => {
  const cloudClient = fakeClient();
  const service = createClaudeAccountUsageService({ cloudClient, isEnabled: () => { throw new Error('settings are gone'); } });
  assert.equal(await service.getAccountUsage(), null);
  assert.equal(cloudClient.calls.getAccountUsage, 0);
});

test('a result is served from the cache for a minute, then read again', async () => {
  const { service, calls, clock } = setup();
  const first = await service.getAccountUsage();
  clock.ms += 59_000;
  assert.equal(await service.getAccountUsage(), first);
  assert.equal(calls.getAccountUsage, 1);
  clock.ms += 2_000;
  const second = await service.getAccountUsage();
  assert.equal(calls.getAccountUsage, 2);
  assert.equal(second.fetchedAt, '2026-10-02T10:01:01.000Z');
  // The organisation is the client's to remember; the service asks every time it reads.
  assert.equal(calls.getPrepaidCredits, 2);
});

test('cacheMs sets how long a result is kept', async () => {
  const { service, calls, clock } = setup({ cacheMs: 5_000 });
  await service.getAccountUsage();
  clock.ms += 4_000;
  await service.getAccountUsage();
  assert.equal(calls.getAccountUsage, 1);
  clock.ms += 2_000;
  await service.getAccountUsage();
  assert.equal(calls.getAccountUsage, 2);
});

test('callers that ask at the same time share one read', async () => {
  const gate = deferred();
  const { service, calls } = setup({ answers: { getAccountUsage: () => gate.promise } });
  const pending = [service.getAccountUsage(), service.getAccountUsage(), service.getAccountUsage()];
  gate.resolve(USAGE);
  const results = await Promise.all(pending);
  assert.equal(calls.getAccountUsage, 1);
  assert.equal(calls.getPrepaidCredits, 1);
  assert.equal(results[0], results[1]);
  assert.equal(results[1], results[2]);
});

test('a failing prepaid or offer read leaves its field empty and the usage intact', async () => {
  const { service } = setup({
    answers: {
      getPrepaidCredits: new ClaudeCloudError('not_found', 'no prepaid credits here'),
      getCreditGrantOffer: new Error('boom'),
    },
  });
  assert.deepEqual(await service.getAccountUsage(), {
    usage: USAGE, prepaid: null, offer: null, fetchedAt: '2026-10-02T10:00:00.000Z', error: null,
  });
});

test('without an organisation the two extras are skipped, not asked for in vain', async () => {
  const { service, calls } = setup({ answers: { getOrganizationId: new ClaudeCloudError('bad_request', 'no organisation') } });
  const result = await service.getAccountUsage();
  assert.equal(result.usage, USAGE);
  assert.equal(result.prepaid, null);
  assert.equal(result.offer, null);
  assert.equal(calls.getPrepaidCredits, 0);
  assert.equal(calls.getCreditGrantOffer, 0);
});

test('extras that are not objects are dropped', async () => {
  const { service } = setup({ answers: { getPrepaidCredits: 'nope', getCreditGrantOffer: [1, 2] } });
  const result = await service.getAccountUsage();
  assert.equal(result.prepaid, null);
  assert.equal(result.offer, null);
});

test('a failed usage read resolves with the error, and the extras still arrive', async () => {
  const { service } = setup({
    answers: { getAccountUsage: new ClaudeCloudError('login_expired', 'The Claude login has expired. Log in again.') },
  });
  assert.deepEqual(await service.getAccountUsage(), {
    usage: null,
    prepaid: PREPAID,
    offer: OFFER,
    fetchedAt: '2026-10-02T10:00:00.000Z',
    error: 'The Claude login has expired. Log in again.',
  });
});

test('a failed read is kept for a shorter time than a good one', async () => {
  let fail = true;
  const { service, calls, clock } = setup({
    answers: { getAccountUsage: () => (fail ? new ClaudeCloudError('transient', 'Claude Cloud could not be reached.') : USAGE) },
  });
  assert.equal((await service.getAccountUsage()).error, 'Claude Cloud could not be reached.');
  clock.ms += 10_000;
  await service.getAccountUsage();
  assert.equal(calls.getAccountUsage, 1);
  fail = false;
  clock.ms += 6_000;
  const result = await service.getAccountUsage();
  assert.equal(calls.getAccountUsage, 2);
  assert.equal(result.error, null);
  assert.equal(result.usage, USAGE);
});

test('an error message never carries a token', async () => {
  const unexpected = setup({ answers: { getAccountUsage: new Error(`request with Authorization: Bearer ${TOKEN} failed`) } });
  const first = await unexpected.service.getAccountUsage();
  assert.equal(first.error, 'The Claude account usage could not be read.');

  const coded = setup({
    answers: { getAccountUsage: new ClaudeCloudError('bad_request', `Refused (HTTP 400). header was Bearer ${TOKEN}`) },
  });
  const second = await coded.service.getAccountUsage();
  assert.doesNotMatch(second.error, new RegExp(TOKEN));
  assert.match(second.error, /Refused \(HTTP 400\)/);

  const long = setup({ answers: { getAccountUsage: new ClaudeCloudError('bad_request', 'x'.repeat(2000)) } });
  assert.ok((await long.service.getAccountUsage()).error.length <= 301);
});

test('a usage answer that is not an object is an error, not data', async () => {
  const { service } = setup({ answers: { getAccountUsage: null } });
  const result = await service.getAccountUsage();
  assert.equal(result.usage, null);
  assert.equal(result.error, 'The Claude account usage could not be read.');
});

test('a client without the calls resolves with an error instead of throwing', async () => {
  const service = createClaudeAccountUsageService({ cloudClient: null, isEnabled: () => true });
  const result = await service.getAccountUsage();
  assert.equal(result.usage, null);
  assert.equal(result.prepaid, null);
  assert.equal(result.error, 'The Claude account usage could not be read.');
});

test('a slow read gives up for the caller after timeoutMs and still fills the cache', async () => {
  const gate = deferred();
  const { service, calls } = setup({ answers: { getAccountUsage: () => gate.promise } });
  assert.deepEqual(await service.getAccountUsage({ timeoutMs: 5 }), {
    usage: null, prepaid: null, offer: null, fetchedAt: null, error: 'The Claude account usage did not arrive in time.',
  });
  gate.resolve(USAGE);
  const result = await service.getAccountUsage({ timeoutMs: 1_000 });
  assert.equal(result.usage, USAGE);
  assert.equal(result.error, null);
  assert.equal(calls.getAccountUsage, 1);
});

test('an answer that arrives after the provider was switched off is not handed out', async () => {
  const gate = deferred();
  const { service, state } = setup({ answers: { getAccountUsage: () => gate.promise } });
  const pending = service.getAccountUsage();
  state.enabled = false;
  gate.resolve(USAGE);
  assert.equal(await pending, null);
});

test('the clock may be a Date', async () => {
  const service = createClaudeAccountUsageService({
    cloudClient: fakeClient(),
    isEnabled: () => true,
    now: () => new Date(START_MS),
  });
  assert.equal((await service.getAccountUsage()).fetchedAt, '2026-10-02T10:00:00.000Z');
});
