import assert from 'node:assert/strict';
import test from 'node:test';

import {
  humanizeModelLabel,
  modelSelectorOptionsEqual,
  normalizeModelSelectorOptions,
} from './model-selector-options.mjs';

test('normalizes model options with Auto first and alphabetical labels', () => {
  const options = normalizeModelSelectorOptions(
    ['zeta', 'auto', 'Alpha', 'beta-10', 'beta-2', 'Alpha'],
    {
      labelFor: (modelId) => modelId === 'auto' ? 'Auto' : modelId,
    },
  );

  assert.deepEqual(options, [
    { value: 'auto', label: 'Auto' },
    { value: 'Alpha', label: 'Alpha' },
    { value: 'beta-2', label: 'beta-2' },
    { value: 'beta-10', label: 'beta-10' },
    { value: 'zeta', label: 'zeta' },
  ]);
});

test('detects identical option sequences without requiring DOM replacement', () => {
  const options = normalizeModelSelectorOptions(['gpt-5', 'gpt-4'], {
    labelFor: (modelId) => modelId === 'auto' ? 'Auto' : modelId,
  });

  assert.equal(modelSelectorOptionsEqual(options, options.map((option) => ({ ...option }))), true);
  assert.equal(modelSelectorOptionsEqual(options, [...options].reverse()), false);
});

test('claude labels compress to family + dotted version for narrow selects', () => {
  assert.equal(humanizeModelLabel('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(humanizeModelLabel('claude-fable-5'), 'Fable 5');
  assert.equal(humanizeModelLabel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(humanizeModelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5', 'snapshot dates are noise');
  assert.equal(humanizeModelLabel('claude-opus-5[1m]'), 'Opus 5 [1m]', 'capability suffix survives verbatim');
  assert.equal(humanizeModelLabel('claude-opus-4-6-fast'), 'Opus 4.6 Fast');
});

test('non-claude labels keep their family prefixes', () => {
  assert.equal(humanizeModelLabel('gpt-5.4-mini'), 'GPT-5.4 Mini');
  assert.equal(humanizeModelLabel('gemini-3.5-flash'), 'Gemini 3.5 Flash');
  assert.equal(humanizeModelLabel('grok-4'), 'grok-4', 'unknown families pass through untouched');
  assert.equal(humanizeModelLabel(''), '');
});

test('colliding labels (alias + dated snapshot) fall back to raw ids', () => {
  const options = normalizeModelSelectorOptions(
    ['claude-fable-5-1', 'claude-fable-5-1-20251103', 'claude-sonnet-5'],
    { labelFor: humanizeModelLabel },
  );
  const byValue = Object.fromEntries(options.map((option) => [option.value, option.label]));
  assert.equal(byValue['claude-fable-5-1'], 'claude-fable-5-1', 'ambiguous label degrades to the id');
  assert.equal(byValue['claude-fable-5-1-20251103'], 'claude-fable-5-1-20251103');
  assert.equal(byValue['claude-sonnet-5'], 'Sonnet 5', 'unambiguous labels keep the compact form');
});
