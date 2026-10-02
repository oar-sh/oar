import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCatalogModelOptions,
  catalogModelLabel,
  catalogOrderFor,
  composerPlaceholderFor,
  contextWindowSuffix,
  humanizeModelLabel,
  modelMetadataFor,
  modelSelectorOptionsEqual,
  normalizeModelSelectorOptions,
  splitModelVariantId,
} from './model-selector-options.mjs';

// A slice of what GET /api/models publishes once the server carries the richer
// catalog: Copilot rows have a canonical index, SDK-only rows do not.
const CATALOG_METADATA = {
  'gpt-5.4-mini': { displayName: 'GPT-5.4 mini', vendor: 'OpenAI', contextWindowTokens: 400000, defaultContextLimitTokens: 128000, catalogIndex: 1 },
  'gpt-5.6-terra': { displayName: 'GPT-5.6 Terra', vendor: 'OpenAI', contextWindowTokens: 1050000, catalogIndex: 2 },
  'claude-haiku-4-5': { displayName: 'Claude Haiku 4.5', vendor: 'Anthropic', contextWindowTokens: 144000, catalogIndex: 5 },
  'claude-opus-4-8-fast': { displayName: 'Claude Opus 4.8 (fast mode)', vendor: 'Anthropic', contextWindowTokens: 200000, catalogIndex: 3 },
  'gemini-3.6-flash': { displayName: 'Gemini 3.6 Flash', vendor: 'Google', contextWindowTokens: 1000000, catalogIndex: 4 },
  // A Claude-SDK-only model: no index, no real window.
  'claude-fable-5-1': { displayName: null, contextWindowTokens: null, catalogIndex: null },
};

