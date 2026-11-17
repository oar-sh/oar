import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEED_CATALOG_SOURCE,
  blockingReadinessReasons,
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
// Copilot switched on (its settings say so), as on every relay from before the switch.
const copilotOn = { engine: 'sdk', engines: ['sdk'], enabled: true, cliFound: true };
const nothingReady = { copilot: copilotOn, openai: off, claude: off, claudeCloud: off, cursor: off, grok: off, catalog: seedCatalog };

test('a seed catalog with nothing enabled is known and not ready, Copilot unknown', () => {
  const readiness = resolveProviderReadiness(nothingReady);
  assert.deepEqual(readiness, { known: true, anyReady: false, ready: [], copilot: 'unknown' });
  assert.equal(isSetupRequired(readiness), true);
});

test('each settings provider counts as ready when its payload says enabled', () => {
  const cases = [
    ['openai', 'openai'],
    ['claude', 'claude'],
    ['claudeApi', 'claude-api'],
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
  for (const key of ['copilot', 'openai', 'claude', 'cursor', 'grok', 'catalog']) {
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
  updateProviderReadinessInputs({ copilot: copilotOn, openai: off, claude: off, cursor: off });
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

function sdkSnapshot(claude = {}, cursor = {}) {
  return {
    root: '/srv/fixture/sdks',
    host: { platform: 'linux', arch: 'x64', libc: 'glibc' },
    sdks: {
      claude: { id: 'claude', label: 'Claude Agent SDK', state: 'ready', ...claude },
      cursor: { id: 'cursor', label: 'Cursor SDK', state: 'ready', ...cursor },
      koffi: { id: 'koffi', label: 'Windows helper (koffi)', state: 'unsupported', support: 'no' },
    },
  };
}

const sdkProvidersOn = { ...nothingReady, claude: { enabled: true }, claudeApi: { enabled: true }, deepseek: { enabled: true }, cursor: { enabled: true }, grok: { enabled: true } };

test('without an agent SDK snapshot nothing changes, and no reasons are added', () => {
  for (const agentSdks of [undefined, null, {}, { sdks: null }]) {
    const readiness = resolveProviderReadiness({ ...sdkProvidersOn, agentSdks });
    assert.deepEqual(readiness.ready, ['claude', 'claude-api', 'cursor', 'grok', 'deepseek']);
    assert.equal('reasons' in readiness, false);
  }
});

test('ready SDKs change nothing but say so with an empty reasons map', () => {
  const readiness = resolveProviderReadiness({ ...sdkProvidersOn, agentSdks: sdkSnapshot() });
  assert.deepEqual(readiness.ready, ['claude', 'claude-api', 'cursor', 'grok', 'deepseek']);
  assert.deepEqual(readiness.reasons, {});
});

test('a missing or installing SDK keeps its providers ready, with a note: the first chat installs it', () => {
  const missing = resolveProviderReadiness({ ...sdkProvidersOn, agentSdks: sdkSnapshot({ state: 'missing' }, { state: 'installing' }) });
  assert.deepEqual(missing.ready, ['claude', 'claude-api', 'cursor', 'grok', 'deepseek']);
  assert.equal(isSetupRequired(missing), false);
  for (const providerId of ['claude', 'claude-api', 'deepseek']) {
    assert.deepEqual(missing.reasons[providerId], {
      blocking: false,
      text: 'Claude Agent SDK not installed yet — it installs with the first chat or from Settings',
    }, providerId);
  }
  assert.deepEqual(missing.reasons.cursor, { blocking: false, text: 'Cursor SDK is installing — the first chat waits for it' });
  assert.equal(missing.reasons.grok, undefined, 'Grok runs on no agent SDK');
});

test('a failed or unavailable SDK makes its providers not ready, with the reason', () => {
  const readiness = resolveProviderReadiness({
    ...sdkProvidersOn,
    agentSdks: sdkSnapshot({ state: 'error', error: 'npm exited with code 1' }, { state: 'unsupported' }),
  });
  assert.deepEqual(readiness.ready, ['grok']);
  assert.deepEqual(readiness.reasons.claude, { blocking: true, text: 'Claude Agent SDK install failed: npm exited with code 1' });
  assert.equal(readiness.reasons['claude-api'].blocking, true);
  assert.equal(readiness.reasons.deepseek.blocking, true);
  assert.deepEqual(readiness.reasons.cursor, { blocking: true, text: 'Cursor SDK not available on this platform' });
  // Three providers share Claude's SDK: its reason is given once.
  assert.deepEqual(blockingReadinessReasons(readiness), [
    'Claude Agent SDK install failed: npm exited with code 1',
    'Cursor SDK not available on this platform',
  ]);
  assert.deepEqual(blockingReadinessReasons(null), []);
  assert.equal(resolveProviderReadiness({ ...sdkProvidersOn, agentSdks: sdkSnapshot({ state: 'error' }) }).reasons.claude.text, 'Claude Agent SDK install failed');
});

test('only enabled providers are judged, and a failed SDK can be the setup wall', () => {
  const onlyClaude = { ...nothingReady, claude: { enabled: true }, agentSdks: sdkSnapshot({ state: 'unsupported' }) };
  const readiness = resolveProviderReadiness(onlyClaude);
  assert.deepEqual(readiness.ready, []);
  assert.deepEqual(Object.keys(readiness.reasons), ['claude']);
  assert.equal(isSetupRequired(readiness), true);
  // Copilot is not on an agent SDK: a real catalog keeps the relay usable.
  const withCopilot = resolveProviderReadiness({ ...onlyClaude, catalog: { ...seedCatalog, source: 'server-discovery:boot' } });
  assert.deepEqual(withCopilot.ready, ['github']);
  // An SDK the snapshot does not name, or a state it does not know, changes nothing.
  const unnamed = resolveProviderReadiness({ ...onlyClaude, agentSdks: { sdks: { cursor: { state: 'error' } } } });
  assert.deepEqual(unnamed.ready, ['claude']);
  const odd = resolveProviderReadiness({ ...onlyClaude, agentSdks: sdkSnapshot({ state: 'paused' }) });
  assert.deepEqual(odd.ready, ['claude']);
});

test('the live copy takes the SDK snapshot and tells listeners when a reason changes', () => {
  resetProviderReadinessForTests();
  const seen = [];
  subscribeProviderReadiness((readiness) => seen.push(readiness));
  updateProviderReadinessInputs({ ...nothingReady, claude: { enabled: true } });
  assert.equal(seen.length, 1);
  updateProviderReadinessInputs({ agentSdks: sdkSnapshot({ state: 'installing', log: 'a\n', logSeq: 1 }) });
  assert.equal(seen.length, 2, 'a note is a change');
  // A log flush of the same install is not.
  updateProviderReadinessInputs({ agentSdks: sdkSnapshot({ state: 'installing', log: 'a\nb\n', logSeq: 2 }) });
  assert.equal(seen.length, 2);
  updateProviderReadinessInputs({ agentSdks: sdkSnapshot({ state: 'error', error: 'boom' }) });
  assert.equal(seen.length, 3);
  assert.equal(isProviderSetupRequired(), true);
  updateProviderReadinessInputs({ agentSdks: sdkSnapshot() });
  assert.equal(isProviderSetupRequired(), false);
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

test('Copilot switched off is not ready, whatever the catalog says; a payload without `enabled` is on', () => {
  const discovered = { ...seedCatalog, source: 'server-discovery:boot' };
  const offAnswer = resolveProviderReadiness({ ...nothingReady, copilot: { ...copilotOn, enabled: false }, catalog: discovered });
  assert.deepEqual(offAnswer, { known: true, anyReady: false, ready: [], copilot: 'off' });
  assert.equal(isSetupRequired(offAnswer), true, 'nothing else on: the setup wall');
  const older = resolveProviderReadiness({ ...nothingReady, copilot: { engine: 'sdk', engines: ['sdk'] }, catalog: discovered });
  assert.equal(older.copilot, 'ready');
  assert.deepEqual(older.ready, ['github']);
});

test('Copilot off and only Claude on: Claude alone is ready', () => {
  const readiness = resolveProviderReadiness({
    ...nothingReady,
    copilot: { ...copilotOn, enabled: false },
    claude: { enabled: true },
    catalog: { ...seedCatalog, source: 'server-discovery:boot' },
  });
  assert.deepEqual(readiness.ready, ['claude']);
  assert.equal(readiness.copilot, 'off');
  assert.equal(isSetupRequired(readiness), false);
});

test('the live copy follows the Copilot switch', () => {
  resetProviderReadinessForTests();
  updateProviderReadinessInputs({ ...nothingReady, catalog: { ...seedCatalog, source: 'server-discovery:boot' } });
  assert.deepEqual(getProviderReadiness().ready, ['github']);
  const seen = [];
  const unsubscribe = subscribeProviderReadiness((readiness) => seen.push(readiness.copilot));
  updateProviderReadinessInputs({ copilot: { ...copilotOn, enabled: false } });
  assert.equal(isProviderSetupRequired(), true);
  updateProviderReadinessInputs({ copilot: copilotOn });
  assert.deepEqual(seen, ['off', 'ready']);
  unsubscribe();
  resetProviderReadinessForTests();
});

test('composerLockReason: setup with no chat open, copilot-off in a Copilot chat while Copilot is off', async () => {
  const { composerLockReason } = await import('./provider-readiness.mjs');
  const offAnswer = resolveProviderReadiness({ ...nothingReady, copilot: { ...copilotOn, enabled: false }, claude: { enabled: true } });
  const onAnswer = resolveProviderReadiness({ ...nothingReady, claude: { enabled: true } });
  for (const providerType of ['github', '', null, undefined]) {
    assert.equal(composerLockReason({ conversationId: 'conv-1', providerType }, offAnswer), 'copilot-off', String(providerType));
    assert.equal(composerLockReason({ conversationId: 'conv-1', providerType }, onAnswer), null, String(providerType));
  }
  for (const providerType of ['openai', 'claude', 'cursor', 'claude-api']) {
    assert.equal(composerLockReason({ conversationId: 'conv-1', providerType }, offAnswer), null, providerType);
  }
  // No chat open: Copilot off with Claude on points to New Chat; Copilot on
  // leaves the composer as it was; nothing on is the setup lock.
  assert.equal(composerLockReason({ conversationId: '' }, offAnswer), 'new-chat');
  assert.equal(composerLockReason({ conversationId: '' }, onAnswer), null);
  assert.equal(composerLockReason({ conversationId: '' }, resolveProviderReadiness(nothingReady)), 'setup');
  const nothingOn = resolveProviderReadiness({ ...nothingReady, copilot: { ...copilotOn, enabled: false } });
  assert.equal(composerLockReason({ conversationId: '' }, nothingOn), 'setup', 'Copilot off and nothing else on: the setup lock stays');
});
