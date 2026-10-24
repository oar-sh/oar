'use strict';

import { randomUUID } from 'node:crypto';

import { compareGroupMembers } from '../public/app/conversation-group-order.mjs';

// Session groups (migration 0014): the set of conversations that share a
// `group_id`, with a row in `conversation_groups` for what the set itself
// needs: a name given by hand, and the head (the session that created the
// others with the remote_relay tool; NULL for a group made by hand or once
// the head is deleted).
//
// A session an agent creates on this relay joins its creator's group at
// bootstrap (`attachCreatedConversation`); the origin stays the record of who
// created it and is not read again for the grouping. Everything else is done
// by hand in the sidebar. Every reader tolerates a schema without the
// migration: it then sees no groups and writes nothing.
//
// A group can have a hand order (migration 0015): once the owner drags a row
// into place, every member after the head gets a `group_position` (10, 20,
// 30, ...) and keeps it; later arrivals join at the end. A group nobody
// reordered keeps NULL positions and the activity order. Without the column
// the hand order is off and moves only change the membership.
//
// An agent's update_session moves one session at a time (migration 0021): a
// group it made by name is marked `agent_made` and goes once it is empty; a
// group the owner made never goes that way, it stays empty and marked
// `kept_empty_at`, which the boot repair respects, until a member joins.

const POSITION_STEP = 10;

export const GROUP_NAME_MAX = 60;

function toText(value) {
  return String(value ?? '').trim();
}

/** The name a group shows: its own, else the head's current title, else "Group". */
export function resolveGroupDisplayName({ name = null, headTitle = null } = {}) {
  return toText(name) || toText(headTitle) || 'Group';
}

/** A group name as stored: trimmed, capped, NULL when empty. */
export function normalizeGroupName(value) {
  const text = toText(value).replace(/\s+/g, ' ');
  return text ? text.slice(0, GROUP_NAME_MAX) : null;
}

function rowToGroup(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || null,
    parentConversationId: row.parent_conversation_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Made by an agent's update_session; an owner's group an agent emptied.
    agentMade: Number(row.agent_made) === 1,
    keptEmptyAt: row.kept_empty_at || null,
  };
}

