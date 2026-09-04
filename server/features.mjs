'use strict';

import fs from 'fs';
import path from 'path';

// The single registry of relay feature flags. Server resolution, the settings
// API payload, and the web UI's Features tab all render from these entries, so
// a new in-development feature only needs a row here plus the code it gates.
// `noop` marks a flag that is wired into resolution but not yet read by any
// behavior — shown honestly in the UI so a rollout can be staged later.
export const FEATURE_REGISTRY = Object.freeze([
  Object.freeze({
    name: 'SESSION_WORKER_ROUTING_ENABLED',
    label: 'Session worker routing',
    default: true,
    noop: false,
    description: 'Give each conversation its own dedicated worker process. The relay routes every message to the worker that owns that conversation, monitors its health, and recovers it if it crashes — a stuck or crashed turn in one conversation no longer stalls the others. When off, all conversations share the legacy polling pipeline.',
  }),
  Object.freeze({
    name: 'SESSION_WORKER_CONTINUATION_ROUTING_ENABLED',
    label: 'Continuation answer routing',
    default: true,
    noop: false,
    description: 'Validate ownership strictly when you answer a clarification question: the relay checks the question’s conversation, continuation id, and owning worker before accepting the answer, so a stale or cross-wired reply is rejected instead of landing in the wrong session. Most useful together with session worker routing.',
  }),
  Object.freeze({
    name: 'SESSION_WORKER_FALLBACK_RESTART_ENABLED',
    label: 'Worker fallback restart (reserved)',
    default: false,
    noop: true,
    description: 'Reserved rollout gate with no effect yet. It is intended to let the relay restart a turn on the fallback pipeline when a session worker cannot be revived. The toggle is shown so the rollout can be staged later without a release; enabling it today changes nothing.',
  }),
  Object.freeze({
    name: 'IMAGE_CONVERSATION_CONTINUITY_ENABLED',
    label: 'Generated-image continuity',
    default: true,
    noop: false,
    description: 'Track the lineage of generated images so a follow-up like “edit this image” continues from the exact image you mean, not just the most recent one. The relay records which operation produced each image and threads edits back through the right source. When off, image follow-ups lose that source linkage.',
  }),
]);

const DEFAULT_FEATURES = Object.freeze(Object.fromEntries(
  FEATURE_REGISTRY.map((entry) => [entry.name, entry.default]),
));

const ENV_PREFIX = 'COPILOT_REMOTE_';
const FEATURE_NAMES = Object.freeze(FEATURE_REGISTRY.map((entry) => entry.name));

export function featureSettingKey(name) {
  return `feature_${String(name || '').trim().toLowerCase()}`;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return null;
}

function normalizeKnownFeatureFlags(input) {
  const source = input && typeof input === 'object' ? input : {};
  const normalized = {};
  for (const key of FEATURE_NAMES) {
    const parsed = parseBoolean(source[key]);
    if (parsed === null) continue;
    normalized[key] = parsed;
  }
  return normalized;
}

function readFeaturesFromEnv(env = process.env) {
  const entries = [];
  for (const key of FEATURE_NAMES) {
    const envKey = `${ENV_PREFIX}${key}`;
    if (!(envKey in env)) continue;
    const normalized = parseBoolean(env[envKey]);
    if (normalized === null) continue;
    entries.push([key, normalized]);
  }
  return Object.fromEntries(entries);
}

function readFeaturesFromSettings(readSetting) {
  if (typeof readSetting !== 'function') return {};
  const entries = [];
  for (const key of FEATURE_NAMES) {
    const parsed = parseBoolean(readSetting(featureSettingKey(key)));
    if (parsed === null) continue;
    entries.push([key, parsed]);
  }
  return Object.fromEntries(entries);
}

export function normalizeFeatureFlags(featureFlags = null) {
  return Object.freeze({
    ...DEFAULT_FEATURES,
    ...normalizeKnownFeatureFlags(featureFlags),
  });
}

/**
 * The boot-time flag snapshot: registry defaults, overridden by rows in
 * app_settings, overridden by COPILOT_REMOTE_* environment variables. Env stays
 * on top so an isolated test server can pin a flag regardless of what its
 * database says.
 */
