import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelSwitchingService, extractModelDescriptors } from './model-switching.mjs';

test('extractModelDescriptors keeps context limits from model RPC descriptors', () => {
  const descriptors = extractModelDescriptors({
    models: [
      { modelId: 'gpt-5.6-terra', capabilities: { limits: { max_context_window_tokens: 1050000, max_output_tokens: 16000 } }, billing: { tokenPrices: { batchSize: 1000000, maxPromptTokens: 312000, inputPrice: 100, outputPrice: 600, cacheReadPrice: 10, cacheWritePrice: 125, longContext: { maxPromptTokens: 1084000, inputPrice: 200, outputPrice: 1200 } } } },
      { id: 'claude-sonnet-4.6', capabilities: { maxContextTokens: '200000' } },
      { model: 'gemini-3.5-flash' },
      { modelId: 'not-a-model', contextWindow: 42 },
    ],
  });

  assert.deepEqual(descriptors, [
    { modelId: 'gpt-5.6-terra', contextLimitTokens: 328000, longContextLimitTokens: 1100000, pricing: { default: { input: 100, output: 600, cacheRead: 10, cacheWrite: 125, batchSize: 1000000 }, longContext: { input: 200, output: 1200, cacheRead: null, cacheWrite: null, batchSize: 1000000 } } },
    { modelId: 'claude-sonnet-4.6', contextLimitTokens: 200000, longContextLimitTokens: null, pricing: { default: null, longContext: null } },
    { modelId: 'gemini-3.5-flash', contextLimitTokens: null, longContextLimitTokens: null, pricing: { default: null, longContext: null } },
  ]);
});

test('createModelSwitchingService prefers models.list metadata over fallback session lists', async () => {
  const richModelsPayload = {
    models: [
      {
        id: 'gpt-5.6-luna',
        capabilities: { limits: { max_context_window_tokens: 1050000, max_output_tokens: 16000 } },
        billing: {
          tokenPrices: {
            batchSize: 1000000,
            maxPromptTokens: 312000,
            inputPrice: 100,
            outputPrice: 600,
            longContext: { maxPromptTokens: 1084000, inputPrice: 200, outputPrice: 1200 },
          },
        },
      },
    ],
  };
  const lowFidelityPayload = {
    list: [
      {
        id: 'gpt-5.6-luna',
        capabilities: { limits: { max_context_window_tokens: 1050000 } },
      },
    ],
  };
  const session = {
    connection: {
      sendRequest: async (method) => {
        if (method === 'models.list') return richModelsPayload;
        throw new Error(`Unexpected method ${method}`);
      },
    },
    rpc: {
      model: {
        list: async () => lowFidelityPayload,
      },
    },
  };
  const service = createModelSwitchingService({
    api: async () => ({}),
    dbg: () => {},
    getSession: () => session,
    modelSnapshotMinIntervalMs: 0,
  });

  const models = await service.getAvailableModels();
  assert.deepEqual(models, [
    {
      modelId: 'gpt-5.6-luna',
      contextLimitTokens: 328000,
      longContextLimitTokens: 1100000,
      pricing: {
        default: { input: 100, output: 600, cacheRead: null, cacheWrite: null, batchSize: 1000000 },
        longContext: { input: 200, output: 1200, cacheRead: null, cacheWrite: null, batchSize: 1000000 },
      },
    },
  ]);
});

test('createModelSwitchingService does not treat Auto as an SDK model switch target', async () => {
  const service = createModelSwitchingService({
    api: async () => ({}),
    dbg: () => {},
    getSession: () => ({
      rpc: { model: { getCurrent: async () => ({ modelId: 'gpt-5.6-luna' }) } },
    }),
  });

  assert.deepEqual(
    await service.setModelForMessage('auto'),
    {
      requested: 'auto',
      current: 'gpt-5.6-luna',
      switched: false,
      requiresSessionBoundary: true,
      error: 'Auto model selection is only available when a new SDK session is created',
    },
  );
});

