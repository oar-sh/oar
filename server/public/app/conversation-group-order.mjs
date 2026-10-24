// The order of the conversation list once sessions can form groups, shared by
// the list route (paging) and the sidebar (rendering) so both agree row for
// row. DOM-free.
//
// A grouped row sorts by its group's activity time: the newest `updatedAt`
// among the group's rows in the list at hand (the live list, the Archived
// view, or both). So an active member lifts its whole group. Inside a group
// the head comes first, then the members the owner placed by hand (their
// `groupPosition`, ascending), then the others newest first. An ungrouped row
// sorts by its own time. Ties fall back to ids, descending, as the list
// always has.
//
// A page never ends inside a group: the server extends it to the group's last
// row, so a client always holds whole groups and can count and fold them.

function toText(value) {
  return String(value ?? '').trim();
}

/** `updatedAt` as milliseconds: ISO, SQLite's "YYYY-MM-DD HH:MM:SS" (UTC), or a number. */
export function parseConversationTimeMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = toText(value);
  if (!text) return 0;
  const sqliteUtcLike = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)$/;
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  let normalized = text;
  if (!hasExplicitTimezone && sqliteUtcLike.test(text)) {
    const [, day, time] = text.match(sqliteUtcLike) || [];
    normalized = `${day}T${time}Z`;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowId(row) {
  return toText(row?.id);
}

function rowGroupId(row) {
  return toText(row?.groupId ?? row?.group_id);
}

function rowOwnTimeMs(row) {
  return parseConversationTimeMs(row?.updatedAt ?? row?.updated_at);
}

/** A row's hand-set place in its group (`groupPosition` / `group_position`), or null. */
export function conversationGroupPosition(row) {
  const raw = row?.groupPosition ?? row?.group_position;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The order of two rows of the same group after the head: a placed row
 * before an unplaced one, placed rows by position, unplaced ones newest
 * first; ties by id, descending. The sidebar and the relay sort members
 * with it.
 */
export function compareGroupMembers(a, b) {
  const pa = conversationGroupPosition(a);
  const pb = conversationGroupPosition(b);
  if (pa !== null && pb === null) return -1;
  if (pa === null && pb !== null) return 1;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;
  const ua = rowOwnTimeMs(a);
  const ub = rowOwnTimeMs(b);
  if (ua !== ub) return ub - ua;
  return rowId(b).localeCompare(rowId(a));
}

function groupOf(groups, groupId) {
  if (!groups || !groupId) return null;
  if (typeof groups.get === 'function') return groups.get(groupId) || null;
  return groups[groupId] || null;
}

/** 'head' | 'member' | null for a row, from the groups' `parentConversationId`. */
export function conversationGroupRole(row, groups) {
  const groupId = rowGroupId(row);
  if (!groupId) return null;
  const group = groupOf(groups, groupId);
  const head = toText(group?.parentConversationId ?? group?.parent_conversation_id);
  return head && head === rowId(row) ? 'head' : 'member';
}

/** `Map<groupId, ms>`: the newest row time of each group among `rows`. */
export function groupActivityTimes(rows) {
  const times = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const groupId = rowGroupId(row);
    if (!groupId) continue;
    const ms = rowOwnTimeMs(row);
    if (ms > (times.get(groupId) || 0)) times.set(groupId, ms);
  }
  return times;
}

function makeContext(rows, groups) {
  const activity = groupActivityTimes(rows);
  return {
    timeOf(row) {
      const groupId = rowGroupId(row);
      return groupId ? Math.max(activity.get(groupId) || 0, rowOwnTimeMs(row)) : rowOwnTimeMs(row);
    },
    keyOf(row) {
      return rowGroupId(row) || rowId(row);
    },
    roleRank(row) {
      return conversationGroupRole(row, groups) === 'head' ? 0 : 1;
    },
  };
}

function compareWith(ctx) {
  return (a, b) => {
    const ta = ctx.timeOf(a);
    const tb = ctx.timeOf(b);
    if (ta !== tb) return tb - ta;
    const ka = ctx.keyOf(a);
    const kb = ctx.keyOf(b);
    if (ka !== kb) return kb.localeCompare(ka);
    const ra = ctx.roleRank(a);
    const rb = ctx.roleRank(b);
    if (ra !== rb) return ra - rb;
    // Same group (or the same ungrouped row): the hand order, then time.
    if (rowGroupId(a)) return compareGroupMembers(a, b);
    const ua = rowOwnTimeMs(a);
    const ub = rowOwnTimeMs(b);
    if (ua !== ub) return ub - ua;
    return rowId(b).localeCompare(rowId(a));
  };
}

/** The rows in list order (a sorted copy). `groups`: Map or object by id. */
export function orderConversationRows(rows, groups = null) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  return list.slice().sort(compareWith(makeContext(list, groups)));
}

