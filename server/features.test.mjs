import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FEATURE_REGISTRY,
  computeFeatureFlagState,
  featureSettingKey,
  migrateLegacyConfigFeatures,
  normalizeFeatureFlags,
  resolveBootFeatureFlags,
} from './features.mjs';

function settingsStore(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    readSetting: (key) => rows.get(key) || '',
    writeSetting: (key, value) => rows.set(key, value),
  };
}

function tempConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-features-'));
  const configPath = path.join(dir, 'config.json');
  if (contents !== undefined) fs.writeFileSync(configPath, contents);
  return configPath;
}

test('the registry carries four described flags with the shipped defaults', () => {
  assert.deepEqual(FEATURE_REGISTRY.map((entry) => [entry.name, entry.default, entry.noop]), [
    ['SESSION_WORKER_ROUTING_ENABLED', true, false],
    ['SESSION_WORKER_CONTINUATION_ROUTING_ENABLED', true, false],
    ['SESSION_WORKER_FALLBACK_RESTART_ENABLED', false, true],
    ['IMAGE_CONVERSATION_CONTINUITY_ENABLED', true, false],
  ]);
  for (const entry of FEATURE_REGISTRY) {
    assert.equal(typeof entry.label, 'string');
    assert.ok(entry.label.length > 0, `${entry.name} has a label`);
    assert.ok(entry.description.length > 40, `${entry.name} has a real description`);
  }
  assert.deepEqual(normalizeFeatureFlags(), Object.fromEntries(
    FEATURE_REGISTRY.map((entry) => [entry.name, entry.default]),
  ));
});

test('boot resolution layers defaults, stored settings, then environment', () => {
  const { readSetting } = settingsStore({
    [featureSettingKey('SESSION_WORKER_ROUTING_ENABLED')]: '0',
    [featureSettingKey('IMAGE_CONVERSATION_CONTINUITY_ENABLED')]: '1',
  });

  const stored = resolveBootFeatureFlags({ readSetting, env: {} });
  assert.equal(stored.SESSION_WORKER_ROUTING_ENABLED, false, 'stored row beats the default');
  assert.equal(stored.SESSION_WORKER_CONTINUATION_ROUTING_ENABLED, true, 'unset flag reads its default');
  assert.equal(stored.IMAGE_CONVERSATION_CONTINUITY_ENABLED, true);

  // The e2e harness contract: an env pin wins over whatever the database says.
  const pinned = resolveBootFeatureFlags({
    readSetting: settingsStore({ [featureSettingKey('SESSION_WORKER_ROUTING_ENABLED')]: '1' }).readSetting,
    env: { COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED: '0' },
  });
  assert.equal(pinned.SESSION_WORKER_ROUTING_ENABLED, false);
});

test('junk stored values fall back to the default instead of disabling the flag', () => {
  const { readSetting } = settingsStore({
    [featureSettingKey('SESSION_WORKER_ROUTING_ENABLED')]: 'banana',
  });
  assert.equal(resolveBootFeatureFlags({ readSetting, env: {} }).SESSION_WORKER_ROUTING_ENABLED, true);
});

test('flag state reports stored, env, and restart-required per flag', () => {
  const { readSetting } = settingsStore({
    [featureSettingKey('IMAGE_CONVERSATION_CONTINUITY_ENABLED')]: '0',
  });
  const state = computeFeatureFlagState({
    readSetting,
    env: { COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED: '0' },
    activeFlags: {
      SESSION_WORKER_ROUTING_ENABLED: true,
      IMAGE_CONVERSATION_CONTINUITY_ENABLED: true,
    },
  });
  const byName = Object.fromEntries(state.map((row) => [row.name, row]));

  const routing = byName.SESSION_WORKER_ROUTING_ENABLED;
  assert.equal(routing.active, true);
  assert.equal(routing.stored, null);
  assert.equal(routing.envOverride, false);
  assert.equal(routing.effectiveNext, false);
  assert.equal(routing.restartRequired, true, 'env pin differs from the running snapshot');

  const image = byName.IMAGE_CONVERSATION_CONTINUITY_ENABLED;
  assert.equal(image.stored, false);
  assert.equal(image.envOverride, null);
  assert.equal(image.effectiveNext, false);
  assert.equal(image.restartRequired, true);

  const continuation = byName.SESSION_WORKER_CONTINUATION_ROUTING_ENABLED;
  assert.equal(continuation.stored, null);
  assert.equal(continuation.effectiveNext, true);
  assert.equal(continuation.restartRequired, false, 'default matches the active snapshot');

  assert.equal(byName.SESSION_WORKER_FALLBACK_RESTART_ENABLED.noop, true);
  for (const row of state) {
    assert.equal(typeof row.label, 'string');
    assert.equal(typeof row.description, 'string');
  }
});

test('migration moves a legacy features key into settings and strips it from the file', () => {
  const configPath = tempConfig(JSON.stringify({
    authToken: 'keep-me',
    port: 3000,
    features: {
      SESSION_WORKER_ROUTING_ENABLED: true,
      SESSION_WORKER_FALLBACK_RESTART_ENABLED: true,
      UNKNOWN_FLAG: true,
    },
  }, null, 2));
  const store = settingsStore({
    // An existing row is never clobbered by the config value.
    [featureSettingKey('SESSION_WORKER_ROUTING_ENABLED')]: '0',
  });

  const result = migrateLegacyConfigFeatures({
    configPath,
    readSetting: store.readSetting,
    writeSetting: store.writeSetting,
  });

  assert.deepEqual(result, { migrated: true, adopted: ['SESSION_WORKER_FALLBACK_RESTART_ENABLED'], stripped: true });
  assert.equal(store.rows.get(featureSettingKey('SESSION_WORKER_ROUTING_ENABLED')), '0');
  assert.equal(store.rows.get(featureSettingKey('SESSION_WORKER_FALLBACK_RESTART_ENABLED')), '1');

  const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal('features' in rewritten, false);
  assert.equal(rewritten.authToken, 'keep-me', 'sibling keys survive the rewrite');
  assert.equal(rewritten.port, 3000);
  if (process.platform !== 'win32') { // host-platform: the chmod is a real fs effect, meaningless on Windows
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600, 'the token-bearing file stays owner-only');
  }
});

test('migration is a no-op for a missing file or a config without a features key', () => {
  const store = settingsStore();
  assert.deepEqual(migrateLegacyConfigFeatures({
    configPath: tempConfig(undefined),
    readSetting: store.readSetting,
    writeSetting: store.writeSetting,
  }), { migrated: false });

  const untouchedPath = tempConfig(JSON.stringify({ authToken: 'keep-me' }));
  const before = fs.readFileSync(untouchedPath, 'utf8');
  assert.deepEqual(migrateLegacyConfigFeatures({
    configPath: untouchedPath,
    readSetting: store.readSetting,
    writeSetting: store.writeSetting,
  }), { migrated: false });
  assert.equal(fs.readFileSync(untouchedPath, 'utf8'), before);
  assert.equal(store.rows.size, 0);
});

test('an unparseable config is left byte-identical and nothing is written', () => {
  const configPath = tempConfig('{ not json');
  const store = settingsStore();
  const warnings = [];
  const result = migrateLegacyConfigFeatures({
    configPath,
    readSetting: store.readSetting,
    writeSetting: store.writeSetting,
    log: (message) => warnings.push(message),
  });
  assert.deepEqual(result, { migrated: false });
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{ not json');
  assert.equal(store.rows.size, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not be parsed/);
});
