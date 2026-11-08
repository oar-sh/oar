// POST /api/openai/images/generate with a stubbed provider: every option
// goes out per model family, all input images go to the edit, the reply's
// type, pixel size and usage come back, each request has its own timeout, a
// remote agent's prompt header never reaches OpenAI, and the route answers
// this machine only. A reply the relay cannot process after the provider
// answered 2xx is flagged relayProcessing, so the callers fail the billed
// row instead of requeueing it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenAIImageRequestFields, registerMessagesRoutes } from './messages-routes.mjs';
import { createLocalRequestCheck } from '../services/request-boundary.mjs';
import {
  FAKE_OPENAI_BASE_URL,
  captureRoutes,
  invokeRoute,
  makeRouteDeps,
  stubImageFetch,
} from './messages-routes-test-harness.mjs';

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

// A WebP header (VP8X) of 1536x1024, enough for the header reader.
function webpBase64(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes.toString('base64');
}

let messageCounter = 0;
function nextRequest(overrides = {}) {
  messageCounter += 1;
  return { ...REQUEST, messageId: `q-gen-${messageCounter}`, ...overrides };
}

function generateRoutes({ config = {}, isTrulyLocalRequest = () => true } = {}) {
  const deps = makeRouteDeps({
    // The relay passes its clock; the processing-failure log line reads it.
    ts: () => '00:00:00.000',
    config,
    isTrulyLocalRequest,
    openAIImageRetryDelayMs: 0,
    MAX_UPLOAD_ATTACHMENTS: 6,
    getOpenAIProviderSettings: () => ({
      configured: true,
      enabled: true,
      apiKey: 'sk-test-key',
      baseUrl: FAKE_OPENAI_BASE_URL,
      model: 'gpt-image-2',
      models: [],
    }),
  });
  return captureRoutes(deps, registerMessagesRoutes);
}

const okReply = (extra = {}) => ({ status: 200, json: { data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }], ...extra } });

test('a 2xx reply that is not JSON is flagged as the relay\'s processing failure', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ status: 200, text: '{"data":[{"b64_json":"iVBOR' }] });
  const { status, body } = await invokeRoute(generateRoutes(), 'POST', GENERATE, { body: nextRequest() });

  assert.equal(calls.openai.length, 1);
  assert.equal(calls.openai[0].path, '/images/generations');
  assert.equal(status, 502);
  assert.match(body.error, /could not process the image OpenAI returned \(OpenAI image API returned invalid JSON\)/);
  assert.match(body.error, /The generation was billed; the message was not retried\./);
  assert.equal(body.relayProcessing, true);
});

test('a 2xx reply without usable images is flagged as the relay\'s processing failure', async (t) => {
  stubImageFetch(t, { openai: [{ status: 200, json: { data: [{ b64_json: 'AB-_' }] } }] });
  const { status, body } = await invokeRoute(generateRoutes(), 'POST', GENERATE, { body: nextRequest() });

  assert.equal(status, 502);
  assert.match(body.error, /invalid base64/);
  assert.equal(body.relayProcessing, true);
});

test('a provider refusal carries OpenAI\'s message and is not a processing failure', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ status: 400, json: { error: { message: 'Invalid size for this model' } } }] });
  const { status, body } = await invokeRoute(generateRoutes(), 'POST', GENERATE, { body: nextRequest() });

  assert.equal(calls.openai.length, 1);
  assert.equal(status, 400);
  assert.equal(body.error, 'OpenAI refused the image request (400): Invalid size for this model.');
  assert.equal(body.code, 'IMAGE_PROVIDER_REJECTED');
  assert.equal(body.outcome, 'terminal');
  assert.equal(body.relayProcessing, undefined);
  // No key and no headers in the note.
  assert.doesNotMatch(body.error, /sk-test-key|Bearer/);
});

