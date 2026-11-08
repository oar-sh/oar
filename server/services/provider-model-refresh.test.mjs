import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_REFRESH_ERROR_MAX_CHARS,
  buildProviderRefreshTable,
  createModelRefreshLedger,
  createModelRefreshSettings,
  modelRefreshErrorSummary,
  redactModelRefreshError,
  refreshProviderModels,
} from './provider-model-refresh.mjs';
import { createModelRefreshScheduler } from './model-refresh-scheduler.mjs';

function createSettingsStore() {
  const values = new Map();
  return { values, readSetting: (key) => values.get(key) ?? '', writeSetting: (key, value) => { values.set(key, String(value)); } };
}

test('a tracked refresh resets the provider clock, a throw counts as a failure', async () => {
  const store = createSettingsStore();
  const ledger = createModelRefreshLedger({ ...store, now: () => new Date('2026-11-01T10:00:00Z') });
  const ok = ledger.track('cursor', async () => ({ ok: true, models: ['model-a'], newModels: [{ id: 'model-b', on: false }] }));
  await ok();
  assert.deepEqual(ledger.readLast().cursor, {
    at: '2026-11-01T10:00:00.000Z', ok: true, error: null, lastOkAt: '2026-11-01T10:00:00.000Z', lastFailureAt: null,
  });
  assert.deepEqual(ledger.takeNewModels(), [{ provider: 'cursor', tab: 'cursor', label: 'Cursor', ids: ['model-b'], on: false }]);
  const broken = ledger.track('cursor', async () => { throw new Error('socket hang up'); });
  await assert.rejects(broken(), /socket hang up/);
  const last = ledger.readLast().cursor;
  assert.equal(last.ok, false);
  assert.equal(last.error, 'socket hang up');
  assert.equal(last.lastOkAt, '2026-11-01T10:00:00.000Z');
  assert.equal(last.lastFailureAt, '2026-11-01T10:00:00.000Z');
});

test('new models of one provider and state gather in one toast entry', () => {
  const ledger = createModelRefreshLedger(createSettingsStore());
  ledger.noteNewModels('github', [{ id: 'gpt-test-a', on: true }]);
  ledger.noteNewModels('github', [{ id: 'gpt-test-b', on: true }, { id: 'gpt-test-a', on: true }]);
  ledger.noteNewModels('nope', [{ id: 'x', on: true }]);
  assert.deepEqual(ledger.takeNewModels(), [{ provider: 'github', tab: 'copilot', label: 'Copilot', ids: ['gpt-test-a', 'gpt-test-b'], on: true }]);
});

test('refreshProviderModels skips providers that are off and answers a throw with the current models', async () => {
  let models = ['composer-2.5'];
  const table = buildProviderRefreshTable({
    getCursorProviderSettings: () => ({ enabled: true, models }),
    refreshCursorProviderModels: async () => { models = ['composer-2.5', 'composer-3']; return { ok: true, models, newModels: [] }; },
    getGrokProviderSettings: () => ({ enabled: true, models: ['grok-4.5'] }),
    refreshGrokProviderModels: async () => { throw new Error('grok is not installed'); },
    getClaudeProviderSettings: () => ({ enabled: false, models: [] }),
    refreshClaudeProviderModels: async () => { throw new Error('must not run'); },
  });
  const { results, changed } = await refreshProviderModels({ table });
  assert.equal(results.cursor.ok, true);
  assert.deepEqual(results.grok, { ok: false, models: ['grok-4.5'], error: 'grok is not installed' });
  assert.equal(results.claude.skipped, true);
  assert.equal(results.github.skipped, true, 'no Copilot discovery wired');
  assert.equal(changed, true, 'Cursor offers another model now');
  const again = await refreshProviderModels({ table, providers: ['cursor'] });
  assert.equal(again.changed, false);
  assert.deepEqual(Object.keys(again.results), ['cursor']);
});

test('Copilot is asked by the button always, by the background check only with a CLI', async () => {
  let cliPresent = false;
  const reasons = [];
  const table = buildProviderRefreshTable({
    copilotModelDiscoveryService: {
      refresh: async (reason) => { reasons.push(reason); return { ok: true, models: [] }; },
      isCliResolvable: () => cliPresent,
    },
  });
  assert.equal(table.github.isEnabled(), true);
  assert.equal(table.github.isSetUp(), false);
  await refreshProviderModels({ table, providers: ['github'], reason: 'background', gate: 'isSetUp' });
  assert.deepEqual(reasons, []);
  cliPresent = true;
  await refreshProviderModels({ table, providers: ['github'], reason: 'background', gate: 'isSetUp' });
  assert.deepEqual(reasons, ['background']);
});

