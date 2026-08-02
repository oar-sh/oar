import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
