// The Inbox, as DOM: every pending question across this relay and its paired
// relays (GET /api/inbox), grouped by relay, newest first; what was answered
// or dismissed in the last day under a divider. And the card a question that
// does not block (remote_relay `ask`) shows in its own session.
//
// Every text here is written by an agent, some on other relays: it goes into
// the page through textContent only, never as HTML or a link. Buttons carry
// what they act on in data attributes; inbox-ui.js handles the clicks.
//
// The browser cannot import shared/ (only server/public is served): the few
// values of shared/relay-asks.mjs this needs are kept here, and
// inbox-view.test.mjs asserts they match.

export const RELAY_ASK_SOCKET_EVENT = 'relay_ask_updated';
export const INBOX_ANSWERED_KEEP_MS = 24 * 60 * 60_000;
export const INBOX_FILTERS = Object.freeze(['all', 'mine', 'agents']);

const CLOSED_STATUSES = new Set(['answered', 'dismissed']);

function toText(value) {
  return String(value ?? '').trim();
}

function el(doc, tag, className = '', text = null) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

function button(doc, className, label, data = {}) {
  const node = el(doc, 'button', className, label);
  node.type = 'button';
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null && value !== '') node.dataset[key] = String(value);
  }
  return node;
}

/** "just now", "5 min", "3 h", "2 d" since `createdAt`. */
export function formatInboxAge(createdAt, now = Date.now()) {
  const at = Date.parse(toText(createdAt));
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** A link that opens one session in a relay's web UI (remoteConversationUrl's copy). */
export function inboxSessionUrl(relayUrl, sessionId) {
  const base = toText(relayUrl).replace(/\/+$/, '');
  const id = toText(sessionId);
  if (!base || !/^https?:\/\//i.test(base)) return '';
  return id ? `${base}/?conv=${encodeURIComponent(id)}` : `${base}/`;
}

/**
 * The filter: "mine" are the questions in sessions the owner started,
 * "agents" those in sessions an agent started.
 */
export function inboxFilterMatches(item, filter = 'all') {
  if (filter === 'mine') return item?.session?.startedBy !== 'agent';
  if (filter === 'agents') return item?.session?.startedBy === 'agent';
  return true;
}

function isClosed(item) {
  return CLOSED_STATUSES.has(toText(item?.status));
}

function newestFirst(a, b) {
  return toText(b?.createdAt).localeCompare(toText(a?.createdAt));
}

/**
 * The Inbox's groups: per relay (this one first, then the paired ones as
 * listed), its pending items newest first and its items closed in the last
 * day; a relay that did not answer shows as such, with nothing listed.
 */
export function inboxSections(relays, { filter = 'all', now = Date.now() } = {}) {
  return (Array.isArray(relays) ? relays : []).map((relay) => {
    const items = (Array.isArray(relay?.items) ? relay.items : []).filter((item) => item && toText(item.id) && inboxFilterMatches(item, filter));
    const pending = items.filter((item) => toText(item.status) === 'pending').sort(newestFirst);
    const closed = items
      .filter((item) => isClosed(item) && now - (Date.parse(toText(item.answeredAt || item.createdAt)) || 0) <= INBOX_ANSWERED_KEEP_MS)
      .sort((a, b) => toText(b.answeredAt || b.createdAt).localeCompare(toText(a.answeredAt || a.createdAt)));
    return {
      relay: {
        id: toText(relay?.id),
        name: toText(relay?.name) || toText(relay?.id),
        self: relay?.self === true,
        url: toText(relay?.url),
        reachable: relay?.reachable !== false,
        error: toText(relay?.error),
      },
      pending,
      closed,
    };
  });
}

/**
 * A load that never runs twice at once, and never misses a change: a call
 * while one runs is answered by that one and asks for one more after it
 * (once, however many calls came meanwhile). Resolves with the last load's
 * result.
 */
export function createCoalescedRefresh(load) {
  let running = null;
  let again = false;
  function refresh() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let result;
      try {
        do {
          again = false;
          result = await load();
        } while (again);
        return result;
      } finally {
        running = null;
      }
    })();
    return running;
  }
  return refresh;
}

