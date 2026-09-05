import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CLAUDE_CATALOG_MODELS,
  mergeClaudeModelEfforts,
  mergeDiscoveredClaudeModels,
} from './claude-model-catalog.mjs';

test('a model the CLI stopped advertising is retained, not dropped', () => {
  // The real 2026-09-05 case: Fable 5 vanished from supportedModels() the
  // moment Fable 5.1 appeared, taking it out of the composer picker.
  const merged = mergeDiscoveredClaudeModels({
    defaultModel: 'claude-sonnet-5',
    discovered: ['claude-sonnet-5', 'claude-opus-5[1m]', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'],
    previouslyKnown: ['claude-sonnet-5', 'claude-opus-5[1m]', 'claude-fable-5', 'claude-haiku-4-5-20251001'],
  });
  assert.deepEqual(merged, [
    'claude-sonnet-5',
    'claude-opus-5[1m]',
    'claude-fable-5-1',
    'claude-haiku-4-5-20251001',
    'claude-fable-5',
  ]);
});

test('the default model always leads, even when discovery never reported it', () => {
  const merged = mergeDiscoveredClaudeModels({
    defaultModel: 'claude-fable-5',
    discovered: ['claude-sonnet-5', 'claude-fable-5-1'],
    previouslyKnown: [],
  });
  assert.equal(merged[0], 'claude-fable-5', 'the composer selection cannot fall out of its own list');
  assert.deepEqual(merged, ['claude-fable-5', 'claude-sonnet-5', 'claude-fable-5-1']);
});

test('duplicates collapse case-insensitively, keeping the first spelling', () => {
  const merged = mergeDiscoveredClaudeModels({
    defaultModel: '',
    discovered: ['claude-Sonnet-5', 'claude-sonnet-5'],
    previouslyKnown: ['CLAUDE-SONNET-5'],
  });
  assert.deepEqual(merged, ['claude-Sonnet-5']);
});

test('blank and non-array inputs degrade instead of throwing', () => {
  assert.deepEqual(mergeDiscoveredClaudeModels(), []);
  assert.deepEqual(mergeDiscoveredClaudeModels({ defaultModel: '  ', discovered: null, previouslyKnown: undefined }), []);
  assert.deepEqual(
    mergeDiscoveredClaudeModels({ defaultModel: ' claude-opus-5 ', discovered: ['', '   '] }),
    ['claude-opus-5'],
  );
});

test('the catalog is capped, shedding the stalest retained ids first', () => {
  const discovered = Array.from({ length: 30 }, (_value, index) => `claude-new-${index}`);
  const previouslyKnown = Array.from({ length: 30 }, (_value, index) => `claude-old-${index}`);
  const merged = mergeDiscoveredClaudeModels({ defaultModel: 'claude-default', discovered, previouslyKnown, max: 32 });
  assert.equal(merged.length, 32);
  assert.equal(merged[0], 'claude-default');
  assert.equal(merged.at(-1), 'claude-old-0', 'retained ids fill only what the current lineup leaves');
  assert.equal(merged.includes('claude-new-29'), true, 'the current lineup is never shed');
  assert.equal(MAX_CLAUDE_CATALOG_MODELS, 32);
});

test('a bad cap falls back to the default instead of emptying the catalog', () => {
  const merged = mergeDiscoveredClaudeModels({ discovered: ['claude-opus-5'], max: 0 });
  assert.deepEqual(merged, ['claude-opus-5']);
});

test('effort ladders: discovery wins, retained models keep what they had', () => {
  const merged = mergeClaudeModelEfforts(
    { 'claude-fable-5': ['low', 'high'], 'claude-sonnet-5': ['low'] },
    { 'claude-sonnet-5': ['low', 'high', 'xhigh'], 'claude-fable-5-1': ['high'] },
  );
  assert.deepEqual(merged, {
    'claude-fable-5': ['low', 'high'],
    'claude-sonnet-5': ['low', 'high', 'xhigh'],
    'claude-fable-5-1': ['high'],
  });
  assert.deepEqual(mergeClaudeModelEfforts(null, undefined), {});
});
