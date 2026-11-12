import test from 'node:test';
import assert from 'node:assert/strict';

import { OWNER_TOKEN_LAST_USE_SETTING_KEY, OWNER_TOKEN_LAST_USE_WRITE_INTERVAL_MS, createOwnerTokenUseTracker } from './owner-token-use.mjs';

// The owner token's last non-browser use (agent auth §13.2, 3a): when and
// from where, never the value; written at most every 10 minutes; a rotation
// moves it to `previous`. The hashes here are made-up hex.

function makeTracker({ settings = new Map(), clock = { now: Date.parse('2026-11-02T08:00:00.000Z') }, owner = { hash: 'a'.repeat(64) } } = {}) {
  const writes = [];
  const tracker = createOwnerTokenUseTracker({
    readSetting: (key) => settings.get(key) ?? null,
    writeSetting: (key, value) => { writes.push(key); settings.set(key, value); },
    ownerHash: () => owner.hash,
    createdAt: () => '2026-10-01T00:00:00.000Z',
    now: () => clock.now,
    logger: { log() {}, warn() {} },
  });
  return { tracker, settings, clock, owner, writes };
}

test('a first start: nothing used yet, since the token was made', () => {
  const { tracker } = makeTracker();
  assert.deepEqual(tracker.view(), { lastNonBrowserUse: null, previousLastNonBrowserUse: null, since: '2026-10-01T00:00:00.000Z' });
});

test('a use is kept in memory at once and written at most every 10 minutes', () => {
  const ctx = makeTracker();
  ctx.writes.length = 0;
  ctx.tracker.record({ address: '203.0.113.5' });
  assert.equal(ctx.writes.length, 1, 'the first use is written');
  ctx.clock.now += 60_000;
  ctx.tracker.record({ address: '203.0.113.6' });
  assert.equal(ctx.writes.length, 1, 'not again within 10 minutes');
  assert.deepEqual(ctx.tracker.view().lastNonBrowserUse, { at: new Date(ctx.clock.now).toISOString(), address: '203.0.113.6' });
  assert.equal(JSON.parse(ctx.settings.get(OWNER_TOKEN_LAST_USE_SETTING_KEY)).current.address, '203.0.113.5');
  ctx.tracker.flush();
  assert.equal(JSON.parse(ctx.settings.get(OWNER_TOKEN_LAST_USE_SETTING_KEY)).current.address, '203.0.113.6', 'flush writes what is pending');
  ctx.clock.now += OWNER_TOKEN_LAST_USE_WRITE_INTERVAL_MS;
  ctx.tracker.record({ address: '203.0.113.7' });
  assert.equal(JSON.parse(ctx.settings.get(OWNER_TOKEN_LAST_USE_SETTING_KEY)).current.address, '203.0.113.7');
});

test('a rotation moves the record to previous, in the relay or while it was down', () => {
  const ctx = makeTracker();
  ctx.tracker.record({ address: '198.51.100.1' });
  ctx.owner.hash = 'b'.repeat(64);
  assert.equal(ctx.tracker.syncOwner(), true);
  assert.equal(ctx.tracker.syncOwner(), false, 'once per new token');
  const view = ctx.tracker.view();
  assert.equal(view.lastNonBrowserUse, null);
  assert.equal(view.previousLastNonBrowserUse.address, '198.51.100.1');
  assert.equal(view.since, new Date(ctx.clock.now).toISOString());
  // `oar setup --new-token` while the relay was down: the next start sees it.
  ctx.tracker.record({ address: '198.51.100.2' });
  ctx.tracker.flush(); // the runtime's shutdown
  ctx.owner.hash = 'c'.repeat(64);
  const restarted = makeTracker({ settings: ctx.settings, clock: ctx.clock, owner: ctx.owner });
  assert.equal(restarted.tracker.view().previousLastNonBrowserUse.address, '198.51.100.2');
  assert.equal(restarted.tracker.view().lastNonBrowserUse, null);
  // The setting holds a short prefix of the hash, never a token.
  const stored = JSON.parse(ctx.settings.get(OWNER_TOKEN_LAST_USE_SETTING_KEY));
  assert.equal(stored.owner, 'c'.repeat(16));
});
