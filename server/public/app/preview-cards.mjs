// Preview cards: live dev servers published through the preview lane. Fed by
// the `previews` socket event (REPLACE semantics for the whole set, since the
// registry is relay-owned and global) and by the conversation payload's
// `previews` on reload.
//
// The same row builder serves both surfaces: the composer's background-task
// panel (this conversation's previews, beside the Bash task running the dev
// server) and the settings modal's "Live previews" list (every session's).
// Previews never expire, so the settings list is the one place that can always
// close a link left behind in a conversation you have moved on from.

import { apiFetch } from './api-client.js';

let previews = [];
const closesInFlight = new Set();
const subscribers = new Set();

export function subscribePreviews(callback) {
  if (typeof callback !== 'function') return () => {};
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

function notify() {
  for (const callback of subscribers) {
    try { callback(previews); } catch {}
  }
}

function normalizePreview(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const token = String(entry.token || '').trim();
  if (!token) return null;
  return {
    token,
    conversationId: String(entry.conversationId || '').trim() || null,
    label: String(entry.label || '').trim() || 'Preview',
    targetHost: String(entry.targetHost || '').trim(),
    targetPort: Number(entry.targetPort) || null,
    url: String(entry.url || '').trim(),
    basePath: String(entry.basePath || '').trim(),
    createdAt: Number(entry.createdAt) || null,
    // null = not probed yet; the badge stays absent rather than guessing.
    online: entry.online === true ? true : (entry.online === false ? false : null),
  };
}

export function setPreviews(nextPreviews) {
  previews = (Array.isArray(nextPreviews) ? nextPreviews : [])
    .map(normalizePreview)
    .filter(Boolean);
  notify();
}

// The conversation payload only carries that conversation's previews, so it
// merges into the global set rather than replacing it — otherwise opening a
// conversation would erase every other session's cards until the next socket
// event.
export function mergeConversationPreviews(conversationId, conversationPreviews) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const incoming = (Array.isArray(conversationPreviews) ? conversationPreviews : [])
    .map(normalizePreview)
    .filter(Boolean);
  previews = previews.filter((entry) => entry.conversationId !== id).concat(incoming);
  notify();
}

export function getPreviews() {
  return previews;
}

export function getPreviewsForConversation(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return [];
  return previews.filter((entry) => entry.conversationId === id);
}

