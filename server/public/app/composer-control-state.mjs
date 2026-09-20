export function hasComposerDraft({ text = '', attachmentCount = 0 } = {}) {
  return String(text || '').trim().length > 0 || Math.max(0, Number(attachmentCount) || 0) > 0;
}

/**
 * Counts attachments that are actively being uploaded. Failed uploads are
 * deliberately excluded: treating them as in-flight would leave Send disabled
 * forever with no way out except reloading the page.
 */
export function countUploadingAttachments(attachments = []) {
  const list = Array.isArray(attachments) ? attachments : [];
  return list.filter((attachment) => {
    const state = String(attachment?.uploadState || '').trim();
    return state === 'pending' || state === 'uploading';
  }).length;
}

export function hasUploadingAttachments(attachments = []) {
  return countUploadingAttachments(attachments) > 0;
}

// Why the composer is refusing to steer right now — worker-reported hold
// reasons mapped to a human title. Stopping a turn lives on the message
// bubbles, never here, so every state below is a Send/Steer/Queue shape.
const STEERING_HOLD_TITLES = Object.freeze({
  question: 'Waiting on your answer to the open question',
  compaction: 'Compacting the conversation — steering resumes afterwards',
  adoption: 'Recovering from a compaction — steering resumes shortly',
  delivery: 'Delivering a message — steering resumes shortly',
});

export function deriveComposerControlState({
  hasActiveTurn = false,
  hasDraft = false,
  sendInFlight = false,
  modelMetadataBlocked = false,
  attachmentsUploading = false,
  // The conversation's provider delivers a message typed during a live turn
  // INTO that turn (mid-turn steering, currently the Claude worker) rather than
  // queueing it behind — so the control says "Steer", not "Queue". Providers
  // that still serialize keep the queue wording.
  steeringSupported = false,
  // The worker reports steering as momentarily held (open question card or
  // plan approval, compaction, post-compaction adoption). The button stays
  // "Steer" but disables, truthfully: a send now would neither steer nor be
  // answerable until the hold clears.
  steeringHeld = false,
  steeringHoldReason = null,
} = {}) {
  const active = !!hasActiveTurn;
  const draft = !!hasDraft;
  const metadataBlocked = !!modelMetadataBlocked;
  const uploading = !!attachmentsUploading;
  const held = active && !!steeringSupported && !!steeringHeld;
  // The label/title/action for a draft typed during a live turn: steer into it
  // where the provider supports that, queue behind it otherwise.
  const midTurnAction = steeringSupported ? 'steer' : 'queue';
  const midTurnLabel = steeringSupported ? 'Steer' : 'Queue';
  const midTurnTitle = steeringSupported
    ? 'Steer message into the running turn'
    : 'Queue message behind current turn';
  const heldTitle = STEERING_HOLD_TITLES[String(steeringHoldReason || '').trim()]
    || 'Steering is momentarily unavailable';

  if (metadataBlocked && !active) {
    return {
      action: 'send',
      label: 'Send',
      title: 'Refresh model metadata to send',
      disabled: true,
    };
  }

  // Uploads are eager, so the blocking window is short. The control keeps its
  // Send/Steer/Queue meaning while it waits.
  if (uploading) {
    const midTurn = active && draft;
    return {
      action: midTurn ? midTurnAction : 'send',
      label: midTurn ? midTurnLabel : 'Send',
      title: 'Waiting for attachments to finish uploading',
      disabled: true,
    };
  }

  if (sendInFlight) {
    return {
      action: active && draft ? midTurnAction : 'send',
      label: active && draft ? midTurnLabel : 'Send',
      title: active && draft ? midTurnTitle : 'Send message',
      disabled: true,
    };
  }

  if (active && draft) {
    if (held) {
      return {
        action: midTurnAction,
        label: midTurnLabel,
        title: heldTitle,
        disabled: true,
      };
    }
    return {
      action: midTurnAction,
      label: midTurnLabel,
      title: midTurnTitle,
      disabled: false,
    };
  }

  if (active) {
    // Empty composer during a live turn: nothing to send, nothing to steer.
    // The label stays "Send" (it only reads "Steer" with text present) and
    // re-enables the moment the user types or the turn ends.
    return {
      action: 'send',
      label: 'Send',
      title: 'Type a message to send',
      disabled: true,
    };
  }

  return {
    action: 'send',
    label: 'Send',
    title: 'Send message',
    disabled: false,
  };
}
