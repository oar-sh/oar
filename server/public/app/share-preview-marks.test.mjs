import test from 'node:test';
import assert from 'node:assert/strict';

import { PREVIEW_MARK_CHARS, splitPreviewMarks, stripPreviewMarks } from './share-preview-marks.mjs';
import { SHARE_PREVIEW_MARKS } from '../../services/share-path-redaction.mjs';

const { redactedStart: RS, redactedEnd: RE, suspectStart: SS, suspectEnd: SE } = PREVIEW_MARK_CHARS;

test('the browser reads the marks the relay writes', () => {
  assert.deepEqual({ ...PREVIEW_MARK_CHARS }, { ...SHARE_PREVIEW_MARKS });
});

test('a text splits into plain pieces and highlights', () => {
  assert.deepEqual(splitPreviewMarks(`Read ${RS}app.js${RE} from ${SS}src/app.js${SE}.`), [
    { text: 'Read ', kind: null },
    { text: 'app.js', kind: 'redacted' },
    { text: ' from ', kind: null },
    { text: 'src/app.js', kind: 'suspect' },
    { text: '.', kind: null },
  ]);
});

test('a highlight split across nodes carries on, and a stray end mark is dropped', () => {
  const state = { kind: null };
  assert.deepEqual(splitPreviewMarks(`see ${RS}app`, state), [{ text: 'see ', kind: null }, { text: 'app', kind: 'redacted' }]);
  assert.deepEqual(splitPreviewMarks(`.js${RE} done`, state), [{ text: '.js', kind: 'redacted' }, { text: ' done', kind: null }]);
  assert.deepEqual(splitPreviewMarks(`x${SE}y`, { kind: null }), [{ text: 'x', kind: null }, { text: 'y', kind: null }]);
});

test('stripping leaves the text a viewer reads', () => {
  assert.equal(stripPreviewMarks(`Read ${RS}app.js${RE} and ${SS}src/a.js${SE}`), 'Read app.js and src/a.js');
});
