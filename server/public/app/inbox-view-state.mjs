// What the Inbox and the 📓 panel remember of how they are shown, in one
// localStorage key (`oar_inbox_view`): the filters (who, Unanswered, This
// relay, the picked groups) and the folds (folded sections, folded cards).
// Pure: the storage is handed in.
//
// A fold is kept by item key (`relayId\nitemId`), at most 300, the oldest
// dropped first; a new item is not in the list, so it comes unfolded. A load
// forgets the keys of items, groups and sections no longer listed, except a
// paired relay's that did not answer: its items did not leave, they are just
// not shown.

import { INBOX_FILTERS, inboxGroupChoices, inboxRelayKey, inboxSections } from './inbox-sections.mjs';

export const INBOX_VIEW_STORAGE_KEY = 'oar_inbox_view';
// The filter's key before 0.9.32: read once as `who`, then removed.
export const INBOX_LEGACY_FILTER_KEY = 'oar_inbox_filter';
export const INBOX_FOLDED_ITEMS_MAX = 300;
const LIST_MAX = 300;

function cleanList(value, max = LIST_MAX) {
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const text = typeof entry === 'string' ? entry : '';
    if (text && text.length <= 600) {
      seen.delete(text);
      seen.add(text);
    }
  }
  return [...seen].slice(-max);
}

/** A view as stored, whatever was read: unknown parts take their defaults. */
export function normalizeInboxView(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    who: INBOX_FILTERS.includes(value.who) ? value.who : 'all',
    unanswered: value.unanswered === true,
    thisRelay: value.thisRelay === true,
    groups: cleanList(value.groups),
    foldedSections: cleanList(value.foldedSections),
    foldedItems: cleanList(value.foldedItems, INBOX_FOLDED_ITEMS_MAX),
  };
}

/** The view from storage; a stored `oar_inbox_filter` becomes its `who` once, and goes. */
export function readInboxView(storage) {
  let stored = null;
  let legacy = null;
  try {
    stored = storage?.getItem?.(INBOX_VIEW_STORAGE_KEY) ?? null;
    legacy = storage?.getItem?.(INBOX_LEGACY_FILTER_KEY) ?? null;
  } catch {}
  let parsed = null;
  if (stored !== null) {
    try {
      parsed = JSON.parse(stored);
    } catch {}
  }
  const view = normalizeInboxView(parsed ?? (legacy !== null ? { who: String(legacy) } : null));
  if (legacy !== null) {
    try {
      storage.removeItem(INBOX_LEGACY_FILTER_KEY);
      if (stored === null) writeInboxView(storage, view);
    } catch {}
  }
  return view;
}

export function writeInboxView(storage, view) {
  try {
    storage?.setItem?.(INBOX_VIEW_STORAGE_KEY, JSON.stringify(normalizeInboxView(view)));
  } catch {}
}

/** A card's key: its relay and its id. */
export function inboxItemKey(relayId, itemId) {
  return `${String(relayId || '').trim() || 'self'}\n${String(itemId || '').trim()}`;
}

/** `list` with `value` added (at the end) or taken out. */
export function toggleInList(list, value, on = !list.includes(value)) {
  const rest = list.filter((entry) => entry !== value);
  return on ? [...rest, value] : rest;
}

/** The view with the cards of `keys` folded (or unfolded), the newest folds kept. */
export function setItemsFolded(view, keys, folded) {
  const drop = new Set(keys);
  const rest = view.foldedItems.filter((key) => !drop.has(key));
  const foldedItems = folded ? [...rest, ...keys].slice(-INBOX_FOLDED_ITEMS_MAX) : rest;
  return { ...view, foldedItems };
}

/**
 * `stored` (another tab may have written it since this one read it) with
 * only what changed from `before` to `after` applied: a filter that changed
 * takes its new value; a list gets the entries added and loses the ones
 * taken out, so a fold made in another tab is not lost.
 */
export function mergeInboxViewChange(stored, before, after) {
  const base = normalizeInboxView(stored);
  const was = normalizeInboxView(before);
  const now = normalizeInboxView(after);
  const merged = { ...base };
  for (const key of ['who', 'unanswered', 'thisRelay']) {
    if (now[key] !== was[key]) merged[key] = now[key];
  }
  for (const key of ['groups', 'foldedSections', 'foldedItems']) {
    const added = now[key].filter((entry) => !was[key].includes(entry));
    const removed = new Set(was[key].filter((entry) => !now[key].includes(entry)));
    if (!added.length && !removed.size) continue;
    merged[key] = [...base[key].filter((entry) => !removed.has(entry) && !added.includes(entry)), ...added];
  }
  return normalizeInboxView(merged);
}

function sameList(a, b) {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * The view after an Inbox load (GET /api/inbox's relays): folds of items no
 * longer listed, groups no longer there and sections gone are forgotten; a
 * relay that did not answer keeps its own. Returns the same object when
 * nothing changed.
 */
export function pruneInboxView(view, relays, { now = Date.now() } = {}) {
  const list = Array.isArray(relays) ? relays : [];
  const relayIds = new Set(list.map(inboxRelayKey));
  const kept = new Set(list.filter((relay) => relay?.reachable === false).map(inboxRelayKey));
  const listed = new Set();
  for (const section of inboxSections(list, { now })) {
    for (const item of [...section.pending, ...section.closed]) listed.add(inboxItemKey(inboxRelayKey(section.relay), item.id));
  }
  const groups = new Set(inboxGroupChoices(list, { now }).map((choice) => choice.key));
  const relayOf = (key) => key.split('\n')[0];
  const keep = (key, known) => known.has(key) || kept.has(relayOf(key));
  const foldedItems = view.foldedItems.filter((key) => keep(key, listed));
  const picked = view.groups.filter((key) => keep(key, groups));
  // A relay's own fold is its id (no line break); a group's is its key.
  const foldedSections = view.foldedSections.filter((key) => (key.includes('\n') ? keep(key, groups) : relayIds.has(key)));
  if (sameList(foldedItems, view.foldedItems) && sameList(picked, view.groups) && sameList(foldedSections, view.foldedSections)) return view;
  return { ...view, foldedItems, groups: picked, foldedSections };
}
