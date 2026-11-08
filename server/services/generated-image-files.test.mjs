import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { withGeneratedImageFiles } from './generated-image-files.mjs';

// The first bytes of a PNG: signature, then the IHDR chunk with its size.
function pngHeader(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-image-files-'));
  const dir = path.join(root, 'sdk-1', 'generated-images', 'conv-a', 'reply-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'img-01.png'), pngHeader(1536, 1024));
  fs.writeFileSync(path.join(dir, 'img-02.png'), pngHeader(1024, 1536));
  return { root, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function attachment(imageId, extra = {}) {
  return {
    name: `${imageId}.png`,
    type: 'image/png',
    size: 33,
    generatedImage: { imageId, messageId: 'reply-1', conversationId: 'conv-a', sessionId: 'sdk-1', relativePath: `conv-a/reply-1/${imageId}.png` },
    ...extra,
  };
}

test('a generated image gets its file path and, for an older attachment, the size from its header', (t) => {
  const { root, dir, cleanup } = fixture();
  t.after(cleanup);
  const messages = [
    { id: 'q-1', role: 'user', text: 'Draw it', attachments: [] },
    { id: 'reply-1', role: 'assistant', text: '', attachments: [attachment('img-01'), attachment('img-02', { width: 640, height: 480 })] },
  ];
  const [user, reply] = withGeneratedImageFiles(messages, { resolveSessionStateRoot: () => root });
  assert.equal(user, messages[0], 'a message without generated images is passed on as it is');
  assert.equal(reply.attachments[0].generatedImage.path, path.join(dir, 'img-01.png'));
  assert.equal(reply.attachments[0].width, 1536);
  assert.equal(reply.attachments[0].height, 1024);
  assert.equal(reply.attachments[1].generatedImage.path, path.join(dir, 'img-02.png'));
  assert.equal(reply.attachments[1].width, 640, 'a stored size is kept, the file not read for it');
  assert.equal(messages[1].attachments[0].generatedImage.path, undefined, 'the stored rows are not changed');
});

test('a missing file, an escaping path or no state root give no path and never throw', (t) => {
  const { root, cleanup } = fixture();
  t.after(cleanup);
  const stale = attachment('img-09');
  stale.generatedImage.path = '/home/dev/old-checkout/img-09.png';
  const escaping = attachment('img-01');
  escaping.generatedImage.relativePath = '../../../etc/img-01.png';
  const [reply] = withGeneratedImageFiles([
    { id: 'reply-1', role: 'assistant', text: '', attachments: [stale, escaping, null, { name: 'notes.txt' }] },
  ], { resolveSessionStateRoot: () => root });
  assert.equal(reply.attachments[0].generatedImage.path, undefined, 'a path someone stored is never passed on');
  assert.equal(reply.attachments[0].width, undefined);
  assert.equal(reply.attachments[1].generatedImage.path, undefined);
  assert.equal(reply.attachments[2], null);
  assert.deepEqual(reply.attachments[3], { name: 'notes.txt' });

  const messages = [{ id: 'reply-1', role: 'assistant', attachments: [attachment('img-01')] }];
  assert.equal(withGeneratedImageFiles(messages, { resolveSessionStateRoot: () => '' }), messages);
  assert.equal(withGeneratedImageFiles(messages, { resolveSessionStateRoot: () => { throw new Error('no root'); } }), messages);
  assert.equal(withGeneratedImageFiles(messages, {}), messages);
});

test('a file that is no image gets its path but no size', (t) => {
  const { root, dir, cleanup } = fixture();
  t.after(cleanup);
  fs.writeFileSync(path.join(dir, 'img-03.png'), 'not an image');
  const [reply] = withGeneratedImageFiles([
    { id: 'reply-1', role: 'assistant', attachments: [attachment('img-03')] },
  ], { resolveSessionStateRoot: () => root });
  assert.equal(reply.attachments[0].generatedImage.path, path.join(dir, 'img-03.png'));
  assert.equal(reply.attachments[0].width, undefined);
});
