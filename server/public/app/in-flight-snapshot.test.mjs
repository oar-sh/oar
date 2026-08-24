import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInFlightSnapshotKey } from './in-flight-snapshot.mjs';

const baseInFlight = () => ({
  messageId: 'msg-1',
  status: 'processing',
  lastStreamSeq: 4,
  streamDone: false,
  thoughts: [{ reasoningId: 'r1', text: 'thinking', done: false, subagentRunId: null }],
  activities: ['● Reading files', { text: 'Bash: ls', subagentRunId: 'sub-1' }],
  subagentRuns: [{ subagentRunId: 'sub-1', status: 'running', parentSubagentId: null, displayName: 'Explore' }],
  streamEvents: [{ seq: 4, text: 'partial reply', done: false, subagentRunId: null }],
});

test('identical payloads produce identical keys', () => {
  assert.equal(buildInFlightSnapshotKey(baseInFlight()), buildInFlightSnapshotKey(baseInFlight()));
});

test('null and non-object payloads share the none key', () => {
  assert.equal(buildInFlightSnapshotKey(null), 'none');
  assert.equal(buildInFlightSnapshotKey(undefined), 'none');
  assert.notEqual(buildInFlightSnapshotKey(baseInFlight()), 'none');
});

test('key changes when stream content advances', () => {
  const a = baseInFlight();
  const b = baseInFlight();
  b.lastStreamSeq = 5;
  b.streamEvents = [{ seq: 5, text: 'partial reply grew', done: false }];
  assert.notEqual(buildInFlightSnapshotKey(a), buildInFlightSnapshotKey(b));
});

test('key changes when a thought updates or completes', () => {
  const a = baseInFlight();
  const b = baseInFlight();
  b.thoughts = [{ reasoningId: 'r1', text: 'thinking', done: true }];
  assert.notEqual(buildInFlightSnapshotKey(a), buildInFlightSnapshotKey(b));
});

test('key changes when a subagent run changes status', () => {
  const a = baseInFlight();
  const b = baseInFlight();
  b.subagentRuns = [{ subagentRunId: 'sub-1', status: 'completed', parentSubagentId: null, displayName: 'Explore' }];
  assert.notEqual(buildInFlightSnapshotKey(a), buildInFlightSnapshotKey(b));
});

test('key ignores unrelated payload fields', () => {
  const a = baseInFlight();
  const b = { ...baseInFlight(), unrelated: 'noise', updatedAt: '2026-08-07T00:00:00Z' };
  assert.equal(buildInFlightSnapshotKey(a), buildInFlightSnapshotKey(b));
});
