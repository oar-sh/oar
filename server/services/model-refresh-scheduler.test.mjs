import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelRefreshScheduler, dueModelRefreshProviders } from './model-refresh-scheduler.mjs';
import { createModelRefreshLedger, refreshProviderModels } from './provider-model-refresh.mjs';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

function createClock(start = T0) {
  let nowMs = start;
  const timers = [];
  return {
    now: () => nowMs,
    date: () => new Date(nowMs),
    advance(ms) { nowMs += ms; },
    setTimeoutFn: (fn, ms) => {
      const handle = { fn, at: nowMs + ms, cleared: false, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => { if (handle) handle.cleared = true; },
    pending: () => timers.filter((handle) => !handle.cleared && !handle.fired),
    async runDue() {
      for (const handle of timers) {
        if (handle.cleared || handle.fired || handle.at > nowMs) continue;
        handle.fired = true;
        handle.fn();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function createSettingsStore() {
  const values = new Map();
  return { values, readSetting: (key) => values.get(key) ?? '', writeSetting: (key, value) => { values.set(key, String(value)); } };
}

/** A relay with Cursor and Claude set up, Grok enabled but nothing else. */
function createRelay({ clock, settings = { auto: true, intervalHours: 24, excluded: [] }, results = {} } = {}) {
  const store = createSettingsStore();
  const ledger = createModelRefreshLedger({ ...store, now: clock.date });
  const calls = [];
  const provider = (id, { setUp = true } = {}) => ({
    isEnabled: () => setUp,
    isSetUp: () => setUp,
    currentModels: () => [],
    refresh: ledger.track(id, async (reason) => {
      calls.push({ id, reason, at: clock.now() });
      return results[id] ? results[id]() : { ok: true, models: ['model-a'], newModels: [] };
    }),
  });
  const table = { cursor: provider('cursor'), claude: provider('claude'), deepseek: provider('deepseek', { setUp: false }) };
  const changes = [];
  const logs = [];
  const scheduler = createModelRefreshScheduler({
    getSettings: () => settings,
    getLast: () => ledger.readLast(),
    getTable: () => table,
    refreshProviders: ({ providers, reason }) => refreshProviderModels({ table, providers, reason, gate: 'isSetUp' }),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    logger: { log: (line) => logs.push(line), warn: (line) => logs.push(line) },
  });
  scheduler.setOnModelsChanged(() => changes.push(clock.now()));
  return { scheduler, ledger, table, calls, changes, logs, settings };
}

test('overdue providers are checked a minute after boot, then not again until due', async () => {
  const clock = createClock();
  const relay = createRelay({ clock });
  relay.scheduler.start();
  clock.advance(59 * 1000);
  await clock.runDue();
  assert.deepEqual(relay.calls, []);
  clock.advance(1000);
  await clock.runDue();
  assert.deepEqual(relay.calls.map((call) => [call.id, call.reason]), [['claude', 'background'], ['cursor', 'background']]);
  assert.ok(relay.logs.some((line) => line.includes('background model refresh: claude, cursor')));
  // The quarter-hourly ticks find nothing due for a day.
  for (let index = 0; index < 4 * 23; index += 1) {
    clock.advance(15 * 60 * 1000);
    await clock.runDue();
  }
  assert.equal(relay.calls.length, 2);
  clock.advance(60 * 60 * 1000);
  await clock.runDue();
  assert.equal(relay.calls.length, 4);
});

test('due and not due follow the interval', () => {
  const table = { cursor: { isSetUp: () => true, refresh: () => {} } };
  const last = { cursor: { lastOkAt: new Date(T0 - 5 * HOUR).toISOString() } };
  assert.deepEqual(dueModelRefreshProviders({ settings: { intervalHours: 6 }, last, table, nowMs: T0 }), []);
  assert.deepEqual(dueModelRefreshProviders({ settings: { intervalHours: 6 }, last, table, nowMs: T0 + HOUR }), ['cursor']);
  assert.deepEqual(dueModelRefreshProviders({ settings: { intervalHours: 24 }, last, table, nowMs: T0 + HOUR }), []);
});

test('any refresh resets the clock: a manual refresh pushes the next check out', async () => {
  const clock = createClock();
  const relay = createRelay({ clock, settings: { auto: true, intervalHours: 6, excluded: [] } });
  await relay.table.cursor.refresh('manual-refresh');
  await relay.table.claude.refresh('manual-refresh');
  clock.advance(5 * HOUR);
  await relay.scheduler.tick();
  assert.equal(relay.calls.filter((call) => call.reason === 'background').length, 0);
  clock.advance(HOUR);
  await relay.scheduler.tick();
  assert.equal(relay.calls.filter((call) => call.reason === 'background').length, 2);
});

test('a failure is tried again after an hour, not at every tick', async () => {
  const clock = createClock();
  let failing = true;
  const relay = createRelay({
    clock,
    results: { cursor: () => (failing ? { ok: false, models: [], error: 'listing refused' } : { ok: true, models: ['model-a'] }) },
  });
  await relay.scheduler.tick();
  const cursorCalls = () => relay.calls.filter((call) => call.id === 'cursor').length;
  assert.equal(cursorCalls(), 1);
  assert.equal(relay.ledger.readLast().cursor.ok, false);
  assert.equal(relay.ledger.readLast().cursor.error, 'listing refused');
  assert.ok(relay.logs.some((line) => line.includes('cursor (listing refused)')));
  clock.advance(45 * 60 * 1000);
  await relay.scheduler.tick();
  assert.equal(cursorCalls(), 1);
  clock.advance(15 * 60 * 1000);
  failing = false;
  await relay.scheduler.tick();
  assert.equal(cursorCalls(), 2);
  assert.equal(relay.ledger.readLast().cursor.ok, true);
  clock.advance(HOUR);
  await relay.scheduler.tick();
  assert.equal(cursorCalls(), 2);
});

test('providers that are off, not set up or left out are skipped; so is everything when the check is off', async () => {
  const clock = createClock();
  const relay = createRelay({ clock, settings: { auto: true, intervalHours: 24, excluded: ['claude'] } });
  await relay.scheduler.tick();
  assert.deepEqual(relay.calls.map((call) => call.id), ['cursor']);
  // deepseek is not set up: no clock entry at all.
  assert.equal(relay.ledger.readLast().deepseek, undefined);

  const quiet = createRelay({ clock, settings: { auto: false, intervalHours: 24, excluded: [] } });
  await quiet.scheduler.tick();
  assert.deepEqual(quiet.calls, []);
});

test('a skipped refresh is neither a success nor a failure', () => {
  const store = createSettingsStore();
  const ledger = createModelRefreshLedger({ ...store, now: () => new Date(T0) });
  assert.equal(ledger.record('grok', { ok: true, skipped: true }), null);
  assert.deepEqual(ledger.readLast(), {});
});

test('models_updated is asked for only when a refresh changed something', async () => {
  const clock = createClock();
  let found = [];
  const relay = createRelay({ clock, results: { cursor: () => ({ ok: true, models: ['model-a'], newModels: found }) } });
  await relay.scheduler.tick();
  assert.deepEqual(relay.changes, []);
  found = [{ id: 'model-new', on: true }];
  clock.advance(25 * HOUR);
  await relay.scheduler.tick();
  assert.equal(relay.changes.length, 1);
  assert.deepEqual(relay.ledger.takeNewModels(), [{ provider: 'cursor', tab: 'cursor', label: 'Cursor', ids: ['model-new'], on: true }]);
  assert.deepEqual(relay.ledger.takeNewModels(), []);
});

test('dispose stops the timer and waits for a running check', async () => {
  const clock = createClock();
  let release;
  const relay = createRelay({ clock, results: { cursor: () => new Promise((resolve) => { release = () => resolve({ ok: true, models: [] }); }) } });
  relay.scheduler.start();
  assert.equal(relay.scheduler.isStarted(), true);
  clock.advance(60 * 1000);
  await clock.runDue();
  let disposed = false;
  const disposing = relay.scheduler.dispose().then(() => { disposed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, false);
  release();
  await disposing;
  assert.equal(relay.scheduler.isStarted(), false);
  assert.deepEqual(clock.pending(), []);
  const calls = relay.calls.length;
  clock.advance(48 * HOUR);
  await clock.runDue();
  await relay.scheduler.tick();
  assert.equal(relay.calls.length, calls);
});

test('a last success or failure stamped in the future does not hold a provider back', () => {
  const table = { cursor: { isSetUp: () => true, refresh: () => {} } };
  const future = new Date(T0 + 30 * HOUR).toISOString();
  assert.deepEqual(dueModelRefreshProviders({ settings: { intervalHours: 24 }, last: { cursor: { lastOkAt: future } }, table, nowMs: T0 }), ['cursor']);
  assert.deepEqual(dueModelRefreshProviders({ settings: { intervalHours: 24 }, last: { cursor: { lastFailureAt: future } }, table, nowMs: T0 }), ['cursor']);
  // A real recent stamp still holds it back.
  assert.deepEqual(dueModelRefreshProviders({ settings: { intervalHours: 24 }, last: { cursor: { lastOkAt: new Date(T0 - HOUR).toISOString() } }, table, nowMs: T0 }), []);
});