export async function closePreview(token) {
  const id = String(token || '').trim();
  if (!id || closesInFlight.has(id)) return;
  closesInFlight.add(id);
  notify();
  try {
    // apiFetch resolves to null on a network error or a non-2xx status rather
    // than throwing, so success has to be checked, not assumed: a card removed
    // on a failed DELETE would hide a link that is still publicly live.
    const response = await apiFetch(`/api/previews/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (response?.ok === true) {
      // Optimistic removal: the socket event will confirm, but the card should
      // not linger while the round trip completes.
      previews = previews.filter((entry) => entry.token !== id);
    }
  } catch {
    // Left in place on failure so the user can retry rather than lose the link.
  } finally {
    closesInFlight.delete(id);
    notify();
  }
}

async function copyPreviewUrl(url, button) {
  try {
    await navigator.clipboard.writeText(url);
    const previousText = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = previousText; }, 1500);
  } catch {
    button.textContent = 'Copy failed';
  }
}

function previewDetail(preview, { withConversation = false } = {}) {
  const parts = [];
  if (preview.targetPort) parts.push(`:${preview.targetPort}`);
  if (preview.online === false) parts.push('offline — dev server not responding');
  if (withConversation && preview.conversationId) {
    parts.push(`session ${preview.conversationId.slice(0, 8)}`);
  }
  return parts.join(' · ');
}

/**
 * One preview row. Built with createElement/textContent throughout: a label is
 * agent-supplied text and must never be able to execute as markup.
 */
export function buildPreviewRow(preview, { withConversation = false } = {}) {
  const row = document.createElement('div');
  row.className = 'preview-row';
  row.dataset.token = preview.token;
  if (preview.online === false) row.classList.add('preview-row-offline');

  const icon = document.createElement('span');
  icon.className = 'preview-icon';
  icon.textContent = '🌐';
  icon.title = 'Preview server';
  row.appendChild(icon);

  const main = document.createElement('span');
  main.className = 'preview-main';
  row.appendChild(main);

  const label = document.createElement('span');
  label.className = 'preview-label';
  label.textContent = preview.label;
  main.appendChild(label);

  const detailText = previewDetail(preview, { withConversation });
  if (detailText) {
    const detail = document.createElement('span');
    detail.className = 'preview-detail';
    detail.textContent = detailText;
    main.appendChild(detail);
  }

  // The link is public: anyone who has it reaches the dev server without
  // logging in, so the card says so rather than leaving it to be discovered.
  const warning = document.createElement('span');
  warning.className = 'preview-warning';
  warning.textContent = 'public link — anyone with the URL can reach this app';
  main.appendChild(warning);

  const side = document.createElement('span');
  side.className = 'preview-side';
  row.appendChild(side);

  if (preview.online !== null) {
    const badge = document.createElement('span');
    badge.className = preview.online
      ? 'preview-badge preview-badge-online'
      : 'preview-badge preview-badge-offline';
    badge.textContent = preview.online ? 'online' : 'offline';
    side.appendChild(badge);
  }

  const actions = document.createElement('span');
  actions.className = 'preview-actions';
  side.appendChild(actions);

  const open = document.createElement('a');
  open.className = 'preview-open';
  open.href = preview.url;
  open.target = '_blank';
  // noopener/noreferrer: the preview is a different origin running app code we
  // do not control, and it has no business holding a handle on this window.
  open.rel = 'noopener noreferrer';
  open.textContent = 'Open';
  actions.appendChild(open);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'preview-copy';
  copy.textContent = 'Copy link';
  copy.addEventListener('click', (event) => {
    event.preventDefault();
    void copyPreviewUrl(preview.url, copy);
  });
  actions.appendChild(copy);

  const closing = closesInFlight.has(preview.token);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'preview-close';
  close.disabled = closing;
  close.textContent = closing ? 'Closing…' : 'Close';
  close.addEventListener('click', (event) => {
    event.preventDefault();
    void closePreview(preview.token);
  });
  actions.appendChild(close);

  return row;
}

/**
 * Transcript card for a preview published during a turn. Renders from the
 * persisted snapshot (the registry may be long gone), overlaying live state
 * from the current store: a token still registered gets a working row, a
 * vanished one keeps the label but drops the dead link for a `closed` badge.
 */
export function buildTranscriptPreviewCard(snapshot) {
  const preview = normalizePreview(snapshot);
  if (!preview) return null;
  const live = previews.some((entry) => entry.token === preview.token);

  const card = document.createElement('div');
  card.className = live ? 'msg-preview-card' : 'msg-preview-card msg-preview-card-closed';

  const icon = document.createElement('span');
  icon.className = 'preview-icon';
  icon.textContent = '🌐';
  card.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'preview-label';
  label.textContent = preview.label;
  card.appendChild(label);

  if (live) {
    const open = document.createElement('a');
    open.className = 'preview-open';
    open.href = preview.url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Open';
    card.appendChild(open);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'preview-copy';
    copy.textContent = 'Copy link';
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      void copyPreviewUrl(preview.url, copy);
    });
    card.appendChild(copy);
  } else {
    const badge = document.createElement('span');
    badge.className = 'preview-badge preview-badge-offline';
    badge.textContent = 'closed';
    card.appendChild(badge);
  }
  return card;
}

export function renderPreviewRowsInto(container, rows, options = {}) {
  if (!container) return 0;
  container.textContent = '';
  for (const preview of rows) {
    container.appendChild(buildPreviewRow(preview, options));
  }
  return rows.length;
}
