import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeAttachmentContent, buildClaudeUserContent } from './claude-attachments.mjs';

function fakeFs(files = {}) {
  return {
    existsSync: (filePath) => Object.prototype.hasOwnProperty.call(files, filePath),
    readFileSync: (filePath) => {
      if (!Object.prototype.hasOwnProperty.call(files, filePath)) throw new Error('missing');
      return files[filePath];
    },
  };
}

test('small image with path becomes a base64 image block', () => {
  const bytes = Buffer.from('fake-png-bytes');
  const fsImpl = fakeFs({ '/uploads/abc': bytes });
  const { imageBlocks, noteLines } = buildClaudeAttachmentContent([
    { name: 'shot.png', type: 'image/png', path: '/uploads/abc', size: bytes.length },
  ], { fsImpl });
  assert.equal(imageBlocks.length, 1);
  assert.deepEqual(imageBlocks[0], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
  });
  assert.match(noteLines[0], /embedded in this message/);
});

test('oversized image falls back to a path reference line', () => {
  const bytes = Buffer.alloc(64, 1);
  const fsImpl = fakeFs({ '/uploads/big': bytes });
  const { imageBlocks, noteLines } = buildClaudeAttachmentContent([
    { name: 'big.png', type: 'image/png', path: '/uploads/big', size: bytes.length },
  ], { fsImpl, maxInlineImageBytes: 16 });
  assert.equal(imageBlocks.length, 0);
  assert.equal(noteLines.length, 1);
  assert.match(noteLines[0], /Attached image "big.png" \(image\/png\): \/uploads\/big/);
});

test('image data-url is used when no path is readable', () => {
  const fsImpl = fakeFs({});
  const data = Buffer.from('img').toString('base64');
  const { imageBlocks } = buildClaudeAttachmentContent([
    { name: 'inline.png', type: 'image/png', dataUrl: `data:image/png;base64,${data}` },
  ], { fsImpl });
  assert.equal(imageBlocks.length, 1);
  assert.equal(imageBlocks[0].source.data, data);
});

test('non-image with readable path becomes a note line; unreadable is skipped', () => {
  const fsImpl = fakeFs({ '/uploads/doc': Buffer.from('pdf') });
  const { imageBlocks, noteLines } = buildClaudeAttachmentContent([
    { name: 'spec.pdf', type: 'application/pdf', path: '/uploads/doc' },
    { name: 'ghost.txt', type: 'text/plain', path: '/uploads/missing' },
  ], { fsImpl });
  assert.equal(imageBlocks.length, 0);
  assert.equal(noteLines.length, 1);
  assert.equal(noteLines[0], 'Attached file "spec.pdf" (application/pdf): /uploads/doc');
});

test('buildClaudeUserContent composes text, notes, context, and image blocks', () => {
  const bytes = Buffer.from('png');
  const fsImpl = fakeFs({ '/uploads/img': bytes });
  const content = buildClaudeUserContent({
    text: 'Look at this.',
    attachmentPromptContext: '<system_reminder>Attached files: …</system_reminder>',
    attachments: [
      { name: 'a.png', type: 'image/png', path: '/uploads/img' },
    ],
  }, { fsImpl });
  assert.equal(content.length, 2);
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /^Look at this\./);
  assert.match(content[0].text, /system_reminder/);
  assert.equal(content[1].type, 'image');
});

test('buildClaudeUserContent yields a text block even for empty input', () => {
  const content = buildClaudeUserContent({ text: '', attachments: [] });
  assert.deepEqual(content, [{ type: 'text', text: '' }]);
});
