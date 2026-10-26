import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalProviderModelId,
  checkRequestedProviderModel,
  isProviderModelAvailable,
  resolveProviderModelSelection,
  suggestProviderModelIds,
  unknownProviderModelText,
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

// ─── checkRequestedProviderModel (relay_tool create_session / send) ───────

const COPILOT_MODELS = ['gpt-5.4', 'gpt-5.4-mini', 'claude-sonnet-5', 'gpt-5.6-luna'];
const CLAUDE_MODELS = ['claude-opus-4-7', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

test('a mistyped id is unknown, with the same id written with other separators first', () => {
  const check = checkRequestedProviderModel({ requestedModel: 'gpt-5-4', provider: 'github', models: COPILOT_MODELS });
  assert.equal(check.status, 'unknown');
  assert.deepEqual(check.suggestions, ['gpt-5.4', 'gpt-5.4-mini']);
  assert.deepEqual(check.models, COPILOT_MODELS);
  assert.equal(
    unknownProviderModelText({ ...check, provider: 'github' }),
    'Unknown model \'gpt-5-4\' for Copilot; did you mean \'gpt-5.4\' or \'gpt-5.4-mini\'? Valid ids: gpt-5.4, gpt-5.4-mini, claude-sonnet-5, gpt-5.6-luna.',
  );
});

test('suggestions: a few edits away, or containing what was asked; nothing far off', () => {
  assert.deepEqual(suggestProviderModelIds('claude-sonet-5', CLAUDE_MODELS), ['claude-sonnet-5']);
  assert.deepEqual(suggestProviderModelIds('GPT-5.6-LUNA', COPILOT_MODELS), ['gpt-5.6-luna']);
  assert.deepEqual(suggestProviderModelIds('luna', COPILOT_MODELS), ['gpt-5.6-luna']);
  assert.deepEqual(suggestProviderModelIds('mistral-large', COPILOT_MODELS), []);
  assert.deepEqual(suggestProviderModelIds('', COPILOT_MODELS), []);
  assert.equal(suggestProviderModelIds('gpt', ['gpt-1', 'gpt-2', 'gpt-3', 'gpt-4']).length, 3, 'at most three');
});

test('listed ids match in any casing; auto and a blank request always pass', () => {
  assert.deepEqual(checkRequestedProviderModel({ requestedModel: 'GPT-5.4', provider: 'github', models: COPILOT_MODELS }), { status: 'known', model: 'gpt-5.4' });
  assert.deepEqual(checkRequestedProviderModel({ requestedModel: 'auto', provider: 'cursor', models: ['composer-2.5'] }), { status: 'known', model: 'auto' });
  assert.deepEqual(checkRequestedProviderModel({ requestedModel: '', provider: 'cursor', models: ['composer-2.5'] }), { status: 'known', model: '' });
  // The default model counts as listed.
  assert.deepEqual(checkRequestedProviderModel({ requestedModel: 'grok-4.5', provider: 'grok', models: ['grok-code'], defaultModel: 'grok-4.5' }), { status: 'known', model: 'grok-4.5' });
});

// As Claude's model discovery lists them: "[1m]" ids beside their bases,
// dated ids, and a default that is a long-context id.
const DISCOVERED_CLAUDE = [
  'claude-opus-5[1m]',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-sonnet-5',
  'claude-sonnet-5[1m]',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
];

test('Claude: an alias is the newest of its family by version, never a "[1m]" id unless asked', () => {
  const check = (requestedModel, extra = {}) => checkRequestedProviderModel({ requestedModel, provider: 'claude', models: DISCOVERED_CLAUDE, ...extra });
  assert.deepEqual(check('opus', { defaultModel: 'claude-opus-5[1m]' }), { status: 'alias', model: 'claude-opus-5-5', tierDropped: false });
  assert.deepEqual(check('Sonnet'), { status: 'alias', model: 'claude-sonnet-5', tierDropped: false });
  assert.deepEqual(check('haiku'), { status: 'alias', model: 'claude-haiku-4-5', tierDropped: false }, 'the undated id of the same version');
  // The tier comes back when it was asked for and is listed, and is reported when it is not.
  assert.deepEqual(check('sonnet[1m]'), { status: 'alias', model: 'claude-sonnet-5[1m]', tierDropped: false });
  assert.deepEqual(check('opus[1m]'), { status: 'alias', model: 'claude-opus-5-5', tierDropped: true });
  // A dated 4.1 is newer than a dated 4.0.
  const older = ['claude-opus-4-20250514', 'claude-opus-4-1-20250805'];
  assert.equal(checkRequestedProviderModel({ requestedModel: 'opus', provider: 'claude', models: older }).model, 'claude-opus-4-1-20250805');
  assert.equal(check('fable').status, 'unknown', 'no family of that name listed');
  // A family listed only as "[1m]" ids resolves to those.
  assert.deepEqual(
    checkRequestedProviderModel({ requestedModel: 'opus', provider: 'claude', models: ['claude-opus-5[1m]', 'claude-sonnet-5'] }),
    { status: 'alias', model: 'claude-opus-5[1m]', tierDropped: false },
  );
  assert.deepEqual(checkRequestedProviderModel({ requestedModel: 'opus', provider: 'claude-cloud', models: ['claude-opus-5'] }), { status: 'alias', model: 'claude-opus-5', tierDropped: false });
  // Claude API runs Claude's models on a key: the same aliases and "[1m]" rule.
  assert.deepEqual(checkRequestedProviderModel({ requestedModel: 'opus', provider: 'claude-api', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }), { status: 'alias', model: 'claude-opus-5-5', tierDropped: false });
  assert.deepEqual(checkRequestedProviderModel({ requestedModel: 'claude-sonnet-5-5[1m]', provider: 'claude-api', models: ['claude-sonnet-5-5'] }), { status: 'known', model: 'claude-sonnet-5-5', tierDropped: true });
  assert.equal(checkRequestedProviderModel({ requestedModel: 'opus', provider: 'cursor', models: ['claude-opus-5'] }).status, 'unknown', 'an alias only for Claude');
});

test('Claude: a "[1m]" id is taken as listed, else as its listed base with the tier dropped', () => {
  const check = (requestedModel, models) => checkRequestedProviderModel({ requestedModel, provider: 'claude', models });
  assert.deepEqual(check('claude-opus-5[1m]', DISCOVERED_CLAUDE), { status: 'known', model: 'claude-opus-5[1m]' });
  assert.deepEqual(check('claude-opus-5-5[1m]', DISCOVERED_CLAUDE), { status: 'known', model: 'claude-opus-5-5', tierDropped: true });
});

test('Copilot takes a listed model with an effort it lists in the id, handing base and effort apart; other providers do not', () => {
  const effortsFor = (base) => ({ 'gpt-5.4': ['low', 'medium', 'high'], 'gpt-5.1-codex': ['low', 'medium', 'high'] })[base] || null;
  assert.deepEqual(
    checkRequestedProviderModel({ requestedModel: 'GPT-5.4-High', provider: 'github', models: COPILOT_MODELS, effortsFor }),
    { status: 'known', model: 'gpt-5.4-high', base: 'gpt-5.4', effort: 'high' },
  );
  // A model of its own that ends like an effort is not its base at that effort.
  const codexMax = checkRequestedProviderModel({ requestedModel: 'gpt-5.1-codex-max', provider: 'github', models: ['gpt-5.1-codex', 'gpt-5.4'], effortsFor });
  assert.equal(codexMax.status, 'unknown');
  assert.equal(codexMax.suggestions[0], 'gpt-5.1-codex', 'the base is suggested');
  // No efforts known for the base: no split either.
  const claudeHigh = checkRequestedProviderModel({ requestedModel: 'claude-sonnet-5-high', provider: 'github', models: COPILOT_MODELS, effortsFor });
  assert.equal(claudeHigh.status, 'unknown');
  assert.equal(claudeHigh.suggestions[0], 'claude-sonnet-5');
  assert.equal(checkRequestedProviderModel({ requestedModel: 'gpt-5.4-high', provider: 'github', models: COPILOT_MODELS }).status, 'unknown', 'without effort data');
  assert.equal(checkRequestedProviderModel({ requestedModel: 'composer-2.5-high', provider: 'cursor', models: ['composer-2.5'] }).status, 'unknown');
  const variant = checkRequestedProviderModel({ requestedModel: 'gpt-5-4-high', provider: 'github', models: COPILOT_MODELS });
  assert.equal(variant.status, 'unknown');
  assert.equal(variant.suggestions[0], 'gpt-5.4', 'suggested from the id without its effort');
});

test('"auto" alone is no list: before discovery a Copilot model is unchecked, not refused', () => {
  assert.deepEqual(checkRequestedProviderModel({ requestedModel: 'gpt-5.4', provider: 'github', models: ['auto'] }), { status: 'unchecked', model: 'gpt-5.4' });
  const refused = checkRequestedProviderModel({ requestedModel: 'gpt-5-4', provider: 'github', models: ['auto', 'gpt-5.4'] });
  assert.deepEqual(refused.models, ['gpt-5.4'], 'auto is never listed as a valid id');
});

test('no suggestion for a stub: a single letter or two is no typo of anything', () => {
  assert.deepEqual(suggestProviderModelIds('x', ['o3', 'o4-mini']), []);
  assert.deepEqual(suggestProviderModelIds('o5', ['o3', 'o4-mini']), []);
});

test('without a list (not loaded, not answered) the model is unchecked, never refused', () => {
  for (const models of [null, undefined, [], ['', '  ']]) {
    assert.deepEqual(checkRequestedProviderModel({ requestedModel: 'gpt-5-4', provider: 'github', models }), { status: 'unchecked', model: 'gpt-5-4' });
  }
});

test('the refusal lists at most twenty ids and counts the rest', () => {
  const models = Array.from({ length: 23 }, (_, index) => `model-${index}`);
  const text = unknownProviderModelText({ model: 'x', provider: 'openai', suggestions: [], models, where: 'on relay "lab"' });
  assert.match(text, /^Unknown model 'x' for OpenAI on relay "lab"\. Valid ids: model-0, .*model-19 \(and 3 more\)\.$/);
});
