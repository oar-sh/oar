// Provenance of work another relay's agent started here: the badge on a user
// bubble ("↗ from win-test · “report builder” · claude-sonnet-5", linking back
// to the source session) and the "↗ win-test" marker on the sidebar row of a
// conversation such an agent created. Both read the `origin` the relay stores
// with the message or conversation (docs/plans/2026-09-27-remote-relays.md §4).
//
// An agent on THIS relay can start sessions too. Such an origin carries
// `local: true` and names the conversation the agent runs in: the marker then
// reads "via agent · “title”" and opens that conversation inside the app
// (window.openOriginConversation, journal-view.js) instead of linking to
// another relay. An origin without `local` renders exactly as before.

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

// How much of the other conversation's title a marker carries; CSS ellipsis
// takes over where the row is narrower than that.
export const ORIGIN_TITLE_MAX_SIDEBAR = 28;
export const ORIGIN_TITLE_MAX = 60;

/** "a long conversation tit…": at most `max` characters, one line. */
export function truncateOriginTitle(value, max = ORIGIN_TITLE_MAX) {
  const text = oneLine(value);
  const limit = Math.max(2, Math.floor(Number(max)) || ORIGIN_TITLE_MAX);
  // By code point, so an emoji is never cut in half.
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit - 1).join('').trimEnd()}…`;
}

/** True for the origin of work an agent on this relay started. */
export function isLocalAgentOrigin(raw) {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && raw.local === true;
}

function knownConversation(conversations, id) {
  if (!id || !conversations || typeof conversations !== 'object') return null;
  const found = Object.prototype.hasOwnProperty.call(conversations, id) ? conversations[id] : null;
  return found && typeof found === 'object' ? found : null;
}

/**
 * What a local origin shows, or null when the origin is not a local one.
 * `conversations` is the browser's list by id: the marker is a link only while
 * the orchestrating conversation is in it, and shows that conversation's
 * current title (the origin stores the one it had at creation). `ownId` is the
 * conversation the marker sits on, which never links to itself.
 */
export function localAgentOriginModel(origin, {
  conversations = null,
  ownId = '',
  linkable = true,
  maxTitleLength = ORIGIN_TITLE_MAX,
} = {}) {
  if (!isLocalAgentOrigin(origin)) return null;
  const conversationId = oneLine(origin.conversationId);
  const known = conversationId !== oneLine(ownId) ? knownConversation(conversations, conversationId) : null;
  const fullTitle = oneLine(known?.title) || oneLine(origin.conversationTitle);
  const title = truncateOriginTitle(fullTitle, maxTitleLength);
  return {
    conversationId,
    fullTitle,
    title,
    model: oneLine(origin.model),
    text: title ? `via agent · “${title}”` : 'via agent',
    linkable: linkable !== false && !!known,
  };
}

// A button while the orchestrating conversation can be opened, plain text
// otherwise. `tooltip` is a full sentence.
function localAgentElementHtml(model, { className, text = model.text, tooltip }) {
  const label = escapeHtml(text);
  if (model.linkable) {
    return `<button type="button" class="${className}" data-origin-conversation-id="${escapeHtml(model.conversationId)}" title="${escapeHtml(`${tooltip} Opens that conversation.`)}" onclick="openOriginConversation(event, this)">${label}</button>`;
  }
  return `<span class="${className}" title="${escapeHtml(tooltip)}">${label}</span>`;
}

function startedByTooltip(model) {
  return model.fullTitle
    ? `Started by an agent in “${model.fullTitle}”.`
    : 'Started by an agent in another conversation on this relay.';
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

export function remoteOriginBadgeText(origin, options = {}) {
  const local = localAgentOriginModel(origin, options);
  if (local) return local.model ? `${local.text} · ${local.model}` : local.text;
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
 * `conversations` (the browser's list by id) lets a local agent's badge open
 * the conversation that agent runs in.
 */
export function renderRemoteOriginBadgeHtml(origin, { linkable = true, conversations = null } = {}) {
  const local = localAgentOriginModel(origin, { conversations, linkable });
  if (local) {
    const badge = localAgentElementHtml(local, {
      className: 'msg-origin-badge msg-origin-agent',
      text: remoteOriginBadgeText(origin, { conversations }),
      tooltip: local.fullTitle
        ? `Sent by an agent in “${local.fullTitle}”.`
        : 'Sent by an agent in another conversation on this relay.',
    });
    return `<div class="msg-origin">${badge}</div>`;
  }
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

/**
 * The sidebar marker for a conversation an agent created: "↗ win-test" for
 * another relay's agent, "via agent · “title”" for one on this relay.
 */
export function renderConversationOriginMarkerHtml(conversation, { conversations = null, linkable = true } = {}) {
  const local = localAgentOriginModel(conversation?.origin, {
    conversations,
    linkable,
    ownId: conversation?.id,
    maxTitleLength: ORIGIN_TITLE_MAX_SIDEBAR,
  });
  if (local) {
    return localAgentElementHtml(local, {
      className: 'conv-origin-marker conv-origin-agent',
      tooltip: startedByTooltip(local),
    });
  }
  const normalized = normalizeRemoteOrigin(conversation?.origin);
  if (!normalized) return '';
  const name = escapeHtml(normalized.relayName);
  return `<span class="conv-origin-marker" title="Started by an agent on relay ${name}">↗ ${name}</span>`;
}

/**
 * The same marker for the conversation header, with room for more of the
 * title. Only a local origin has one; '' for everything else.
 */
export function renderConversationHeaderOriginHtml(conversation, { conversations = null, linkable = true } = {}) {
  const local = localAgentOriginModel(conversation?.origin, { conversations, linkable, ownId: conversation?.id });
  if (!local) return '';
  return localAgentElementHtml(local, { className: 'conv-origin-agent', tooltip: startedByTooltip(local) });
}
