import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPastedFiles,
  extractDroppedFiles,
  dataTransferHasFiles,
  pastedFileName,
  extensionForMimeType,
  isGenericClipboardName,
  planAttachmentMerge,
  overCapNoticeText,
} from './composer-paste.mjs';

function fakeFile(name, type = 'image/png') {
  return { name, type };
}

function stringItem(type = 'text/plain') {
  return { kind: 'string', type, getAsFile: () => null };
}

function fileItem(file) {
  return { kind: 'file', type: file.type, getAsFile: () => file };
}

test('paste with only an image extracts the file', () => {
  const png = fakeFile('image.png');
  const result = extractPastedFiles({ types: ['Files'], files: [png], items: [fileItem(png)] });
  assert.deepEqual(result.files, [png]);
  assert.equal(result.hadText, false);
});

test('paste with both image and text lets the image win but reports the text', () => {
  const png = fakeFile('image.png');
  const result = extractPastedFiles({
    types: ['text/plain', 'text/html', 'Files'],
    files: [png],
    items: [stringItem(), fileItem(png)],
  });
  assert.deepEqual(result.files, [png]);
  assert.equal(result.hadText, true, 'caller needs to know text was present');
});

test('paste with only text yields no files so native text paste is preserved', () => {
  const result = extractPastedFiles({ types: ['text/plain'], files: [], items: [stringItem()] });
  assert.deepEqual(result.files, []);
  assert.equal(result.hadText, true);
});

test('paste falls back to items when files is empty (Safari)', () => {
  const png = fakeFile('image.png');
  const result = extractPastedFiles({ types: ['Files'], files: [], items: [fileItem(png)] });
  assert.deepEqual(result.files, [png]);
});

test('paste tolerates a missing clipboard payload', () => {
  const result = extractPastedFiles(null);
  assert.deepEqual(result.files, []);
  assert.equal(result.hadText, false);
});

test('drop without a Files type is ignored', () => {
  const result = extractDroppedFiles({ types: ['text/plain'], files: [], items: [stringItem()] });
  assert.deepEqual(result.files, []);
  assert.equal(result.hadText, true);
});

test('drop with files extracts every file', () => {
  const a = fakeFile('a.png');
  const b = fakeFile('b.pdf', 'application/pdf');
  const result = extractDroppedFiles({ types: ['Files'], files: [a, b], items: [] });
  assert.deepEqual(result.files, [a, b]);
});

test('dropping a dragged link is not treated as a file drop', () => {
  const result = extractDroppedFiles({ types: ['text/uri-list', 'text/plain'], files: [], items: [] });
  assert.deepEqual(result.files, []);
});

test('dataTransferHasFiles detects both the types list and item kinds', () => {
  assert.equal(dataTransferHasFiles({ types: ['Files'], items: [] }), true);
  assert.equal(dataTransferHasFiles({ types: [], items: [fileItem(fakeFile('a.png'))] }), true);
  assert.equal(dataTransferHasFiles({ types: ['text/plain'], items: [stringItem()] }), false);
  assert.equal(dataTransferHasFiles(null), false);
});

test('pastedFileName builds a filesystem-safe timestamp name', () => {
  const name = pastedFileName('image/png', new Date('2026-08-09T22:33:02.876Z'));
  assert.equal(name, 'pasted-2026-08-09T22-33-02.png');
});

test('pastedFileName disambiguates multiple files pasted at once', () => {
  const now = new Date('2026-08-09T22:33:02.000Z');
  assert.equal(pastedFileName('image/webp', now, 0), 'pasted-2026-08-09T22-33-02.webp');
  assert.equal(pastedFileName('image/webp', now, 1), 'pasted-2026-08-09T22-33-02-2.webp');
});

test('pastedFileName falls back to a bin extension for unknown types', () => {
  const name = pastedFileName('application/x-unknown-thing', new Date('2026-08-09T22:33:02.000Z'));
  assert.match(name, /\.bin$/);
});

test('extensionForMimeType ignores charset parameters and casing', () => {
  assert.equal(extensionForMimeType('TEXT/Plain; charset=utf-8'), 'txt');
  assert.equal(extensionForMimeType(''), 'bin');
});

test('generic clipboard names are recognised so they can be replaced', () => {
  assert.equal(isGenericClipboardName('image.png'), true);
  assert.equal(isGenericClipboardName(''), true);
  assert.equal(isGenericClipboardName('quarterly-report.png'), false);
});

test('planAttachmentMerge keeps the first files and counts the overflow', () => {
  const existing = [1, 2, 3, 4];
  const plan = planAttachmentMerge(existing, [5, 6, 7], 6);
  assert.deepEqual(plan.accepted, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(plan.acceptedAdditions, [5, 6]);
  assert.equal(plan.droppedCount, 1);
});

test('planAttachmentMerge drops everything once the cap is already reached', () => {
  const plan = planAttachmentMerge([1, 2, 3, 4, 5, 6], [7, 8], 6);
  assert.equal(plan.accepted.length, 6);
  assert.deepEqual(plan.acceptedAdditions, []);
  assert.equal(plan.droppedCount, 2);
});

test('planAttachmentMerge accepts everything below the cap', () => {
  const plan = planAttachmentMerge([], [1, 2], 6);
  assert.deepEqual(plan.accepted, [1, 2]);
  assert.equal(plan.droppedCount, 0);
});

test('overCapNoticeText only speaks up when something was dropped', () => {
  assert.equal(overCapNoticeText(0, 6), '');
  assert.equal(overCapNoticeText(1, 6), 'Only 6 attachments allowed — 1 file was dropped.');
  assert.equal(overCapNoticeText(3, 6), 'Only 6 attachments allowed — 3 files were dropped.');
});
