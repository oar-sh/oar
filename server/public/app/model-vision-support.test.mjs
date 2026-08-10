import test from 'node:test';
import assert from 'node:assert/strict';
import {
  modelLikelySupportsVision,
  shouldWarnAboutImageAttachments,
  imageAttachmentWarningText,
  countImageAttachments,
} from './model-vision-support.mjs';

const image = { name: 'shot.png', type: 'image/png', isImage: true };
const pdf = { name: 'spec.pdf', type: 'application/pdf', isImage: false };

test('unknown models are assumed vision-capable so the composer stays quiet', () => {
  assert.equal(modelLikelySupportsVision('some-future-model-9'), true);
  assert.equal(shouldWarnAboutImageAttachments('some-future-model-9', [image]), false);
});

test('known text-only models are flagged', () => {
  assert.equal(modelLikelySupportsVision('o1-mini'), false);
  assert.equal(shouldWarnAboutImageAttachments('o1-mini', [image]), true);
});

test('model id matching ignores casing and padding', () => {
  assert.equal(modelLikelySupportsVision('  O1-Mini  '), false);
});

test('no warning without image attachments', () => {
  assert.equal(shouldWarnAboutImageAttachments('o1-mini', []), false);
  assert.equal(shouldWarnAboutImageAttachments('o1-mini', [pdf]), false);
});

test('an empty model id never warns', () => {
  assert.equal(modelLikelySupportsVision(''), true);
  assert.equal(shouldWarnAboutImageAttachments('', [image]), false);
});

test('countImageAttachments falls back to the mime type', () => {
  assert.equal(countImageAttachments([{ type: 'image/webp' }, { type: 'text/plain' }]), 1);
  assert.equal(countImageAttachments([]), 0);
  assert.equal(countImageAttachments(null), 0);
});

test('warning text is singular or plural and names the model', () => {
  assert.equal(imageAttachmentWarningText('o1-mini', [image]),
    'o1-mini may not read image — the image will be sent as a file reference instead.');
  assert.equal(imageAttachmentWarningText('o1-mini', [image, image]),
    'o1-mini may not read images — the images will be sent as a file reference instead.');
});

test('warning text is empty when there is nothing to warn about', () => {
  assert.equal(imageAttachmentWarningText('claude-opus-5', [image]), '');
});
