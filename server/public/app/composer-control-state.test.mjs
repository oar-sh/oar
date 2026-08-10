import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveComposerControlState,
  hasComposerDraft,
  countUploadingAttachments,
  hasUploadingAttachments,
} from './composer-control-state.mjs';

test('a draft exists when there is text or an attachment', () => {
  assert.equal(hasComposerDraft({ text: 'hi' }), true);
  assert.equal(hasComposerDraft({ text: '   ' }), false);
  assert.equal(hasComposerDraft({ text: '', attachmentCount: 1 }), true);
  assert.equal(hasComposerDraft({}), false);
});

test('idle composer offers an enabled Send', () => {
  const state = deriveComposerControlState({});
  assert.equal(state.action, 'send');
  assert.equal(state.disabled, false);
});

test('an active turn with a draft offers Queue', () => {
  const state = deriveComposerControlState({ hasActiveTurn: true, hasDraft: true });
  assert.equal(state.action, 'queue');
  assert.equal(state.disabled, false);
});

test('an active turn without a draft offers Stop', () => {
  const state = deriveComposerControlState({ hasActiveTurn: true });
  assert.equal(state.action, 'stop');
  assert.equal(state.disabled, false);
});

test('send is disabled while attachments are uploading', () => {
  const state = deriveComposerControlState({ hasDraft: true, attachmentsUploading: true });
  assert.equal(state.disabled, true);
  assert.equal(state.action, 'send');
  assert.match(state.title, /uploading/i);
});

test('uploading keeps the Queue label when a turn is running', () => {
  const state = deriveComposerControlState({
    hasActiveTurn: true,
    hasDraft: true,
    attachmentsUploading: true,
  });
  assert.equal(state.action, 'queue');
  assert.equal(state.disabled, true);
});

test('send is re-enabled once uploads finish', () => {
  const state = deriveComposerControlState({ hasDraft: true, attachmentsUploading: false });
  assert.equal(state.disabled, false);
});

test('blocked model metadata still takes priority over uploading', () => {
  const state = deriveComposerControlState({ modelMetadataBlocked: true, attachmentsUploading: true });
  assert.match(state.title, /model metadata/i);
  assert.equal(state.disabled, true);
});

test('a failed upload does not wedge the send button', () => {
  const attachments = [{ uploadState: 'error' }, { uploadState: 'uploaded' }];
  assert.equal(hasUploadingAttachments(attachments), false);
  const state = deriveComposerControlState({
    hasDraft: true,
    attachmentsUploading: hasUploadingAttachments(attachments),
  });
  assert.equal(state.disabled, false, 'the user must be able to send or retry after a failure');
});

test('pending and uploading attachments both count as in flight', () => {
  assert.equal(countUploadingAttachments([
    { uploadState: 'pending' },
    { uploadState: 'uploading' },
    { uploadState: 'uploaded' },
    { uploadState: 'error' },
  ]), 2);
  assert.equal(countUploadingAttachments([]), 0);
  assert.equal(countUploadingAttachments(null), 0);
});

test('a send already in flight disables the button', () => {
  assert.equal(deriveComposerControlState({ sendInFlight: true }).disabled, true);
});

test('a stopping turn reports the stopping label', () => {
  const state = deriveComposerControlState({ hasActiveTurn: true, cancelRequested: true });
  assert.equal(state.label, 'Stopping…');
  assert.equal(state.disabled, true);
});
