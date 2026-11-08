// The partial previews of image turns, outside the routes: where the files
// go, which events the owner's clients get, a turn's end that waits for its
// request, a race between a partial and a retry, and the sweep of a
// conversation's leftovers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createOpenAIImagePreviewTurns, openAIImagePartialContentUrl } from './openai-image-preview-turns.mjs';

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Hh9kAAAAASUVORK5CYII=';
const REPO_ROOT = process.cwd();
let counter = 0;

function setup(t, options = {}) {
  counter += 1;
  const root = path.join(REPO_ROOT, '.test-artifacts', `preview-turns-${process.pid}-${counter}`);
  fs.rmSync(root, { recursive: true, force: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  const previews = createOpenAIImagePreviewTurns({
    resolveSessionStateRoot: () => root,
    sessionIdFor: () => 'sdk-7',
    emit: (event, payload) => events.push([event, payload]),
    logger: null,
    ...options,
  });
  const conversationDir = path.join(root, 'sdk-7', 'generated-images', 'conv-7');
  return { root, events, previews, conversationDir };
}

test('the content URL names conversation, message and file, encoded', () => {
  assert.equal(openAIImagePartialContentUrl('conv 1', 'q/1', 'img-01-try1-p0.png'), '/api/generated-image/conv%201/q%2F1/partials/img-01-try1-p0.png');
});

test('a turn\'s end while its request runs waits for the request', async (t) => {
  const { events, previews, conversationDir } = setup(t);
  const turn = previews.begin({ conversationId: 'conv-7', messageId: 'q-7', size: 'auto', quality: 'auto', count: 1, model: 'gpt-image-2' });
  turn.started(1);
  const shown = await turn.partial({ imageIndex: 0, partialIndex: 0, b64: ONE_PIXEL_PNG_BASE64, outputFormat: 'webp' });
  // The bytes' own header names the type, over the format asked for.
  assert.equal(shown.mime, 'image/png');
  assert.ok(fs.existsSync(path.join(conversationDir, 'q-7', 'partials', 'img-01-try1-p0.png')));

  assert.equal(previews.finish('q-7', 'done'), true);
  assert.equal(events.at(-1)[0], 'image_preview');
  assert.ok(previews.partialFile({ conversationId: 'conv-7', messageId: 'q-7', fileName: 'img-01-try1-p0.png' }));
  turn.ended({ ok: true });
  assert.deepEqual(events.at(-1), ['image_preview_reset', { conversationId: 'conv-7', messageId: 'q-7', attempt: 1, reason: 'done' }]);
  assert.equal(fs.existsSync(path.join(conversationDir, 'q-7')), false);
  assert.equal(previews.has('q-7'), false);
  assert.equal(previews.finish('q-7', 'done'), false);
});

test('a partial written while the retry started is dropped, not shown', async (t) => {
  const { events, previews, conversationDir } = setup(t);
  const turn = previews.begin({ conversationId: 'conv-7', messageId: 'q-8' });
  turn.started(1);
  const pending = turn.partial({ partialIndex: 0, b64: ONE_PIXEL_PNG_BASE64 });
  turn.retry();
  turn.started(2);
  assert.equal(await pending, null);
  assert.deepEqual(fs.readdirSync(path.join(conversationDir, 'q-8', 'partials')), []);
  assert.deepEqual(events.map(([event, payload]) => [event, payload.attempt]), [
    ['image_started', 1],
    ['image_preview_reset', 1],
    ['image_started', 2],
  ]);
});

test('without a session-state root nothing is written, the placeholder events still go', async (t) => {
  const events = [];
  const previews = createOpenAIImagePreviewTurns({ resolveSessionStateRoot: () => '', emit: (event) => events.push(event), logger: null });
  const turn = previews.begin({ conversationId: 'conv-7', messageId: 'q-9' });
  turn.started(1);
  assert.equal(await turn.partial({ b64: ONE_PIXEL_PNG_BASE64 }), null);
  turn.ended({ ok: false });
  previews.finish('q-9', 'failed');
  assert.deepEqual(events, ['image_started', 'image_preview_reset']);
});

test('a turn\'s end sweeps partials no running turn owns, and leaves a running turn\'s alone', async (t) => {
  const { previews, conversationDir } = setup(t);
  const running = previews.begin({ conversationId: 'conv-7', messageId: 'q-running' });
  running.started(1);
  await running.partial({ b64: ONE_PIXEL_PNG_BASE64 });
  const leftover = path.join(conversationDir, 'q-old', 'partials');
  fs.mkdirSync(leftover, { recursive: true });
  fs.writeFileSync(path.join(leftover, 'img-01-try1-p0.png'), 'x');
  // A reply folder with final images is never touched.
  fs.mkdirSync(path.join(conversationDir, 'reply-1'), { recursive: true });
  fs.writeFileSync(path.join(conversationDir, 'reply-1', 'img-01.png'), 'x');

  const ending = previews.begin({ conversationId: 'conv-7', messageId: 'q-ending' });
  ending.started(1);
  ending.ended({ ok: false });
  previews.finish('q-ending', 'failed');

  assert.equal(fs.existsSync(path.join(conversationDir, 'q-old')), false);
  assert.equal(fs.readdirSync(path.join(conversationDir, 'q-running', 'partials')).length, 1);
  assert.ok(fs.existsSync(path.join(conversationDir, 'reply-1', 'img-01.png')));
});

test('a partial past the partials per image, or past the turn\'s count, writes nothing', async (t) => {
  const { events, previews, conversationDir } = setup(t);
  const turn = previews.begin({ conversationId: 'conv-7', messageId: 'q-9', count: 2 });
  turn.started(1);
  assert.ok(await turn.partial({ imageIndex: 1, partialIndex: 1, b64: ONE_PIXEL_PNG_BASE64 }));
  assert.equal(await turn.partial({ imageIndex: 0, partialIndex: 2, b64: ONE_PIXEL_PNG_BASE64 }), null);
  assert.equal(await turn.partial({ imageIndex: 2, partialIndex: 0, b64: ONE_PIXEL_PNG_BASE64 }), null);
  assert.deepEqual(fs.readdirSync(path.join(conversationDir, 'q-9', 'partials')), ['img-02-try1-p1.png']);
  assert.equal(events.filter(([event]) => event === 'image_preview').length, 1);
});
