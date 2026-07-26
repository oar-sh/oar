import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildModelCatalogWithOpenAIProvider,
  parseOpenAISettingsUpdateRequest,
} from './sessions-routes.mjs';

test('parses provider toggles without requiring an API key', () => {
  assert.deepEqual(
    parseOpenAISettingsUpdateRequest({ enabled: false, model: 'gpt-4o' }),
    {
      ok: true,
      remove: false,
      apiKey: '',
      model: 'gpt-4o',
      enabled: false,
    },
  );
  assert.deepEqual(
    parseOpenAISettingsUpdateRequest({ enabled: true }),
    {
      ok: true,
      remove: false,
      apiKey: '',
      enabled: true,
    },
  );
});

test('baseUrl is only included when explicitly provided', () => {
  assert.deepEqual(
    parseOpenAISettingsUpdateRequest({ model: 'gpt-4o' }),
    {
      ok: true,
      remove: false,
      apiKey: '',
      model: 'gpt-4o',
      enabled: undefined,
    },
  );
  assert.deepEqual(
    parseOpenAISettingsUpdateRequest({ model: 'gpt-4o', baseUrl: 'https://proxy.example/v1' }),
    {
      ok: true,
      remove: false,
      apiKey: '',
      model: 'gpt-4o',
      baseUrl: 'https://proxy.example/v1',
      enabled: undefined,
    },
  );
});

test('saving a new API key enables OpenAI unless explicitly disabled', () => {
  assert.equal(parseOpenAISettingsUpdateRequest({ apiKey: 'sk-test' }).enabled, true);
  assert.equal(parseOpenAISettingsUpdateRequest({
    apiKey: 'sk-test',
    enabled: false,
  }).enabled, false);
});

test('OpenAI models are merged only when OpenAI API key is enabled', () => {
  const base = {
    models: ['claude-sonnet'],
    reasoningByModel: {},
    modelMetadataByModel: {},
  };

  assert.deepEqual(
    buildModelCatalogWithOpenAIProvider(base, {
      configured: false,
      enabled: false,
      model: 'gpt-4o',
      models: ['gpt-4o-mini'],
    }).models,
    ['claude-sonnet'],
  );

  const configuredButDisabled = buildModelCatalogWithOpenAIProvider(base, {
    configured: true,
    enabled: false,
    model: 'gpt-4o',
    models: ['gpt-4o-mini'],
  });
  assert.deepEqual(configuredButDisabled.models, ['claude-sonnet']);

  const enabled = buildModelCatalogWithOpenAIProvider(base, {
    configured: true,
    enabled: true,
    model: 'gpt-4o',
    models: ['gpt-4o-mini'],
  });
  assert.deepEqual(enabled.models, ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet']);
  assert.equal(enabled.modelMetadataByModel['gpt-4o'].provider, 'openai-byok');
  assert.deepEqual(enabled.reasoningByProvider.openai['gpt-4o'], ['none']);
  assert.equal(enabled.defaultModel, undefined);
});

test('overlapping model IDs keep provider-specific reasoning capabilities', () => {
  const enabled = buildModelCatalogWithOpenAIProvider({
    models: ['gpt-5.4'],
    reasoningByModel: {
      'gpt-5.4': ['none', 'low', 'medium', 'high'],
    },
    modelMetadataByModel: {
      'gpt-5.4': { provider: 'github-copilot' },
    },
  }, {
    configured: true,
    enabled: true,
    model: 'gpt-5.4',
    models: ['gpt-5.4'],
  });

  assert.deepEqual(enabled.reasoningByProvider.github['gpt-5.4'], ['none', 'low', 'medium', 'high']);
  assert.deepEqual(enabled.reasoningByProvider.openai['gpt-5.4'], ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(enabled.modelMetadataByModel['gpt-5.4'].provider, 'github-copilot');
  assert.deepEqual(enabled.providersByModel['gpt-5.4'], ['github-copilot', 'openai-byok']);
});

test('overlapping models keep GitHub provider without explicit metadata', () => {
  const enabled = buildModelCatalogWithOpenAIProvider({
    models: ['gpt-5.4'],
    reasoningByModel: {
      'gpt-5.4': ['none'],
    },
    modelMetadataByModel: {},
  }, {
    configured: true,
    enabled: true,
    model: 'gpt-5.4',
    models: ['gpt-5.4'],
  });

  assert.deepEqual(enabled.providersByModel['gpt-5.4'], ['github-copilot', 'openai-byok']);
  assert.equal(enabled.modelMetadataByModel['gpt-5.4'].provider, 'github-copilot');
});