/**
 * This relay's asks out of an Inbox load (GET /api/inbox), by id: what the
 * session cards show. Built anew from each load, so an ask that was
 * withdrawn or cancelled (no longer listed) drops out.
 */
export function sessionAsksFromInbox(relays) {
  const own = (Array.isArray(relays) ? relays : []).find((relay) => relay?.self === true);
  const asks = new Map();
  for (const item of Array.isArray(own?.items) ? own.items : []) {
    if (item?.kind === 'ask' && toText(item.id)) asks.set(item.id, { ...item, conversationId: item.session?.id });
  }
  return asks;
}

/** Pending items across every relay (the sidebar's badge), whatever the filter. */
export function inboxPendingCount(relays) {
  return (Array.isArray(relays) ? relays : [])
    .reduce((sum, relay) => sum + (Array.isArray(relay?.items) ? relay.items : []).filter((item) => toText(item?.status) === 'pending').length, 0);
}

function headLine(doc, item, { relay, now, label }) {
  const head = el(doc, 'div', 'inbox-item-head');
  head.append(el(doc, 'span', 'inbox-item-kind', label));
  if (item.urgency === 'now') head.append(el(doc, 'span', 'inbox-item-urgent', 'urgent'));
  const age = formatInboxAge(item.createdAt, now);
  if (age) head.append(el(doc, 'span', 'inbox-item-age', age));
  if (relay && !relay.self) head.append(el(doc, 'span', 'inbox-item-relay', relay.name));
  return head;
}

function sessionLine(doc, item, relay, { withLink = true } = {}) {
  const line = el(doc, 'div', 'inbox-item-session');
  const title = toText(item?.session?.title) || 'Untitled session';
  if (withLink && relay?.self) {
    line.append(button(doc, 'inbox-open-session', title, { inboxAction: 'open', sessionId: item?.session?.id }));
  } else if (withLink && relay && !relay.self) {
    const url = inboxSessionUrl(relay.url, item?.session?.id);
    if (url) {
      const link = el(doc, 'a', 'inbox-open-there', title);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      line.append(link);
    } else {
      line.append(el(doc, 'span', 'inbox-session-title', title));
    }
  } else {
    line.append(el(doc, 'span', 'inbox-session-title', title));
  }
  const asker = item?.askedBy;
  if (item?.onBehalf && asker) {
    const who = [toText(asker.title) || toText(asker.conversationId), toText(asker.relay) ? `on ${toText(asker.relay)}` : ''].filter(Boolean).join(' ');
    if (who) line.append(el(doc, 'span', 'inbox-item-asker', `asked by ${who}`));
  }
  return line;
}

function outcomeLine(doc, item) {
  if (item.status === 'dismissed') return el(doc, 'div', 'inbox-item-outcome', 'Dismissed');
  if (item.status !== 'answered') return null;
  const answer = toText(item.answer) || toText(item.choice);
  const via = toText(item.answeredVia);
  return el(doc, 'div', 'inbox-item-outcome', `Answered: ${answer}${via ? ` (from ${via})` : ''}`);
}

/**
 * A question that does not block, as a card: in the Inbox (`mode` "inbox",
 * with its session and relay) or in its session ("session"). `answerable`:
 * the buttons answer it (this relay's, or a paired relay's ask).
 */
