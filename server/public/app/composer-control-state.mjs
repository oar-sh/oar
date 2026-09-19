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

export function deriveComposerControlState({
  hasActiveTurn = false,
  cancelRequested = false,
  hasDraft = false,
  sendInFlight = false,
  modelMetadataBlocked = false,
  attachmentsUploading = false,
  // The conversation's provider delivers a message typed during a live turn
  // INTO that turn (mid-turn steering, currently the Claude worker) rather than
  // queueing it behind — so the control says "Steer", not "Queue". Providers
  // that still serialize keep the queue wording.
  steeringSupported = false,
} = {}) {
  const active = !!hasActiveTurn;
  const stopping = !!cancelRequested;
  const draft = !!hasDraft;
  const metadataBlocked = !!modelMetadataBlocked;
  const uploading = !!attachmentsUploading;
  // The label/title/action for a draft typed during a live turn: steer into it
  // where the provider supports that, queue behind it otherwise.
  const midTurnAction = steeringSupported ? 'steer' : 'queue';
  const midTurnLabel = steeringSupported ? 'Steer' : 'Queue';
  const midTurnTitle = steeringSupported
    ? 'Steer message into the running turn'
    : 'Queue message behind current turn';

  if (metadataBlocked && !active) {
    return {
      action: 'send',
      label: 'Send',
      title: 'Refresh model metadata to send',
      disabled: true,
    };
  }

  // Uploads are eager, so the blocking window is short. Keeping the button
  // labelled Send/Steer/Queue (rather than switching to Stop) avoids the
  // control flipping meaning mid-upload while a turn is running.
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
    if (active && draft) {
      return {
        action: midTurnAction,
        label: midTurnLabel,
        title: midTurnTitle,
        disabled: true,
      };
    }
    if (active) {
      return {
        action: 'stop',
        label: stopping ? 'Stopping…' : 'Stop',
        title: stopping ? 'Stopping the current turn' : 'Stop the current turn',
        disabled: true,
      };
    }
    return {
      action: 'send',
      label: 'Send',
      title: 'Send message',
      disabled: true,
    };
  }

  if (active && draft) {
    return {
      action: midTurnAction,
      label: midTurnLabel,
      title: midTurnTitle,
      disabled: false,
    };
  }

  if (active) {
    return {
      action: 'stop',
      label: stopping ? 'Stopping…' : 'Stop',
      title: stopping ? 'Stopping the current turn' : 'Stop the current turn',
      disabled: stopping,
    };
  }

  return {
    action: 'send',
    label: 'Send',
    title: 'Send message',
    disabled: false,
  };
}
