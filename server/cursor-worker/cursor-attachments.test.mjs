import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCursorUserMessage } from './cursor-attachments.mjs';

function fakeFs(files = {}) {
  return {
    existsSync: (filePath) => Object.prototype.hasOwnProperty.call(files, filePath),
    readFileSync: (filePath) => {
      if (!Object.prototype.hasOwnProperty.call(files, filePath)) throw new Error('missing');
      return files[filePath];
    },
  };
}

test('small image with path becomes an inline base64 image', () => {
  const bytes = Buffer.from('fake-png-bytes');
  const fsImpl = fakeFs({ '/home/dev/uploads/abc': bytes });
  const { text, images } = buildCursorUserMessage({
    text: '',
    attachments: [{ name: 'shot.png', type: 'image/png', path: '/home/dev/uploads/abc', size: bytes.length }],
  }, { fsImpl });
  assert.equal(images.length, 1);
  assert.deepEqual(images[0], { data: bytes.toString('base64'), mimeType: 'image/png' });
  assert.match(text, /Attached image "shot.png" \(image\/png\) is embedded in this message\./);
});

test('oversized image falls back to a path reference line', () => {
  const bytes = Buffer.alloc(64, 1);
  const fsImpl = fakeFs({ '/home/dev/uploads/big': bytes });
  const { text, images } = buildCursorUserMessage({
    text: '',
    attachments: [{ name: 'big.png', type: 'image/png', path: '/home/dev/uploads/big', size: bytes.length }],
  }, { fsImpl, maxInlineImageBytes: 16 });
  assert.equal(images.length, 0);
  assert.match(text, /Attached image "big.png" \(image\/png\): \/home\/dev\/uploads\/big/);
});

test('image data-url is used when no path is readable', () => {
  const fsImpl = fakeFs({});
  const data = Buffer.from('img').toString('base64');
  const { images } = buildCursorUserMessage({
    text: '',
    attachments: [{ name: 'inline.png', type: 'image/png', dataUrl: `data:image/png;base64,${data}` }],
  }, { fsImpl });
  assert.equal(images.length, 1);
  assert.deepEqual(images[0], { data, mimeType: 'image/png' });
});

test('non-image with readable path becomes a note line; unreadable is skipped', () => {
  const fsImpl = fakeFs({ '/home/dev/uploads/doc': Buffer.from('pdf') });
  const { text, images } = buildCursorUserMessage({
    text: '',
    attachments: [
      { name: 'spec.pdf', type: 'application/pdf', path: '/home/dev/uploads/doc' },
      { name: 'ghost.txt', type: 'text/plain', path: '/home/dev/uploads/missing' },
    ],
  }, { fsImpl });
  assert.equal(images.length, 0);
  assert.equal(text, 'Attached file "spec.pdf" (application/pdf): /home/dev/uploads/doc');
});

test('composes user text, note lines, and attachment context in order', () => {
  const bytes = Buffer.from('png');
  const fsImpl = fakeFs({ '/home/dev/uploads/img': bytes });
  const { text, images } = buildCursorUserMessage({
    text: 'Look at this.',
    attachmentPromptContext: '<system_reminder>Attached files: …</system_reminder>',
    attachments: [{ name: 'a.png', type: 'image/png', path: '/home/dev/uploads/img' }],
  }, { fsImpl });
  assert.equal(images.length, 1);
  assert.equal(text, [
    'Look at this.',
    'Attached image "a.png" (image/png) is embedded in this message.',
    '<system_reminder>Attached files: …</system_reminder>',
  ].join('\n\n'));
});

test('empty input yields empty text and no images', () => {
  assert.deepEqual(buildCursorUserMessage({ text: '', attachments: [] }), { text: '', images: [] });
  assert.deepEqual(buildCursorUserMessage(null), { text: '', images: [] });
});