/**
 * One page of the ordered list. The cursor names the last row of the page
 * before (`beforeConversationId`); when that row is gone, `beforeUpdatedAt`
 * (its sort time) and the id stand in. The page holds `limit` rows, extended
 * to the end of the group its last row is in.
 */
export function pageConversationRows(rows, groups = null, { limit = 40, beforeConversationId = '', beforeUpdatedAt = '', beforeGroupId = '' } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const ctx = makeContext(list, groups);
  const ordered = list.slice().sort(compareWith(ctx));
  const pageLimit = Math.max(1, Math.trunc(Number(limit) || 0) || 40);
  const cursorId = toText(beforeConversationId);
  const cursorGroupId = toText(beforeGroupId);
  let older = ordered;
  if (cursorId || toText(beforeUpdatedAt)) {
    const index = cursorId ? ordered.findIndex((row) => rowId(row) === cursorId) : -1;
    if (index >= 0) {
      // A cursor inside a group (a member moved up in the hand order since
      // the page was served): the page held the whole group, so the next
      // one starts after the group's last row.
      let end = index;
      const cursorRowGroup = rowGroupId(ordered[index]);
      while (cursorRowGroup && end + 1 < ordered.length && rowGroupId(ordered[end + 1]) === cursorRowGroup) end += 1;
      older = ordered.slice(end + 1);
    } else {
      // The cursor row is gone (archived or deleted since). Its sort time
      // and key place the next page; a row inside a group stood for that
      // group, which is served again whole rather than cut short.
      const cursorMs = parseConversationTimeMs(beforeUpdatedAt);
      const cursorKey = cursorGroupId || cursorId;
      older = ordered.filter((row) => {
        const ms = ctx.timeOf(row);
        if (ms < cursorMs) return true;
        if (ms > cursorMs || !cursorKey) return false;
        const key = ctx.keyOf(row);
        if (cursorGroupId && key === cursorGroupId) return true;
        return key.localeCompare(cursorKey) < 0;
      });
    }
  }
  let end = Math.min(pageLimit, older.length);
  const lastGroup = end > 0 ? rowGroupId(older[end - 1]) : '';
  while (lastGroup && end < older.length && rowGroupId(older[end]) === lastGroup) end += 1;
  const pageRows = older.slice(0, end);
  const last = pageRows[pageRows.length - 1] || null;
  const lastMs = last ? ctx.timeOf(last) : 0;
  return {
    rows: pageRows,
    pageInfo: {
      hasMore: older.length > pageRows.length,
      nextCursor: last ? {
        beforeConversationId: rowId(last),
        beforeUpdatedAt: lastMs ? new Date(lastMs).toISOString() : (toText(last.updatedAt ?? last.updated_at) || null),
        ...(rowGroupId(last) ? { beforeGroupId: rowGroupId(last) } : {}),
      } : null,
    },
  };
}

