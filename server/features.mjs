'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_FEATURES = Object.freeze({
  SESSION_WORKER_ROUTING_ENABLED: false,
  SESSION_WORKER_CONTINUATION_ROUTING_ENABLED: false,
  SESSION_WORKER_FALLBACK_RESTART_ENABLED: false,
  IMAGE_CONVERSATION_CONTINUITY_ENABLED: false,
});

const ENV_PREFIX = 'COPILOT_REMOTE_';
const FEATURE_NAMES = Object.freeze(Object.keys(DEFAULT_FEATURES));

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

function readFeaturesFromConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const configured = parsed && typeof parsed === 'object' ? parsed.features : null;
    return normalizeKnownFeatureFlags(configured);
  } catch {
    return {};
  }
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

export function normalizeFeatureFlags(featureFlags = null) {
  return Object.freeze({
    ...DEFAULT_FEATURES,
    ...normalizeKnownFeatureFlags(featureFlags),
  });
}

export function resolveFeatureFlags({
  configFeatures = null,
  env = process.env,
} = {}) {
  return normalizeFeatureFlags({
    ...normalizeKnownFeatureFlags(configFeatures),
    ...readFeaturesFromEnv(env),
  });
}

export const FEATURES = resolveFeatureFlags({
  configFeatures: readFeaturesFromConfig(),
});

export function getSessionWorkerFeatureFlags(featureFlags = FEATURES) {
  const normalized = normalizeFeatureFlags(featureFlags);
  return {
    enabled: normalized.SESSION_WORKER_ROUTING_ENABLED === true,
    continuationRoutingEnabled: normalized.SESSION_WORKER_CONTINUATION_ROUTING_ENABLED === true,
    fallbackRestartEnabled: normalized.SESSION_WORKER_FALLBACK_RESTART_ENABLED === true,
  };
}

export function isFeatureEnabled(featureName, featureFlags = FEATURES) {
  const name = String(featureName || '').trim();
  if (!name) return false;
  const normalized = normalizeFeatureFlags(featureFlags);
  return normalized[name] === true;
}
