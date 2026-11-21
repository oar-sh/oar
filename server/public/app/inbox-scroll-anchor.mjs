// Keeps a list of cards still while it is drawn anew under the reader: the
// Inbox and the 📓 panel replace every node on each refresh, and putting
// back only the old scrollTop moves the text by a whole card whenever one
// is added, answered or removed above the reader. A position is therefore
// held by content: the first card the reader sees and the next few, each
// with its offset from the scroller's top. After the redraw the first of
// them still in the same section is put back at its offset.
//
// A card that changed section (answered, so moved under "Answered in the
// last day") does not hold the position: it went away from the reader, and
// the card after it is the one to keep in place.

// The first card the reader sees and this many after it.
const FOLLOWING_ITEMS = 3;

/** The cards of the Inbox and of the 📓 panel. */
export const INBOX_ITEM_SELECTOR = '.inbox-item';

function toText(value) {
  return String(value ?? '').trim();
}

/** A card's key: its relay and its item id. Empty for a card with no id. */
export function inboxItemKey(node) {
  const itemId = toText(node?.dataset?.itemId);
  return itemId ? `${toText(node.dataset.relayId) || 'self'}\n${itemId}` : '';
}

// Whether a card comes after the "Answered in the last day" divider.
function afterDivider(node) {
  for (let prev = node?.previousElementSibling; prev; prev = prev.previousElementSibling) {
    if (prev.classList?.contains('inbox-divider')) return true;
  }
  return false;
}

/**
 * A card's section: its relay's group in the Inbox, and whether it waits
 * (pending) or is done (closed). The card's status says which; a card that
 * has none (a relay notice) goes by where it sits.
 */
export function inboxItemSection(node) {
  const relay = toText(node?.closest?.('.inbox-relay')?.dataset?.relayId);
  const status = toText(node?.dataset?.status);
  const closed = status ? status !== 'pending' : afterDivider(node);
  return `${relay}\n${closed ? 'closed' : 'pending'}`;
}

function itemsOf(scroller, itemSelector) {
  return typeof scroller?.querySelectorAll === 'function' ? Array.from(scroller.querySelectorAll(itemSelector)) : [];
}

/**
 * Where the reader is in the list: the old scrollTop, and the first card
 * whose bottom is below the scroller's top plus the next ones, each with
 * its key, its section and its offset from the scroller's top. Null without
 * a scroller.
 */
export function captureListAnchor(scroller, itemSelector = INBOX_ITEM_SELECTOR, { keyOf = inboxItemKey, sectionOf = inboxItemSection } = {}) {
  if (!scroller) return null;
  const anchor = { scrollTop: Number(scroller.scrollTop || 0), items: [] };
  const view = scroller.getBoundingClientRect();
  for (const node of itemsOf(scroller, itemSelector)) {
    const rect = node.getBoundingClientRect();
    // A card not drawn (hidden) has no box to hold.
    if (!(rect.bottom - rect.top > 0)) continue;
    if (!anchor.items.length && rect.bottom <= view.top + 1) continue;
    const key = toText(keyOf(node));
    if (!key) continue;
    anchor.items.push({ key, section: toText(sectionOf(node)), offset: rect.top - view.top });
    if (anchor.items.length > FOLLOWING_ITEMS) break;
  }
  return anchor;
}

/**
 * Scrolls so the first captured card still in its section sits at its old
 * offset. With none left, the old scrollTop is put back. Returns true when
 * a card held the position.
 */
export function restoreListAnchor(scroller, anchor, itemSelector = INBOX_ITEM_SELECTOR, { keyOf = inboxItemKey, sectionOf = inboxItemSection } = {}) {
  if (!scroller || !anchor) return false;
  const byKey = new Map();
  for (const node of itemsOf(scroller, itemSelector)) {
    const key = toText(keyOf(node));
    if (key && !byKey.has(key)) byKey.set(key, node);
  }
  for (const entry of anchor.items || []) {
    const node = byKey.get(entry.key);
    if (!node || toText(sectionOf(node)) !== entry.section) continue;
    const rect = node.getBoundingClientRect();
    if (!(rect.bottom - rect.top > 0)) continue;
    const delta = rect.top - scroller.getBoundingClientRect().top - Number(entry.offset || 0);
    if (Math.abs(delta) > 0.5) scroller.scrollTop = Number(scroller.scrollTop || 0) + delta;
    return true;
  }
  scroller.scrollTop = Number(anchor.scrollTop || 0);
  return false;
}
