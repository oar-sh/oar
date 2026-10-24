'use strict';

// Session groups, made and changed by hand in the sidebar: a new group from
// one or more conversations, a name, a conversation moved in or out (or
// dragged to a place inside a group), and a group dissolved. Archiving a group lives with the archive route
// (sessions-routes.mjs) and stopping one with the turn controls
// (messages-routes.mjs), next to the code they reuse.
//
// The owner's action only: every route is behind `auth`, and a request that
// arrived from a paired relay is refused, as the remote_relay tool's own
// route refuses calls from other relays. The tool reads groups, names an
// existing one for a session it creates (the bootstrap route), and moves one
// session into a group, out of it, or into a new group of a name it gives
// (update_session, PATCH /api/conversation/:id/settings in
// sessions-routes.mjs). Renaming and dissolving groups, and moving several
// rows at once, stay here, the owner's.
//
// The one read, GET /api/conversation-groups, is the list relay_info and
// create_session look a group up in: open to whoever may list conversations
// (the same `auth` as GET /api/conversations), paired relays included, and
// only id, name and member count.

import { readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';
import { GROUP_NAME_MAX } from '../repositories/conversation-group-repository.mjs';
import { resolveConversationTitle } from './sessions-routes.mjs';

const resolveConversationTitleText = (title) => resolveConversationTitle({ title, titleSource: 'auto' });

export function registerConversationGroupRoutes(app, deps) {
  const {
    auth,
    io,
    conversationGroups = null,
    remoteRelayInbound = null,
  } = deps;

  function refuseRemote(req, res) {
    if (!readRemoteRelayRequest(req, remoteRelayInbound).remote) return false;
    res.status(403).json({ error: 'Session groups are managed by this relay\'s owner only.' });
    return true;
  }

  function unavailable(res) {
    return res.status(503).json({ ok: false, error: 'Session groups are not available on this relay (its storage for them is missing).' });
  }

  // What the page can apply in place: the group's summary (null once
  // dissolved), the named conversations' membership, the group's order (head
  // first) and the positions of its members and of the named conversations.
  function emitChanged(groupId, conversationIds = []) {
    const ids = [...new Set(conversationIds.map((id) => String(id || '').trim()).filter(Boolean))];
    const group = groupId ? conversationGroups.describeGroup(groupId, { headTitle: resolveConversationTitleText }) : null;
    const order = group ? conversationGroups.orderOf(groupId) : [];
    io.emit('conversation_group_changed', {
      groupId: groupId || null,
      conversationIds: ids,
      group,
      memberships: conversationGroups.membershipsOf(ids),
      order,
      positions: conversationGroups.positionsOf([...order, ...ids]),
    });
  }

  function groupPayload(group) {
    if (!group) return null;
    return {
      id: group.id,
      name: group.name || null,
      parentConversationId: group.parentConversationId || null,
      members: conversationGroups.membersOf(group.id).map((member) => member.id),
    };
  }

  // GET /api/conversation-groups — `{ ok, groups: [{ id, name, memberCount }] }`, latest activity first.
  app.get('/api/conversation-groups', auth, (req, res) => {
    if (!conversationGroups?.enabled) return unavailable(res);
    return res.json({ ok: true, groups: conversationGroups.listGroups({ headTitle: resolveConversationTitleText }) });
  });

  // POST /api/conversation-groups { name?, conversationIds } — a group by hand.
  app.post('/api/conversation-groups', auth, (req, res) => {
    if (refuseRemote(req, res)) return;
    if (!conversationGroups?.enabled) return unavailable(res);
    const ids = (Array.isArray(req.body?.conversationIds) ? req.body.conversationIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    if (!ids.length) return res.status(400).json({ ok: false, error: 'conversationIds must name at least one conversation' });
    const name = req.body?.name == null ? null : String(req.body.name);
    if (name && name.trim().length > GROUP_NAME_MAX) {
      return res.status(400).json({ ok: false, error: `A group name has at most ${GROUP_NAME_MAX} characters` });
    }
    // The rows leave the groups they were in (a drop from a view that had
    // not caught up yet): those groups are announced too.
    const previousGroupIds = new Map();
    for (const id of ids) {
      const previous = conversationGroups.groupOfConversation(id)?.id;
      if (!previous) continue;
      if (!previousGroupIds.has(previous)) previousGroupIds.set(previous, []);
      previousGroupIds.get(previous).push(id);
    }
    const group = conversationGroups.createGroup({ name, conversationIds: ids });
    const payload = groupPayload(group);
    if (!payload.members.length) {
      conversationGroups.deleteIfEmpty(group.id);
      return res.status(404).json({ ok: false, error: 'None of the conversations exists' });
    }
    emitChanged(group.id, ids);
    for (const [previous, movedIds] of previousGroupIds) emitChanged(previous, movedIds);
    return res.json({ ok: true, group: payload });
  });

  // PATCH /api/conversation-groups/:id { name } — rename; empty returns to the head's title.
  app.patch('/api/conversation-groups/:id', auth, (req, res) => {
    if (refuseRemote(req, res)) return;
    if (!conversationGroups?.enabled) return unavailable(res);
    const groupId = String(req.params.id || '').trim();
    if (!conversationGroups.getGroup(groupId)) return res.status(404).json({ ok: false, error: 'Group not found' });
    if (!('name' in (req.body || {}))) return res.status(400).json({ ok: false, error: 'name is required' });
    const name = req.body.name == null ? '' : String(req.body.name);
    if (name.trim().length > GROUP_NAME_MAX) {
      return res.status(400).json({ ok: false, error: `A group name has at most ${GROUP_NAME_MAX} characters` });
    }
    const group = conversationGroups.renameGroup(groupId, name);
    emitChanged(groupId, []);
    return res.json({ ok: true, group: groupPayload(group) });
  });

  // PUT /api/conversation/:id/group { groupId, beforeConversationId? } — move
  // a conversation into a group. `groupId: null` takes it out (as DELETE).
  // With `beforeConversationId` in the body (null: to the end) it is a drag:
  // the row lands before that one and the group gets a hand order; without
  // it the row joins at the end of a hand-ordered group, as the menu does.
  app.put('/api/conversation/:id/group', auth, (req, res) => {
    if (refuseRemote(req, res)) return;
    if (!conversationGroups?.enabled) return unavailable(res);
    const body = req.body || {};
    const conversationId = String(req.params.id || '').trim();
    const idOrNull = (value) => value === null || typeof value === 'string';
    if (!idOrNull(body.groupId ?? null)) return res.status(400).json({ ok: false, error: 'groupId must be a string or null' });
    if ('beforeConversationId' in body && !idOrNull(body.beforeConversationId)) {
      return res.status(400).json({ ok: false, error: 'beforeConversationId must be a string or null' });
    }
    const leaving = 'groupId' in body && body.groupId === null;
    const groupId = leaving ? '' : String(body.groupId || '').trim();
    if (!groupId && !leaving) return res.status(400).json({ ok: false, error: 'groupId is required' });
    const placing = 'beforeConversationId' in body;
    const result = placing
      ? conversationGroups.moveConversation(conversationId, {
        groupId: groupId || null,
        beforeConversationId: body.beforeConversationId == null ? null : String(body.beforeConversationId).trim() || null,
      })
      : conversationGroups.setMembership(conversationId, groupId || null);
    if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
    if (result.changed && groupId) emitChanged(groupId, [conversationId]);
    if (result.changed && result.previousGroupId && result.previousGroupId !== groupId) emitChanged(result.previousGroupId, [conversationId]);
    return res.json({
      ok: true,
      groupId: groupId || null,
      previousGroupId: result.previousGroupId || null,
      changed: result.changed === true,
      ...(placing ? { order: result.order || [] } : {}),
    });
  });

  // DELETE /api/conversation/:id/group — move a conversation out of its group.
  app.delete('/api/conversation/:id/group', auth, (req, res) => {
    if (refuseRemote(req, res)) return;
    if (!conversationGroups?.enabled) return unavailable(res);
    const conversationId = String(req.params.id || '').trim();
    const result = conversationGroups.setMembership(conversationId, null);
    if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
    if (result.changed) emitChanged(result.previousGroupId, [conversationId]);
    return res.json({ ok: true, previousGroupId: result.previousGroupId || null, changed: result.changed === true });
  });

  // DELETE /api/conversation-groups/:id — dissolve: members stay, ungrouped.
  app.delete('/api/conversation-groups/:id', auth, (req, res) => {
    if (refuseRemote(req, res)) return;
    if (!conversationGroups?.enabled) return unavailable(res);
    const groupId = String(req.params.id || '').trim();
    const members = conversationGroups.membersOf(groupId).map((member) => member.id);
    if (!conversationGroups.dissolveGroup(groupId)) return res.status(404).json({ ok: false, error: 'Group not found' });
    emitChanged(groupId, members);
    return res.json({ ok: true, members });
  });
}