export function createConversationGroupRepository(db) {
  const hasTable = !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_groups'`).get();
  const hasColumn = db.prepare(`PRAGMA table_info(conversations)`).all().some((column) => column.name === 'group_id');
  const enabled = hasTable && hasColumn;
  const hasPosition = enabled && db.prepare(`PRAGMA table_info(conversations)`).all().some((column) => column.name === 'group_position');
  // What update_session may do to a group (migration 0021): a group it made
  // (`agent_made`), and an owner's group it emptied, which stays
  // (`kept_empty_at`). Without the columns a kept group lasts until the boot
  // repair.
  const groupColumns = enabled ? new Set(db.prepare(`PRAGMA table_info(conversation_groups)`).all().map((column) => column.name)) : new Set();
  const hasAgentMarks = groupColumns.has('agent_made') && groupColumns.has('kept_empty_at');
  if (!enabled) {
    return {
      enabled: false,
      getGroup: () => null,
      listGroupsByIds: () => new Map(),
      groupOfConversation: () => null,
      membersOf: () => [],
      createGroup: () => null,
      renameGroup: () => null,
      setMembership: () => ({ ok: false, error: 'groups-unavailable' }),
      moveConversation: () => ({ ok: false, error: 'groups-unavailable' }),
      attachCreatedConversation: () => null,
      dissolveGroup: () => false,
      forgetConversation: () => null,
      carryToCompacted: () => null,
      deleteIfEmpty: () => false,
      sweepEmpty: () => 0,
      repair: () => ({ headsDetached: 0, groupsRemoved: 0 }),
      freezeNamesForHeads: () => 0,
      membershipsOf: () => ({}),
      describeGroup: () => null,
      listGroups: () => [],
      listKeptEmptyGroups: () => [],
      orderOf: () => [],
      positionsOf: () => ({}),
    };
  }

  const getGroup = db.prepare(`SELECT * FROM conversation_groups WHERE id = ?`);
  const insertGroup = db.prepare(`INSERT INTO conversation_groups (id, name, parent_conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
  const markAgentMade = hasAgentMarks ? db.prepare(`UPDATE conversation_groups SET agent_made = 1 WHERE id = ?`) : null;
  const markKeptEmpty = hasAgentMarks ? db.prepare(`UPDATE conversation_groups SET kept_empty_at = ? WHERE id = ?`) : null;
  const clearKeptEmpty = hasAgentMarks ? db.prepare(`UPDATE conversation_groups SET kept_empty_at = NULL WHERE id = ? AND kept_empty_at IS NOT NULL`) : null;
  const updateName = db.prepare(`UPDATE conversation_groups SET name = ?, updated_at = ? WHERE id = ?`);
  const updateParent = db.prepare(`UPDATE conversation_groups SET parent_conversation_id = ?, updated_at = ? WHERE id = ?`);
  // A frozen head title keeps to the name cap, so a later rename is never
  // refused for a length it did not choose.
  const freezeName = db.prepare(`UPDATE conversation_groups SET name = COALESCE(name, substr(?, 1, ${GROUP_NAME_MAX})), parent_conversation_id = NULL, updated_at = ? WHERE id = ?`);
  const freezeNameKeepHead = db.prepare(`UPDATE conversation_groups SET name = COALESCE(name, substr(?, 1, ${GROUP_NAME_MAX})), updated_at = ? WHERE id = ? AND name IS NULL`);
  const findGroupHeadedBy = db.prepare(`SELECT id FROM conversation_groups WHERE parent_conversation_id = ? ORDER BY created_at ASC LIMIT 1`);
  const listGroupsWithHead = db.prepare(`
    SELECT g.id, g.parent_conversation_id, c.title, c.status
    FROM conversation_groups g LEFT JOIN conversations c ON c.id = g.parent_conversation_id
    WHERE g.parent_conversation_id IS NOT NULL
  `);
  const deleteGroup = db.prepare(`DELETE FROM conversation_groups WHERE id = ?`);
  const positionSelect = hasPosition ? 'group_position' : 'NULL AS group_position';
  const getConversation = db.prepare(`SELECT id, title, archived, status, group_id, ${positionSelect}, updated_at FROM conversations WHERE id = ?`);
  // Every change of group sets the position too: NULL unless given.
  const setGroupStatement = db.prepare(hasPosition
    ? `UPDATE conversations SET group_id = ?, group_position = ? WHERE id = ?`
    : `UPDATE conversations SET group_id = ? WHERE id = ?`);
  const setGroup = {
    run: (groupId, conversationId, position = null) => {
      // A kept empty group that gets a member is an ordinary group again.
      if (groupId) clearKeptEmpty?.run(groupId);
      return hasPosition
        ? setGroupStatement.run(groupId, position, conversationId)
        : setGroupStatement.run(groupId, conversationId);
    },
  };
  const setPosition = hasPosition ? db.prepare(`UPDATE conversations SET group_position = ? WHERE id = ?`) : null;
  const clearGroup = db.prepare(hasPosition
    ? `UPDATE conversations SET group_id = NULL, group_position = NULL WHERE group_id = ?`
    : `UPDATE conversations SET group_id = NULL WHERE group_id = ?`);
  const listMembersByTime = db.prepare(`
    SELECT id, title, archived, group_id, ${positionSelect}, updated_at FROM conversations
    WHERE group_id = ? AND status != 'deleted'
    ORDER BY updated_at DESC
  `);
  const maxPosition = hasPosition
    ? db.prepare(`SELECT MAX(group_position) AS n FROM conversations WHERE group_id = ? AND status != 'deleted'`)
    : null;
  const countMembers = db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE group_id = ? AND status != 'deleted'`);
  // Groups with a live member, the one with the latest activity first, then
  // the owner's groups an agent emptied (kept, and still nameable).
  const listGroupsWithMembers = db.prepare(hasAgentMarks
    ? `
    SELECT g.id, g.name, g.parent_conversation_id, COUNT(c.id) AS member_count, MAX(c.updated_at) AS last_activity
    FROM conversation_groups g LEFT JOIN conversations c ON c.group_id = g.id AND c.status != 'deleted'
    GROUP BY g.id
    HAVING COUNT(c.id) > 0 OR g.kept_empty_at IS NOT NULL
    ORDER BY last_activity DESC, g.created_at DESC
  `
    : `
    SELECT g.id, g.name, g.parent_conversation_id, COUNT(c.id) AS member_count, MAX(c.updated_at) AS last_activity
    FROM conversation_groups g JOIN conversations c ON c.group_id = g.id AND c.status != 'deleted'
    GROUP BY g.id
    ORDER BY last_activity DESC, g.created_at DESC
  `);
  const listKeptEmpty = hasAgentMarks ? db.prepare(`
    SELECT g.* FROM conversation_groups g
    WHERE g.kept_empty_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.group_id = g.id AND c.status != 'deleted')
    ORDER BY g.kept_empty_at DESC, g.id DESC
  `) : null;
  // A kept empty group is not left over: the repair and the sweep pass it by.
  const listEmptyGroups = db.prepare(`
    SELECT g.id FROM conversation_groups g
    WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.group_id = g.id AND c.status != 'deleted')
    ${hasAgentMarks ? 'AND g.kept_empty_at IS NULL' : ''}
  `);

  /** The group's rows in display order: the head, then the members (see compareGroupMembers). */
  const listMembers = {
    all(groupId) {
      const id = toText(groupId);
      const headId = toText(getGroup.get(id)?.parent_conversation_id);
      const rows = listMembersByTime.all(id);
      const head = headId ? rows.find((row) => row.id === headId) || null : null;
      const members = rows.filter((row) => row !== head).sort(compareGroupMembers);
      return head ? [head, ...members] : members;
    },
  };

  const positionValue = (row) => (row?.group_position == null ? null : Number(row.group_position));

  /** Where a row joining `groupId` goes: after the last placed member, or NULL when nobody ordered the group. */
  function joiningPosition(groupId) {
    if (!hasPosition) return null;
    const max = maxPosition.get(toText(groupId))?.n;
    return max == null ? null : Number(max) + POSITION_STEP;
  }

  const liveConversation = (id) => {
    const row = getConversation.get(toText(id));
    return row && String(row.status || '') !== 'deleted' ? row : null;
  };

  function deleteIfEmpty(groupId) {
    const id = toText(groupId);
    if (!id) return false;
    if (Number(countMembers.get(id)?.n || 0) > 0) return false;
    return deleteGroup.run(id).changes > 0;
  }

  /**
   * The conversation leaves its group. A head that leaves makes its group
   * headless: the name freezes to the head's title unless one was given by
   * hand. An empty group is removed, except with `keepOwnerGroups` (an
   * agent's update_session): then only a group an agent made goes, and the
   * owner's stays, marked as kept empty. Returns the previous group id.
   */
  const leaveGroup = db.transaction((conversationId, nowIso, { anyStatus = false, keepOwnerGroups = false } = {}) => {
    // A row already marked deleted (the delete path marks before it removes)
    // still leaves its group the same way.
    const row = anyStatus ? getConversation.get(toText(conversationId)) : liveConversation(conversationId);
    const previous = toText(row?.group_id);
    if (!row || !previous) return null;
    const group = getGroup.get(previous);
    if (group && toText(group.parent_conversation_id) === row.id) freezeName.run(row.title || null, nowIso, previous);
    setGroup.run(null, row.id);
    if (keepOwnerGroups && group && Number(group.agent_made) !== 1) {
      if (Number(countMembers.get(previous)?.n || 0) === 0) markKeptEmpty?.run(nowIso, previous);
    } else {
      deleteIfEmpty(previous);
    }
    return previous;
  });

  /**
   * A new group. `agentMade` marks one an agent's update_session made;
   * `keepOwnerGroups` is leaveGroup's, for the groups its members leave.
   */
  const createGroup = db.transaction(({ name = null, parentConversationId = null, conversationIds = [], agentMade = false, keepOwnerGroups = false } = {}, nowIso = new Date().toISOString()) => {
    const id = `grp_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const head = liveConversation(parentConversationId);
    insertGroup.run(id, normalizeGroupName(name), head ? head.id : null, nowIso, nowIso);
    if (agentMade) markAgentMade?.run(id);
    const members = new Set([...(head ? [head.id] : []), ...conversationIds.map(toText).filter(Boolean)]);
    for (const memberId of members) {
      if (!liveConversation(memberId)) continue;
      leaveGroup(memberId, nowIso, { keepOwnerGroups });
      setGroup.run(id, memberId);
    }
    return rowToGroup(getGroup.get(id));
  });

  const setMembership = db.transaction((conversationId, groupId, nowIso = new Date().toISOString(), { keepOwnerGroups = false } = {}) => {
    const row = liveConversation(conversationId);
    if (!row) return { ok: false, error: 'conversation-not-found' };
    const target = toText(groupId);
    if (target && !getGroup.get(target)) return { ok: false, error: 'group-not-found' };
    if (toText(row.group_id) === target) return { ok: true, changed: false, groupId: target || null, previousGroupId: target || null };
    const previousGroupId = leaveGroup(row.id, nowIso, { keepOwnerGroups });
    if (target) setGroup.run(target, row.id, joiningPosition(target));
    return { ok: true, changed: true, groupId: target || null, previousGroupId };
  });

  /** The ids of a group in display order, head first. */
  function orderOf(groupId) {
    return listMembers.all(groupId).map((member) => member.id);
  }

  /**
   * A drag in the sidebar: the conversation goes into `groupId` (null: out of
   * its group) and lands before `beforeConversationId`, or at the end when
   * that is null or not a member there. The group then has a hand order:
   * every member after the head is numbered 10, 20, 30, ... in the order
   * that results. The head stays first and unnumbered; moving it within its
   * own group, or dropping a row before it, never displaces it.
   */
  const moveConversation = db.transaction((conversationId, { groupId = null, beforeConversationId = null } = {}, nowIso = new Date().toISOString()) => {
    const row = liveConversation(conversationId);
    if (!row) return { ok: false, error: 'conversation-not-found' };
    const target = toText(groupId);
    const group = target ? getGroup.get(target) : null;
    if (target && !group) return { ok: false, error: 'group-not-found' };
    const current = toText(row.group_id);
    if (!target) {
      if (!current) return { ok: true, changed: false, groupId: null, previousGroupId: null, order: [] };
      const previousGroupId = leaveGroup(row.id, nowIso);
      return { ok: true, changed: true, groupId: null, previousGroupId, order: [] };
    }
    const headId = toText(group.parent_conversation_id);
    if (current === target && row.id === headId) {
      return { ok: true, changed: false, groupId: target, previousGroupId: target, order: orderOf(target) };
    }
    let changed = false;
    let previousGroupId = current || null;
    if (current !== target) {
      previousGroupId = leaveGroup(row.id, nowIso);
      setGroup.run(target, row.id);
      changed = true;
    }
    // A row that turns out to be the head (a link kept for a re-import) leads unnumbered.
    if (hasPosition && row.id !== headId) {
      const rows = listMembers.all(target).filter((member) => member.id !== headId);
      const before = toText(beforeConversationId);
      const moved = rows.find((member) => member.id === row.id);
      // Dropped before itself: it stays where it is.
      const others = before === row.id ? rows : rows.filter((member) => member !== moved);
      if (before !== row.id) {
        const index = headId && before === headId ? 0 : (before ? others.findIndex((member) => member.id === before) : -1);
        others.splice(index < 0 ? others.length : index, 0, moved);
      }
      others.forEach((member, index) => {
        const position = (index + 1) * POSITION_STEP;
        if (positionValue(member) === position) return;
        setPosition.run(position, member.id);
        changed = true;
      });
    }
    return { ok: true, changed, groupId: target, previousGroupId, order: orderOf(target) };
  });

  /** `{ [conversationId]: position | null }` for the ids given (rows outside a group read as null). */
  function positionsOf(conversationIds) {
    const out = {};
    for (const raw of new Set((Array.isArray(conversationIds) ? conversationIds : []).map(toText).filter(Boolean))) {
      const row = liveConversation(raw);
      out[raw] = row && toText(row.group_id) ? positionValue(row) : null;
    }
    return out;
  }

  /**
   * Bootstrap of a session an agent created here: the child joins the
   * creator's group, or a new group with the creator as head. A creator that
   * is gone leaves the child ungrouped.
   */
  const attachCreatedConversation = db.transaction((childId, creatorId, nowIso = new Date().toISOString()) => {
    const child = liveConversation(childId);
    const creator = liveConversation(creatorId);
    if (!child || !creator || child.id === creator.id) return null;
    let groupId = toText(creator.group_id);
    if (!groupId || !getGroup.get(groupId)) {
      // A group that still names this creator as its head (its row was
      // removed and made again, as a cache rebuild does) is taken up again
      // rather than doubled.
      const headed = findGroupHeadedBy.get(creator.id);
      // The group an agent's create_session forms is an agent's: it goes once
      // the agent path empties it.
      groupId = headed ? toText(headed.id) : createGroup({ parentConversationId: creator.id, agentMade: true }, nowIso).id;
      setGroup.run(groupId, creator.id);
    }
    setGroup.run(groupId, child.id, joiningPosition(groupId));
    return groupId;
  });

  /**
   * What a delete path that does not know groups leaves behind: a head whose
   * row is tombstoned (the group stays headless, the title frozen as its
   * name) and groups without a live member. A head whose row is simply
   * absent keeps its link: a cache wipe froze its name first, and the row
   * may be imported again under the same id and take the group up.
   */
  const repair = db.transaction((nowIso = new Date().toISOString()) => {
    let headsDetached = 0;
    for (const row of listGroupsWithHead.all()) {
      if (!row.status || String(row.status) !== 'deleted') continue;
      freezeName.run(row.title || null, nowIso, row.id);
      headsDetached += 1;
    }
    let groupsRemoved = 0;
    for (const row of listEmptyGroups.all()) groupsRemoved += deleteGroup.run(row.id).changes;
    return { headsDetached, groupsRemoved };
  });

  /**
   * Before rows are wiped (the cache rebuild): the groups headed by any of
   * them get their head's title as their name, so the group that survives
   * (its hand-titled members stay) is not nameless. The head link stays for
   * a re-import. Returns how many names were frozen.
   */
  const freezeNamesForHeads = db.transaction((conversationIds, nowIso = new Date().toISOString()) => {
    const ids = new Set((Array.isArray(conversationIds) ? conversationIds : []).map(toText).filter(Boolean));
    let frozen = 0;
    for (const row of listGroupsWithHead.all()) {
      if (!ids.has(toText(row.parent_conversation_id))) continue;
      frozen += freezeNameKeepHead.run(row.title || null, nowIso, row.id).changes;
    }
    return frozen;
  });

  /** `{ [conversationId]: { groupId, role } | null }` for the ids given (deleted rows read as null). */
  function membershipsOf(conversationIds) {
    const out = {};
    for (const raw of new Set((Array.isArray(conversationIds) ? conversationIds : []).map(toText).filter(Boolean))) {
      const row = liveConversation(raw);
      const groupId = toText(row?.group_id);
      const group = groupId ? getGroup.get(groupId) : null;
      out[raw] = row && group
        ? { groupId, role: toText(group.parent_conversation_id) === row.id ? 'head' : 'member' }
        : null;
    }
    return out;
  }

  return {
    enabled: true,
    getGroup(groupId) {
      return rowToGroup(getGroup.get(toText(groupId)));
    },
    /** `Map<id, group>` for the ids given (unknown ids are left out). */
    listGroupsByIds(groupIds) {
      const map = new Map();
      for (const raw of new Set((Array.isArray(groupIds) ? groupIds : []).map(toText).filter(Boolean))) {
        const group = rowToGroup(getGroup.get(raw));
        if (group) map.set(group.id, group);
      }
      return map;
    },
    groupOfConversation(conversationId) {
      const row = liveConversation(conversationId);
      return row?.group_id ? rowToGroup(getGroup.get(row.group_id)) : null;
    },
    /**
     * `[{ id, title, archived, updatedAt, groupPosition }]` in display order
     * (the head, then the placed members, then the others newest first),
     * deleted rows left out.
     */
    membersOf(groupId) {
      return listMembers.all(toText(groupId)).map((row) => ({
        id: row.id,
        title: row.title,
        archived: Number(row.archived || 0) === 1,
        updatedAt: row.updated_at,
        groupPosition: positionValue(row),
      }));
    },
    createGroup,
    renameGroup(groupId, name, nowIso = new Date().toISOString()) {
      const id = toText(groupId);
      if (!getGroup.get(id)) return null;
      updateName.run(normalizeGroupName(name), nowIso, id);
      return rowToGroup(getGroup.get(id));
    },
    setMembership,
    moveConversation,
    orderOf,
    positionsOf,
    attachCreatedConversation,
    /** Every member leaves; the group row goes. Conversations are untouched otherwise. */
    dissolveGroup(groupId) {
      const id = toText(groupId);
      if (!getGroup.get(id)) return false;
      clearGroup.run(id);
      deleteGroup.run(id);
      return true;
    },
    /**
     * Called before a conversation's rows are deleted: a head leaves its group
     * (name frozen), and a group left empty goes. Returns the group id it was in.
     */
    forgetConversation(conversationId, nowIso = new Date().toISOString()) {
      return leaveGroup(conversationId, nowIso, { anyStatus: true });
    },
    /** Compaction: the new conversation takes the old one's group, its place in it, and its head role. */
    carryToCompacted(sourceId, targetId, nowIso = new Date().toISOString()) {
      const source = liveConversation(sourceId);
      const groupId = toText(source?.group_id);
      if (!groupId || !getGroup.get(groupId) || !getConversation.get(toText(targetId))) return null;
      setGroup.run(groupId, toText(targetId), positionValue(source));
      // The old row stays in the group, unplaced: it must not tie with the new one.
      if (toText(targetId) !== source.id) setGroup.run(groupId, source.id, null);
      const group = getGroup.get(groupId);
      if (toText(group?.parent_conversation_id) === source.id) updateParent.run(toText(targetId), nowIso, groupId);
      return groupId;
    },
    deleteIfEmpty,
    /** Removes groups without a live member; returns how many. */
    sweepEmpty() {
      let removed = 0;
      for (const row of listEmptyGroups.all()) removed += deleteGroup.run(row.id).changes;
      return removed;
    },
    repair,
    freezeNamesForHeads,
    membershipsOf,
    /**
     * The group as the list payload and the change event describe it: name,
     * display name (the head's current title when none was given), head and
     * member counts. `headTitle(title)` may dress the title as the list does.
     */
    describeGroup(groupId, { headTitle = (title) => title } = {}) {
      const group = rowToGroup(getGroup.get(toText(groupId)));
      if (!group) return null;
      const members = listMembers.all(group.id);
      const head = group.parentConversationId ? members.find((member) => member.id === group.parentConversationId) || null : null;
      return {
        id: group.id,
        name: group.name || null,
        displayName: resolveGroupDisplayName({ name: group.name, headTitle: head ? headTitle(head.title) : null }),
        parentConversationId: group.parentConversationId || null,
        memberCount: members.length,
        liveMemberCount: members.filter((member) => Number(member.archived || 0) !== 1).length,
        keptEmptyAt: group.keptEmptyAt,
      };
    },
    /**
     * The owner's groups an agent emptied and that stay (kept empty, no live
     * member), newest first: the sidebar shows them, so the owner can rename
     * or dissolve them. Nothing removes them by itself.
     */
    listKeptEmptyGroups() {
      return listKeptEmpty ? listKeptEmpty.all().map(rowToGroup) : [];
    },
    /**
     * Every group with a live member, latest activity first, as an agent may
     * see it: `[{ id, name, memberCount }]`, `name` being what the sidebar
     * shows (the head's current title for a group nobody named). No member
     * ids, no other titles.
     */
    listGroups({ headTitle = (title) => title } = {}) {
      return listGroupsWithMembers.all().map((row) => {
        const head = row.parent_conversation_id ? liveConversation(row.parent_conversation_id) : null;
        const headInGroup = head && toText(head.group_id) === row.id ? head : null;
        return {
          id: row.id,
          name: resolveGroupDisplayName({ name: row.name, headTitle: headInGroup ? headTitle(headInGroup.title) : null }),
          memberCount: Number(row.member_count || 0),
        };
      });
    },
  };
}
