import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildModelCatalogWithOpenAIProvider,
  parseOpenAISettingsUpdateRequest,
  resolveOpenAISessionModel,
  resolveBootstrapModelSelection,
  parseDefaultSessionWorkspaceRootUpdateRequest,
  normalizePreferredReasoningByMode,
} from './sessions-routes.mjs';

test('resolveOpenAISessionModel preserves selected OpenAI models', () => {
  assert.equal(resolveOpenAISessionModel({
    requestedModel: 'gpt-5.4',
    configuredModel: 'gpt-4o',
    availableModels: ['gpt-4o', 'gpt-5.4'],
  }), 'gpt-5.4');
  assert.equal(resolveOpenAISessionModel({
    requestedModel: 'o3-pro',
    configuredModel: 'gpt-4o',
    availableModels: ['gpt-4o', 'o3-pro'],
  }), 'o3-pro');
  assert.equal(resolveOpenAISessionModel({
    requestedModel: 'gpt-github-only',
    configuredModel: 'gpt-4o',
    availableModels: ['gpt-4o'],
  }), 'gpt-4o');
  assert.equal(resolveOpenAISessionModel({
    requestedModel: 'claude-sonnet-4.6',
    configuredModel: 'gpt-4o',
  }), 'gpt-4o');
});

test('parseOpenAISettingsUpdateRequest accepts save and remove requests', () => {
  assert.deepEqual(parseOpenAISettingsUpdateRequest({
    apiKey: 'sk-test',
    model: 'gpt-4o',
  }), {
    ok: true,
    remove: false,
    apiKey: 'sk-test',
    model: 'gpt-4o',
    enabled: true,
  });
  assert.deepEqual(parseOpenAISettingsUpdateRequest({
    remove: true,
    model: 'gpt-4o',
  }), {
    ok: true,
    remove: true,
    apiKey: '',
    model: 'gpt-4o',
    enabled: false,
  });
});

test('buildModelCatalogWithOpenAIProvider prepends configured model without exposing a key', () => {
  const payload = buildModelCatalogWithOpenAIProvider({
    models: ['gpt-5.4-mini'],
    defaultModel: 'gpt-5.4-mini',
    reasoningByModel: {
      'gpt-5.4-mini': ['none'],
      'gpt-5.4': ['none', 'low', 'medium', 'high'],
    },
  }, {
    configured: true,
    enabled: true,
    model: 'gpt-4o',
    models: ['gpt-4o', 'gpt-5.4', 'o3-pro'],
    apiKey: 'sk-secret',
  });
  assert.deepEqual(payload.models, ['gpt-4o', 'gpt-5.4', 'o3-pro', 'gpt-5.4-mini']);
  assert.equal(payload.defaultModel, 'gpt-5.4-mini');
  assert.deepEqual(payload.reasoningByModel['gpt-4o'], ['none']);
  assert.deepEqual(payload.reasoningByModel['gpt-5.4'], ['none', 'low', 'medium', 'high']);
  assert.deepEqual(payload.reasoningByProvider.openai['gpt-5.4'], ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(payload.reasoningByProvider.github['gpt-5.4'], ['none', 'low', 'medium', 'high']);
  assert.deepEqual(payload.reasoningByModel['o3-pro'], ['none']);
  assert.equal(JSON.stringify(payload).includes('sk-secret'), false);
});

test('resolveBootstrapModelSelection prefers requested model when supported', () => {
  const selected = resolveBootstrapModelSelection({
    requestedModel: 'gpt-5.4-mini',
    modelState: { models: ['gpt-5.4-mini', 'claude-4-sonnet'], currentModel: 'claude-4-sonnet' },
    defaultModel: 'gpt-5.4-mini',
  });
  assert.equal(selected, 'gpt-5.4-mini');
});

test('resolveBootstrapModelSelection falls back to current/default model', () => {
  const selectedCurrent = resolveBootstrapModelSelection({
    requestedModel: 'unknown-model',
    modelState: { models: ['gpt-5.4-mini'], currentModel: 'gpt-5.4-mini', defaultModel: 'gpt-5.4-mini' },
    defaultModel: 'gpt-5.4-mini',
  });
  assert.equal(selectedCurrent, 'gpt-5.4-mini');

  const selectedFallback = resolveBootstrapModelSelection({
    requestedModel: '',
    modelState: { models: [] },
    defaultModel: 'gpt-5.4-mini',
  });
  assert.equal(selectedFallback, 'gpt-5.4-mini');
});

test('parseDefaultSessionWorkspaceRootUpdateRequest reads supported body aliases', () => {
  const parsed = parseDefaultSessionWorkspaceRootUpdateRequest({
    default_session_workspace_root_path: 'C:\\dev\\project',
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.clearRequested, false);
  assert.equal(parsed.rootPath, 'C:\\dev\\project');
});

test('parseDefaultSessionWorkspaceRootUpdateRequest supports explicit clear', () => {
  const parsed = parseDefaultSessionWorkspaceRootUpdateRequest({ clear: true });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.clearRequested, true);
  assert.equal(parsed.rootPath, '');
});

test('parseDefaultSessionWorkspaceRootUpdateRequest rejects missing payload value', () => {
  const parsed = parseDefaultSessionWorkspaceRootUpdateRequest({});
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'Missing rootPath');
});

test('normalizePreferredReasoningByMode keeps only supported relay modes', () => {
  assert.deepEqual(
    normalizePreferredReasoningByMode({
      agent: 'HIGH',
      plan: 'low',
      unknown: 'medium',
    }, {
      supportedRelayModes: ['plan', 'agent'],
    }),
    {
      plan: 'low',
      agent: 'high',
    },
  );
});
