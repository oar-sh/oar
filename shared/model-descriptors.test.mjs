import test from 'node:test';
import assert from 'node:assert/strict';

import { extractModelDescriptors } from './model-descriptors.mjs';

test('extractModelDescriptors does not leak a sibling model context window', () => {
  const descriptors = extractModelDescriptors({
    id: 'gpt-5.4',
    data: [{ id: 'gpt-5.4-mini', contextWindow: 8000 }],
  });
  const byId = new Map(descriptors.map((entry) => [entry.modelId, entry]));
  assert.deepEqual([...byId.keys()], ['gpt-5.4', 'gpt-5.4-mini']);
  assert.equal(byId.get('gpt-5.4').contextLimitTokens, null);
  assert.equal(byId.get('gpt-5.4-mini').contextLimitTokens, 8000);
});

test('extractModelDescriptors still finds a model own nested context window', () => {
  const [descriptor] = extractModelDescriptors({
    id: 'gpt-5.4',
    capabilities: { contextWindow: 128000 },
  });
  assert.equal(descriptor.contextLimitTokens, 128000);
});

test('extractModelDescriptors treats batchSize-only pricing as no pricing', () => {
  const [descriptor] = extractModelDescriptors({
    id: 'gpt-5.4',
    tokenPrices: { batchSize: 1000000 },
  });
  assert.equal(descriptor.pricing.default, null);
});

test('extractModelDescriptors keeps pricing when a real rate is present', () => {
  const [descriptor] = extractModelDescriptors({
    id: 'gpt-5.4',
    tokenPrices: { inputPrice: 1.25, batchSize: 1000000 },
  });
  assert.deepEqual(descriptor.pricing.default, {
    input: 1.25,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    batchSize: 1000000,
  });
});