test('createModelSwitchingService accepts the model returned by switchTo', async () => {
  const switchCalls = [];
  const service = createModelSwitchingService({
    api: async () => ({}),
    dbg: () => {},
    getSession: () => ({
      rpc: {
        model: {
          getCurrent: async () => ({ modelId: 'gpt-5.6-sol' }),
          list: async () => ({ models: [{ modelId: 'gpt-5.6-terra' }] }),
          switchTo: async (request) => {
            switchCalls.push(request);
            return { modelId: 'gpt-5.6-terra' };
          },
        },
      },
    }),
    modelSwitchConfirmDelayMs: 0,
  });

  const result = await service.setModelForMessage('gpt-5.6-terra');

  assert.equal(result.switched, true);
  assert.equal(result.after, 'gpt-5.6-terra');
  assert.equal(result.confirmationPending, undefined);
  assert.deepEqual(switchCalls, [{ modelId: 'gpt-5.6-terra', contextTier: 'default' }]);
});

test('createModelSwitchingService confirms a void switch result after a delayed current-model update', async () => {
  let currentReads = 0;
  let switchCalls = 0;
  const service = createModelSwitchingService({
    api: async () => ({}),
    dbg: () => {},
    getSession: () => ({
      rpc: {
        model: {
          getCurrent: async () => {
            currentReads += 1;
            return { modelId: currentReads >= 3 ? 'gpt-5.6-terra' : 'gpt-5.6-sol' };
          },
          list: async () => ({ models: [{ modelId: 'gpt-5.6-terra' }] }),
          switchTo: async () => {
            switchCalls += 1;
            return undefined;
          },
        },
      },
    }),
    modelSwitchConfirmAttempts: 3,
    modelSwitchConfirmDelayMs: 0,
    sleep: async () => {},
  });

  const result = await service.setModelForMessage('gpt-5.6-terra');

  assert.equal(result.switched, true);
  assert.equal(result.after, 'gpt-5.6-terra');
  assert.equal(result.confirmationPending, undefined);
  assert.equal(switchCalls, 1);
});

test('createModelSwitchingService keeps an accepted void switch pending when getCurrent stays stale', async () => {
  let switchCalls = 0;
  const snapshots = [];
  const session = {
    rpc: {
      model: {
        getCurrent: async () => ({ modelId: 'gpt-5.6-sol' }),
        list: async () => ({ models: [{ modelId: 'gpt-5.6-terra' }] }),
        switchTo: async () => {
          switchCalls += 1;
          return undefined;
        },
      },
    },
  };
  const service = createModelSwitchingService({
    api: async (method, path, payload) => {
      if (path === '/api/models/snapshot') snapshots.push(payload);
      return {};
    },
    dbg: () => {},
    getSession: () => session,
    modelSnapshotMinIntervalMs: 0,
    modelSwitchConfirmAttempts: 2,
    modelSwitchConfirmDelayMs: 0,
    modelSwitchPendingTtlMs: 10_000,
    sleep: async () => {},
  });

  const result = await service.setModelForMessage('gpt-5.6-terra');
  await service.publishModelSnapshot('test', true);

  assert.equal(result.switched, true);
  assert.equal(result.confirmationPending, true);
  assert.equal(result.after, 'gpt-5.6-terra');
  assert.equal(result.observedModel, 'gpt-5.6-sol');
  assert.equal(switchCalls, 1);
  assert.equal(snapshots.at(-1)?.currentModel, 'gpt-5.6-terra');
});

test('createModelSwitchingService does not retry the same model candidate after a mismatch', async () => {
  let switchCalls = 0;
  const service = createModelSwitchingService({
    api: async () => ({}),
    dbg: () => {},
    getSession: () => ({
      rpc: {
        model: {
          getCurrent: async () => ({ modelId: 'gpt-5.6-sol' }),
          list: async () => ({ models: [{ modelId: 'gpt-5.6-terra' }] }),
          switchTo: async () => {
            switchCalls += 1;
            return { modelId: 'gpt-5.6-sol' };
          },
        },
      },
    }),
    modelSwitchConfirmDelayMs: 0,
  });

  const result = await service.setModelForMessage('gpt-5.6-terra');

  assert.equal(result.switched, false);
  assert.equal(switchCalls, 1);
  assert.match(result.error, /returned active=gpt-5\.6-sol/);
});
