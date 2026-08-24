import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGrokContextUsage, resolveGrokContextWindow } from './grok-context-usage.mjs';

test('resolveGrokContextWindow prefers discovery metadata over the static map', () => {
  assert.equal(resolveGrokContextWindow('grok-4.5', { 'grok-4.5': 131072 }), 131072);
  assert.equal(resolveGrokContextWindow('grok-4.5', {}), 256000);
  assert.equal(resolveGrokContextWindow('grok-unknown-99', {}), null);
  assert.equal(resolveGrokContextWindow('', {}), null);
});

test('buildGrokContextUsage maps a turn usage blob onto the shared payload shape', () => {
  const built = buildGrokContextUsage({
    usage: {
      inputTokens: 13972,
      outputTokens: 36,
      cachedReadTokens: 7808,
      cacheCreationTokens: 0,
      totalTokens: 999999, // cumulative — must not drive occupancy
    },
    model: 'grok-4.5',
    contextWindow: 256000,
  });
  assert.ok(built);
  assert.equal(built.contextUsage.model, 'grok-4.5');
  assert.equal(built.contextUsage.totalTokens, 13972 + 7808 + 36);
  assert.equal(built.contextUsage.maxTokens, 256000);
  assert.ok(built.contextUsage.percentage > 0);
  assert.equal(built.contextUsage.apiUsage.input_tokens, 13972);
  assert.equal(built.modelUsage['grok-4.5'].contextWindow, 256000);
});

test('buildGrokContextUsage omits the fill metric without a window and rejects empty blobs', () => {
  const noWindow = buildGrokContextUsage({
    usage: { inputTokens: 100, outputTokens: 10 },
    model: 'grok-x',
    contextWindow: null,
  });
  assert.equal(noWindow.contextUsage.maxTokens, undefined);
  assert.equal(noWindow.contextUsage.percentage, undefined);
  assert.equal(buildGrokContextUsage({ usage: {}, model: 'grok-x' }), null);
  assert.equal(buildGrokContextUsage({ usage: null }), null);
});
