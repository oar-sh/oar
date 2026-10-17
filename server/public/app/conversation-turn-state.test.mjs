import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyBackgroundTasksToConversation, applyFetchedTurnStateToConversation, applyTurnStatusToConversation } from './conversation-turn-state.mjs';

// journal-view.js touches window/document at module scope, so mergeConversationRecord
// is exercised through its source rather than imported. The behaviour under test is
// the reconciliation rule, so the function body is extracted and evaluated directly.
function loadMergeConversationRecord() {
  const source = fs.readFileSync(fileURLToPath(new URL('./journal-view.js', import.meta.url)), 'utf8');
  const start = source.indexOf('function mergeConversationRecord(');
  assert.notEqual(start, -1, 'expected to find mergeConversationRecord');
  const end = source.indexOf('\nfunction upsertConversationRecord(', start);
  assert.notEqual(end, -1, 'expected mergeConversationRecord to be followed by upsertConversationRecord');
  // eslint-disable-next-line no-new-func
  return new Function(`${source.slice(start, end)}; return mergeConversationRecord;`)();
}

const mergeConversationRecord = loadMergeConversationRecord();

test('a server record without an activeTurn verdict leaves optimistic state alone', () => {
  const merged = mergeConversationRecord(
    { id: 'c1', localTurnStatus: 'processing', localTurnStatusUpdatedAt: 1000 },
    { id: 'c1', title: 'Renamed' },
  );
  assert.equal(merged.localTurnStatus, 'processing');
  assert.equal(merged.localTurnStatusUpdatedAt, 1000);
  assert.equal(merged.title, 'Renamed');
});

test('an active turn keeps the spinner running', () => {
  const merged = mergeConversationRecord(
    { id: 'c1', localTurnStatus: 'processing', localTurnStatusUpdatedAt: 1000 },
    { id: 'c1', activeTurn: true },
  );
  assert.equal(merged.localTurnStatus, 'processing');
});

test('the server clearing activeTurn clears a stranded processing flag', () => {
  // The relay-restart case: the terminal message_status never reached the client,
  // so localTurnStatus would otherwise keep the list spinner going for 5 minutes.
  const merged = mergeConversationRecord(
    { id: 'c1', localTurnStatus: 'processing', localTurnStatusUpdatedAt: 1000 },
    { id: 'c1', activeTurn: false },
  );
  assert.equal('localTurnStatus' in merged, false);
  assert.equal('localTurnStatusUpdatedAt' in merged, false);
  assert.equal(merged.id, 'c1');
});

test('merging is still a plain overlay for every other field', () => {
  const merged = mergeConversationRecord(
    { id: 'c1', title: 'Old', draftText: 'keep me' },
    { id: 'c1', title: 'New', activeTurn: false },
  );
  assert.equal(merged.title, 'New');
  assert.equal(merged.draftText, 'keep me');
});

test('the conversation list payload advertises activeTurn', () => {
  const routes = fs.readFileSync(
    fileURLToPath(new URL('../../routes/sessions-routes.mjs', import.meta.url)),
    'utf8',
  );
  assert.match(routes, /activeTurn:\s+activeTurnConversationIds\.has/);
  assert.match(routes, /listConversationIdsWithActiveQueue/);
});

// The record's turn fields between list fetches (conversation-turn-state.mjs).
test('a turn that ends clears the running state the list fetch set, for a row that is not open', () => {
  const conversation = { id: 'conv-a', activeTurn: true, sessionState: 'running_turn' };
  assert.equal(applyTurnStatusToConversation(conversation, 'done'), true);
  assert.deepEqual([conversation.activeTurn, conversation.sessionState], [false, 'idle']);
  for (const status of ['failed', 'dropped', 'cancelled']) {
    const row = { activeTurn: true, sessionState: 'running_turn' };
    applyTurnStatusToConversation(row, status);
    assert.deepEqual([row.activeTurn, row.sessionState], [false, 'idle'], status);
  }
});

test('processing and queued statuses mark a turn active; unknown statuses change nothing', () => {
  const conversation = { id: 'conv-a', activeTurn: false, sessionState: 'idle' };
  assert.equal(applyTurnStatusToConversation(conversation, 'pending'), true);
  assert.deepEqual([conversation.activeTurn, conversation.sessionState], [true, 'idle']);
  assert.equal(applyTurnStatusToConversation(conversation, 'processing'), true);
  assert.deepEqual([conversation.activeTurn, conversation.sessionState], [true, 'running_turn']);
  assert.equal(applyTurnStatusToConversation(conversation, 'parked'), false, 'a parked row keeps the running state it had');
  assert.equal(applyTurnStatusToConversation(conversation, 'mystery'), false);
  assert.equal(applyTurnStatusToConversation(null, 'done'), false);
});

test('background work carries the state once the turn is over, and ends it when the set empties', () => {
  const conversation = { id: 'conv-a', activeTurn: true, sessionState: 'running_turn' };
  assert.equal(applyBackgroundTasksToConversation(conversation, [{ taskId: 't-1', status: 'running' }, { taskId: 't-2', status: 'completed' }]), true);
  assert.equal(conversation.backgroundTaskCount, 1);
  assert.equal(conversation.sessionState, 'running_turn', 'the turn still runs');
  applyTurnStatusToConversation(conversation, 'done');
  assert.deepEqual([conversation.activeTurn, conversation.sessionState], [false, 'background_only']);
  assert.equal(applyBackgroundTasksToConversation(conversation, []), true);
  assert.deepEqual([conversation.backgroundTaskCount, conversation.sessionState], [0, 'idle']);
});

test('a fetched payload is the truth: a row fetched while a task runs stays running when its turn then ends', () => {
  const conversation = { id: 'conv-a' };
  applyFetchedTurnStateToConversation(conversation, { activeTurn: true, sessionState: 'running_turn', sessionTasks: [{ taskId: 't-1', status: 'running' }, { taskId: 't-0', status: 'completed' }] });
  assert.deepEqual([conversation.activeTurn, conversation.sessionState, conversation.backgroundTaskCount], [true, 'running_turn', 1]);
  applyTurnStatusToConversation(conversation, 'done');
  assert.deepEqual([conversation.activeTurn, conversation.sessionState], [false, 'background_only'], 'the task the fetch reported still runs');
  // A list row that only names the state counts as one task.
  const bare = { id: 'conv-b' };
  applyFetchedTurnStateToConversation(bare, { activeTurn: false, sessionState: 'background_only' });
  assert.equal(bare.backgroundTaskCount, 1);
  applyBackgroundTasksToConversation(bare, []);
  assert.equal(bare.sessionState, 'idle');
  // A later fetch that says idle overrides what the events left (a reconnect).
  const stale = { id: 'conv-c', activeTurn: true, sessionState: 'running_turn', backgroundTaskCount: 2 };
  assert.equal(applyFetchedTurnStateToConversation(stale, { activeTurn: false, sessionState: 'idle' }), true);
  assert.deepEqual([stale.activeTurn, stale.sessionState, stale.backgroundTaskCount], [false, 'idle', 0]);
  // The single payload's live set.
  const single = { id: 'conv-d', sessionState: 'idle', backgroundTaskCount: 0 };
  applyFetchedTurnStateToConversation(single, { backgroundTasks: [{ taskId: 't-9', status: 'running' }] });
  assert.deepEqual([single.sessionState, single.backgroundTaskCount], ['background_only', 1]);
  assert.equal(applyFetchedTurnStateToConversation(single, null), false);
});
