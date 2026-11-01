// The header's "via agent · “title”" line: the conversation on screen was
// started by an agent in another conversation on this relay, and the line
// opens that conversation. Derived from the conversation record alone, so the
// one sync function is idempotent and runs with every header sync. A
// conversation another relay's agent created has no header line (its sidebar
// marker is all there is), and neither has one a person started.

import { conversations, currentConvId, IS_SHARED_VIEW } from './store.js';
import { conversationOriginInfo, renderConversationHeaderOriginHtml } from './remote-relay-origin-view.mjs';

/**
 * The ︙ entry that stands in for the line where the meta line is hidden
 * (phone landscape): `{ label: 'Started by an agent in “title”',
 * conversationId }` while the line is a button that opens that conversation,
 * else null.
 */
export function conversationOriginMenuEntry() {
  if (IS_SHARED_VIEW) return null;
  const id = String(currentConvId || '').trim();
  const conversation = id ? (conversations[id] || null) : null;
  if (!conversation) return null;
  const info = conversationOriginInfo(conversation, { conversations, linkable: true });
  if (!info || info.kind !== 'local' || !info.linkable || !info.conversationId) return null;
  return { label: info.label, conversationId: info.conversationId };
}

let renderedHtml = '';

export function syncConversationOriginHeader() {
  const line = document.getElementById('chat-title-origin');
  if (!line) return;
  const id = String(currentConvId || '').trim();
  const conversation = id ? (conversations[id] || null) : null;
  const html = conversation
    ? renderConversationHeaderOriginHtml(conversation, { conversations, linkable: !IS_SHARED_VIEW })
    : '';
  // This runs on every list render; the button must not be rebuilt under a tap.
  if (html !== renderedHtml) {
    line.innerHTML = html;
    renderedHtml = html;
  }
  line.hidden = !html;
}
