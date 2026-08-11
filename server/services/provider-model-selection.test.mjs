import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalProviderModelId,
  isProviderModelAvailable,
  resolveProviderModelSelection,
} from './provider-model-selection.mjs';

test('an available model resolves to the catalog casing', () => {
  const selection = resolveProviderModelSelection({
    requestedModel: 'grok-4.5',
    configuredModel: 'composer-2.5',
    availableModels: ['composer-2.5', 'Grok-4.5'],
  });
  assert.equal(selection.ok, true);
  assert.equal(selection.model, 'Grok-4.5');
  assert.equal(selection.source, 'matched');
});

test('a blank or auto request falls back to the configured model', () => {
  for (const requestedModel of ['', '   ', 'auto', 'AUTO']) {
    const selection = resolveProviderModelSelection({
      requestedModel,
      configuredModel: 'composer-2.5',
      availableModels: ['composer-2.5'],
    });
    assert.equal(selection.ok, true, requestedModel);
    assert.equal(selection.model, 'composer-2.5');
    assert.equal(selection.source, 'default');
  }
});

test('an unavailable model is refused rather than substituted', () => {
  const selection = resolveProviderModelSelection({
    requestedModel: 'claude-opus-5',
    configuredModel: 'composer-2.5',
    availableModels: ['composer-2.5', 'grok-4.5'],
  });
  assert.equal(selection.ok, false);
  assert.equal(selection.model, '');
  assert.equal(selection.requestedModel, 'claude-opus-5');
  assert.deepEqual(selection.availableModels, ['composer-2.5', 'grok-4.5']);
});

test('the configured model counts as available even when the list omits it', () => {
  const selection = resolveProviderModelSelection({
    requestedModel: 'composer-2.5',
    configuredModel: 'composer-2.5',
    availableModels: [],
  });
  assert.equal(selection.ok, true);
  assert.equal(selection.model, 'composer-2.5');
});

test('canonical lookup helpers match case-insensitively', () => {
  assert.equal(canonicalProviderModelId('GROK-4.5', ['grok-4.5']), 'grok-4.5');
  assert.equal(canonicalProviderModelId('missing', ['grok-4.5']), '');
  assert.equal(isProviderModelAvailable('Grok-4.5', ['grok-4.5']), true);
  assert.equal(isProviderModelAvailable('', ['grok-4.5']), false);
});
