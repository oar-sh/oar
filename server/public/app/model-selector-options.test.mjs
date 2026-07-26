import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
