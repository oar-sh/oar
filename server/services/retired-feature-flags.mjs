'use strict';

import fs from 'fs';

// The feature flags that used to switch session worker routing, continuation
// answer routing and generated-image continuity. All three are always on;
// a stored "off" is no longer read. The relay names one once at start so an
// owner who switched one off learns that the setting is ignored. Nothing
// stored is changed: a downgrade finds its values as they were. The fourth
// name, the reserved SESSION_WORKER_FALLBACK_RESTART_ENABLED, never did
// anything and is passed over without a line.
const RETIRED_FEATURE_FLAGS = Object.freeze([
  'SESSION_WORKER_ROUTING_ENABLED',
  'SESSION_WORKER_CONTINUATION_ROUTING_ENABLED',
  'IMAGE_CONVERSATION_CONTINUITY_ENABLED',
]);

const ENV_PREFIX = 'COPILOT_REMOTE_';

function settingKey(name) {
  return `feature_${name.toLowerCase()}`;
}

function isOff(value) {
  if (typeof value === 'boolean') return value === false;
  if (typeof value === 'number') return value === 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off';
}

// The `features` object of config.json, or null: a missing file, one that
// does not parse, or one without the key is passed over silently. Read only.
function readConfigFeatures(configPath, fsImpl) {
  const target = String(configPath || '').trim();
  if (!target) return null;
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
    const features = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.features : null;
    return features && typeof features === 'object' && !Array.isArray(features) ? features : null;
  } catch {
    return null;
  }
}

/**
 * The one boot log line for retired feature flags that still say "off", or
 * null when none does. Looks at the `feature_*` app settings rows, the
 * COPILOT_REMOTE_* environment variables and a `features` key in
 * config.json, in that order.
 */
export function retiredFeatureFlagsLine({ readSetting = null, env = {}, configPath = '', fsImpl = fs } = {}) {
  const found = [];
  if (typeof readSetting === 'function') {
    for (const name of RETIRED_FEATURE_FLAGS) {
      let value = null;
      try { value = readSetting(settingKey(name)); } catch {}
      if (value !== null && value !== undefined && isOff(value)) found.push(`${name}=off (app setting)`);
    }
  }
  const environment = env && typeof env === 'object' ? env : {};
  for (const name of RETIRED_FEATURE_FLAGS) {
    const envKey = `${ENV_PREFIX}${name}`;
    if (Object.hasOwn(environment, envKey) && isOff(environment[envKey])) found.push(`${name}=off (${envKey})`);
  }
  const configFeatures = readConfigFeatures(configPath, fsImpl);
  if (configFeatures) {
    for (const name of RETIRED_FEATURE_FLAGS) {
      if (Object.hasOwn(configFeatures, name) && isOff(configFeatures[name])) found.push(`${name}=off (config.json features)`);
    }
  }
  if (!found.length) return null;
  return `feature flags are always on now; ignoring ${found.join(', ')}`;
}
