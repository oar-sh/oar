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

test('an active turn with a draft offers Queue on a serial provider', () => {
  const state = deriveComposerControlState({ hasActiveTurn: true, hasDraft: true });
  assert.equal(state.action, 'queue');
  assert.equal(state.label, 'Queue');
  assert.match(state.title, /queue/i);
  assert.equal(state.disabled, false);
});

test('an active turn with a draft offers Steer where the provider steers', () => {
  const state = deriveComposerControlState({ hasActiveTurn: true, hasDraft: true, steeringSupported: true });
  assert.equal(state.action, 'steer');
  assert.equal(state.label, 'Steer');
  assert.match(state.title, /steer message into the running turn/i);
  assert.equal(state.disabled, false);
});

// The composer never doubles as Stop: stopping lives on the message bubbles.
// An active turn with an empty composer is a disabled Send that re-enables on
// typing (Steer) or when the turn ends (Send).
test('no state ever produces a stop action', () => {
  const combos = [];
  for (const hasActiveTurn of [false, true]) {
    for (const hasDraft of [false, true]) {
      for (const steeringSupported of [false, true]) {
        for (const sendInFlight of [false, true]) {
          for (const steeringHeld of [false, true]) {
            combos.push({ hasActiveTurn, hasDraft, steeringSupported, sendInFlight, steeringHeld });
          }
        }
      }
    }
  }
  for (const combo of combos) {
    const state = deriveComposerControlState(combo);
    assert.notEqual(state.action, 'stop', JSON.stringify(combo));
    assert.notEqual(state.label, 'Stop', JSON.stringify(combo));
  }
});

test('an active turn with an empty composer is a disabled Send, not Stop', () => {
  const state = deriveComposerControlState({ hasActiveTurn: true, steeringSupported: true });
  assert.equal(state.action, 'send');
  assert.equal(state.label, 'Send');
  assert.equal(state.disabled, true);
});

test('the label reverts to Send when the turn ends with text still drafted', () => {
  const during = deriveComposerControlState({ hasActiveTurn: true, hasDraft: true, steeringSupported: true });
  assert.equal(during.label, 'Steer');
  const after = deriveComposerControlState({ hasActiveTurn: false, hasDraft: true, steeringSupported: true });
  assert.equal(after.label, 'Send');
  assert.equal(after.disabled, false);
});

test('a steering hold disables the Steer button and explains why', () => {
  const question = deriveComposerControlState({
    hasActiveTurn: true, hasDraft: true, steeringSupported: true,
    steeringHeld: true, steeringHoldReason: 'question',
  });
  assert.equal(question.action, 'steer');
  assert.equal(question.label, 'Steer');
  assert.equal(question.disabled, true);
  assert.match(question.title, /question/i);

  const compaction = deriveComposerControlState({
    hasActiveTurn: true, hasDraft: true, steeringSupported: true,
    steeringHeld: true, steeringHoldReason: 'compaction',
  });
  assert.equal(compaction.disabled, true);
  assert.match(compaction.title, /compact/i);

  const unknown = deriveComposerControlState({
    hasActiveTurn: true, hasDraft: true, steeringSupported: true,
    steeringHeld: true, steeringHoldReason: 'something-new',
  });
  assert.equal(unknown.disabled, true);
  assert.match(unknown.title, /unavailable/i);
});

test('a steering hold is inert for serial (queue) providers', () => {
  const state = deriveComposerControlState({
    hasActiveTurn: true, hasDraft: true, steeringSupported: false, steeringHeld: true,
  });
  assert.equal(state.action, 'queue');
  assert.equal(state.disabled, false);
});

test('a steering hold is inert without an active turn', () => {
  const state = deriveComposerControlState({
    hasDraft: true, steeringSupported: true, steeringHeld: true,
  });
  assert.equal(state.action, 'send');
  assert.equal(state.disabled, false);
});

test('the steer wording carries through the send-in-flight and uploading windows', () => {
  const inFlight = deriveComposerControlState({
    hasActiveTurn: true, hasDraft: true, steeringSupported: true, sendInFlight: true,
  });
  assert.equal(inFlight.label, 'Steer');
  assert.equal(inFlight.disabled, true);
  const uploading = deriveComposerControlState({
    hasActiveTurn: true, hasDraft: true, steeringSupported: true, attachmentsUploading: true,
  });
  assert.equal(uploading.label, 'Steer');
  assert.equal(uploading.disabled, true);
});

test('steeringSupported is inert without an active turn or draft', () => {
  assert.equal(deriveComposerControlState({ steeringSupported: true }).label, 'Send');
  const activeEmpty = deriveComposerControlState({ hasActiveTurn: true, steeringSupported: true });
  assert.equal(activeEmpty.action, 'send');
  assert.equal(activeEmpty.disabled, true);
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
  const activeEmpty = deriveComposerControlState({ hasActiveTurn: true, sendInFlight: true });
  assert.equal(activeEmpty.action, 'send');
  assert.equal(activeEmpty.disabled, true);
});
