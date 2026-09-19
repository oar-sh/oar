import test from 'node:test';
import assert from 'node:assert/strict';

import { pickLiveTurnRowId } from './live-turn-picker.mjs';

test('a single processing row is the live turn', () => {
  assert.equal(pickLiveTurnRowId([{ id: 'a', processingAtMs: 100 }]), 'a');
});

test('no rows yields an empty id', () => {
  assert.equal(pickLiveTurnRowId([]), '');
  assert.equal(pickLiveTurnRowId(null), '');
});

test('the streaming turn wins over a folded steered row with no output', () => {
  // The running turn (older, streamed) vs the steered row folded into it
  // (newer, silent): the live turn is the one producing output, so the empty
  // steered row never captures the live bubble.
  const live = pickLiveTurnRowId([
    { id: 'turn', processingAtMs: 1000, lastStreamSeq: 42, activityCount: 7 },
    { id: 'steered', processingAtMs: 2000, lastStreamSeq: 0, activityCount: 0 },
  ]);
  assert.equal(live, 'turn');
});

test('activity breaks the tie when neither row has streamed yet', () => {
  const live = pickLiveTurnRowId([
    { id: 'turn', processingAtMs: 1000, lastStreamSeq: 0, activityCount: 3 },
    { id: 'steered', processingAtMs: 2000, lastStreamSeq: 0, activityCount: 0 },
  ]);
  assert.equal(live, 'turn');
});

test('with nothing to separate them, the oldest processing row wins', () => {
  // The instant a message is steered in, before the turn streams: the running
  // turn is the older row, so the live bubble stays with it.
  const live = pickLiveTurnRowId([
    { id: 'turn', processingAtMs: 1000, lastStreamSeq: 0, activityCount: 0 },
    { id: 'steered', processingAtMs: 2000, lastStreamSeq: 0, activityCount: 0 },
  ]);
  assert.equal(live, 'turn');
});

test('a higher stream seq outranks more activity', () => {
  const live = pickLiveTurnRowId([
    { id: 'streaming', processingAtMs: 2000, lastStreamSeq: 10, activityCount: 1 },
    { id: 'chatty', processingAtMs: 1000, lastStreamSeq: 5, activityCount: 99 },
  ]);
  assert.equal(live, 'streaming');
});
