'use strict';

// The list of messages a conversation hides from its shared viewers: one
// short plain-text preview per message, the same shape as the pin list, so
// the owner's 🙈 list and its count cover messages outside the loaded page.
// Owner-only: the shared payload never carries it.

import { buildPinPreview, countAttachments } from './message-pin-list.mjs';

export function buildHiddenMessageList(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row?.id || '').trim())
    .map((row) => ({
      messageId: String(row.id).trim(),
      role: String(row.role || '').trim(),
      preview: buildPinPreview(row.text, row.mode),
      timestamp: row.timestamp || null,
      hiddenAt: row.share_hidden_at || null,
      attachmentCount: countAttachments(row.attachments),
    }));
}