export function resolveBootFeatureFlags({ readSetting, env = process.env } = {}) {
  return normalizeFeatureFlags({
    ...readFeaturesFromSettings(readSetting),
    ...readFeaturesFromEnv(env),
  });
}

/**
 * Per-flag rows for the settings API: what is active in this process, what is
 * stored, whether the environment pins it, and what would be active after a
 * restart. `restartRequired` is the only signal the UI needs to show the
 * restart notice — flags are resolved once at boot and never reloaded.
 */
export function computeFeatureFlagState({ readSetting, env = process.env, activeFlags = null } = {}) {
  const active = normalizeFeatureFlags(activeFlags);
  const envFlags = readFeaturesFromEnv(env);
  const storedFlags = readFeaturesFromSettings(readSetting);
  return FEATURE_REGISTRY.map((entry) => {
    const stored = Object.hasOwn(storedFlags, entry.name) ? storedFlags[entry.name] : null;
    const envOverride = Object.hasOwn(envFlags, entry.name) ? envFlags[entry.name] : null;
    const effectiveNext = envOverride ?? stored ?? entry.default;
    return {
      name: entry.name,
      label: entry.label,
      description: entry.description,
      default: entry.default,
      noop: entry.noop,
      active: active[entry.name],
      stored,
      envOverride,
      effectiveNext,
      restartRequired: effectiveNext !== active[entry.name],
    };
  });
}

/**
 * One-time boot migration away from a `features` key in config.json: known
 * flags move into app_settings (without clobbering rows that already exist)
 * and the key is stripped from the file.
 *
 * A read that fails is never followed by a write — config.json holds the auth
 * token, so rewriting an unparseable-but-recoverable file would be far worse
 * than running one boot on defaults (see writeCliBinariesToConfigFile in
 * cli-install-service.mjs for the full rationale). The rewrite itself is
 * tmp-file-then-rename in the config directory, mode 0600, for the same
 * partial-write and token-exposure reasons.
 */
export function migrateLegacyConfigFeatures({
  configPath,
  readSetting,
  writeSetting,
  fsImpl = fs,
  log = (message) => console.warn(message),
} = {}) {
  const target = String(configPath || '').trim();
  if (!target || typeof readSetting !== 'function' || typeof writeSetting !== 'function') {
    return { migrated: false };
  }
  if (!fsImpl.existsSync(target)) return { migrated: false };

  let parsed = null;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
  } catch (error) {
    log(`feature flags: refusing to migrate ${target}: it could not be parsed (${error?.message || error}); flags fall back to defaults + app settings + environment for this boot`);
    return { migrated: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('features' in parsed)) {
    return { migrated: false };
  }

  const legacy = normalizeKnownFeatureFlags(parsed.features);
  const adopted = [];
  for (const [name, enabled] of Object.entries(legacy)) {
    if (parseBoolean(readSetting(featureSettingKey(name))) !== null) continue;
    writeSetting(featureSettingKey(name), enabled ? '1' : '0');
    adopted.push(name);
  }

  delete parsed.features;
  const tmpPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fsImpl.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    try { fsImpl.chmodSync(tmpPath, 0o600); } catch {}
    fsImpl.renameSync(tmpPath, target);
  } catch (error) {
    try { fsImpl.unlinkSync(tmpPath); } catch {}
    log(`feature flags: migrated values to app settings but could not strip the features key from ${target} (${error?.message || error})`);
    return { migrated: true, adopted, stripped: false };
  }
  return { migrated: true, adopted, stripped: true };
}

export function getSessionWorkerFeatureFlags(featureFlags) {
  const normalized = normalizeFeatureFlags(featureFlags);
  return {
    enabled: normalized.SESSION_WORKER_ROUTING_ENABLED === true,
    continuationRoutingEnabled: normalized.SESSION_WORKER_CONTINUATION_ROUTING_ENABLED === true,
    fallbackRestartEnabled: normalized.SESSION_WORKER_FALLBACK_RESTART_ENABLED === true,
  };
}

export function isFeatureEnabled(featureName, featureFlags) {
  const name = String(featureName || '').trim();
  if (!name) return false;
  const normalized = normalizeFeatureFlags(featureFlags);
  return normalized[name] === true;
}
