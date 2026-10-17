// Where a conversation row dragged in the sidebar lands, from what the
// pointer is over. DOM-free: the sidebar measures, this module decides.
//
// The list is the arranged one (conversation-group-order.mjs): loose rows and
// groups ordered by activity, each group a head (a real row, or a synthetic
// line for a group without its head in view) followed by its members while
// open. Only the order inside a group is the user's to set, so a drop either
// places a row inside a group, takes it out of one, or makes a group of two
// loose rows. Nothing reorders the top level.
//
// The pointer is over an item at a relative height `y` (0 top, 1 bottom), or
// below the last item. The rules, by what is under the pointer:
//
//   member of group G (upper half: before it; lower half: after it)
//     dragged row in G           -> reorder in G (a head of G: none, it stays first)
//     dragged row elsewhere      -> join G at that place
//   head of group G (real or synthetic)
//     lower half of an open head -> before G's first member (the head stays first)
//     upper half, or folded      -> join G at the end (outline only)
//     a member of G itself       -> lower half of the open head: to the top of G; else none
//   loose row
//     dragged row loose          -> middle half (25 % to 75 %): a new group of the two; edges: none
//     dragged row in a group     -> leave the group (it then sorts by its own activity)
//   below the last item          -> a grouped row leaves its group; a loose row: none
//
// A drop onto the dragged row itself, or one that would leave a member where
// it is, is none. A head dragged within its own group is none.

const EDGE = 0.25;

/** A drop that does nothing. */
export const NO_DROP = Object.freeze({ action: 'none', groupId: null, beforeConversationId: null, indicator: null });

function toText(value) {
  return String(value ?? '').trim();
}

/** The key of a sidebar item: its conversation id, or `group:<id>` for a synthetic head. */
export function dragItemKey({ conversationId = null, groupId = null } = {}) {
  const id = toText(conversationId);
  return id || `group:${toText(groupId)}`;
}

/**
 * Plain items from arrangeConversationList(): `{ key, kind, conversationId,
 * groupId }`, and on heads `open` and `memberIds` (the group's rows after
 * the head, in list order).
 */
export function describeDragItems(arranged) {
  const items = [];
  for (const item of Array.isArray(arranged) ? arranged : []) {
    if (!item || !['row', 'head', 'member'].includes(item.kind)) continue;
    const conversationId = toText(item.conversation?.id) || null;
    const groupId = item.kind === 'row' ? null : (toText(item.group?.id) || null);
    if (!conversationId && !groupId) continue;
    const described = { key: dragItemKey({ conversationId, groupId }), kind: item.kind, conversationId, groupId };
    if (item.kind === 'head') {
      described.open = item.group?.open !== false;
      described.memberIds = (Array.isArray(item.group?.members) ? item.group.members : [])
        .map((row) => toText(row?.id))
        .filter(Boolean);
    }
    items.push(described);
  }
  return items;
}

function drop(action, { groupId = null, beforeConversationId = null, indicator = null, targetConversationId = null } = {}) {
  return {
    action,
    groupId,
    beforeConversationId,
    indicator,
    ...(targetConversationId ? { targetConversationId } : {}),
  };
}

/**
 * The drop for `draggedId` with the pointer at `hover`: `{ key, y }` over an
 * item, `{ below: true }` under the last one, or null (nowhere). Returns
 * `{ action: 'none' | 'reorder' | 'join' | 'leave' | 'new-group', groupId,
 * beforeConversationId, indicator: { itemId, edge: 'before' | 'after' |
 * 'inside' } | null }`, with `targetConversationId` on a new group.
 */