test('without a server order, Auto leads and labels sort alphabetically', () => {
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

test('a server order wins over the alphabet; unindexed models trail alphabetically', () => {
  const order = { zeta: 0, gamma: 1 };
  const options = normalizeModelSelectorOptions(
    ['Alpha', 'gamma', 'auto', 'zeta', 'beta'],
    {
      labelFor: (modelId) => modelId === 'auto' ? 'Auto' : modelId,
      orderFor: (modelId) => order[modelId] ?? null,
    },
  );
  assert.deepEqual(options.map((option) => option.value), ['auto', 'zeta', 'gamma', 'Alpha', 'beta']);
});

test('the sort key and the collision check ignore the window suffix', () => {
  const options = normalizeModelSelectorOptions(
    ['b-model', 'a-model', 'claude-fable-5-1', 'claude-fable-5-1-20251103'],
    {
      labelFor: humanizeModelLabel,
      // Suffixes chosen so sorting on the annotated label would flip a/b.
      suffixFor: (modelId) => (modelId === 'a-model' ? ' · 999K' : ' · 1K'),
    },
  );
  assert.deepEqual(options.map((option) => option.value), [
    'auto', 'a-model', 'b-model', 'claude-fable-5-1', 'claude-fable-5-1-20251103',
  ]);
  const byValue = Object.fromEntries(options.map((option) => [option.value, option.label]));
  assert.equal(byValue['a-model'], 'a-model · 999K');
  assert.equal(byValue['auto'], 'auto', 'Auto never carries a window');
  assert.equal(byValue['claude-fable-5-1'], 'claude-fable-5-1 · 1K', 'colliding labels fall back to the id but keep the window');
});

test('buildCatalogModelOptions: canonical Copilot order, display names, window annotation', () => {
  const options = buildCatalogModelOptions(
    ['claude-fable-5-1', 'gemini-3.6-flash', 'claude-haiku-4-5', 'gpt-5.6-terra', 'auto', 'gpt-5.4-mini', 'claude-opus-4-8-fast'],
    { metadataByModel: CATALOG_METADATA },
  );
  assert.deepEqual(options, [
    { value: 'auto', label: 'Auto' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini · 400K' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · 1.05M' },
    { value: 'claude-opus-4-8-fast', label: 'Claude Opus 4.8 (fast mode) · 200K' },
    { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash · 1M' },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 · 144K' },
    // No catalogIndex and no displayName: humanized, unannotated, after the indexed rows.
    { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  ]);
});

test('both pickers render the identical list from the same catalog', () => {
  const catalogModels = ['gemini-3.6-flash', 'claude-haiku-4-5', 'gpt-5.6-terra', 'auto', 'gpt-5.4-mini'];
  // The composer normalizes the catalog once into state, then rebuilds per
  // provider from that stored list; the modal builds straight from the catalog.
  const composerStateModels = buildCatalogModelOptions(catalogModels, { metadataByModel: CATALOG_METADATA })
    .map((option) => option.value);
  const composer = buildCatalogModelOptions(composerStateModels, { metadataByModel: CATALOG_METADATA });
  const modal = buildCatalogModelOptions([...catalogModels].reverse(), { metadataByModel: CATALOG_METADATA });
  assert.deepEqual(modal, composer);
  assert.equal(modelSelectorOptionsEqual(composer, modal), true);
});

test('the Claude SDK picker keeps display names but drops the (Copilot) window', () => {
  const options = buildCatalogModelOptions(['claude-haiku-4-5'], {
    metadataByModel: CATALOG_METADATA,
    annotateContextWindow: false,
  });
  assert.deepEqual(options, [
    { value: 'auto', label: 'Auto' },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ]);
});

test('catalog helpers: display name fallback, variant tails, order, suffix, case', () => {
  assert.equal(catalogModelLabel('gpt-5.4-mini', CATALOG_METADATA), 'GPT-5.4 mini');
  assert.equal(catalogModelLabel('gpt-5.4-mini-high', CATALOG_METADATA), 'GPT-5.4 mini (high)', 'variant ids keep the effort tail');
  assert.equal(catalogModelLabel('gpt-5.4-mini-minimal', CATALOG_METADATA), 'GPT-5.4 mini (minimal)');
  assert.equal(catalogModelLabel('claude-fable-5-1', CATALOG_METADATA), 'Fable 5.1', 'null displayName humanizes');
  assert.equal(catalogModelLabel('grok-4', CATALOG_METADATA), 'grok-4', 'unknown model passes through');
  assert.equal(catalogModelLabel('auto', CATALOG_METADATA), 'Auto');
  assert.equal(catalogModelLabel('AUTO', {}), 'Auto');
  assert.equal(catalogOrderFor('gpt-5.6-terra', CATALOG_METADATA), 2);
  assert.equal(catalogOrderFor('claude-fable-5-1', CATALOG_METADATA), null);
  assert.equal(catalogOrderFor('missing', CATALOG_METADATA), null);
  assert.equal(contextWindowSuffix('gpt-5.4-mini', CATALOG_METADATA), ' · 400K', 'real window beats the derived limit');
  assert.equal(contextWindowSuffix('claude-fable-5-1', CATALOG_METADATA), '');
  assert.equal(contextWindowSuffix('claude-haiku-4-5', { 'claude-haiku-4-5': { defaultContextLimitTokens: 144000 } }), ' · 144K', 'derived limit is the fallback');
  assert.equal(modelMetadataFor('GPT-5.4-Mini', CATALOG_METADATA)?.displayName, 'GPT-5.4 mini', 'case-insensitive lookup');
  assert.equal(modelMetadataFor('', CATALOG_METADATA), null);
  assert.deepEqual(splitModelVariantId('gpt-5.4-mini-xhigh'), { baseModelId: 'gpt-5.4-mini', reasoningEffort: 'xhigh' });
  assert.deepEqual(splitModelVariantId('gemini-3.6-flash'), { baseModelId: 'gemini-3.6-flash', reasoningEffort: null });
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

test('the composer placeholder follows the model family', () => {
  const cases = [
    ['claude-fable-5-1', '', 'Message Claude…'],
    ['claude-sonnet-5', 'cursor', 'Message Claude…'],
    ['grok-4.5', '', 'Message Grok…'],
    ['gpt-5.4-mini', 'github', 'Message GPT…'],
    ['gpt-5.6-luna', 'openai', 'Message GPT…'],
    ['gemini-3.5-flash', 'github', 'Message Gemini…'],
    ['composer-2.5', 'cursor', 'Message Cursor…'],
    ['claude-opus-5[1m]', 'claude', 'Message Claude…'],
  ];
  for (const [modelId, providerType, expected] of cases) {
    assert.equal(composerPlaceholderFor({ modelId, providerType }), expected, `${modelId} (${providerType})`);
  }
});

test('Auto and unknown models fall back to the bound provider', () => {
  assert.equal(composerPlaceholderFor({ modelId: 'auto', providerType: 'claude' }), 'Message Claude…');
  assert.equal(composerPlaceholderFor({ modelId: '', providerType: 'claude-cloud' }), 'Message Claude…');
  assert.equal(composerPlaceholderFor({ modelId: 'auto', providerType: 'grok' }), 'Message Grok…');
  assert.equal(composerPlaceholderFor({ modelId: 'auto', providerType: 'openai' }), 'Message OpenAI…');
  assert.equal(composerPlaceholderFor({ modelId: 'auto', providerType: 'cursor' }), 'Message Cursor…');
  assert.equal(composerPlaceholderFor({ modelId: 'auto', providerType: 'github' }), 'Message Copilot…');
  assert.equal(composerPlaceholderFor({ modelId: '', providerType: '' }), 'Message Copilot…');
  assert.equal(composerPlaceholderFor({ modelId: 'my-custom-endpoint-model', providerType: 'openai' }), 'Message OpenAI…');
  assert.equal(composerPlaceholderFor({ modelId: 'my-custom-endpoint-model', providerType: 'github' }), 'Message Copilot…');
  assert.equal(composerPlaceholderFor(), 'Message Copilot…');
});