export function buildAskCard(doc, item, { relay = null, mode = 'inbox', now = Date.now(), answerable = true } = {}) {
  const card = el(doc, 'article', `inbox-item inbox-ask${mode === 'session' ? ' relay-ask-card' : ''}`);
  card.dataset.itemId = toText(item.id);
  card.dataset.kind = 'ask';
  if (relay?.id) card.dataset.relayId = relay.id;
  card.dataset.status = toText(item.status) || 'pending';
  card.append(headLine(doc, item, { relay, now, label: mode === 'session' ? 'Question for you · does not block this session' : 'Question' }));
  if (mode === 'inbox') card.append(sessionLine(doc, item, relay));
  else if (item.onBehalf && item.askedBy) card.append(sessionLine(doc, item, relay, { withLink: false }));
  card.append(el(doc, 'p', 'inbox-item-question', item.question || item.prompt || ''));
  const options = Array.isArray(item.options) ? item.options.map(toText).filter(Boolean) : [];
  const recommendation = toText(item.recommendation);
  const recommendedOption = options.find((option) => option === recommendation) || '';
  if (recommendation && !recommendedOption) card.append(el(doc, 'p', 'inbox-item-recommendation', `Recommended: ${recommendation}`));
  if (toText(item.detail)) {
    const details = el(doc, 'details', 'inbox-item-detail');
    details.append(el(doc, 'summary', '', 'Details'));
    // Plain text, line breaks kept: never parsed as markup.
    details.append(el(doc, 'pre', 'inbox-item-detail-text', item.detail));
    card.append(details);
  }
  const outcome = outcomeLine(doc, item);
  if (outcome) card.append(outcome);
  if (item.status === 'pending' && answerable) {
    const data = { relayId: relay?.id || 'self', itemId: item.id };
    if (options.length) {
      const row = el(doc, 'div', 'inbox-item-options');
      for (const option of options) {
        const choice = button(doc, `inbox-choice${option === recommendedOption ? ' recommended' : ''}`, option, { ...data, inboxAction: 'choice', choice: option });
        if (option === recommendedOption) {
          choice.append(el(doc, 'span', 'inbox-recommended-tag', 'recommended'));
          choice.setAttribute('aria-label', `${option} (recommended)`);
        }
        row.append(choice);
      }
      card.append(row);
    }
    const reply = el(doc, 'div', 'inbox-item-reply');
    const field = el(doc, 'textarea', 'inbox-answer-text');
    field.rows = 2;
    field.placeholder = options.length ? 'Or type an answer…' : 'Your answer…';
    field.setAttribute('aria-label', 'Answer');
    field.dataset.itemId = toText(item.id);
    reply.append(field);
    const actions = el(doc, 'div', 'inbox-item-actions');
    actions.append(button(doc, 'inbox-answer', 'Answer', { ...data, inboxAction: 'answer' }));
    actions.append(button(doc, 'inbox-dismiss', 'Dismiss', { ...data, inboxAction: 'dismiss' }));
    reply.append(actions);
    card.append(reply);
  }
  return card;
}

/**
 * A card a turn waits on (ask_user) or an approval card, in the Inbox. Here:
 * a plain one is answered like in its session (choices, or typed text); one
 * with fields or several picks opens its session. A paired relay's is never
 * answered from here: "Open there".
 */
