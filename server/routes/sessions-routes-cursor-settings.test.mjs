import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildModelCatalogWithClaudeProvider,
  buildModelCatalogWithCursorProvider,
  buildModelCatalogWithOpenAIProvider,
  parseCursorSettingsUpdateRequest,
} from './sessions-routes.mjs';

test('parseCursorSettingsUpdateRequest requires at least one recognized field', () => {
  const result = parseCursorSettingsUpdateRequest({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'No Cursor settings update provided');
  assert.equal(parseCursorSettingsUpdateRequest({ unrelated: true }).ok, false);
  assert.equal(parseCursorSettingsUpdateRequest({ enabled: true }).ok, true);
  assert.equal(parseCursorSettingsUpdateRequest({ model: 'composer-2.5' }).ok, true);
});

test('parseCursorSettingsUpdateRequest rejects unsafe model ids', () => {
  const result = parseCursorSettingsUpdateRequest({ model: 'bad model !!' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid Cursor model ID/);
});

test('parseCursorSettingsUpdateRequest defaults an empty model to composer-2.5', () => {
  const result = parseCursorSettingsUpdateRequest({ model: '' });
  assert.equal(result.ok, true);
  assert.equal(result.remove, false);
  assert.equal(result.model, 'composer-2.5');
  assert.equal(result.apiKey, '');
  assert.equal(result.enabled, undefined);
});

test('parseCursorSettingsUpdateRequest enables the provider when a key arrives without an explicit flag', () => {
  assert.deepEqual(parseCursorSettingsUpdateRequest({
    apiKey: 'cur-test-key',
    model: 'composer-2.5',
  }), {
    ok: true,
    remove: false,
    apiKey: 'cur-test-key',
    model: 'composer-2.5',
    enabled: true,
  });
  // An explicit flag always wins over the implied one.
  assert.equal(parseCursorSettingsUpdateRequest({ apiKey: 'cur-test-key', enabled: false }).enabled, false);
});

test('parseCursorSettingsUpdateRequest normalizes remove requests', () => {
  assert.deepEqual(parseCursorSettingsUpdateRequest({
    remove: true,
    model: 'composer-2.5',
  }), {
    ok: true,
    remove: true,
    apiKey: '',
    model: 'composer-2.5',
    enabled: false,
  });
  assert.deepEqual(parseCursorSettingsUpdateRequest({ remove: true }), {
    ok: true,
    remove: true,
    apiKey: '',
    enabled: false,
  });
});

test('cursor catalog is unchanged when the provider is disabled', () => {
  const base = { models: ['gpt-5.4-mini'], providersByModel: {}, reasoningByModel: {} };
  const result = buildModelCatalogWithCursorProvider(base, { enabled: false, model: 'composer-2.5' });
  assert.notEqual(result, base);
  assert.deepEqual(result.models, ['gpt-5.4-mini']);
  assert.deepEqual(result.providersByModel, {});
  assert.equal(result.reasoningByProvider, undefined);
});

test('cursor catalog appends models with the cursor provider id', () => {
  const base = {
    models: ['auto', 'gpt-5.4-mini'],
    providersByModel: { 'gpt-5.4-mini': ['github-copilot'] },
    reasoningByModel: { 'gpt-5.4-mini': ['medium'] },
    reasoningByProvider: { github: { 'gpt-5.4-mini': ['medium'] } },
    modelMetadataByModel: {},
  };
  const result = buildModelCatalogWithCursorProvider(base, {
    enabled: true,
    model: 'composer-2.5',
    models: ['composer-2.5', 'cheetah'],
  });
  // Base ordering stays untouched; cursor models append after it.
  assert.deepEqual(result.models, ['auto', 'gpt-5.4-mini', 'composer-2.5', 'cheetah']);
  assert.deepEqual(result.providersByModel['composer-2.5'], ['cursor']);
  assert.deepEqual(result.providersByModel['cheetah'], ['cursor']);
  assert.equal(result.modelMetadataByModel['composer-2.5'].provider, 'cursor');
  assert.deepEqual(result.reasoningByModel['composer-2.5'], ['none']);
  // Existing entries untouched.
  assert.deepEqual(result.providersByModel['gpt-5.4-mini'], ['github-copilot']);
  assert.deepEqual(result.reasoningByModel['gpt-5.4-mini'], ['medium']);
  assert.deepEqual(result.reasoningByProvider.github, { 'gpt-5.4-mini': ['medium'] });
});

test('cursor catalog keeps github-copilot alongside cursor on base-catalog collisions', () => {
  const base = {
    models: ['auto', 'gpt-5.5'],
    providersByModel: { 'gpt-5.5': ['github-copilot'] },
    reasoningByModel: { 'gpt-5.5': ['none', 'low'] },
    modelMetadataByModel: { 'gpt-5.5': { provider: 'github-copilot' } },
  };
  const result = buildModelCatalogWithCursorProvider(base, {
    enabled: true,
    model: 'composer-2.5',
    models: ['gpt-5.5'],
  });
  assert.deepEqual(result.providersByModel['gpt-5.5'], ['github-copilot', 'cursor']);
  assert.equal(result.modelMetadataByModel['gpt-5.5'].provider, 'github-copilot');
  // The colliding id is not duplicated in the model list.
  assert.deepEqual(result.models.filter((id) => id === 'gpt-5.5'), ['gpt-5.5']);
  // Existing reasoning tiers stay untouched; the cursor map still reports 'none'.
  assert.deepEqual(result.reasoningByModel['gpt-5.5'], ['none', 'low']);
  assert.deepEqual(result.reasoningByProvider.cursor['gpt-5.5'], ['none']);
});

test('cursor catalog reports none-only reasoning and preserves other provider maps', () => {
  const base = {
    models: ['gpt-5.4-mini'],
    providersByModel: {},
    reasoningByModel: {},
    reasoningByProvider: {
      github: { 'gpt-5.4-mini': ['medium'] },
      openai: { 'gpt-4o': ['none'] },
      claude: { 'claude-sonnet-5': ['none', 'low'] },
    },
    modelMetadataByModel: {},
  };
  const result = buildModelCatalogWithCursorProvider(base, {
    enabled: true,
    model: 'composer-2.5',
    models: ['composer-2.5'],
  });
  assert.deepEqual(result.reasoningByProvider.cursor, { 'composer-2.5': ['none'] });
  assert.deepEqual(result.reasoningByProvider.github, { 'gpt-5.4-mini': ['medium'] });
  assert.deepEqual(result.reasoningByProvider.openai, { 'gpt-4o': ['none'] });
  assert.deepEqual(result.reasoningByProvider.claude, { 'claude-sonnet-5': ['none', 'low'] });
});

test('cursor catalog composes onto the openai and claude layers', () => {
  const base = {
    models: ['gpt-5.4-mini'],
    providersByModel: { 'gpt-5.4-mini': ['github-copilot'] },
    reasoningByModel: { 'gpt-5.4-mini': ['medium'] },
    modelMetadataByModel: {},
  };
  const combined = buildModelCatalogWithCursorProvider(
    buildModelCatalogWithClaudeProvider(
      buildModelCatalogWithOpenAIProvider(base, {
        enabled: true,
        model: 'gpt-4o',
        models: ['gpt-4o'],
      }),
      {
        enabled: true,
        model: 'claude-sonnet-5',
        models: ['claude-sonnet-5'],
      },
    ),
    {
      enabled: true,
      model: 'composer-2.5',
      models: ['composer-2.5', 'cheetah'],
    },
  );
  assert.ok(combined.models.includes('gpt-4o'));
  assert.ok(combined.models.includes('claude-sonnet-5'));
  assert.ok(combined.models.includes('composer-2.5'));
  assert.ok(combined.models.includes('cheetah'));
  // Each provider-exclusive entry stays exclusive to its own provider.
  assert.deepEqual(combined.providersByModel['gpt-4o'], ['openai-byok']);
  assert.deepEqual(combined.providersByModel['claude-sonnet-5'], ['claude']);
  assert.deepEqual(combined.providersByModel['composer-2.5'], ['cursor']);
  assert.deepEqual(combined.providersByModel['gpt-5.4-mini'], ['github-copilot']);
  assert.ok(combined.reasoningByProvider.github);
  assert.ok(combined.reasoningByProvider.openai);
  assert.deepEqual(combined.reasoningByProvider.claude['claude-sonnet-5'], ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(combined.reasoningByProvider.cursor, {
    'composer-2.5': ['none'],
    cheetah: ['none'],
  });
});
