// POST /api/openai/images/generate with a stubbed provider: a reply the relay
// cannot process after the provider answered 2xx is flagged relayProcessing,
// so the callers fail the billed row instead of requeueing it; a provider
// error is not.
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerMessagesRoutes } from './messages-routes.mjs';
import { captureRoutes, invokeRoute, makeRouteDeps } from './messages-routes-test-harness.mjs';

const GENERATE = '/api/openai/images/generate';
const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Hh9kAAAAASUVORK5CYII=';
const REQUEST = Object.freeze({
  messageId: 'q-1',
  conversationId: 'conv-1',
  model: 'gpt-image-2',
  prompt: 'a grey concrete panel',
  n: 1,
  size: '1024x1024',
  quality: 'low',
  attachments: [],
});

function generateRoutes() {
  const deps = makeRouteDeps({
    // The relay passes its clock; the processing-failure log line reads it.
    ts: () => '00:00:00.000',
    getOpenAIProviderSettings: () => ({
      configured: true,
      enabled: true,
      apiKey: 'sk-test-key',
      baseUrl: 'http://provider.invalid/v1',
      model: 'gpt-image-2',
      models: [],
    }),
  });
  return captureRoutes(deps, registerMessagesRoutes);
}

/** The provider answers `status` with the raw `text`; the calls are recorded. */
function stubProvider(t, status, text) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('a 2xx reply that is not JSON is flagged as the relay\'s processing failure', async (t) => {
  const calls = stubProvider(t, 200, '{"data":[{"b64_json":"iVBOR');
  const { status, body } = await invokeRoute(generateRoutes(), 'POST', GENERATE, { body: { ...REQUEST } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://provider.invalid/v1/images/generations');
  assert.equal(status, 502);
  assert.equal(body.error, 'OpenAI image API returned invalid JSON');
  assert.equal(body.relayProcessing, true);
});

test('a 2xx reply without usable images is flagged as the relay\'s processing failure', async (t) => {
  stubProvider(t, 200, JSON.stringify({ data: [{ b64_json: 'AB-_' }] }));
  const { status, body } = await invokeRoute(generateRoutes(), 'POST', GENERATE, { body: { ...REQUEST } });

  assert.equal(status, 502);
  assert.match(body.error, /invalid base64/);
  assert.equal(body.relayProcessing, true);
});

test('a provider error with a body that is not JSON stays a provider failure', async (t) => {
  stubProvider(t, 502, '<html>Bad gateway</html>');
  const { status, body } = await invokeRoute(generateRoutes(), 'POST', GENERATE, { body: { ...REQUEST } });

  assert.equal(status, 502);
  assert.equal(body.relayProcessing, undefined);
});

test('a provider error with a JSON body stays a provider failure', async (t) => {
  stubProvider(t, 500, JSON.stringify({ error: { message: 'server_error' } }));
  const { status, body } = await invokeRoute(generateRoutes(), 'POST', GENERATE, { body: { ...REQUEST } });

  assert.equal(status, 502);
  assert.match(body.error, /OpenAI image API failed \(500\): server_error/);
  assert.equal(body.relayProcessing, undefined);
});

test('a good reply comes back as generated images', async (t) => {
  stubProvider(t, 200, JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }] }));
  const { status, body } = await invokeRoute(generateRoutes(), 'POST', GENERATE, { body: { ...REQUEST } });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.generatedImages.length, 1);
  assert.equal(body.generatedImages[0].data, ONE_PIXEL_PNG_BASE64);
});
