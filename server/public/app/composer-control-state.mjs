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
} = {}) {
  const active = !!hasActiveTurn;
  const stopping = !!cancelRequested;
  const draft = !!hasDraft;
  const metadataBlocked = !!modelMetadataBlocked;
  const uploading = !!attachmentsUploading;

  if (metadataBlocked && !active) {
    return {
      action: 'send',
      label: 'Send',
      title: 'Refresh model metadata to send',
      disabled: true,
    };
  }

  // Uploads are eager, so the blocking window is short. Keeping the button
  // labelled Send/Queue (rather than switching to Stop) avoids the control
  // flipping meaning mid-upload while a turn is running.
  if (uploading) {
    const queueing = active && draft;
    return {
      action: queueing ? 'queue' : 'send',
      label: queueing ? 'Queue' : 'Send',
      title: 'Waiting for attachments to finish uploading',
      disabled: true,
    };
  }

  if (sendInFlight) {
    if (active && draft) {
      return {
        action: 'queue',
        label: 'Queue',
        title: 'Queue message behind current turn',
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
      action: 'queue',
      label: 'Queue',
      title: 'Queue message behind current turn',
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
