// The Inbox's model, without DOM: which items show (the filters), in which
// relay section and which group sub-section, in what order. inbox-view.mjs
// draws it; inbox-view-state.mjs keeps the filters and folds.
//
// A section per relay: this one first, then the paired ones as listed. In it
// a sub-section per conversation group of the items' sessions (`session.group`,
// `{ id, name }` from the relay that owns the session; a relay before 0.9.32
// sends none), ordered by name so they never reorder while read, "No group"
// last. Each part lists its pending items newest first, then what was closed
// in the last day.

export const INBOX_ANSWERED_KEEP_MS = 24 * 60 * 60_000;
export const INBOX_FILTERS = Object.freeze(['all', 'mine', 'agents']);
export const INBOX_NO_GROUP_LABEL = 'No group';
// A group name as shown; the relay caps its own at 60.
const GROUP_NAME_MAX = 80;

// A plan card that was acted on is closed too.
const CLOSED_STATUSES = new Set(['answered', 'dismissed', 'acted']);

function toText(value) {
  return String(value ?? '').trim();
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

/**
 * The filters of a view (inbox-view-state.mjs) or a plain "all" / "mine" /
 * "agents": `{ who, unanswered, thisRelay, groups }`.
 */
export function normalizeInboxFilter(filter) {
  const raw = typeof filter === 'string' ? { who: filter } : (filter && typeof filter === 'object' ? filter : {});
  return {
    who: INBOX_FILTERS.includes(raw.who) ? raw.who : 'all',
    unanswered: raw.unanswered === true,
    thisRelay: raw.thisRelay === true,
    groups: Array.isArray(raw.groups) ? raw.groups.map(String).filter(Boolean) : [],
  };
}

/** An item's relay id as fold and group keys use it. */
export function inboxRelayKey(relay) {
  return toText(relay?.id) || 'self';
}

/** A group's key in the picker and the section folds: `relayId\ngroupId` ("" for no group). */
export function inboxGroupKey(relayId, groupId = '') {
  return `${toText(relayId) || 'self'}\n${toText(groupId)}`;
}

/** The group an item's session sits in: `{ id, name }`, or null. */
export function inboxGroupOf(item) {
  const group = item?.session?.group;
  const id = toText(group?.id);
  if (!id) return null;
  return { id, name: toText(group.name).replace(/\s+/g, ' ').slice(0, GROUP_NAME_MAX) || 'Group' };
}

function isClosed(item) {
  return CLOSED_STATUSES.has(toText(item?.status));
}

// When an item was closed: answered, a plan card acted on, else made.
function closedAt(item) {
  return item?.answeredAt || item?.actedAt || item?.createdAt;
}

function newestFirst(a, b) {
  return toText(b?.createdAt).localeCompare(toText(a?.createdAt));
}

// What a relay lists: pending, and closed in the last day.
function listedItems(relay, now) {
  return (Array.isArray(relay?.items) ? relay.items : []).filter((item) => {
    if (!item || !toText(item.id)) return false;
    if (toText(item.status) === 'pending') return true;
    return isClosed(item) && now - (Date.parse(toText(closedAt(item))) || 0) <= INBOX_ANSWERED_KEEP_MS;
  });
}

function byName(a, b) {
  if (!a.id !== !b.id) return a.id ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

/**
 * The groups that have items, for the Groups picker: per reachable relay
 * (this one first), by name, "No group" last. `label` names a paired
 * relay's groups with that relay.
 */
export function inboxGroupChoices(relays, { now = Date.now() } = {}) {
  const choices = [];
  for (const relay of Array.isArray(relays) ? relays : []) {
    if (relay?.reachable === false) continue;
    const relayId = inboxRelayKey(relay);
    const relayName = toText(relay?.name) || relayId;
    const found = new Map();
    for (const item of listedItems(relay, now)) {
      const group = inboxGroupOf(item);
      const id = group?.id || '';
      if (!found.has(id)) found.set(id, { id, name: group?.name || INBOX_NO_GROUP_LABEL });
    }
    for (const group of [...found.values()].sort(byName)) {
      choices.push({
        key: inboxGroupKey(relayId, group.id),
        relayId,
        id: group.id,
        name: group.name,
        label: relay?.self === true ? group.name : `${group.name} · ${relayName}`,
      });
    }
  }
  return choices;
}

/**
 * The picked groups that still have items; empty: no group filter. A key
 * of a group gone, or of a relay that did not answer, is left out. With no
 * real group listed the picker is not drawn, so nothing it holds filters:
 * a "No group" tick alone would hide items with no way to undo it.
 */
export function inboxGroupSelection(groups, relays, { now = Date.now() } = {}) {
  const wanted = new Set(Array.isArray(groups) ? groups.map(String) : []);
  if (!wanted.size) return new Set();
  const choices = inboxGroupChoices(relays, { now });
  if (!choices.some((choice) => choice.id)) return new Set();
  return new Set(choices.map((choice) => choice.key).filter((key) => wanted.has(key)));
}

/** "3 waiting · 2 answered", the parts that are not zero. */
export function inboxCountsText(pending, closed) {
  const waiting = Array.isArray(pending) ? pending.length : Number(pending) || 0;
  const done = Array.isArray(closed) ? closed.length : Number(closed) || 0;
  return [waiting ? `${waiting} waiting` : '', done ? `${done} answered` : ''].filter(Boolean).join(' · ');
}

function byClosedAt(a, b) {
  return toText(closedAt(b)).localeCompare(toText(closedAt(a)));
}

/**
 * The Inbox's sections: per relay (this one first, then the paired ones as
 * listed; "This relay" keeps this one alone), its pending items newest first
 * and its items closed in the last day ("Unanswered" drops those), split
 * into `groups`. `listed` and `listedPending` count the relay's items (all,
 * pending) before any filter. A
 * relay that did not answer shows as such, with nothing listed.
 * `filter`: "all" / "mine" / "agents", or `{ who, unanswered, thisRelay, groups }`.
 */
export function inboxSections(relays, { filter = 'all', now = Date.now() } = {}) {
  const view = normalizeInboxFilter(filter);
  const list = Array.isArray(relays) ? relays : [];
  const picked = inboxGroupSelection(view.groups, list, { now });
  return list.filter((relay) => !view.thisRelay || relay?.self === true).map((relay) => {
    const relayId = inboxRelayKey(relay);
    const listed = listedItems(relay, now);
    const items = listed.filter((item) => inboxFilterMatches(item, view.who)
      && (!picked.size || picked.has(inboxGroupKey(relayId, inboxGroupOf(item)?.id))));
    const pending = items.filter((item) => toText(item.status) === 'pending').sort(newestFirst);
    const closed = view.unanswered ? [] : items.filter(isClosed).sort(byClosedAt);
    const buckets = new Map();
    for (const [part, entries] of [['pending', pending], ['closed', closed]]) {
      for (const item of entries) {
        const group = inboxGroupOf(item);
        const id = group?.id || '';
        if (!buckets.has(id)) buckets.set(id, { key: inboxGroupKey(relayId, id), id, name: group?.name || INBOX_NO_GROUP_LABEL, pending: [], closed: [] });
        buckets.get(id)[part].push(item);
      }
    }
    return {
      relay: {
        id: toText(relay?.id),
        name: toText(relay?.name) || toText(relay?.id),
        self: relay?.self === true,
        url: toText(relay?.url),
        // Its page answers `?answer=` (capabilities.answerLink): popup buttons.
        answerLink: relay?.answerLink === true,
        reachable: relay?.reachable !== false,
        error: toText(relay?.error),
        // A relay that shares no Inbox with this one by design (added one
        // way): one quiet line, no "Not reachable".
        note: toText(relay?.note),
      },
      pending,
      closed,
      groups: [...buckets.values()].sort(byName),
      listed: listed.length,
      // Pending before any filter: a section that hides one says so.
      listedPending: listed.filter((item) => toText(item.status) === 'pending').length,
    };
  });
}

/** Whether any filter narrows the list ("This relay" with only this relay does not). */
export function inboxFilterActive(filter, relays, { now = Date.now() } = {}) {
  const view = normalizeInboxFilter(filter);
  const list = Array.isArray(relays) ? relays : [];
  return view.who !== 'all' || view.unanswered
    || (view.thisRelay && list.some((relay) => relay?.self !== true))
    || inboxGroupSelection(view.groups, list, { now }).size > 0;
}
