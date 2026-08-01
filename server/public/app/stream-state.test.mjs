import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveInFlightStreamTextByThread,
  deriveLatestInFlightStreamEvent,
} from './stream-state.mjs';

// Stream rows are numbered per queue message, not per thread, so main-thread
// and subagent rows interleave in one monotonic seq sequence.
const inFlight = {
  streamEvents: [
    { seq: 1, text: 'Main so far', done: false, subagentRunId: null },
    { seq: 2, text: 'Sub so far', done: false, subagentRunId: 'toolu_a' },
    { seq: 3, text: 'Main so far, more', done: false, subagentRunId: null },
    { seq: 4, text: 'Other sub', done: false, subagentRunId: 'toolu_b' },
    { seq: 5, text: 'Sub so far, more', done: false, subagentRunId: 'toolu_a' },
  ],
};

test('per-thread derivation keeps main and subagent text apart', () => {
  const { main, bySubagentRunId } = deriveInFlightStreamTextByThread(inFlight);
  assert.equal(main.text, 'Main so far, more');
  assert.equal(main.seq, 3);
  assert.equal(bySubagentRunId.get('toolu_a').text, 'Sub so far, more');
  assert.equal(bySubagentRunId.get('toolu_b').text, 'Other sub');
  assert.equal(bySubagentRunId.size, 2);
});

test('the shared seq/done derivation still sees the globally latest row', () => {
  // Unchanged behaviour: this feeds the accept/reject state machine, which is
  // per message rather than per thread.
  const latest = deriveLatestInFlightStreamEvent(inFlight);
  assert.equal(latest.seq, 5);
});

test('a turn with only subagent output has no main text', () => {
  const { main, bySubagentRunId } = deriveInFlightStreamTextByThread({
    streamEvents: [{ seq: 1, text: 'sub only', done: false, subagentRunId: 'toolu_a' }],
  });
  assert.equal(main, null);
  assert.equal(bySubagentRunId.get('toolu_a').text, 'sub only');
});

test('missing or malformed stream events derive empty state', () => {
  for (const value of [undefined, {}, { streamEvents: [] }, { streamEvents: [{ seq: null, text: 'x' }] }]) {
    const { main, bySubagentRunId } = deriveInFlightStreamTextByThread(value);
    assert.equal(main, null);
    assert.equal(bySubagentRunId.size, 0);
  }
});
