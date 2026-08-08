'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelCatalogWithGrokProvider,
  buildModelCatalogWithCursorProvider,
  buildModelCatalogWithClaudeProvider,
  buildModelCatalogWithOpenAIProvider,
  parseGrokSettingsUpdateRequest,
} from './sessions-routes.mjs';

const base = {
  models: ['gpt-5.4-mini', 'auto'],
  reasoningByModel: {},
  reasoningByProvider: {},
  modelMetadataByModel: {},
  providersByModel: {
    'gpt-5.4-mini': ['github-copilot'],
  },
};

test('parseGrokSettingsUpdateRequest accepts enable + model', () => {
  const parsed = parseGrokSettingsUpdateRequest({ enabled: true, model: 'grok-4.5' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.model, 'grok-4.5');
});

test('parseGrokSettingsUpdateRequest rejects empty body', () => {
  const parsed = parseGrokSettingsUpdateRequest({});
  assert.equal(parsed.ok, false);
});

test('parseGrokSettingsUpdateRequest rejects invalid model ids', () => {
  const parsed = parseGrokSettingsUpdateRequest({ model: 'not a model!!' });
  assert.equal(parsed.ok, false);
});

test('buildModelCatalogWithGrokProvider is a no-op when disabled', () => {
  const result = buildModelCatalogWithGrokProvider(base, { enabled: false, model: 'grok-4.5' });
  assert.deepEqual(result.models, base.models);
  assert.equal(result.reasoningByProvider?.grok, undefined);
});

test('buildModelCatalogWithGrokProvider adds models and provider tags when enabled', () => {
  const result = buildModelCatalogWithGrokProvider(base, {
    enabled: true,
    model: 'grok-4.5',
    models: ['grok-4.5', 'grok-code-fast-1'],
    effortsByModel: {
      'grok-4.5': ['none', 'low', 'medium', 'high'],
    },
  });
  assert.ok(result.models.includes('grok-4.5'));
  assert.ok(result.models.includes('grok-code-fast-1'));
  assert.ok(result.providersByModel['grok-4.5'].includes('grok'));
  assert.equal(result.modelMetadataByModel['grok-4.5'].provider, 'grok');
  assert.deepEqual(result.reasoningByProvider.grok['grok-4.5'], ['none', 'low', 'medium', 'high']);
});

test('buildModelCatalogWithGrokProvider layers after cursor/claude/openai', () => {
  const combined = buildModelCatalogWithGrokProvider(
    buildModelCatalogWithCursorProvider(
      buildModelCatalogWithClaudeProvider(
        buildModelCatalogWithOpenAIProvider(base, {
          enabled: true,
          model: 'gpt-4o',
          models: ['gpt-4o'],
        }),
        { enabled: true, model: 'claude-sonnet-5', models: ['claude-sonnet-5'] },
      ),
      { enabled: true, model: 'composer-2.5', models: ['composer-2.5'] },
    ),
    { enabled: true, model: 'grok-4.5', models: ['grok-4.5'] },
  );
  assert.ok(combined.models.includes('grok-4.5'));
  assert.ok(combined.models.includes('composer-2.5'));
  assert.ok(combined.models.includes('claude-sonnet-5'));
  assert.ok(combined.providersByModel['grok-4.5'].includes('grok'));
});
