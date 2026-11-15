import test from 'node:test';
import assert from 'node:assert/strict';

import { retiredFeatureFlagsLine } from './retired-feature-flags.mjs';

const CONFIG_PATH = '/home/dev/.oar-test/config.json';

// A config.json that is never written: readFileSync answers from the map,
// and any write fails the test.
function fakeFs(files = {}) {
  return {
    readFileSync(target) {
      if (!Object.hasOwn(files, target)) {
        const error = new Error(`ENOENT: ${target}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files[target];
    },
    writeFileSync() { throw new Error('config.json must not be written'); },
    renameSync() { throw new Error('config.json must not be written'); },
  };
}

function settings(rows = {}) {
  return (key) => (Object.hasOwn(rows, key) ? rows[key] : '');
}

test('no stored value, no variable and no config.json: no line', () => {
  assert.equal(retiredFeatureFlagsLine({ readSetting: settings(), env: {}, configPath: CONFIG_PATH, fsImpl: fakeFs() }), null);
  assert.equal(retiredFeatureFlagsLine(), null);
});

test('only "on" values: no line', () => {
  const line = retiredFeatureFlagsLine({
    readSetting: settings({ feature_session_worker_routing_enabled: '1' }),
    env: { COPILOT_REMOTE_IMAGE_CONVERSATION_CONTINUITY_ENABLED: 'true' },
    configPath: CONFIG_PATH,
    fsImpl: fakeFs({ [CONFIG_PATH]: JSON.stringify({ features: { SESSION_WORKER_CONTINUATION_ROUTING_ENABLED: true } }) }),
  });
  assert.equal(line, null);
});

test('one "off" row in app settings: one line naming it', () => {
  const line = retiredFeatureFlagsLine({
    readSetting: settings({ feature_session_worker_routing_enabled: '0' }),
    env: {},
    configPath: CONFIG_PATH,
    fsImpl: fakeFs(),
  });
  assert.equal(line, 'feature flags are always on now; ignoring SESSION_WORKER_ROUTING_ENABLED=off (app setting)');
});

test('one "off" environment variable: one line naming the variable', () => {
  const line = retiredFeatureFlagsLine({
    readSetting: settings(),
    env: { COPILOT_REMOTE_IMAGE_CONVERSATION_CONTINUITY_ENABLED: 'off' },
    configPath: CONFIG_PATH,
    fsImpl: fakeFs(),
  });
  assert.equal(
    line,
    'feature flags are always on now; ignoring IMAGE_CONVERSATION_CONTINUITY_ENABLED=off (COPILOT_REMOTE_IMAGE_CONVERSATION_CONTINUITY_ENABLED)',
  );
});

test('an "off" in the features key of config.json: one line, the file is only read', () => {
  const line = retiredFeatureFlagsLine({
    readSetting: settings(),
    env: {},
    configPath: CONFIG_PATH,
    fsImpl: fakeFs({ [CONFIG_PATH]: JSON.stringify({ port: 3000, features: { SESSION_WORKER_CONTINUATION_ROUTING_ENABLED: false } }) }),
  });
  assert.equal(line, 'feature flags are always on now; ignoring SESSION_WORKER_CONTINUATION_ROUTING_ENABLED=off (config.json features)');
});

test('a config.json that does not parse is passed over silently', () => {
  const line = retiredFeatureFlagsLine({
    readSetting: settings(),
    env: {},
    configPath: CONFIG_PATH,
    fsImpl: fakeFs({ [CONFIG_PATH]: '{ "features": { "SESSION_WORKER_ROUTING_ENABLED": false ' }),
  });
  assert.equal(line, null);
});

test('several "off" values from every source: still one line naming each', () => {
  const line = retiredFeatureFlagsLine({
    readSetting: settings({
      feature_session_worker_routing_enabled: '0',
      feature_image_conversation_continuity_enabled: 'false',
    }),
    env: { COPILOT_REMOTE_SESSION_WORKER_CONTINUATION_ROUTING_ENABLED: '0' },
    configPath: CONFIG_PATH,
    fsImpl: fakeFs({ [CONFIG_PATH]: JSON.stringify({ features: { SESSION_WORKER_ROUTING_ENABLED: 'no' } }) }),
  });
  assert.equal(line, 'feature flags are always on now; ignoring '
    + 'SESSION_WORKER_ROUTING_ENABLED=off (app setting), '
    + 'IMAGE_CONVERSATION_CONTINUITY_ENABLED=off (app setting), '
    + 'SESSION_WORKER_CONTINUATION_ROUTING_ENABLED=off (COPILOT_REMOTE_SESSION_WORKER_CONTINUATION_ROUTING_ENABLED), '
    + 'SESSION_WORKER_ROUTING_ENABLED=off (config.json features)');
  assert.equal(line.split('\n').length, 1);
});

test('the reserved fallback-restart name alone gives no line, whatever its value', () => {
  const line = retiredFeatureFlagsLine({
    readSetting: settings({ feature_session_worker_fallback_restart_enabled: '0' }),
    env: { COPILOT_REMOTE_SESSION_WORKER_FALLBACK_RESTART_ENABLED: 'false' },
    configPath: CONFIG_PATH,
    fsImpl: fakeFs({ [CONFIG_PATH]: JSON.stringify({ features: { SESSION_WORKER_FALLBACK_RESTART_ENABLED: false } }) }),
  });
  assert.equal(line, null);
});

test('a value that is neither on nor off is not reported', () => {
  const line = retiredFeatureFlagsLine({
    readSetting: settings({ feature_session_worker_routing_enabled: 'maybe' }),
    env: { COPILOT_REMOTE_IMAGE_CONVERSATION_CONTINUITY_ENABLED: '' },
    configPath: CONFIG_PATH,
    fsImpl: fakeFs(),
  });
  assert.equal(line, null);
});
