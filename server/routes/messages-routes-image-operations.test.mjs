// POST /api/image-operations/:id/execute: the OpenAI request runs in the
// relay's own process with the operation's options and input images, the
// images go to /api/response with OpenAI's usage, and a failure is published
// as the row's terminal error.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTerminalFailurePayload } from './messages-routes.mjs';
import {
  executeImageOperation as executeOperation,
  makeImageOperationDeps as imageOperationDeps,
  stubImageFetch,
} from './messages-routes-test-harness.mjs';

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Hh9kAAAAASUVORK5CYII=';
const okReply = (extra = {}) => ({ status: 200, json: { data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }], ...extra } });

test('an image request the provider refuses is published as the row\'s terminal error', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ status: 400, json: { error: { message: 'Invalid image size' } } }] });
  const { deps, finished } = imageOperationDeps();

  const { status, body } = await executeOperation(deps);

  assert.equal(status, 409);
  assert.equal(body.outcome, 'terminal');
  assert.equal(calls.openai.length, 1);
  assert.equal(finished[0].status, 'failed_terminal');
  assert.equal(finished[0].httpStatus, 400);
  const sent = JSON.parse(calls.openai[0].init.body);
  assert.equal(sent.model, 'gpt-image-2');
  assert.equal(sent.quality, 'low');
  // In-process: the relay does not call its own generate route.
  assert.equal(calls.self.some((p) => p.route === '/api/openai/images/generate'), false);
  const failure = calls.self.find((p) => p.route === '/api/response').body;
  // /api/response reads `terminalError`; anything else was an empty reply it refused.
  const resolved = resolveTerminalFailurePayload(failure);
  assert.equal(resolved?.terminal, true);
  assert.equal(resolved.stableCode, 'relay.image-provider-rejected');
  assert.equal(resolved.message, 'OpenAI refused the image request (400): Invalid image size.');
  assert.equal(calls.self.some((p) => p.route === '/api/requeue'), false);
});

test('an interrupted earlier attempt is published as an uncertain terminal error', async (t) => {
  const calls = stubImageFetch(t, {});
  const { deps } = imageOperationDeps({
    latestAttempt: { id: 'img_attempt_1', attempt_number: 1, status: 'started', started_at: '2026-10-24T09:00:00.000Z' },
  });

  const { status, body } = await executeOperation(deps);

  assert.equal(status, 409);
  assert.equal(body.outcome, 'uncertain');
  assert.equal(calls.openai.length, 0);
  const resolved = resolveTerminalFailurePayload(calls.self.find((p) => p.route === '/api/response').body);
  assert.equal(resolved?.stableCode, 'relay.image-attempt-interrupted');
  assert.equal(resolved.message, 'The relay was interrupted while OpenAI was working on the image; the request may have been billed; retry the message.');
});

test('a reply the relay could not process fails the row instead of requeueing the billed generation', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ status: 200, text: 'not json' }] });
  const { deps, finished } = imageOperationDeps();

  const { status, body } = await executeOperation(deps);

  assert.equal(status, 409);
  assert.equal(body.outcome, 'terminal');
  assert.equal(calls.openai.length, 1);
  assert.equal(finished[0].status, 'failed_terminal');
  assert.equal(finished[0].errorCode, 'IMAGE_REPLY_UNPROCESSED');
  assert.match(finished[0].errorMessage, /could not process the image OpenAI returned \(OpenAI image API returned invalid JSON\)/);
  const resolved = resolveTerminalFailurePayload(calls.self.find((p) => p.route === '/api/response').body);
  assert.equal(resolved?.terminal, true);
  // The row's code says what the attempt row says, not "provider rejected".
  assert.equal(resolved.stableCode, 'relay.image-reply-unprocessed');
  assert.match(resolved.message, /The generation was billed; the message was not retried\./);
  assert.equal(calls.self.some((p) => p.route === '/api/requeue'), false);
});

