import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPollingLoop,
  processSdkSessionDeleteRequest,
  resolveEmptyFinalTextHandling,
  shouldUseDirectOpenAIImageApi,
} from './polling-loop.mjs';
import { createSessionIoHelpers } from '../runtime/session-io.mjs';

test('resolveEmptyFinalTextHandling treats generated images as successful completion', () => {
  const outcome = resolveEmptyFinalTextHandling({
    lastStreamedSent: '',
    lastActivityText: '',
    hasGeneratedImages: true,
  });
  assert.equal(outcome.action, 'publish_generated_images_only');
});

test('direct OpenAI image execution supports all editable image model families', () => {
  for (const model of ['gpt-image-1', 'gpt-image-2', 'dall-e-3']) {
    assert.equal(shouldUseDirectOpenAIImageApi({
      providerType: 'openai',
      providerModel: model,
    }), true);
  }
  assert.equal(shouldUseDirectOpenAIImageApi({
    providerType: 'openai',
    providerModel: 'gpt-5.4-mini',
  }), false);
});

test('session-io extracts generated images from response envelope payloads', () => {
  const helpers = createSessionIoHelpers({
    getSession: () => null,
    sleep: async () => {},
    dbg: () => {},
  });
  const images = helpers.extractGeneratedImages({
    data: {
      output: [
        {
          type: 'image_generation_call',
          mime_type: 'image/png',
          b64_json: 'aGVsbG8=',
          name: 'draft',
        },
      ],
    },
  });
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, 'image/png');
  assert.equal(images[0].name, 'draft');
});

test('session-io ignores non-string generated image payload fields', () => {
  const helpers = createSessionIoHelpers({
    getSession: () => null,
    sleep: async () => {},
    dbg: () => {},
  });
  const images = helpers.extractGeneratedImages({
    data: {
      output: [
        {
          type: 'image_generation_call',
          mime_type: 'image/png',
          b64_json: { malformed: true },
          data: { also: 'invalid' },
          name: 'draft',
        },
      ],
    },
  });
  assert.equal(images.length, 0);
});

test('session-io keeps same-prefix same-length generated images when tails differ', () => {
  const helpers = createSessionIoHelpers({
    getSession: () => null,
    sleep: async () => {},
    dbg: () => {},
  });
  const sharedPrefix = 'A'.repeat(64);
  const first = `${sharedPrefix}1111`;
  const second = `${sharedPrefix}2222`;
  const images = helpers.extractGeneratedImages({
    data: {
      output: [
        { type: 'image_generation_call', mime_type: 'image/png', b64_json: first, name: 'one' },
        { type: 'image_generation_call', mime_type: 'image/png', b64_json: second, name: 'two' },
      ],
    },
  });
  assert.equal(images.length, 2);
  assert.equal(images[0].data, first);
  assert.equal(images[1].data, second);
});

test('unsupported SDK session deletion is finalized without console warning or retry', async () => {
  const apiCalls = [];
  const logCalls = [];
  const handled = await processSdkSessionDeleteRequest({
    request: { sdkSessionId: 'sdk-1', conversationId: 'conv-1' },
    api: async (method, route, body) => {
      apiCalls.push({ method, route, body });
      return { ok: true };
    },
    session: {
      log: async (...args) => { logCalls.push(args); },
    },
  });

  assert.equal(handled, true);
  assert.equal(logCalls.length, 0);
  assert.deepEqual(apiCalls, [{
    method: 'POST',
    route: '/api/sdk-session-delete/result',
    body: {
      sdk_session_id: 'sdk-1',
      conversation_id: 'conv-1',
      ok: false,
      unsupported: true,
      error: 'SDK deleteSession() is unavailable in this CLI runtime',
    },
  }]);
});

