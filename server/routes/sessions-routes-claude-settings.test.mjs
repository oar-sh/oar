import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildModelCatalogWithClaudeProvider,
  buildModelCatalogWithOpenAIProvider,
  parseClaudeSettingsUpdateRequest,
  buildConversationMessages,
} from './sessions-routes.mjs';

test('parseClaudeSettingsUpdateRequest requires at least one field', () => {
  assert.equal(parseClaudeSettingsUpdateRequest({}).ok, false);
  assert.equal(parseClaudeSettingsUpdateRequest({ enabled: true }).ok, true);
  assert.equal(parseClaudeSettingsUpdateRequest({ model: 'claude-sonnet-5' }).ok, true);
  assert.equal(parseClaudeSettingsUpdateRequest({ models: ['claude-opus-5'] }).ok, true);
});

test('parseClaudeSettingsUpdateRequest rejects unsafe model ids', () => {
  const result = parseClaudeSettingsUpdateRequest({ model: 'bad model !!' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid Claude model ID/);
});

test('parseClaudeSettingsUpdateRequest accepts bracketed capability variants', () => {
  const result = parseClaudeSettingsUpdateRequest({ model: 'claude-opus-5[1m]' });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'claude-opus-5[1m]');
});

test('parseClaudeSettingsUpdateRequest accepts an enabledModels selection', () => {
  const result = parseClaudeSettingsUpdateRequest({ enabledModels: ['claude-sonnet-5', 'claude-opus-5[1m]'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.enabledModels, ['claude-sonnet-5', 'claude-opus-5[1m]']);
});

test('claude catalog is unchanged when the provider is disabled', () => {
  const base = { models: ['gpt-5.4-mini'], providersByModel: {}, reasoningByModel: {} };
  const result = buildModelCatalogWithClaudeProvider(base, { enabled: false, model: 'claude-sonnet-5' });
  assert.deepEqual(result.models, ['gpt-5.4-mini']);
  assert.deepEqual(result.providersByModel, {});
});

test('claude catalog appends models with the claude provider id', () => {
  const base = {
    models: ['auto', 'gpt-5.4-mini'],
    providersByModel: { 'gpt-5.4-mini': ['github-copilot'] },
    reasoningByModel: { 'gpt-5.4-mini': ['medium'] },
    reasoningByProvider: { github: { 'gpt-5.4-mini': ['medium'] } },
    modelMetadataByModel: {},
  };
  const result = buildModelCatalogWithClaudeProvider(base, {
    enabled: true,
    model: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-opus-5'],
  });
  assert.ok(result.models.includes('claude-sonnet-5'));
  assert.ok(result.models.includes('claude-opus-5'));
  assert.deepEqual(result.providersByModel['claude-sonnet-5'], ['claude']);
  assert.deepEqual(result.providersByModel['claude-opus-5'], ['claude']);
  assert.equal(result.modelMetadataByModel['claude-sonnet-5'].provider, 'claude');
  // Without discovered effort metadata every level is offered; the SDK
  // silently downgrades unsupported ones.
  assert.deepEqual(
    result.reasoningByProvider.claude['claude-sonnet-5'],
    ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  );
  // Existing entries untouched.
  assert.deepEqual(result.providersByModel['gpt-5.4-mini'], ['github-copilot']);
  assert.deepEqual(result.reasoningByProvider.github, { 'gpt-5.4-mini': ['medium'] });
});

test('claude catalog uses discovered per-model effort levels', () => {
  const base = { models: [], providersByModel: {}, reasoningByModel: {}, modelMetadataByModel: {} };
  const result = buildModelCatalogWithClaudeProvider(base, {
    enabled: true,
    model: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    effortsByModel: {
      'claude-sonnet-5': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      'claude-haiku-4-5-20251001': ['none', 'low', 'medium', 'high'],
    },
  });
  assert.deepEqual(
    result.reasoningByProvider.claude['claude-sonnet-5'],
    ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.deepEqual(
    result.reasoningByProvider.claude['claude-haiku-4-5-20251001'],
    ['none', 'low', 'medium', 'high'],
  );
  assert.deepEqual(
    result.reasoningByModel['claude-haiku-4-5-20251001'],
    ['none', 'low', 'medium', 'high'],
  );
});

test('claude catalog folds [1m] variants into the base model as a long_context tier', () => {
  const base = { models: [], providersByModel: {}, reasoningByModel: {}, modelMetadataByModel: {} };
  const result = buildModelCatalogWithClaudeProvider(base, {
    enabled: true,
    model: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-5[1m]'],
  });
  assert.ok(result.models.includes('claude-opus-5'));
  assert.ok(!result.models.includes('claude-opus-5[1m]'), '[1m] ids must not be separate composer entries');
  assert.equal(result.providersByModel['claude-opus-5[1m]'], undefined);
  assert.equal(result.modelMetadataByModel['claude-opus-5'].longContextLimitTokens, 1000000);
  assert.equal(result.modelMetadataByModel['claude-opus-5'].defaultContextLimitTokens, 200000);
  // Models without a discovered [1m] variant get no long_context tier.
  assert.equal(result.modelMetadataByModel['claude-sonnet-5'].longContextLimitTokens, undefined);
});

test('claude catalog surfaces the base model when only the [1m] variant is enabled', () => {
  const base = { models: [], providersByModel: {}, reasoningByModel: {}, modelMetadataByModel: {} };
  const result = buildModelCatalogWithClaudeProvider(base, {
    enabled: true,
    model: 'claude-sonnet-5',
    models: ['claude-opus-5[1m]'],
    effortsByModel: {
      'claude-opus-5[1m]': ['none', 'low', 'medium'],
    },
  });
  assert.ok(result.models.includes('claude-opus-5'));
  assert.ok(!result.models.includes('claude-opus-5[1m]'));
  assert.deepEqual(result.providersByModel['claude-opus-5'], ['claude']);
  assert.equal(result.modelMetadataByModel['claude-opus-5'].longContextLimitTokens, 1000000);
  // Effort metadata discovered for the variant applies to the base entry.
  assert.deepEqual(result.reasoningByProvider.claude['claude-opus-5'], ['none', 'low', 'medium']);
});

test('claude catalog composes with the openai catalog', () => {
  const base = {
    models: ['gpt-5.4-mini'],
    providersByModel: {},
    reasoningByModel: {},
    modelMetadataByModel: {},
  };
  const withOpenAI = buildModelCatalogWithOpenAIProvider(base, {
    enabled: true,
    model: 'gpt-4o',
    models: ['gpt-4o'],
  });
  const combined = buildModelCatalogWithClaudeProvider(withOpenAI, {
    enabled: true,
    model: 'claude-sonnet-5',
    models: [],
  });
  assert.ok(combined.models.includes('gpt-4o'));
  assert.ok(combined.models.includes('claude-sonnet-5'));
  assert.deepEqual(combined.providersByModel['claude-sonnet-5'], ['claude']);
  assert.ok(combined.providersByModel['gpt-4o'].includes('openai-byok'));
  assert.ok(combined.reasoningByProvider.openai);
  assert.ok(combined.reasoningByProvider.claude);
});

test('buildConversationMessages attaches per-message subagentRuns', () => {
  const messages = buildConversationMessages({
    dbMessages: [
      { id: 'resp-1', role: 'assistant', text: 'done', timestamp: '2026-07-31T00:00:00Z' },
      { id: 'user-1', role: 'user', text: 'hi', timestamp: '2026-07-30T23:59:00Z' },
    ],
    subagentRunsByMessageId: new Map([
      ['resp-1', [{ subagentRunId: 'run-1', displayName: 'Explore', status: 'completed', parentSubagentId: null }]],
    ]),
  });
  const assistant = messages.find((message) => message.id === 'resp-1');
  assert.ok(assistant);
  assert.equal(assistant.subagentRuns.length, 1);
  assert.equal(assistant.subagentRuns[0].subagentRunId, 'run-1');
  const user = messages.find((message) => message.id === 'user-1');
  assert.deepEqual(user.subagentRuns ?? [], []);
});
