import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isReasoningOffUnsupported,
  reasoningEffortOptionLabel,
} from './reasoning-effort-labels.mjs';

const catalog = {
  reasoningOffUnsupportedByProvider: {
    cursor: { 'grok-4.5': true, 'composer-2.5': false },
  },
};

test('only models that cannot express reasoning-off are flagged', () => {
  assert.equal(isReasoningOffUnsupported(catalog, 'cursor', 'Grok-4.5'), true);
  assert.equal(isReasoningOffUnsupported(catalog, 'cursor', 'composer-2.5'), false);
  assert.equal(isReasoningOffUnsupported(catalog, 'claude', 'grok-4.5'), false);
  assert.equal(isReasoningOffUnsupported(null, 'cursor', 'grok-4.5'), false);
});

test('"none" is labelled as the provider default only where it means that', () => {
  assert.equal(reasoningEffortOptionLabel('none', { reasoningOffUnsupported: true }), 'default');
  assert.equal(reasoningEffortOptionLabel('none', { reasoningOffUnsupported: false }), 'none');
  assert.equal(reasoningEffortOptionLabel('high', { reasoningOffUnsupported: true }), 'high');
  assert.equal(reasoningEffortOptionLabel(''), '');
});
