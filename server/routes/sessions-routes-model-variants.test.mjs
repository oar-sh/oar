import test from 'node:test';
import assert from 'node:assert/strict';

import { buildModelVariantCatalogPayload, buildReasoningByModelFromVariantRows } from './model-routes.mjs';

test('buildModelVariantCatalogPayload keeps enabled unavailable variants and warning metadata', () => {
  const payload = buildModelVariantCatalogPayload({
    rows: [
      {
        variantId: 'gpt-5.4-mini-none',
        baseModelId: 'gpt-5.4-mini',
        provider: 'openai',
        label: 'GPT-5.4 Mini',
        releaseStatus: 'unavailable',
        reasoningEffort: 'none',
        enabled: true,
        sortOrder: 0,
      },
      {
        variantId: 'claude-sonnet-4.6-none',
        baseModelId: 'claude-sonnet-4.6',
        provider: 'anthropic',
        label: 'Claude Sonnet 4.6',
        releaseStatus: null,
        reasoningEffort: 'none',
        enabled: false,
        sortOrder: 1,
      },
    ],
    modelState: {
      source: 'rpc-snapshot',
      refreshedAt: '2026-06-24T00:00:00.000Z',
      warning: null,
      error: null,
    },
    reasoningEfforts: ['none', 'low', 'medium'],
  });

  assert.deepEqual(payload.enabledVariantIds, ['gpt-5.4-mini-none']);
  assert.equal(payload.variants[0].releaseStatus, 'unavailable');
  assert.equal(payload.source, 'rpc-snapshot');
  assert.deepEqual(payload.reasoningEfforts, ['none', 'low', 'medium']);
});

test('buildReasoningByModelFromVariantRows aggregates efforts per base model', () => {
  const map = buildReasoningByModelFromVariantRows([
    { baseModelId: 'gpt-5.4', reasoningEffort: 'none' },
    { baseModelId: 'gpt-5.4', reasoningEffort: 'low' },
    { baseModelId: 'claude-sonnet-4.6', reasoningEffort: 'medium' },
  ]);
  assert.deepEqual(map['gpt-5.4'], ['none', 'low']);
  assert.deepEqual(map['claude-sonnet-4.6'], ['medium']);
});

test('buildModelVariantCatalogPayload includes reasoningByModel from model state', () => {
  const payload = buildModelVariantCatalogPayload({
    rows: [
      {
        variantId: 'gpt-5.4-none',
        baseModelId: 'gpt-5.4',
        provider: 'openai',
        label: 'GPT-5.4',
        reasoningEffort: 'none',
        enabled: true,
        sortOrder: 0,
      },
    ],
    modelState: {
      reasoningByModel: { 'gpt-5.4': ['none', 'low'] },
      reasoningEfforts: ['none', 'low'],
      contextLimitsByModel: { 'gpt-5.4': 256000 },
    },
  });
  assert.deepEqual(payload.reasoningByModel['gpt-5.4'], ['none', 'low']);
  assert.equal(payload.contextLimitsByModel['gpt-5.4'], 256000);
});
