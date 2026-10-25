import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEED_CATALOG_SOURCE,
  getProviderReadiness,
  isProviderSetupRequired,
  isSetupRequired,
  resetProviderReadinessForTests,
  resolveProviderReadiness,
  subscribeProviderReadiness,
  updateProviderReadinessInputs,
} from './provider-readiness.mjs';

const off = { enabled: false };
const seedCatalog = { models: ['auto', 'gpt-5.4-mini'], source: SEED_CATALOG_SOURCE };
const nothingReady = { openai: off, claude: off, claudeCloud: off, cursor: off, grok: off, catalog: seedCatalog };

test('a seed catalog with nothing enabled is known and not ready, Copilot unknown', () => {
  const readiness = resolveProviderReadiness(nothingReady);
  assert.deepEqual(readiness, { known: true, anyReady: false, ready: [], copilot: 'unknown' });
  assert.equal(isSetupRequired(readiness), true);
});

test('each settings provider counts as ready when its payload says enabled', () => {
  const cases = [
    ['openai', 'openai'],
    ['claude', 'claude'],
    ['claudeCloud', 'claude-cloud'],
    ['cursor', 'cursor'],
    ['grok', 'grok'],
    ['deepseek', 'deepseek'],
  ];
  for (const [key, providerId] of cases) {
    const readiness = resolveProviderReadiness({ ...nothingReady, [key]: { enabled: true } });
    assert.equal(readiness.known, true, key);
    assert.equal(readiness.anyReady, true, key);
    assert.deepEqual(readiness.ready, [providerId], key);
    assert.equal(readiness.copilot, 'unknown', key);
    assert.equal(isSetupRequired(readiness), false, key);
  }
  // Only a strict true counts, as in the New Chat provider list.
  assert.equal(resolveProviderReadiness({ ...nothingReady, claude: { enabled: 'true' } }).anyReady, false);
  assert.equal(resolveProviderReadiness({ ...nothingReady, claude: { configured: true } }).anyReady, false);
});

test('a catalog whose source is not the seed makes Copilot ready', () => {
  for (const source of ['server-discovery:boot', 'copilot-sdk-worker:session-start', 'web-relay-extension:snapshot', 'legacy', 'manual-refresh']) {
    const readiness = resolveProviderReadiness({ ...nothingReady, catalog: { ...seedCatalog, source } });
    assert.equal(readiness.copilot, 'ready', source);
    assert.deepEqual(readiness.ready, ['github'], source);
    assert.equal(readiness.anyReady, true, source);
  }
  // A catalog without a source says nothing about Copilot.
  assert.equal(resolveProviderReadiness({ ...nothingReady, catalog: { models: [] } }).copilot, 'unknown');
});

test('ready providers are listed together', () => {
  const readiness = resolveProviderReadiness({
    ...nothingReady,
    claude: { enabled: true },
    grok: { enabled: true },
    catalog: { ...seedCatalog, source: 'server-discovery:boot' },
  });
  assert.deepEqual(readiness.ready, ['claude', 'grok', 'github']);
});

test('a payload that failed to load makes the answer unknown, and unknown is never a setup wall', () => {
  for (const key of ['openai', 'claude', 'cursor', 'grok', 'catalog']) {
    const readiness = resolveProviderReadiness({ ...nothingReady, [key]: null });
    assert.equal(readiness.known, false, key);
    assert.equal(isSetupRequired(readiness), false, key);
  }
  // Still reports what it can see.
  const partial = resolveProviderReadiness({ ...nothingReady, openai: null, claude: { enabled: true } });
  assert.equal(partial.known, false);
  assert.deepEqual(partial.ready, ['claude']);
  assert.equal(resolveProviderReadiness({}).known, false);
  assert.equal(resolveProviderReadiness(null).known, false);
  assert.equal(isSetupRequired(null), false);
});

test('a relay without Claude Cloud answers null for it, which is "not offered", not unknown', () => {
  const readiness = resolveProviderReadiness({ ...nothingReady, claudeCloud: null });
  assert.equal(readiness.known, true);
  assert.equal(readiness.anyReady, false);
});

test('the live copy starts unknown, follows the inputs and tells listeners only on a change', () => {
  resetProviderReadinessForTests();
  assert.equal(getProviderReadiness().known, false);
  assert.equal(isProviderSetupRequired(), false);
  const seen = [];
  const unsubscribe = subscribeProviderReadiness((readiness) => seen.push(readiness));

  // Loads arrive one by one; nothing is known until the last one lands.
  updateProviderReadinessInputs({ openai: off, claude: off, cursor: off });
  assert.equal(seen.length, 0);
  updateProviderReadinessInputs({ grok: off, claudeCloud: null });
  assert.equal(seen.length, 0);
  updateProviderReadinessInputs({ catalog: seedCatalog });
  assert.equal(seen.length, 1);
  assert.equal(isProviderSetupRequired(), true);

  // The same answer again is not an event.
  updateProviderReadinessInputs({ catalog: { ...seedCatalog } });
  assert.equal(seen.length, 1);
  // Keys left out are left as they were.
  updateProviderReadinessInputs({});
  updateProviderReadinessInputs({ openai: undefined });
  assert.equal(seen.length, 1);

  // A Settings save turns Claude on: the wall comes down.
  updateProviderReadinessInputs({ claude: { enabled: true } });
  assert.equal(seen.length, 2);
  assert.equal(isProviderSetupRequired(), false);
  assert.deepEqual(seen[1].ready, ['claude']);

  // A failed reload makes the answer unknown, which is a change too.
  updateProviderReadinessInputs({ catalog: null });
  assert.equal(seen.length, 3);
  assert.equal(getProviderReadiness().known, false);

  unsubscribe();
  updateProviderReadinessInputs({ catalog: seedCatalog });
  assert.equal(seen.length, 3);
  resetProviderReadinessForTests();
});

test('a listener that throws does not stop the others', () => {
  resetProviderReadinessForTests();
  let reached = false;
  subscribeProviderReadiness(() => { throw new Error('boom'); });
  subscribeProviderReadiness(() => { reached = true; });
  updateProviderReadinessInputs(nothingReady);
  assert.equal(reached, true);
  resetProviderReadinessForTests();
});
