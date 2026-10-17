import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import { createConversationGroupRepository } from '../repositories/conversation-group-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { markRemoteRelayLoopbackRequest } from '../services/remote-relay-inbound.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';
import { registerConversationGroupRoutes } from './conversation-group-routes.mjs';

// Session groups on the conversation routes, against the REAL schema: a
// session an agent of this relay creates joins its creator's group at
// bootstrap, the list and single payloads carry the group, the hand-made
// group routes, the group archive, and what deleting a head does. Relay
// names and titles are fictional.

const NOW = '2026-10-13T10:00:00.000Z';
const LOCAL_ORIGIN = (conversationId, title = 'Release lead') => ({
  relayId: 'relay-id-self',
  relayName: 'linux-test',
  relayUrl: 'https://relay-self.example.test',
  conversationId,
  conversationTitle: title,
  provider: 'github',
  model: 'gpt-5.4-mini',
  hops: 0,
  local: true,
});
const PAIRED_ORIGIN = {
  relayId: 'relay-id-win',
  relayName: 'win-test',
  relayUrl: 'https://relay-a.example.test',
  conversationId: 'conv-on-other-relay',
  conversationTitle: 'report builder',
  provider: 'claude',
  model: 'claude-sonnet-5',
  hops: 1,
};
const agentHeaders = { 'x-oar-remote-origin': 'relay-id-win', 'x-oar-remote-hops': '1' };

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  };
  return {
    routes,
    get: record('GET'),
    post: record('POST'),
    patch: record('PATCH'),
    put: record('PUT'),
    delete: record('DELETE'),
    use() {},
  };
}

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const repository = createRemoteRelayRepository(db);
  const conversationGroups = createConversationGroupRepository(db);
  const remoteRelayInbound = {
    repository,
    listRelays: () => [],
    selfNames: () => ['linux-test'],
    inboundEnabled: () => true,
    recordUnlock: (conversationId, relayId, messageId) => repository.recordUnlock(conversationId, relayId, messageId),
    describeRelay: () => null,
  };
  const emitted = [];
  const app = createMockApp();
  const deps = {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emitted.push([event, payload]); } },
    db,
    stmts,
    runtimeState: {},
    config: {},
    parseAttachments: () => [],
    hydrateAttachment: (v) => v,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => [],
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({
      models: ['gpt-5.4-mini'],
      currentModel: 'gpt-5.4-mini',
      defaultModel: 'gpt-5.4-mini',
      reasoningByModel: { 'gpt-5.4-mini': ['none'] },
      providersByModel: { 'gpt-5.4-mini': ['github-copilot'] },
    }),
    updateModelCatalog: () => ({}),
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => ({}),
    setEnabledModelVariants: () => ({}),
    SUPPORTED_REASONING_EFFORTS: ['none', 'low', 'medium', 'high'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => ({ recentWorkspaceRoots: [] }),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => null,
    updateConversationConfiguredWorkspaceRoot: () => ({ ok: true }),
    learnConversationWorkspaceRoot: () => ({ ok: true }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    getPendingSessionCwd: () => null,
    workspaceRootAllowList: [],
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => 'client-1',
    touchCli: () => {},
    markCliOffline: () => {},
    fetchUsageSummary: () => {},
    ensureRuntimeSessionBinding: () => ({ id: 'runtime-session-1' }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent', 'ask', 'plan', 'autopilot'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: () => null,
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    resolveSessionStateRoot: () => null,
    sessionWorkerRegistry: createSessionWorkerRegistry(),
    sessionHistoryRefreshService: {
      evaluateRefreshIdleState: () => ({ idle: true }),
      replaceRetrievableHistory: () => {},
    },
    sdkSessionImportService: null,
    statusEventService: { recordSharedAccess: () => ({ event: null }) },
    isSha256: () => false,
    remoteRelayInbound,
    conversationGroups,
  };
  registerSessionsRoutes(app, deps);
  registerConversationGroupRoutes(app, deps);

  const call = async (key, { body = {}, headers = {}, params = {}, query = {}, loopback = false } = {}) => {
    const handler = app.routes.get(key);
    assert.ok(handler, `${key} should be registered`);
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      set() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    const req = { body, headers, query, params, socket: {} };
    // The in-process loopback (an agent of this relay) marks its requests.
    if (loopback) markRemoteRelayLoopbackRequest(req);
    await handler(req, res);
    return captured;
  };
  const bootstrap = async (body = {}, headers = {}, loopback = false) => {
    const created = await call('POST /api/conversation/bootstrap', {
      body: { title: 'Sample chat', relayMode: 'agent', ...body },
      headers,
      loopback,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body.conversationId;
  };
  // A session an agent of a local conversation creates: the loopback's
  // request, with a local origin.
  const createdBy = (creatorId, title) => bootstrap(
    { title, origin: LOCAL_ORIGIN(creatorId) },
    { 'x-oar-remote-origin': 'self', 'x-oar-remote-hops': '0' },
    true,
  );
  const events = (name) => emitted.filter(([event]) => event === name).map(([, payload]) => payload);
  const touch = (id, at) => db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(at, id);
  return { db, stmts, conversationGroups, emitted, events, call, bootstrap, createdBy, touch };
}

test('a session created by a local conversation joins its creator\'s group; the list and the single payload carry it', async () => {
  const fx = setup();
  const lead = await fx.bootstrap({ title: 'Release lead' });
  const child = await fx.createdBy(lead, 'Docs pass');
  const group = fx.conversationGroups.groupOfConversation(child);
  assert.ok(group, 'the child is grouped');
  assert.equal(group.parentConversationId, lead);
  assert.equal(fx.conversationGroups.groupOfConversation(lead)?.id, group.id);
  // The event carries what a page applies in place: the group's summary and
  // the named conversations' membership.
  assert.deepEqual(fx.events('conversation_group_changed'), [{
    groupId: group.id,
    conversationIds: [child, lead],
    group: { id: group.id, name: null, displayName: 'Release lead', parentConversationId: lead, memberCount: 2, liveMemberCount: 2 },
    memberships: { [child]: { groupId: group.id, role: 'member' }, [lead]: { groupId: group.id, role: 'head' } },
    order: [lead, child],
    positions: { [lead]: null, [child]: null },
  }]);

  const second = await fx.createdBy(lead, 'Tests pass');
  assert.equal(fx.conversationGroups.groupOfConversation(second)?.id, group.id);

  const list = await fx.call('GET /api/conversations');
  const rows = list.body.conversations;
  assert.deepEqual(rows.map((row) => [row.id, row.groupId, row.groupRole]), [
    [lead, group.id, 'head'],
    [second, group.id, 'member'],
    [child, group.id, 'member'],
  ]);
  assert.deepEqual(list.body.groups, {
    [group.id]: {
      id: group.id,
      name: null,
      displayName: 'Release lead',
      parentConversationId: lead,
      memberCount: 3,
      liveMemberCount: 3,
    },
  });

  const single = await fx.call('GET /api/conversation/:id', { params: { id: child } });
  assert.equal(single.status, 200);
  assert.equal(single.body.group.id, group.id);
  assert.equal(single.body.group.role, 'member');
  assert.equal(single.body.group.displayName, 'Release lead');
  // The members only when asked for (the tool's read_session), never for a
  // paired relay's agent, and without the archived ones.
  assert.equal('members' in single.body.group, false);
  await fx.call('POST /api/conversation/:id/archive', { params: { id: second } });
  const withMembers = await fx.call('GET /api/conversation/:id', { params: { id: child }, query: { groupMembers: '1' } });
  assert.deepEqual(withMembers.body.group.members.map((member) => [member.id, member.role, member.state]).sort(), [
    [child, 'member', 'idle'],
    [lead, 'head', 'idle'],
  ].sort());
  const asLoopback = await fx.call('GET /api/conversation/:id', { params: { id: child }, query: { groupMembers: '1' }, headers: { 'x-oar-remote-origin': 'self', 'x-oar-remote-hops': '0' }, loopback: true });
  assert.equal(asLoopback.body.group.members.length, 2);
  const asPaired = await fx.call('GET /api/conversation/:id', { params: { id: child }, query: { groupMembers: '1' }, headers: agentHeaders });
  assert.equal(asPaired.status, 200);
  assert.equal('members' in asPaired.body.group, false);
});

test('a session a paired relay\'s agent creates, and one the user makes, are not grouped', async () => {
  const fx = setup();
  const remote = await fx.bootstrap({ origin: PAIRED_ORIGIN }, agentHeaders);
  const own = await fx.bootstrap();
  assert.equal(fx.conversationGroups.groupOfConversation(remote), null);
  assert.equal(fx.conversationGroups.groupOfConversation(own), null);
  const list = await fx.call('GET /api/conversations');
  assert.deepEqual(list.body.conversations.map((row) => [row.groupId, row.groupRole]), [[null, null], [null, null]]);
  assert.deepEqual(list.body.groups, {});
  const single = await fx.call('GET /api/conversation/:id', { params: { id: own } });
  assert.equal(single.body.group, null);
});

test('the list orders a group by its newest member, head first, and keeps it whole across a page', async () => {
  const fx = setup();
  const lead = await fx.bootstrap({ title: 'Release lead' });
  const childA = await fx.createdBy(lead, 'Docs pass');
  const childB = await fx.createdBy(lead, 'Tests pass');
  const solo = await fx.bootstrap({ title: 'Lone chat' });
  const old = await fx.bootstrap({ title: 'Older chat' });
  fx.touch(lead, '2026-10-13T10:00:00.000Z');
  fx.touch(childA, '2026-10-13T10:30:00.000Z');
  fx.touch(childB, '2026-10-13T10:20:00.000Z');
  fx.touch(solo, '2026-10-13T10:25:00.000Z');
  fx.touch(old, '2026-10-13T09:00:00.000Z');
  const first = await fx.call('GET /api/conversations', { query: { limit: '2' } });
  assert.deepEqual(first.body.conversations.map((row) => row.id), [lead, childA, childB]);
  assert.equal(first.body.pageInfo.hasMore, true);
  const second = await fx.call('GET /api/conversations', { query: { limit: '2', ...first.body.pageInfo.nextCursor } });
  assert.deepEqual(second.body.conversations.map((row) => row.id), [solo, old]);
  assert.equal(second.body.pageInfo.hasMore, false);
});

test('hand-made groups: create, rename, move in and out, dissolve; every change is announced', async () => {
  const fx = setup();
  const a = await fx.bootstrap({ title: 'Chat A' });
  const b = await fx.bootstrap({ title: 'Chat B' });
  const c = await fx.bootstrap({ title: 'Chat C' });

  const created = await fx.call('POST /api/conversation-groups', { body: { name: 'Sample batch', conversationIds: [a] } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const groupId = created.body.group.id;
  assert.deepEqual(created.body.group, { id: groupId, name: 'Sample batch', parentConversationId: null, members: [a] });
  assert.deepEqual(fx.events('conversation_group_changed').at(-1), {
    groupId,
    conversationIds: [a],
    group: { id: groupId, name: 'Sample batch', displayName: 'Sample batch', parentConversationId: null, memberCount: 1, liveMemberCount: 1 },
    memberships: { [a]: { groupId, role: 'member' } },
    order: [a],
    positions: { [a]: null },
  });

  const list = await fx.call('GET /api/conversations');
  assert.equal(list.body.groups[groupId].displayName, 'Sample batch');
  assert.equal(list.body.groups[groupId].memberCount, 1);

  const moved = await fx.call('PUT /api/conversation/:id/group', { params: { id: b }, body: { groupId } });
  assert.deepEqual(moved.body, { ok: true, groupId, previousGroupId: null, changed: true });
  const again = await fx.call('PUT /api/conversation/:id/group', { params: { id: b }, body: { groupId } });
  assert.equal(again.body.changed, false);
  const missing = await fx.call('PUT /api/conversation/:id/group', { params: { id: c }, body: { groupId: 'grp_missing' } });
  assert.equal(missing.status, 404);

  const renamed = await fx.call('PATCH /api/conversation-groups/:id', { params: { id: groupId }, body: { name: 'Night batch' } });
  assert.equal(renamed.body.group.name, 'Night batch');
  const tooLong = await fx.call('PATCH /api/conversation-groups/:id', { params: { id: groupId }, body: { name: 'x'.repeat(61) } });
  assert.equal(tooLong.status, 400);

  const removed = await fx.call('DELETE /api/conversation/:id/group', { params: { id: a } });
  assert.deepEqual(removed.body, { ok: true, previousGroupId: groupId, changed: true });
  assert.equal(fx.conversationGroups.groupOfConversation(a), null);

  const dissolved = await fx.call('DELETE /api/conversation-groups/:id', { params: { id: groupId } });
  assert.deepEqual(dissolved.body, { ok: true, members: [b] });
  assert.deepEqual(fx.events('conversation_group_changed').at(-1), { groupId, conversationIds: [b], group: null, memberships: { [b]: null }, order: [], positions: { [b]: null } });
  assert.equal(fx.conversationGroups.getGroup(groupId), null);
  assert.equal((await fx.call('DELETE /api/conversation-groups/:id', { params: { id: groupId } })).status, 404);
  assert.equal((await fx.call('POST /api/conversation-groups', { body: { conversationIds: [] } })).status, 400);
  assert.equal((await fx.call('POST /api/conversation-groups', { body: { conversationIds: ['conv-missing'] } })).status, 404);
});

test('a new group from rows of other groups announces those groups too', async () => {
  const fx = setup();
  const a = await fx.bootstrap({ title: 'Chat A' });
  const b = await fx.bootstrap({ title: 'Chat B' });
  const c = await fx.bootstrap({ title: 'Chat C' });
  const first = (await fx.call('POST /api/conversation-groups', { body: { name: 'Sample batch', conversationIds: [a, b] } })).body.group.id;
  const before = fx.events('conversation_group_changed').length;
  const made = await fx.call('POST /api/conversation-groups', { body: { name: null, conversationIds: [a, c] } });
  assert.equal(made.status, 200);
  const announced = fx.events('conversation_group_changed').slice(before);
  assert.deepEqual(announced.map((event) => [event.groupId, event.conversationIds]), [[made.body.group.id, [a, c]], [first, [a]]]);
  assert.deepEqual(announced[1].memberships, { [a]: { groupId: made.body.group.id, role: 'member' } });
  assert.equal(announced[1].group.memberCount, 1, 'the old group, one row smaller');
  // Its last row taken: the old group is announced gone.
  const third = await fx.call('POST /api/conversation-groups', { body: { name: null, conversationIds: [b] } });
  const gone = fx.events('conversation_group_changed').at(-1);
  assert.equal(gone.groupId, first);
  assert.equal(gone.group, null);
  assert.deepEqual(gone.memberships, { [b]: { groupId: third.body.group.id, role: 'member' } });
});

test('a move names its group and its place with a string or null; anything else is refused', async () => {
  const fx = setup();
  const a = await fx.bootstrap({ title: 'Chat A' });
  const groupId = (await fx.call('POST /api/conversation-groups', { body: { name: 'Sample batch', conversationIds: [a] } })).body.group.id;
  const b = await fx.bootstrap({ title: 'Chat B' });
  for (const body of [
    { groupId: { id: groupId } },
    { groupId: [groupId] },
    { groupId: 7 },
    { groupId, beforeConversationId: { id: a } },
    { groupId, beforeConversationId: [a] },
    { groupId, beforeConversationId: 3 },
  ]) {
    const refused = await fx.call('PUT /api/conversation/:id/group', { params: { id: b }, body });
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.equal(fx.conversationGroups.groupOfConversation(b), null);
  assert.equal((await fx.call('PUT /api/conversation/:id/group', { params: { id: b }, body: { groupId, beforeConversationId: a } })).status, 200);
  assert.equal((await fx.call('PUT /api/conversation/:id/group', { params: { id: b }, body: { groupId: null, beforeConversationId: null } })).status, 200);
  assert.equal(fx.conversationGroups.groupOfConversation(b), null);
});

test('a paired relay\'s request cannot change groups', async () => {
  const fx = setup();
  const a = await fx.bootstrap({ title: 'Chat A' });
  for (const [key, options] of [
    ['POST /api/conversation-groups', { body: { conversationIds: [a] } }],
    ['PATCH /api/conversation-groups/:id', { params: { id: 'grp_x' }, body: { name: 'x' } }],
    ['PUT /api/conversation/:id/group', { params: { id: a }, body: { groupId: 'grp_x' } }],
    ['DELETE /api/conversation/:id/group', { params: { id: a } }],
    ['DELETE /api/conversation-groups/:id', { params: { id: 'grp_x' } }],
    ['POST /api/conversation-groups/:id/archive', { params: { id: 'grp_x' } }],
  ]) {
    const refused = await fx.call(key, { ...options, headers: agentHeaders });
    assert.equal(refused.status, 403, key);
  }
  assert.equal(fx.conversationGroups.groupOfConversation(a), null);
});

test('archiving a group archives the idle members and lists the running one; the head alone leaves a headless live group', async () => {
  const fx = setup();
  const lead = await fx.bootstrap({ title: 'Release lead' });
  const child = await fx.createdBy(lead, 'Docs pass');
  const busy = await fx.createdBy(lead, 'Tests pass');
  const groupId = fx.conversationGroups.groupOfConversation(lead).id;
  // A processing queue row: that member is working on a reply.
  fx.db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES ('q-busy', ?, 'run the tests', 'processing', ?)`).run(busy, NOW);

  const archived = await fx.call('POST /api/conversation-groups/:id/archive', { params: { id: groupId } });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual(archived.body.archived.sort(), [child, lead].sort());
  assert.deepEqual(archived.body.skipped, [{ id: busy, title: 'Tests pass', reason: 'turn-running' }]);
  assert.equal(fx.events('conversation_archived').length, 2);
  assert.deepEqual(fx.events('conversation_group_changed').at(-1).groupId, groupId);

  // The live list: the busy member only, under its group; the head is archived.
  const live = await fx.call('GET /api/conversations');
  assert.deepEqual(live.body.conversations.map((row) => [row.id, row.groupRole]), [[busy, 'member']]);
  assert.equal(live.body.groups[groupId].displayName, 'Release lead');
  assert.equal(live.body.groups[groupId].liveMemberCount, 1);
  assert.equal(live.body.groups[groupId].memberCount, 3);
  const archivedView = await fx.call('GET /api/conversations', { query: { archived: 'only' } });
  assert.deepEqual(archivedView.body.conversations.map((row) => [row.id, row.groupRole]), [[lead, 'head'], [child, 'member']]);
  assert.equal((await fx.call('POST /api/conversation-groups/:id/archive', { params: { id: 'grp_missing' } })).status, 404);
});

test('deleting the head freezes its title as the group name; deleting the last member removes the group', async () => {
  const fx = setup();
  const lead = await fx.bootstrap({ title: 'Release lead' });
  const child = await fx.createdBy(lead, 'Docs pass');
  const groupId = fx.conversationGroups.groupOfConversation(lead).id;

  const deleted = await fx.call('DELETE /api/conversation/:id', { params: { id: lead } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  const headless = fx.conversationGroups.getGroup(groupId);
  assert.equal(headless.parentConversationId, null);
  assert.equal(headless.name, 'Release lead');
  const gone = fx.events('conversation_group_changed').at(-1);
  assert.equal(gone.groupId, groupId);
  assert.deepEqual(gone.conversationIds, [lead]);
  assert.deepEqual(gone.memberships, { [lead]: null }, 'a deleted head has no membership');
  assert.equal(gone.group.parentConversationId, null);
  assert.equal(gone.group.displayName, 'Release lead');
  const list = await fx.call('GET /api/conversations');
  assert.deepEqual(list.body.conversations.map((row) => [row.id, row.groupRole]), [[child, 'member']]);
  assert.equal(list.body.groups[groupId].displayName, 'Release lead');
  assert.equal(list.body.groups[groupId].parentConversationId, null);

  await fx.call('DELETE /api/conversation/:id', { params: { id: child } });
  assert.equal(fx.conversationGroups.getGroup(groupId), null);
});

test('a drag places a conversation before another or at the end, takes it out with groupId null, and announces the order', async () => {
  const fx = setup();
  const a = await fx.bootstrap({ title: 'Chat A' });
  const b = await fx.bootstrap({ title: 'Chat B' });
  const c = await fx.bootstrap({ title: 'Chat C' });
  const d = await fx.bootstrap({ title: 'Chat D' });
  fx.touch(a, '2026-10-13T10:01:00.000Z');
  fx.touch(b, '2026-10-13T10:02:00.000Z');
  fx.touch(c, '2026-10-13T10:03:00.000Z');
  fx.touch(d, '2026-10-13T10:04:00.000Z');
  const created = await fx.call('POST /api/conversation-groups', { body: { name: 'Sample batch', conversationIds: [a, b, c] } });
  const groupId = created.body.group.id;
  assert.deepEqual(created.body.group.members, [c, b, a]);

  // Reorder inside the group: a before c.
  const reordered = await fx.call('PUT /api/conversation/:id/group', { params: { id: a }, body: { groupId, beforeConversationId: c } });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual(reordered.body, { ok: true, groupId, previousGroupId: groupId, changed: true, order: [a, c, b] });
  const changed = fx.events('conversation_group_changed');
  assert.deepEqual(changed.at(-1).order, [a, c, b]);
  assert.deepEqual(changed.at(-1).positions, { [a]: 10, [c]: 20, [b]: 30 });
  assert.equal(changed.at(-1).groupId, groupId);
  const eventsBefore = changed.length;

  // The list rows carry the position and follow the hand order.
  const list = await fx.call('GET /api/conversations');
  assert.deepEqual(list.body.conversations.map((row) => [row.id, row.groupPosition]), [[d, null], [a, 10], [c, 20], [b, 30]]);
  const single = await fx.call('GET /api/conversation/:id', { params: { id: c } });
  assert.equal(single.body.groupPosition, 20);
  // read_session's members (the remote_relay tool) follow the same order.
  const withMembers = await fx.call('GET /api/conversation/:id', { params: { id: c }, query: { groupMembers: '1' } });
  assert.deepEqual(withMembers.body.group.members.map((member) => member.id), [a, c, b]);
  assert.equal((await fx.call('GET /api/conversation/:id', { params: { id: d } })).body.groupPosition, null);

  // In from outside, to the end (beforeConversationId null).
  const toEnd = await fx.call('PUT /api/conversation/:id/group', { params: { id: d }, body: { groupId, beforeConversationId: null } });
  assert.deepEqual(toEnd.body, { ok: true, groupId, previousGroupId: null, changed: true, order: [a, c, b, d] });
  assert.equal(fx.events('conversation_group_changed').length, eventsBefore + 1, 'one event: there was no previous group');
  assert.deepEqual(fx.events('conversation_group_changed').at(-1).positions, { [a]: 10, [c]: 20, [b]: 30, [d]: 40 });

  // A drop that changes nothing announces nothing.
  const same = await fx.call('PUT /api/conversation/:id/group', { params: { id: d }, body: { groupId, beforeConversationId: null } });
  assert.equal(same.body.changed, false);
  assert.equal(fx.events('conversation_group_changed').length, eventsBefore + 1);

  // The menu's body (no beforeConversationId) joins a hand-ordered group at the end, as before.
  const e = await fx.bootstrap({ title: 'Chat E' });
  const menu = await fx.call('PUT /api/conversation/:id/group', { params: { id: e }, body: { groupId } });
  assert.deepEqual(menu.body, { ok: true, groupId, previousGroupId: null, changed: true });
  assert.deepEqual(fx.events('conversation_group_changed').at(-1).order, [a, c, b, d, e]);
  assert.equal(fx.events('conversation_group_changed').at(-1).positions[e], 50);

  // groupId null: out, with or without a place.
  const out = await fx.call('PUT /api/conversation/:id/group', { params: { id: e }, body: { groupId: null } });
  assert.deepEqual(out.body, { ok: true, groupId: null, previousGroupId: groupId, changed: true });
  const outEvent = fx.events('conversation_group_changed').at(-1);
  assert.equal(outEvent.groupId, groupId);
  assert.deepEqual(outEvent.order, [a, c, b, d]);
  assert.equal(outEvent.positions[e], null);
  assert.deepEqual(outEvent.memberships, { [e]: null });
  const outDrag = await fx.call('PUT /api/conversation/:id/group', { params: { id: d }, body: { groupId: null, beforeConversationId: null } });
  assert.deepEqual(outDrag.body, { ok: true, groupId: null, previousGroupId: groupId, changed: true, order: [] });

  // Between groups: both groups are announced.
  const other = await fx.call('POST /api/conversation-groups', { body: { name: 'Other batch', conversationIds: [e] } });
  const otherId = other.body.group.id;
  const across = await fx.call('PUT /api/conversation/:id/group', { params: { id: b }, body: { groupId: otherId, beforeConversationId: e } });
  assert.deepEqual(across.body, { ok: true, groupId: otherId, previousGroupId: groupId, changed: true, order: [b, e] });
  const [toTarget, toSource] = fx.events('conversation_group_changed').slice(-2);
  assert.deepEqual([toTarget.groupId, toTarget.order, toTarget.positions], [otherId, [b, e], { [b]: 10, [e]: 20 }]);
  assert.deepEqual([toSource.groupId, toSource.order, toSource.positions], [groupId, [a, c], { [a]: 10, [c]: 20, [b]: 10 }]);

  // 404s and 400.
  assert.equal((await fx.call('PUT /api/conversation/:id/group', { params: { id: a }, body: { groupId: 'grp_missing', beforeConversationId: null } })).status, 404);
  assert.equal((await fx.call('PUT /api/conversation/:id/group', { params: { id: 'conv-missing' }, body: { groupId, beforeConversationId: null } })).status, 404);
  assert.equal((await fx.call('PUT /api/conversation/:id/group', { params: { id: a }, body: {} })).status, 400);
  // A paired relay's drag is refused.
  const refused = await fx.call('PUT /api/conversation/:id/group', { params: { id: a }, body: { groupId: null, beforeConversationId: null }, headers: agentHeaders });
  assert.equal(refused.status, 403);
  assert.equal(fx.conversationGroups.groupOfConversation(a)?.id, groupId);
});