export function resolveDropTarget({ items = [], draggedId = '', hover = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const id = toText(draggedId);
  const dragged = id ? list.find((item) => item.conversationId === id) : null;
  if (!dragged || !hover) return NO_DROP;
  const draggedGroupId = dragged.kind === 'row' ? null : dragged.groupId;
  const draggedIsHead = dragged.kind === 'head';
  const headOf = (groupId) => list.find((item) => item.kind === 'head' && item.groupId === groupId) || null;
  const membersOf = (groupId) => headOf(groupId)?.memberIds || [];

  if (hover.below) {
    const last = list[list.length - 1];
    if (!draggedGroupId || !last) return NO_DROP;
    return drop('leave', { indicator: { itemId: last.key, edge: 'after' } });
  }

  const target = list.find((item) => item.key === toText(hover.key));
  if (!target) return NO_DROP;
  if (target.conversationId && target.conversationId === id) return NO_DROP;
  const y = Math.min(1, Math.max(0, Number(hover.y) || 0));
  const half = y < 0.5 ? 'before' : 'after';

  if (target.kind === 'member') {
    const groupId = target.groupId;
    if (draggedIsHead && draggedGroupId === groupId) return NO_DROP;
    const members = membersOf(groupId);
    const index = members.indexOf(target.conversationId);
    const before = half === 'before' ? target.conversationId : (members[index + 1] ?? null);
    if (draggedGroupId === groupId) {
      // Before itself, or before the row that already follows it: no move.
      const currentNext = members[members.indexOf(id) + 1] ?? null;
      if (before === id || before === currentNext) return NO_DROP;
      return drop('reorder', { groupId, beforeConversationId: before, indicator: { itemId: target.key, edge: half } });
    }
    return drop('join', { groupId, beforeConversationId: before, indicator: { itemId: target.key, edge: half } });
  }

  if (target.kind === 'head') {
    const groupId = target.groupId;
    const members = membersOf(groupId);
    const toTop = half === 'after' && target.open === true && members.length > 0;
    if (draggedGroupId === groupId) {
      if (draggedIsHead || !toTop || members[0] === id) return NO_DROP;
      return drop('reorder', { groupId, beforeConversationId: members[0], indicator: { itemId: target.key, edge: 'after' } });
    }
    if (toTop) return drop('join', { groupId, beforeConversationId: members[0], indicator: { itemId: target.key, edge: 'after' } });
    return drop('join', { groupId, beforeConversationId: null, indicator: { itemId: target.key, edge: 'inside' } });
  }

  // A loose row.
  if (!draggedGroupId) {
    if (y < EDGE || y > 1 - EDGE) return NO_DROP;
    return drop('new-group', {
      indicator: { itemId: target.key, edge: 'inside' },
      targetConversationId: target.conversationId,
    });
  }
  return drop('leave', { indicator: { itemId: target.key, edge: half } });
}

/**
 * "Move up" / "Move down" in a group's hand order: the `beforeConversationId`
 * for the move, or null at the end it cannot pass. `memberIds` are the rows
 * after the head, in list order.
 */
export function groupMoveStep(memberIds, conversationId, direction) {
  const members = Array.isArray(memberIds) ? memberIds : [];
  const index = members.indexOf(toText(conversationId));
  if (index < 0) return null;
  if (direction === 'up') return index > 0 ? { beforeConversationId: members[index - 1] } : null;
  if (direction === 'down') return index < members.length - 1 ? { beforeConversationId: members[index + 2] ?? null } : null;
  return null;
}

/**
 * Pixels to scroll the list by in one frame while dragging: negative near
 * the top, positive near the bottom, faster toward (and past) the edge, 0
 * outside the zones.
 */
export function autoScrollStep(pointerY, top, bottom, { zone = 48, maxStep = 18 } = {}) {
  const y = Number(pointerY);
  if (!Number.isFinite(y) || !(bottom > top)) return 0;
  const reach = Math.min(zone, (bottom - top) / 2);
  if (!(reach > 0)) return 0;
  const fromTop = y - top;
  const fromBottom = bottom - y;
  const speed = (distance) => {
    const t = Math.min(1, Math.max(0, (reach - distance) / reach));
    return Math.max(1, Math.ceil(maxStep * t * t));
  };
  if (fromTop < reach && fromTop <= fromBottom) return -speed(fromTop);
  if (fromBottom < reach) return speed(fromBottom);
  return 0;
}

function quoted(text) {
  return `“${toText(text) || 'Untitled'}”`;
}

/** What a screen reader hears after a drop. */
export function dropAnnouncement(action, { title = '', groupName = '', otherTitle = '' } = {}) {
  if (action === 'reorder') return `Moved ${quoted(title)} within ${quoted(groupName)}`;
  if (action === 'join') return `Moved ${quoted(title)} to ${quoted(groupName)}`;
  if (action === 'leave') return `Removed ${quoted(title)} from its group`;
  if (action === 'new-group') return `New group with ${quoted(otherTitle)} and ${quoted(title)}`;
  return '';
}
