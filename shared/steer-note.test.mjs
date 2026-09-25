import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STEERED_MESSAGE_NOTE, stripSteerNote, withSteerNote, withSteerNoteContent } from './steer-note.mjs';

test('a steered prompt is prefixed with the note, separated from the user text', () => {
  assert.equal(withSteerNote('also do X'), `${STEERED_MESSAGE_NOTE}\n\nalso do X`);
  assert.equal(withSteerNote(''), STEERED_MESSAGE_NOTE);
  assert.equal(withSteerNote(null), STEERED_MESSAGE_NOTE);
  assert.match(STEERED_MESSAGE_NOTE, /^\[Sent while you were still working on my previous message\. If that request is not finished yet/);
});

test('content blocks get the note in their first text block, keeping the block shape', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const content = [{ type: 'text', text: 'look at this' }, image];
  const noted = withSteerNoteContent(content);
  assert.equal(noted.length, 2);
  assert.equal(noted[0].text, `${STEERED_MESSAGE_NOTE}\n\nlook at this`);
  assert.equal(noted[1], image);
  assert.equal(content[0].text, 'look at this', 'the input is not mutated');
  // An attachment-only message (empty text block) still gets the note.
  assert.deepEqual(withSteerNoteContent([{ type: 'text', text: '' }]), [{ type: 'text', text: STEERED_MESSAGE_NOTE }]);
  // No text block at all: the note leads as its own block.
  assert.deepEqual(withSteerNoteContent([image]), [{ type: 'text', text: STEERED_MESSAGE_NOTE }, image]);
  assert.equal(withSteerNoteContent('plain'), `${STEERED_MESSAGE_NOTE}\n\nplain`);
});

test('stripping the note gives back exactly the user text, and leaves other text alone', () => {
  assert.equal(stripSteerNote(withSteerNote('also do X')), 'also do X');
  assert.equal(stripSteerNote(withSteerNote('')), '');
  assert.equal(stripSteerNote('also do X'), 'also do X');
  assert.equal(stripSteerNote(`x ${STEERED_MESSAGE_NOTE}`), `x ${STEERED_MESSAGE_NOTE}`, 'only a leading note is stripped');
  assert.equal(stripSteerNote(null), '');
});
