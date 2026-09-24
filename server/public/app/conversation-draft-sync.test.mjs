import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAFT_SYNC_PROTOCOL_VERSION,
  draftAttachmentsKey,
  draftFlushRequestBody,
  forgetSyncedDraft,
  getSyncedDraft,
  isDraftSaveNoop,
  recordSyncedDraft,
  resolveDraftConflict,
  shouldApplyIncomingDraftToComposer,
} from './conversation-draft-sync.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

test('draftAttachmentsKey distinguishes absent from empty and ignores unuploaded entries', () => {
  assert.equal(draftAttachmentsKey(undefined), null);
  assert.equal(draftAttachmentsKey([]), '');
  assert.equal(draftAttachmentsKey([{ sha256: SHA_A }, { uploadState: 'uploading' }]), SHA_A);
  assert.equal(draftAttachmentsKey([{ uploaded: { sha256: SHA_B } }, { sha256: SHA_A }]), `${SHA_B},${SHA_A}`);
});

test('a text-only record keeps the previously synced attachments', () => {
  recordSyncedDraft('conv-keep', { text: 'one', attachments: [{ sha256: SHA_A }], updatedAt: 'v1' });
  recordSyncedDraft('conv-keep', { text: 'two', updatedAt: 'v2' });
  assert.deepEqual(getSyncedDraft('conv-keep'), { text: 'two', attachmentsKey: SHA_A, updatedAt: 'v2' });
  forgetSyncedDraft('conv-keep');
  assert.equal(getSyncedDraft('conv-keep'), null);
});

test('a save is a no-op only when it would write what the server already holds', () => {
  const synced = { text: 'hello', attachmentsKey: SHA_A, updatedAt: 'v1' };
  assert.equal(isDraftSaveNoop({ synced, text: 'hello' }), true, 'text-only save of the same text');
  assert.equal(isDraftSaveNoop({ synced, text: 'hello', attachmentsKey: SHA_A }), true);
  assert.equal(isDraftSaveNoop({ synced, text: 'hello!' }), false, 'changed text saves');
  assert.equal(isDraftSaveNoop({ synced, text: 'hello', attachmentsKey: '' }), false, 'removed attachment saves');
  assert.equal(isDraftSaveNoop({ synced: null, text: '' }), false, 'nothing synced yet: always save');
  assert.equal(
    isDraftSaveNoop({ synced: { ...synced, attachmentsKey: null }, text: 'hello', attachmentsKey: '' }),
    false,
    'unknown synced attachments never suppress an attachment save',
  );
});

test('resolveDraftConflict: converged, adopt, keep-local', () => {
  assert.equal(resolveDraftConflict({ localText: 'same', baseText: 'old', serverText: 'same' }), 'converged');
  assert.equal(resolveDraftConflict({ localText: 'old', baseText: 'old', serverText: 'theirs' }), 'adopt');
  assert.equal(resolveDraftConflict({ localText: 'mine', baseText: 'old', serverText: 'theirs' }), 'keep-local');
  assert.equal(
    resolveDraftConflict({ localText: 'mine', baseText: null, serverText: 'theirs' }),
    'keep-local',
    'with no known base the local edit is treated as modified',
  );
  assert.equal(
    resolveDraftConflict({
      localText: 'same', localAttachmentsKey: SHA_A,
      baseText: 'same', baseAttachmentsKey: SHA_A,
      serverText: 'same', serverAttachmentsKey: '',
    }),
    'adopt',
    'an attachment-only remote change is adopted when the local set is unchanged',
  );
});

test('an unmodified composer adopts incoming drafts', () => {
  assert.equal(shouldApplyIncomingDraftToComposer({ inputText: 'old', incomingText: 'new', syncedText: 'old' }), true);
  assert.equal(shouldApplyIncomingDraftToComposer({
    inputText: '', incomingText: 'from the phone', syncedText: '',
  }), true, 'an idle, empty composer takes the other device\'s draft');
  assert.equal(shouldApplyIncomingDraftToComposer({
    inputText: 'same', incomingText: 'same', syncedText: 'old',
  }), true, 'an incoming draft equal to the composer is always accepted');
  assert.equal(shouldApplyIncomingDraftToComposer({
    inputText: 'anything', incomingText: 'new', syncedText: null,
  }), true, 'nothing synced yet: no local edit to protect');
});

test('a modified composer never adopts, whatever the incoming version', () => {
  assert.equal(shouldApplyIncomingDraftToComposer({ inputText: 'typing', incomingText: 'new', syncedText: 'old' }), false);
  assert.equal(
    shouldApplyIncomingDraftToComposer({ inputText: 'unsaved edit', incomingText: 'old', syncedText: 'old' }),
    false,
    'the same server draft coming back (a refresh after a failed flush) never reverts the edit',
  );
});

test('a save is not a no-op once a newer server draft is known', () => {
  const synced = { text: 'hello', attachmentsKey: '', updatedAt: '2026-09-24T09:00:00.000Z' };
  assert.equal(isDraftSaveNoop({ synced, text: 'hello', knownUpdatedAt: synced.updatedAt }), true);
  assert.equal(
    isDraftSaveNoop({ synced, text: 'hello', knownUpdatedAt: '2026-09-24T08:00:00.000Z' }),
    true,
    'an older known version changes nothing',
  );
  assert.equal(
    isDraftSaveNoop({ synced, text: 'hello', knownUpdatedAt: '2026-09-24T09:05:00.000Z' }),
    false,
    'a deferred remote draft forces the save so its version check surfaces it',
  );
});

test('draftFlushRequestBody queues only unsaved text, with the synced base and the protocol marker', () => {
  const synced = { text: 'saved', attachmentsKey: '', updatedAt: '2026-09-24T09:00:00.000Z' };
  assert.equal(draftFlushRequestBody({ inputText: 'saved', synced, fallbackText: 'x', clientId: 'c1' }), null);
  assert.deepEqual(
    draftFlushRequestBody({ inputText: 'saved and more', synced, fallbackText: 'saved and more', clientId: 'c1' }),
    {
      draftText: 'saved and more',
      clientId: 'c1',
      draftSyncVersion: DRAFT_SYNC_PROTOCOL_VERSION,
      baseDraftUpdatedAt: synced.updatedAt,
    },
    'compared with the synced draft, not the local text that tracks every keystroke',
  );
  assert.deepEqual(
    draftFlushRequestBody({ inputText: 'x', synced: null, fallbackText: '', fallbackUpdatedAt: null, clientId: 'c1' }),
    { draftText: 'x', clientId: 'c1', draftSyncVersion: DRAFT_SYNC_PROTOCOL_VERSION, baseDraftUpdatedAt: null },
  );
});

