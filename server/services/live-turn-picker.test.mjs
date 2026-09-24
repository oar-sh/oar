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
    { id: 'turn', processingAtMs: 1000, lastOutputAtMs: 5000 },
    { id: 'steered', processingAtMs: 2000, lastOutputAtMs: 0 },
  ]);
  assert.equal(live, 'turn');
});

test('the row that took the turn over wins over a long handed-off row', () => {
  // Replay handoff: row A streamed and ran tools for minutes (hundreds of
  // events, so a high per-row seq), then B took the turn and has written a
  // single snapshot since. Per-row seq would pick A and aim Stop at a row
  // that is already settling; recency picks B.
  const live = pickLiveTurnRowId([
    { id: 'long-a', processingAtMs: 1000, lastOutputAtMs: 90_000 },
    { id: 'live-b', processingAtMs: 60_000, lastOutputAtMs: 90_500 },
  ]);
  assert.equal(live, 'live-b');
});

test('a handed-off row settling its final snapshot does not take the bubble back', () => {
  // settleHandedOffContext publishes the outgoing row's done=1 snapshot AFTER
  // the incoming row started streaming, re-stamping it as the newest write.
  const live = pickLiveTurnRowId([
    { id: 'handed-off', processingAtMs: 1000, lastOutputAtMs: 91_000, streamDone: true },
    { id: 'live', processingAtMs: 60_000, lastOutputAtMs: 90_500, streamDone: false },
  ]);
  assert.equal(live, 'live');
});

test('an activity line counts as output as much as a stream snapshot', () => {
  // A turn running tools writes activity before any prose.
  const live = pickLiveTurnRowId([
    { id: 'quiet-since', processingAtMs: 1000, lastOutputAtMs: 3000 },
    { id: 'running-tools', processingAtMs: 2000, lastOutputAtMs: 4000 },
  ]);
  assert.equal(live, 'running-tools');
});

test('with nothing to separate them, the oldest processing row wins', () => {
  // The instant a message is steered in, before the turn streams: the running
  // turn is the older row, so the live bubble stays with it.
  const live = pickLiveTurnRowId([
    { id: 'turn', processingAtMs: 1000, lastOutputAtMs: 0 },
    { id: 'steered', processingAtMs: 2000, lastOutputAtMs: 0 },
  ]);
  assert.equal(live, 'turn');
  assert.equal(pickLiveTurnRowId([
    { id: 'steered', processingAtMs: 2000, lastOutputAtMs: 7000 },
    { id: 'turn', processingAtMs: 1000, lastOutputAtMs: 7000 },
  ]), 'turn', 'equal output times fall back to the older row too');
});