test('the check settings check every field before writing any', () => {
  const store = createSettingsStore();
  const settings = createModelRefreshSettings(store);
  assert.deepEqual(settings.get(), { auto: true, intervalHours: 24, excluded: [] });
  assert.equal(settings.update({}).ok, false);
  assert.equal(settings.update({ auto: false, intervalHours: 48 }).ok, false);
  assert.equal(store.values.size, 0);
  const saved = settings.update({ auto: false, intervalHours: 6, excluded: ['grok'] });
  assert.deepEqual(saved, { ok: true, settings: { auto: false, intervalHours: 6, excluded: ['grok'] } });
  assert.equal(store.values.get('model_refresh_auto'), 'false');
  assert.equal(store.values.get('model_refresh_interval_hours'), '6');
  assert.equal(store.values.get('model_refresh_excluded'), '["grok"]');
});

test('Claude and Grok switched on but not set up are skipped by the background check and never noted', async () => {
  const store = createSettingsStore();
  const ledger = createModelRefreshLedger(store);
  const asked = [];
  const table = buildProviderRefreshTable({
    getClaudeProviderSettings: () => ({ enabled: true, models: ['claude-test'] }),
    refreshClaudeProviderModels: ledger.track('claude', async () => { asked.push('claude'); return { ok: true, models: [] }; }),
    getGrokProviderSettings: () => ({ enabled: true, models: ['grok-test'] }),
    refreshGrokProviderModels: ledger.track('grok', async () => { asked.push('grok'); return { ok: true, models: [] }; }),
    isClaudeSetUp: () => false,
    isGrokSetUp: () => { throw new Error('cannot tell'); },
  });
  assert.equal(table.claude.isEnabled(), true);
  assert.equal(table.claude.isSetUp(), false);
  assert.equal(table.grok.isSetUp(), false);
  const { results } = await refreshProviderModels({ table, providers: ['claude', 'grok'], reason: 'background', gate: 'isSetUp' });
  assert.equal(results.claude.skipped, true);
  assert.equal(results.grok.skipped, true);
  assert.deepEqual(asked, []);
  assert.deepEqual(ledger.readLast(), {});
  // The Refresh button still asks a provider that is switched on.
  await refreshProviderModels({ table, providers: ['claude'], reason: 'manual-refresh' });
  assert.deepEqual(asked, ['claude']);
});

test('a refresh error is stored and logged without the key it echoes', async () => {
  const key = 'sk-test-0123456789abcdef';
  const body = `{"error":{"message":"Incorrect API key","request":{"headers":{"Authorization":"Bearer ${key}"}}}}`;
  const store = createSettingsStore();
  const ledger = createModelRefreshLedger({ ...store, secretsFor: (provider) => (provider === 'openai' ? [key] : []) });
  const refresh = ledger.track('openai', async () => ({ ok: false, models: [], error: `OpenAI model discovery failed (401): ${body}` }));
  const result = await refresh();
  const stored = ledger.readLast().openai;
  assert.equal(stored.ok, false);
  assert.equal(stored.error.includes(key), false);
  assert.equal(store.values.get('model_refresh_last').includes(key), false);
  assert.match(stored.error, /\(401\)/);
  // A token nobody named is still cut after "Bearer" or an Authorization header.
  assert.equal(redactModelRefreshError('echo Authorization: Bearer unnamed-token-123').includes('unnamed-token-123'), false);
  assert.equal(redactModelRefreshError('{"authorization":"Bearer abc-def-ghi"}').includes('abc-def-ghi'), false);
  assert.ok(redactModelRefreshError('x'.repeat(1000)).length <= MODEL_REFRESH_ERROR_MAX_CHARS);
  // The log line: the provider and the kind of failure, never the body.
  const lines = [];
  const scheduler = createModelRefreshScheduler({
    getTable: () => ({ openai: { isSetUp: () => true, refresh } }),
    refreshProviders: async () => ({ results: { openai: result }, changed: false }),
    logger: { log: (line) => lines.push(line), warn: (line) => lines.push(line) },
  });
  await scheduler.tick();
  const warning = lines.find((line) => line.includes('failed for'));
  assert.equal(warning, '[model-refresh] background model refresh failed for openai (HTTP 401)');
  assert.equal(lines.some((line) => line.includes(key) || line.includes('Incorrect API key')), false);
  assert.equal(modelRefreshErrorSummary('Cursor model discovery failed: socket hang up'), 'Cursor model discovery failed');
  assert.equal(modelRefreshErrorSummary('Grok model discovery failed: timed out after 20000ms'), 'timed out');
});