/**
 * The sidebar's items, in order: `{ kind: 'row' }` for an ungrouped row,
 * `{ kind: 'head' }` for a group's first line (with `conversation` when the
 * head row is in the list, else a synthetic head), then `{ kind: 'member' }`
 * for each member while the group is open. Every head item carries
 * `group: { id, info, members, activityMs, open }`; `members` holds the
 * group's rows after the head, in the group's order (hand-placed first).
 *
 * `isOpen(groupId, group)` decides the fold; `matches(row)` keeps rows that
 * match a filter (a group shows when any row matches: its head as context
 * with the matching members, or whole when the head or its name matches).
 *
 * With `emptyGroups`, an owner's group an agent emptied (`keptEmptyAt`, no
 * row here) shows too: a head item without members (`group.empty`), placed
 * by the time it was emptied; under a filter only when its name matches.
 */
export function arrangeConversationList(rows, groups = null, {
  isOpen = () => true,
  matches = null,
  groupNameMatches = null,
  emptyGroups = false,
} = {}) {
  const items = arrangeGroupedRows(rows, groups, { isOpen, matches, groupNameMatches });
  if (!emptyGroups || !groups) return items;
  const present = new Set((Array.isArray(rows) ? rows : []).map(rowGroupId).filter(Boolean));
  const entries = typeof groups.entries === 'function' && typeof groups.get === 'function' ? [...groups.entries()] : Object.entries(groups);
  const kept = entries
    .map(([id, info]) => ({ id: toText(id), info }))
    .filter(({ id, info }) => id && toText(info?.keptEmptyAt) && !present.has(id))
    .filter(({ info }) => !matches || (typeof groupNameMatches === 'function' && groupNameMatches(info, null)))
    .map(({ id, info }) => ({
      kind: 'head',
      conversation: null,
      group: { id, info, head: null, members: [], activityMs: parseConversationTimeMs(info.keptEmptyAt), open: false, contextOnly: false, empty: true },
    }))
    .sort((a, b) => (b.group.activityMs - a.group.activityMs) || b.group.id.localeCompare(a.group.id));
  if (!kept.length) return items;
  // Merged in by time, before the first row or group that is older.
  const timeOf = (item) => (item.kind === 'head' ? item.group.activityMs : rowOwnTimeMs(item.conversation));
  const out = [];
  let next = 0;
  for (const item of items) {
    if (item.kind !== 'member') {
      while (next < kept.length && kept[next].group.activityMs > timeOf(item)) out.push(kept[next++]);
    }
    out.push(item);
  }
  while (next < kept.length) out.push(kept[next++]);
  return out;
}

function arrangeGroupedRows(rows, groups, { isOpen, matches, groupNameMatches }) {
  const ordered = orderConversationRows(rows, groups);
  const activity = groupActivityTimes(ordered);
  const items = [];
  let index = 0;
  while (index < ordered.length) {
    const row = ordered[index];
    const groupId = rowGroupId(row);
    if (!groupId) {
      if (!matches || matches(row)) items.push({ kind: 'row', conversation: row });
      index += 1;
      continue;
    }
    let end = index;
    while (end < ordered.length && rowGroupId(ordered[end]) === groupId) end += 1;
    const groupRows = ordered.slice(index, end);
    index = end;
    const info = groupOf(groups, groupId);
    const headId = toText(info?.parentConversationId ?? info?.parent_conversation_id);
    const headRow = groupRows.find((candidate) => rowId(candidate) === headId) || null;
    const members = groupRows.filter((candidate) => candidate !== headRow);
    let shownMembers = members;
    let headMatches = true;
    let contextOnly = false;
    if (matches) {
      headMatches = (headRow ? matches(headRow) : false) || (typeof groupNameMatches === 'function' && groupNameMatches(info, headRow));
      if (!headMatches) {
        shownMembers = members.filter((candidate) => matches(candidate));
        if (!shownMembers.length) continue;
        contextOnly = true;
      }
    }
    const group = {
      id: groupId,
      info: info || null,
      head: headRow,
      members,
      activityMs: activity.get(groupId) || 0,
      open: contextOnly ? true : isOpen(groupId, { info, head: headRow, members }) !== false,
      contextOnly,
    };
    items.push({ kind: 'head', conversation: headRow, group });
    if (group.open) {
      for (const member of shownMembers) items.push({ kind: 'member', conversation: member, group });
    }
  }
  return items;
}
