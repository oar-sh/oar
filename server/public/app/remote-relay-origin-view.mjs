// Provenance of work another relay's agent started here: the badge on a user
// bubble ("↗ from win-test · “report builder” · claude-sonnet-5", linking back
// to the source session) and the "↗ win-test" marker on the sidebar row of a
// conversation such an agent created. Both read the `origin` the relay stores
// with the message or conversation (docs/plans/2026-09-27-remote-relays.md §4).

import { remoteConversationUrl } from './remote-relay-shared.mjs';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** The display fields of an `origin`, or null when it names no relay. */
export function normalizeRemoteOrigin(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const relayName = oneLine(raw.relayName);
  const relayId = oneLine(raw.relayId);
  if (!relayName && !relayId) return null;
  const relayUrl = oneLine(raw.relayUrl);
  return {
    relayName: relayName || relayId,
    relayUrl: /^https?:\/\//i.test(relayUrl) ? relayUrl : '',
    conversationId: oneLine(raw.conversationId),
    conversationTitle: oneLine(raw.conversationTitle),
    model: oneLine(raw.model),
  };
}

export function remoteOriginBadgeText(origin) {
  const normalized = normalizeRemoteOrigin(origin);
  if (!normalized) return '';
  const parts = [`↗ from ${normalized.relayName}`];
  if (normalized.conversationTitle) parts.push(`“${normalized.conversationTitle}”`);
  if (normalized.model) parts.push(normalized.model);
  return parts.join(' · ');
}

/** `<relayUrl>/?conv=<conversationId>`, or '' when the origin has no URL. */
export function remoteOriginLink(origin) {
  const normalized = normalizeRemoteOrigin(origin);
  if (!normalized?.relayUrl) return '';
  return remoteConversationUrl(normalized.relayUrl, normalized.conversationId);
}

/**
 * The badge row that sits above a user bubble's text. `linkable: false` (the
 * shared read-only view) renders it without the link to the other relay.
 */
export function renderRemoteOriginBadgeHtml(origin, { linkable = true } = {}) {
  const normalized = normalizeRemoteOrigin(origin);
  if (!normalized) return '';
  const label = escapeHtml(remoteOriginBadgeText(normalized));
  const href = linkable ? remoteOriginLink(normalized) : '';
  const name = escapeHtml(normalized.relayName);
  if (href) {
    return `<div class="msg-origin"><a class="msg-origin-badge" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="Sent by an agent on relay ${name}. Opens its session there.">${label}</a></div>`;
  }
  return `<div class="msg-origin"><span class="msg-origin-badge" title="Sent by an agent on relay ${name}.">${label}</span></div>`;
}

/** The sidebar marker for a conversation another relay's agent created. */
export function renderConversationOriginMarkerHtml(conversation) {
  const normalized = normalizeRemoteOrigin(conversation?.origin);
  if (!normalized) return '';
  const name = escapeHtml(normalized.relayName);
  return `<span class="conv-origin-marker" title="Started by an agent on relay ${name}">↗ ${name}</span>`;
}
