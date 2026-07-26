import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeFeatureFlags,
  resolveFeatureFlags,
} from './features.mjs';

test('image conversation continuity is enabled by default', () => {
  assert.equal(normalizeFeatureFlags().IMAGE_CONVERSATION_CONTINUITY_ENABLED, true);
});

test('image conversation continuity remains explicitly configurable', () => {
  assert.equal(resolveFeatureFlags({
    configFeatures: { IMAGE_CONVERSATION_CONTINUITY_ENABLED: false },
    env: {},
  }).IMAGE_CONVERSATION_CONTINUITY_ENABLED, false);
  assert.equal(resolveFeatureFlags({
    configFeatures: { IMAGE_CONVERSATION_CONTINUITY_ENABLED: false },
    env: { COPILOT_REMOTE_IMAGE_CONVERSATION_CONTINUITY_ENABLED: 'true' },
  }).IMAGE_CONVERSATION_CONTINUITY_ENABLED, true);
});