test('a good reply comes back as generated images with OpenAI\'s usage', async (t) => {
  const usage = {
    input_tokens: 50,
    output_tokens: 4160,
    total_tokens: 4210,
    input_tokens_details: { text_tokens: 50, image_tokens: 0 },
    note: 'ignored',
  };
  stubImageFetch(t, { openai: [okReply({ usage })] });
  const { status, body } = await invokeRoute(generateRoutes(), 'POST', GENERATE, { body: nextRequest() });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.generatedImages.length, 1);
  assert.equal(body.generatedImages[0].data, ONE_PIXEL_PNG_BASE64);
  assert.equal(body.generatedImages[0].mimeType, 'image/png');
  assert.deepEqual(body.usage, {
    input_tokens: 50,
    output_tokens: 4160,
    total_tokens: 4210,
    input_tokens_details: { text_tokens: 50, image_tokens: 0 },
  });
});

test('a gpt-image request carries count, size, quality, output format and background', async (t) => {
  const calls = stubImageFetch(t, { openai: [okReply()] });
  const { status } = await invokeRoute(generateRoutes(), 'POST', GENERATE, {
    body: nextRequest({ n: 3, size: '1536x1024', quality: 'high', output_format: 'webp', background: 'transparent' }),
  });

  assert.equal(status, 200);
  const sent = JSON.parse(calls.openai[0].init.body);
  assert.deepEqual(sent, {
    model: 'gpt-image-2',
    prompt: 'a grey concrete panel',
    n: 3,
    size: '1536x1024',
    quality: 'high',
    output_format: 'webp',
    background: 'transparent',
    // gpt-image streams its partial previews.
    stream: true,
    partial_images: 2,
  });
  assert.equal(calls.openai[0].init.headers.Authorization, 'Bearer sk-test-key');
  assert.match(calls.openai[0].init.headers['Idempotency-Key'], /^oar-image-q-gen-/);
  assert.ok(calls.openai[0].init.signal instanceof AbortSignal);
});

test('a dall-e request gets no output format or background, and "auto" is left to the API', async (t) => {
  assert.deepEqual(
    buildOpenAIImageRequestFields({ model: 'dall-e-3', prompt: 'p', n: 1, size: 'auto', quality: 'auto' }),
    { model: 'dall-e-3', prompt: 'p', response_format: 'b64_json', n: 1 },
  );
  assert.deepEqual(
    buildOpenAIImageRequestFields({ model: 'dall-e-3', prompt: 'p', n: 1, size: '1792x1024', quality: 'hd', output_format: 'png', background: 'opaque' }),
    { model: 'dall-e-3', prompt: 'p', response_format: 'b64_json', n: 1, size: '1792x1024', quality: 'hd' },
  );

  const calls = stubImageFetch(t, { openai: [okReply()] });
  const routes = generateRoutes();
  const sent = await invokeRoute(routes, 'POST', GENERATE, {
    body: nextRequest({ model: 'dall-e-3', n: 1, size: '1024x1792', quality: 'standard' }),
  });
  assert.equal(sent.status, 200);
  assert.deepEqual(JSON.parse(calls.openai[0].init.body), {
    model: 'dall-e-3',
    prompt: 'a grey concrete panel',
    response_format: 'b64_json',
    n: 1,
    size: '1024x1792',
    quality: 'standard',
  });

  // Checked against the family before anything is sent.
  for (const wrong of [{ output_format: 'webp' }, { n: 2 }, { size: '1536x1024' }, { quality: 'low' }]) {
    const refused = await invokeRoute(routes, 'POST', GENERATE, { body: nextRequest({ model: 'dall-e-3', ...wrong }) });
    assert.equal(refused.status, 400, JSON.stringify(wrong));
    assert.equal(refused.body.code, 'IMAGE_REQUEST_INVALID');
  }
  assert.equal(calls.openai.length, 1);
});

test('the composer\'s legacy size values mean "auto"', async (t) => {
  const calls = stubImageFetch(t, { openai: [okReply()] });
  await invokeRoute(generateRoutes(), 'POST', GENERATE, { body: nextRequest({ size: 'long_context' }) });
  assert.equal(JSON.parse(calls.openai[0].init.body).size, 'auto');
});