export function buildCardItem(doc, item, { relay = null, now = Date.now() } = {}) {
  const approval = item.kind === 'approval';
  const card = el(doc, 'article', `inbox-item inbox-card${approval ? ' inbox-approval' : ''}`);
  card.dataset.itemId = toText(item.id);
  card.dataset.kind = toText(item.kind) || 'ask_user';
  if (relay?.id) card.dataset.relayId = relay.id;
  card.dataset.status = toText(item.status) || 'pending';
  card.append(headLine(doc, item, { relay, now, label: approval ? 'Approval · the session waits' : 'Question · the session waits' }));
  card.append(sessionLine(doc, item, relay));
  if (toText(item.header)) card.append(el(doc, 'div', 'inbox-item-header', item.header));
  if (toText(item.question)) card.append(el(doc, 'p', 'inbox-item-question', item.question));
  else if (approval) card.append(el(doc, 'p', 'inbox-item-question', 'An Allow / Deny card on that relay.'));
  const outcome = outcomeLine(doc, item);
  if (outcome) card.append(outcome);
  if (item.status !== 'pending') return card;
  if (!relay?.self) {
    const url = inboxSessionUrl(relay?.url, item?.session?.id);
    const actions = el(doc, 'div', 'inbox-item-actions');
    if (url) {
      const link = el(doc, 'a', 'inbox-open-there inbox-open-there-button', 'Open there');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.append(link);
    } else {
      actions.append(el(doc, 'span', 'inbox-item-note', 'Answer it on that relay.'));
    }
    card.append(actions);
    return card;
  }
  const options = Array.isArray(item.options) ? item.options.map(toText).filter(Boolean) : [];
  const data = { relayId: 'self', itemId: item.id, sessionId: item?.session?.id, sdkSessionId: item.sdkSessionId || '' };
  if (item.structured || item.multiSelect) {
    const actions = el(doc, 'div', 'inbox-item-actions');
    actions.append(button(doc, 'inbox-open-session-button', 'Open the session to answer', { inboxAction: 'open', sessionId: item?.session?.id }));
    card.append(actions);
    return card;
  }
  if (options.length) {
    const row = el(doc, 'div', 'inbox-item-options');
    for (const option of options) row.append(button(doc, 'inbox-choice', option, { ...data, inboxAction: 'card-choice', choice: option }));
    card.append(row);
  }
  if (item.allowFreeform !== false || !options.length) {
    const reply = el(doc, 'div', 'inbox-item-reply');
    const field = el(doc, 'textarea', 'inbox-answer-text');
    field.rows = 2;
    field.placeholder = 'Your answer…';
    field.setAttribute('aria-label', 'Answer');
    field.dataset.itemId = toText(item.id);
    reply.append(field);
    const actions = el(doc, 'div', 'inbox-item-actions');
    actions.append(button(doc, 'inbox-answer', 'Answer', { ...data, inboxAction: 'card-answer' }));
    reply.append(actions);
    card.append(reply);
  }
  return card;
}

function buildItem(doc, item, relay, now) {
  if (item.kind === 'ask') return buildAskCard(doc, item, { relay, now, mode: 'inbox', answerable: true });
  return buildCardItem(doc, item, { relay, now });
}

/** The whole Inbox: the filter, then one group per relay. */
export function renderInbox(doc, { relays = [], filter = 'all', now = Date.now(), loading = false } = {}) {
  const root = el(doc, 'section', 'status-view inbox-view');
  root.setAttribute('aria-label', 'Inbox');
  const bar = el(doc, 'div', 'inbox-filter');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Show');
  for (const [value, label] of [['all', 'All'], ['mine', 'Mine'], ['agents', 'Agents']]) {
    const option = button(doc, `inbox-filter-option${filter === value ? ' active' : ''}`, label, { inboxFilter: value });
    option.setAttribute('aria-pressed', filter === value ? 'true' : 'false');
    bar.append(option);
  }
  root.append(bar);
  const sections = inboxSections(relays, { filter, now });
  let anything = false;
  for (const section of sections) {
    const group = el(doc, 'section', 'inbox-relay');
    group.dataset.relayId = section.relay.id;
    const heading = el(doc, 'h2', 'inbox-relay-name', section.relay.self ? `${section.relay.name} (this relay)` : section.relay.name);
    group.append(heading);
    if (!section.relay.reachable) {
      group.append(el(doc, 'p', 'inbox-relay-unreachable', `Not reachable${section.relay.error ? `: ${section.relay.error}` : ''}`));
      root.append(group);
      continue;
    }
    if (!section.pending.length && !section.closed.length) {
      if (!section.relay.self) continue;
      group.append(el(doc, 'p', 'inbox-empty', loading ? 'Loading…' : 'Nothing waits for you here.'));
    }
    for (const item of section.pending) group.append(buildItem(doc, item, section.relay, now));
    if (section.closed.length) {
      const divider = el(doc, 'div', 'inbox-divider', 'Answered in the last day');
      divider.setAttribute('role', 'separator');
      group.append(divider);
      for (const item of section.closed) group.append(buildItem(doc, item, section.relay, now));
    }
    anything = anything || section.pending.length > 0 || section.closed.length > 0;
    root.append(group);
  }
  if (!anything && filter !== 'all') root.append(el(doc, 'p', 'inbox-empty', 'Nothing matches this filter.'));
  return root;
}