test('every option of the operation goes to OpenAI, and missing ones are left out', async (t) => {
  const calls = stubImageFetch(t, { openai: [okReply()] });
  const { deps } = imageOperationDeps({
    parameters: { size: '1536x1024', quality: 'medium', count: 2, output_format: 'webp', background: 'opaque' },
  });
  assert.equal((await executeOperation(deps)).status, 200);
  assert.deepEqual(JSON.parse(calls.openai[0].init.body), {
    model: 'gpt-image-2',
    prompt: 'turn the sky purple',
    n: 2,
    size: '1536x1024',
    quality: 'medium',
    output_format: 'webp',
    background: 'opaque',
    stream: true,
    partial_images: 2,
  });
  assert.equal(calls.openai[0].init.headers['Idempotency-Key'], 'img_op_demo');

  const sparse = stubImageFetch(t, { openai: [okReply()] });
  const { deps: sparseDeps } = imageOperationDeps({ parameters: { size: '1024x1024' } });
  assert.equal((await executeOperation(sparseDeps)).status, 200);
  assert.deepEqual(JSON.parse(sparse.openai[0].init.body), { model: 'gpt-image-2', prompt: 'turn the sky purple', n: 1, size: '1024x1024', stream: true, partial_images: 2 });
});

test('a dall-e-3 operation sends neither format nor background, and n=1', async (t) => {
  const calls = stubImageFetch(t, { openai: [okReply()] });
  const { deps } = imageOperationDeps({ model: 'dall-e-3', parameters: { size: 'auto', quality: 'hd', count: 1 } });
  assert.equal((await executeOperation(deps)).status, 200);
  assert.deepEqual(JSON.parse(calls.openai[0].init.body), {
    model: 'dall-e-3',
    prompt: 'turn the sky purple',
    response_format: 'b64_json',
    n: 1,
    quality: 'hd',
  });
});

test('options the model\'s family does not take fail the row before anything is sent', async (t) => {
  const calls = stubImageFetch(t, {});
  const { deps, finished } = imageOperationDeps({ model: 'dall-e-3', parameters: { output_format: 'webp', count: 1 } });

  const { status, body } = await executeOperation(deps);

  assert.equal(status, 409);
  assert.equal(body.outcome, 'terminal');
  assert.equal(calls.openai.length, 0);
  assert.equal(finished[0].errorCode, 'IMAGE_REQUEST_INVALID');
  assert.match(resolveTerminalFailurePayload(calls.self.find((p) => p.route === '/api/response').body).message, /output_format goes with gpt-image models only/);
});

test('every asset of the operation goes to the edit, the first as the base', async (t) => {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-image-assets-'));
  t.after(() => fs.rmSync(uploadsDir, { recursive: true, force: true }));
  const assets = ['base', 'second', 'third'].map((label) => {
    const sha = crypto.createHash('sha256').update(label).digest('hex');
    fs.writeFileSync(path.join(uploadsDir, sha), Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));
    return { original_name: `${label}.png`, media_type: 'image/png', content_sha256: sha };
  });
  const calls = stubImageFetch(t, { openai: [okReply()] });
  const { deps } = imageOperationDeps({ assets, uploadsDir });

  assert.equal((await executeOperation(deps)).status, 200);
  assert.equal(calls.openai[0].path, '/images/edits');
  assert.deepEqual(calls.openai[0].init.body.getAll('image[]').map((file) => file.name), ['base.png', 'second.png', 'third.png']);
});

test('the images go to /api/response, the route answers with OpenAI\'s usage', async (t) => {
  const usage = { input_tokens: 40, output_tokens: 1056, total_tokens: 1096 };
  const calls = stubImageFetch(t, { openai: [okReply({ usage })] });
  const { deps, finished } = imageOperationDeps();

  const { status, body } = await executeOperation(deps);

  assert.equal(status, 200);
  assert.equal(body.outcome, 'completed');
  assert.equal(body.generatedImageCount, 1);
  assert.deepEqual(body.usage, usage);
  const response = calls.self.find((p) => p.route === '/api/response').body;
  assert.equal(response.text, '');
  assert.equal(response.generatedImages[0].data, ONE_PIXEL_PNG_BASE64);
  assert.equal(response.generatedImages[0].mimeType, 'image/png');
  assert.equal(response.model, 'gpt-image-2');
  // The usage is booked where the request ran, not by /api/response.
  assert.equal('imageUsage' in response, false);
  // /api/response finishes the started attempt; the route itself does not.
  assert.equal(finished.length, 0);
});

test('a remote agent\'s prompt header never reaches OpenAI from an operation', async (t) => {
  const calls = stubImageFetch(t, { openai: [okReply()] });
  const { deps } = imageOperationDeps({
    prompt: '[Remote prompt from an agent on relay "harbour-lab" · Claude · acting for the user]\n\nturn the sky purple',
  });
  await executeOperation(deps);
  assert.equal(JSON.parse(calls.openai[0].init.body).prompt, 'turn the sky purple');
});
