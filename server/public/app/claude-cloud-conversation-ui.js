// What a Claude Cloud conversation looks like once it is open: the cloud line
// above the composer (repository, branch, the session on claude.ai, one link
// per pushed branch, cost), the controls that do not apply to a cloud session
// taken away, and an attach button that only offers images.
//
// Everything is derived from the conversation record (`runtimeProviderType`
// and the server's `cloud` payload field), so the one sync function below is
// idempotent and is simply called whenever the header is synced. A
// conversation of any other provider gets every element back exactly as it was.

import { conversations, currentConvId, IS_SHARED_VIEW } from './store.js';
import { openExternalNavigation } from './external-link-policy.mjs';
import {
  CLAUDE_CLOUD_ATTACH_ACCEPT,
  CLAUDE_CLOUD_ATTACH_HINT,
  buildCloudLineModel,
  isClaudeCloudConversation,
  mergeCloudSessionUpdate,
  renderCloudLineHtml,
} from './claude-cloud-ui.mjs';

const DEFAULT_ATTACH_TITLE = 'Attach file';

let renderedLineHtml = '';

function currentConversation() {
  const id = String(currentConvId || '').trim();
  return id ? (conversations[id] || null) : null;
}

export function isCurrentConversationClaudeCloud() {
  return !IS_SHARED_VIEW && isClaudeCloudConversation(currentConversation());
}

// Hides an element for cloud chats and gives it back afterwards, without ever
// un-hiding something another owner (shared view, feature gates) had hidden.
function setHiddenForCloud(element, hide) {
  if (!element) return;
  if (hide) {
    if (!element.hidden) {
      element.hidden = true;
      element.dataset.cloudHidden = '1';
    }
    return;
  }
  if (element.dataset.cloudHidden === '1') {
    element.hidden = false;
    delete element.dataset.cloudHidden;
  }
}

export function syncClaudeCloudConversationUi() {
  const conversation = currentConversation();
  const isCloud = isCurrentConversationClaudeCloud();
  document.body.classList.toggle('claude-cloud-conversation', isCloud);

  const line = document.getElementById('cloud-session-line');
  const lineHtml = isCloud ? renderCloudLineHtml(conversation?.cloud) : '';
  if (line) {
    // This runs on every list render; the links must not be rebuilt under a tap.
    if (lineHtml !== renderedLineHtml) {
      line.innerHTML = lineHtml;
      renderedLineHtml = lineHtml;
    }
    line.hidden = !lineHtml;
  }

  // The session has no working directory on the relay host to change.
  setHiddenForCloud(document.getElementById('chat-menu-change-cwd'), isCloud);

  const openSessionButton = document.getElementById('chat-menu-open-cloud-session');
  if (openSessionButton) {
    openSessionButton.hidden = !(isCloud && buildCloudLineModel(conversation?.cloud)?.sessionUrl);
  }

  const fileInput = document.getElementById('image-input');
  if (fileInput) {
    if (isCloud) fileInput.setAttribute('accept', CLAUDE_CLOUD_ATTACH_ACCEPT);
    else fileInput.removeAttribute('accept');
  }
  const attachButton = document.getElementById('attach-btn');
  if (attachButton) {
    const title = isCloud ? CLAUDE_CLOUD_ATTACH_HINT : DEFAULT_ATTACH_TITLE;
    if (attachButton.title !== title) attachButton.title = title;
  }
}

/**
 * The `claude_cloud_session` socket event: the worker reported a session id, a
 * push or a new cost. Returns true when the record of a known conversation
 * changed; redrawing is left to the caller's usual header sync.
 */
export function applyClaudeCloudSessionEvent(payload = null) {
  const id = String(payload?.conversationId || '').trim();
  if (!id || !conversations[id]) return false;
  conversations[id] = {
    ...conversations[id],
    cloud: mergeCloudSessionUpdate(conversations[id].cloud, payload?.cloud),
  };
  if (id === String(currentConvId || '').trim()) syncClaudeCloudConversationUi();
  return true;
}

export function openCurrentCloudSession(onFallback = null) {
  if (!isCurrentConversationClaudeCloud()) return false;
  const sessionUrl = buildCloudLineModel(currentConversation()?.cloud)?.sessionUrl;
  if (!sessionUrl) return false;
  openExternalNavigation(sessionUrl, onFallback);
  return true;
}