test('polling loop uses direct OpenAI image API path and skips SDK send', async () => {
  const apiCalls = [];
  let waiting = false;
  let sendAndWaitCalls = 0;
  const api = async (method, path, body) => {
    apiCalls.push({ method, path, body });
    if (method === 'POST' && path === '/api/openai/images/generate') {
      return {
        ok: true,
        model: 'gpt-image-1',
        endpoint: '/images/generations',
        generatedImages: [
          { data: 'aGVsbG8=', mimeType: 'image/png', name: 'generated-image-1' },
        ],
      };
    }
    if (method === 'POST' && path === '/api/response') return { ok: true };
    return { ok: true };
  };
  const session = { log: async () => {}, abort: async () => {} };
  const loop = createPollingLoop({
    sleep: async () => {},
    pollMs: 1,
    api,
    dbg: () => {},
    session,
    sendTimeout: 1000,
    publishModelSnapshot: async () => {},
    setModelForMessage: async () => ({ switched: false }),
    buildPromptWithRelayContext: async () => '',
    sendAndWaitWithHardTimeout: async () => {
      sendAndWaitCalls += 1;
      return {};
    },
    extractFinalText: () => '',
    extractGeneratedImages: () => [],
    getLastActivityText: () => '',
    getCurrentModelId: async () => '',
    getPreferredConversationSessionMode: () => 'shared',
    getSupportsIsolatedSessions: () => true,
    getWarnedConversationModeFallback: () => false,
    setWarnedConversationModeFallback: () => {},
    getPollingLoopStarted: () => false,
    setPollingLoopStarted: () => {},
    getSessionReady: () => true,
    getWaitingForAI: () => waiting,
    syncActiveSession: async () => true,
    ensureSessionForConversation: async () => ({ ok: true }),
    setActiveMsg: () => {},
    setWaitingForAI: (value) => { waiting = !!value; },
    setRelayTurnActive: () => {},
    setLastActivityText: () => {},
    setLastAskUserBridge: () => {},
    setPendingAskUserRequest: () => {},
    clearRelayScopeState: () => {},
    shouldFetchPending: () => false,
  });

  await loop.handlePendingPayload({
    message: {
      id: 'msg-1',
      conversationId: 'conv-1',
      relayMode: 'agent',
      text: 'generate an icon',
      model: 'gpt-image-1',
      providerType: 'openai',
      providerModel: 'gpt-image-1',
      attachments: [],
      isNewConversation: false,
    },
  }, 'poll');

  assert.equal(sendAndWaitCalls, 0);
  const responseCall = apiCalls.find((entry) => entry.method === 'POST' && entry.path === '/api/response');
  assert.ok(responseCall);
  assert.equal(responseCall.body.text, '');
  assert.equal(responseCall.body.generatedImages.length, 1);
});

test('polling loop treats direct OpenAI image 4xx as terminal response (no requeue)', async () => {
  const apiCalls = [];
  let waiting = false;
  let sendAndWaitCalls = 0;
  const api = async (method, path, body) => {
    apiCalls.push({ method, path, body });
    if (method === 'POST' && path === '/api/openai/images/generate') {
      const error = new Error('HTTP 400 /api/openai/images/generate: bad request');
      error.status = 400;
      error.detail = 'bad request';
      throw error;
    }
    if (method === 'POST' && path === '/api/response') return { ok: true };
    return { ok: true };
  };
  const session = { log: async () => {}, abort: async () => {} };
  const loop = createPollingLoop({
    sleep: async () => {},
    pollMs: 1,
    api,
    dbg: () => {},
    session,
    sendTimeout: 1000,
    publishModelSnapshot: async () => {},
    setModelForMessage: async () => ({ switched: false }),
    buildPromptWithRelayContext: async () => '',
    sendAndWaitWithHardTimeout: async () => {
      sendAndWaitCalls += 1;
      return {};
    },
    extractFinalText: () => '',
    extractGeneratedImages: () => [],
    getLastActivityText: () => '',
    getCurrentModelId: async () => '',
    getPreferredConversationSessionMode: () => 'shared',
    getSupportsIsolatedSessions: () => true,
    getWarnedConversationModeFallback: () => false,
    setWarnedConversationModeFallback: () => {},
    getPollingLoopStarted: () => false,
    setPollingLoopStarted: () => {},
    getSessionReady: () => true,
    getWaitingForAI: () => waiting,
    syncActiveSession: async () => true,
    ensureSessionForConversation: async () => ({ ok: true }),
    setActiveMsg: () => {},
    setWaitingForAI: (value) => { waiting = !!value; },
    setRelayTurnActive: () => {},
    setLastActivityText: () => {},
    setLastAskUserBridge: () => {},
    setPendingAskUserRequest: () => {},
    clearRelayScopeState: () => {},
    shouldFetchPending: () => false,
  });

  await loop.handlePendingPayload({
    message: {
      id: 'msg-1',
      conversationId: 'conv-1',
      relayMode: 'agent',
      text: 'generate an icon',
      model: 'gpt-image-1',
      providerType: 'openai',
      providerModel: 'gpt-image-1',
      attachments: [],
      isNewConversation: false,
    },
  }, 'poll');

  assert.equal(sendAndWaitCalls, 0);
  assert.ok(apiCalls.some((entry) => entry.method === 'POST' && entry.path === '/api/response'));
  assert.equal(apiCalls.some((entry) => entry.method === 'POST' && entry.path === '/api/requeue'), false);
});