test('every attached image goes to the edit as image[], in order', async (t) => {
  const calls = stubImageFetch(t, { openai: [okReply()] });
  const attachments = ['base.png', 'texture.png', 'logo.png'].map((name) => ({
    name,
    type: 'image/png',
    dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
  }));
  const { status } = await invokeRoute(generateRoutes(), 'POST', GENERATE, {
    body: nextRequest({ attachments, n: 2, output_format: 'jpeg', background: 'opaque' }),
  });

  assert.equal(status, 200);
  assert.equal(calls.openai[0].path, '/images/edits');
  const form = calls.openai[0].init.body;
  assert.ok(form instanceof FormData);
  assert.deepEqual(form.getAll('image[]').map((file) => file.name), ['base.png', 'texture.png', 'logo.png']);
  assert.equal(form.get('image'), null);
  assert.equal(form.get('n'), '2');
  assert.equal(form.get('output_format'), 'jpeg');
  assert.equal(form.get('background'), 'opaque');
  assert.equal(form.get('stream'), 'true');
  assert.equal(form.get('partial_images'), '2');
  assert.equal(form.get('response_format'), null);
  assert.equal(calls.openai[0].init.headers['Content-Type'], undefined);
});

test('the type of a generated image follows the format asked for, and its own header wins', async (t) => {
  const cases = [
    // [output_format, b64 of the reply, expected type]
    ['webp', webpBase64(1536, 1024), 'image/webp'],
    // Asked for JPEG, got PNG bytes: the bytes win.
    ['jpeg', ONE_PIXEL_PNG_BASE64, 'image/png'],
    // Bytes the reader does not know: the format asked for.
    ['webp', Buffer.from('not an image header').toString('base64'), 'image/webp'],
    [undefined, Buffer.from('not an image header').toString('base64'), 'image/png'],
  ];
  for (const [outputFormat, data, expected] of cases) {
    stubImageFetch(t, { openai: [{ status: 200, json: { data: [{ b64_json: data }] } }] });
    const { body } = await invokeRoute(generateRoutes(), 'POST', GENERATE, {
      body: nextRequest(outputFormat ? { output_format: outputFormat } : {}),
    });
    assert.equal(body.generatedImages[0].mimeType, expected, `${outputFormat}`);
  }
});

test('a remote agent\'s prompt header never reaches OpenAI', async (t) => {
  const calls = stubImageFetch(t, { openai: [okReply()] });
  const prompt = '[Remote prompt from an agent on relay "harbour-lab" · Claude · acting for the user]\n\na lighthouse at dusk';
  await invokeRoute(generateRoutes(), 'POST', GENERATE, { body: nextRequest({ prompt }) });
  assert.equal(JSON.parse(calls.openai[0].init.body).prompt, 'a lighthouse at dusk');
});

test('a caller that is not on this machine is refused before anything is sent', async (t) => {
  const calls = stubImageFetch(t, { openai: [okReply()] });
  const routes = generateRoutes({ isTrulyLocalRequest: createLocalRequestCheck().isTrulyLocal });

  const remote = await invokeRoute(routes, 'POST', GENERATE, { body: nextRequest(), socket: { remoteAddress: '203.0.113.7' } });
  assert.equal(remote.status, 403);
  const tunnelled = await invokeRoute(routes, 'POST', GENERATE, {
    body: nextRequest(),
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '198.51.100.4' },
  });
  assert.equal(tunnelled.status, 403);
  assert.equal(calls.openai.length, 0);

  // The relay's own worker, on loopback, still gets through.
  const local = await invokeRoute(routes, 'POST', GENERATE, { body: nextRequest(), socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(local.status, 200);
  assert.equal(calls.openai.length, 1);
});

test('a generation that outlasts its timeout is cut off, and an edit has its own', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ hang: true }] });
  const routes = generateRoutes({ config: { openaiImageGenerateTimeoutMs: 20, openaiImageEditTimeoutMs: 40 } });

  const generated = await invokeRoute(routes, 'POST', GENERATE, { body: nextRequest() });
  assert.equal(generated.status, 504);
  assert.equal(generated.body.code, 'IMAGE_PROVIDER_NO_ANSWER');
  assert.equal(generated.body.outcome, 'uncertain');
  assert.match(generated.body.error, /^OpenAI did not answer within 20 ms \(tried (once|twice)\); the request may have been billed; retry the message\.$/);
  assert.equal(calls.openai[0].init.signal.aborted, true);

  const edited = await invokeRoute(routes, 'POST', GENERATE, {
    body: nextRequest({ attachments: [{ name: 'a.png', type: 'image/png', dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}` }] }),
  });
  assert.match(edited.body.error, /^OpenAI did not answer within 40 ms/);
});
