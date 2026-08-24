import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveFallbackContextLimitTokens } from './context-window-fallbacks.mjs';

test('cursor-served models without a context parameter have fallback windows', () => {
  assert.equal(resolveFallbackContextLimitTokens('grok-4.5'), 256000);
  assert.equal(resolveFallbackContextLimitTokens('composer-2.5'), 200000);
});

test('the [1m] suffix wins over the base model entry', () => {
  assert.equal(resolveFallbackContextLimitTokens('claude-opus-5[1m]'), 1000000);
  assert.equal(resolveFallbackContextLimitTokens('claude-opus-5'), 200000);
  assert.equal(resolveFallbackContextLimitTokens('totally-unknown[1m]'), 1000000);
});

test('unknown models and empty ids resolve to null', () => {
  assert.equal(resolveFallbackContextLimitTokens('totally-unknown'), null);
  assert.equal(resolveFallbackContextLimitTokens(''), null);
  assert.equal(resolveFallbackContextLimitTokens(null), null);
});
