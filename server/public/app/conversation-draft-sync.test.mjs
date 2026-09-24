import test from 'node:test';
import assert from 'node:assert/strict';

import {
  draftAttachmentsKey,
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

test('an unmodified composer adopts incoming drafts even while focused', () => {
  assert.equal(shouldApplyIncomingDraftToComposer({
    isFocused: true, inputText: 'old', incomingText: 'new', syncedText: 'old',
  }), true);
  assert.equal(shouldApplyIncomingDraftToComposer({
    isFocused: true, inputText: '', incomingText: 'from the phone', syncedText: '',
  }), true, 'an idle, empty, focused composer takes the other device\'s draft');
});

test('a modified composer keeps its text while focused or while its own save is pending', () => {
  assert.equal(shouldApplyIncomingDraftToComposer({
    isFocused: true, inputText: 'typing', incomingText: 'new', syncedText: 'old',
  }), false);
  assert.equal(shouldApplyIncomingDraftToComposer({
    isFocused: false, inputText: 'typing', incomingText: 'new', syncedText: 'old', savePending: true,
  }), false);
  assert.equal(shouldApplyIncomingDraftToComposer({
    isFocused: false, inputText: 'other conversation text', incomingText: 'new', syncedText: null,
  }), true, 'an unfocused composer with nothing pending takes the draft (conversation switch)');
  assert.equal(shouldApplyIncomingDraftToComposer({
    isFocused: true, inputText: 'same', incomingText: 'same', syncedText: 'old',
  }), true, 'an incoming draft equal to the composer is always accepted');
});
