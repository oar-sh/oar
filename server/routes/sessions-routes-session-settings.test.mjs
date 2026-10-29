import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// PATCH /api/conversation/:id/settings (the relay_tool tool's
// update_session) and the owner's "agents in this conversation may start
// sessions" on PATCH …/preferences, against the REAL schema. Relay names,
// titles and folders are fictional.

const ROUTE = 'PATCH /api/conversation/:id/settings';
const PREFERENCES = 'PATCH /api/conversation/:id/preferences';
const LOCAL_ORIGIN = (conversationId) => ({
  relayId: 'relay-id-self',
  relayName: 'linux-test',
  conversationId,
  conversationTitle: 'Release lead',
  provider: 'claude',
  model: 'claude-opus-5',
  hops: 0,
  local: true,
});
const PAIRED_ORIGIN = {
  relayId: 'relay-id-win',
  relayName: 'win-test',
  conversationId: 'conv-on-other-relay',
  conversationTitle: 'report builder',
  provider: 'claude',
  model: 'claude-sonnet-5',
  hops: 1,
};
const agentHeaders = { 'x-oar-remote-origin': 'relay-id-win', 'x-oar-remote-hops': '1' };
const loopbackHeaders = { 'x-oar-remote-origin': 'self', 'x-oar-remote-hops': '0' };

let tempRoot = '';
let FOLDER_A = '';
let FOLDER_B = '';

test.before(() => {
  tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-settings-')));
  FOLDER_A = path.join(tempRoot, 'alpha');
  FOLDER_B = path.join(tempRoot, 'beta');
  fs.mkdirSync(FOLDER_A);
  fs.mkdirSync(FOLDER_B);
});

test.after(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  return { routes, get: record('GET'), post: record('POST'), patch: record('PATCH'), put: record('PUT'), delete: record('DELETE'), use() {} };
}

function setup({ sdkSessionId = '', workerStatus = 'ready', launchOk = true, onLaunch = null, processListThrows = false, onWorkspaceState = null } = {}) {
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
    recordUnlock: () => false,
    describeRelay: () => null,
  };
  const emitted = [];
  const calls = [];
  const app = createMockApp();
  const configured = new Map();
  const runtimeRoots = new Map();
  let workspaceReads = 0;
  const workspaceState = (conversationId) => ({
    sdkSessionId: sdkSessionId || null,
    configuredWorkspaceRootPath: configured.get(conversationId) || null,
    runtimeWorkspaceRootPath: runtimeRoots.get(conversationId) || null,
    currentWorkspaceRootPath: runtimeRoots.get(conversationId) || configured.get(conversationId) || null,
  });
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
    getModelCatalogState: () => ({ models: ['gpt-5.4-mini'], currentModel: 'gpt-5.4-mini', defaultModel: 'gpt-5.4-mini', reasoningByModel: {}, providersByModel: {} }),
    updateModelCatalog: () => ({}),
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => ({}),
    setEnabledModelVariants: () => ({}),
    SUPPORTED_REASONING_EFFORTS: ['none', 'low', 'medium', 'high'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => ({ recentWorkspaceRoots: [] }),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: ({ conversationId }) => {
      workspaceReads += 1;
      onWorkspaceState?.(workspaceReads, conversationId, db);
      return workspaceState(conversationId);
    },
    updateConversationConfiguredWorkspaceRoot: ({ conversationId, rootPath }) => {
      calls.push(['persist', conversationId, rootPath]);
      configured.set(conversationId, rootPath);
      return { ok: true, state: workspaceState(conversationId) };
    },
    learnConversationWorkspaceRoot: ({ conversationId, rootPath }) => {
      runtimeRoots.set(conversationId, rootPath);
      return { ok: true, learned: true, state: workspaceState(conversationId) };
    },
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
    sessionHistoryRefreshService: { evaluateRefreshIdleState: () => ({ idle: true }), replaceRetrievableHistory: () => {} },
    sdkSessionImportService: null,
    statusEventService: { recordSharedAccess: () => ({ event: null }) },
    isSha256: () => false,
    remoteRelayInbound,
    conversationGroups,
    // The relaunch path, as the CWD route tests stub it: no real process.
    sessionWorkerSupervisor: {
      getWorkerState: () => (workerStatus ? { status: workerStatus, pid: 0 } : null),
      markKilled: () => {},
      cancelPendingStart: async () => {},
      clearRestartSchedule: () => {},
      resetHealth: () => {},
      ensureWorker: async () => {
        calls.push(['ensureWorker']);
        onLaunch?.(db);
        return launchOk ? { ok: true, worker: { pid: 9999 }, lifecycle: {} } : { ok: false, statusCode: 500, error: 'spawn failed' };
      },
    },
    sessionWorkerProcessInspector: {
      findProcessForSessionAsync: () => {
        if (processListThrows) throw new Error('access denied');
        return null;
      },
      findProcessesForSessionAsync: () => [],
      findWindowsProcessTreeForSessionAsync: () => [],
      stopWindowsPidsAsync: () => {},
    },
    sessionWorkerStopOverrides: { platform: 'win32', isPidAliveImpl: () => false, killImpl: () => {}, killTmuxSessionImpl: () => {} },
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
    if (loopback) markRemoteRelayLoopbackRequest(req);
    await handler(req, res);
    return captured;
  };
  const bootstrap = async (body = {}, headers = {}, loopback = false) => {
    const created = await call('POST /api/conversation/bootstrap', { body: { title: 'Sample chat', relayMode: 'agent', ...body }, headers, loopback });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body.conversationId;
  };
  const owned = () => bootstrap({ title: 'Owner chat' });
  const agentMade = async () => {
    const lead = await owned();
    const child = await bootstrap({ title: 'Agent chat', origin: LOCAL_ORIGIN(lead) }, loopbackHeaders, true);
    return { lead, child };
  };
  // The conversation that started a session here (its origin), if any.
  const creatorOf = (id) => {
    try {
      return JSON.parse(db.prepare('SELECT origin_json FROM conversations WHERE id = ?').get(id)?.origin_json || 'null')?.conversationId || null;
    } catch {
      return null;
    }
  };
  // An agent of this relay (loopback), calling from `caller` (default: the
  // conversation that started the target, the free path), or of a paired one.
  const asLocalAgent = (id, body, { caller = creatorOf(id) } = {}) => call(ROUTE, {
    params: { id },
    body: { ...body, ...(caller ? { origin: LOCAL_ORIGIN(caller) } : {}) },
    headers: loopbackHeaders,
    loopback: true,
  });
  const asPairedAgent = (id, body, { origin = null } = {}) => call(ROUTE, { params: { id }, body: { ...body, ...(origin ? { origin } : {}) }, headers: agentHeaders });
  const events = (name) => emitted.filter(([event]) => event === name).map(([, payload]) => payload);
  const row = (id) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  return { db, stmts, conversationGroups, emitted, events, calls, call, bootstrap, owned, agentMade, asLocalAgent, asPairedAgent, row, creatorOf };
}

// ─── The owner's "may start sessions" switch ─────────────────────────────────

test('the owner turns "may start sessions" on and off; the list and the detail payload show it, the pages hear it', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  assert.equal(fx.row(child).may_create_sessions, null, 'off unless set');
  const on = await fx.call(PREFERENCES, { params: { id: child }, body: { clientId: 'client-a', mayCreateSessions: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.mayCreateSessions, true);
  assert.equal(fx.row(child).may_create_sessions, 1);
  assert.equal(fx.events('conversation_preferences_updated').at(-1).mayCreateSessions, true);
  const list = await fx.call('GET /api/conversations', { query: {} });
  assert.equal(list.body.conversations.find((entry) => entry.id === child).mayCreateSessions, true);
  const detail = await fx.call('GET /api/conversation/:id', { params: { id: child }, query: {} });
  assert.equal(detail.body.mayCreateSessions, true);
  // Another preference write leaves it alone.
  await fx.call(PREFERENCES, { params: { id: child }, body: { clientId: 'client-a', thinkingEnabled: false } });
  assert.equal(fx.row(child).may_create_sessions, 1);
  const off = await fx.call(PREFERENCES, { params: { id: child }, body: { mayCreateSessions: false } });
  assert.equal(off.body.mayCreateSessions, false);
  assert.equal(fx.row(child).may_create_sessions, 0);
});

test('no agent sets "may start sessions": the preferences route refuses a paired relay\'s and this relay\'s own agents', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  const paired = await fx.call(PREFERENCES, { params: { id: child }, body: { mayCreateSessions: true }, headers: agentHeaders });
  assert.equal(paired.status, 403);
  assert.match(paired.body.error, /owner's setting alone/);
  const local = await fx.call(PREFERENCES, { params: { id: child }, body: { mayCreateSessions: true }, headers: loopbackHeaders, loopback: true });
  assert.equal(local.status, 403);
  assert.equal(fx.row(child).may_create_sessions, null);
  const typed = await fx.call(PREFERENCES, { params: { id: child }, body: { mayCreateSessions: 'yes' } });
  assert.equal(typed.status, 400);
  // Nor through the settings route.
  const viaTool = await fx.asLocalAgent(child, { settings: { may_create_sessions: true } });
  assert.equal(viaTool.status, 400);
  assert.match(viaTool.body.error, /Not a setting an agent may change: may_create_sessions/);
  assert.equal(fx.row(child).may_create_sessions, null);
});

// ─── PATCH …/settings ────────────────────────────────────────────────────────

test('an agent changes an agent-made session\'s settings through the owner\'s code paths, with their broadcasts', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  fx.emitted.length = 0;
  const result = await fx.asLocalAgent(child, {
    settings: { model: 'claude-opus-5', effort: 'high', mode: 'plan', auto_compact_window: 200000, title: 'Docs pass', thinking_enabled: false, thinking_display: 'omitted' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(result.body.ownerStarted, false);
  assert.deepEqual(result.body.changed, ['model', 'effort', 'mode', 'auto_compact_window', 'title', 'thinking_enabled', 'thinking_display']);
  assert.equal(result.body.settings.model, 'claude-opus-5');
  assert.equal(result.body.settings.effort, 'high');
  assert.equal(result.body.settings.mode, 'plan');
  assert.equal(result.body.settings.auto_compact_window, 200000);
  assert.equal(result.body.settings.title, 'Docs pass');
  assert.equal(result.body.settings.thinking_enabled, false);
  assert.equal(result.body.settings.thinking_display, 'omitted');
  const stored = fx.row(child);
  assert.equal(stored.preferred_model, 'claude-opus-5');
  assert.equal(stored.preferred_reasoning_effort, 'high');
  assert.equal(stored.preferred_relay_mode, 'plan');
  assert.equal(stored.auto_compact_window, 200000);
  assert.equal(stored.title, 'Docs pass');
  assert.equal(stored.title_source, 'manual');
  assert.equal(stored.thinking_enabled, 0);
  // The open page learns of it at once, from the events its own controls cause.
  const preferences = fx.events('conversation_preferences_updated');
  assert.equal(preferences.length, 1);
  assert.equal(preferences[0].preferredModel, 'claude-opus-5');
  assert.equal(preferences[0].senderClientId, null);
  assert.equal(fx.events('conversation_title_updated')[0].title, 'Docs pass');
});

test('a setting that is already so changes nothing and says so; a window snaps and the answer says to what', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  await fx.asLocalAgent(child, { settings: { effort: 'high' } });
  const same = await fx.asLocalAgent(child, { settings: { effort: 'high' } });
  assert.equal(same.status, 200);
  assert.deepEqual(same.body.changed, []);
  const snapped = await fx.asLocalAgent(child, { settings: { auto_compact_window: 180000 } });
  assert.equal(snapped.body.settings.auto_compact_window, 200000);
  assert.match(snapped.body.notes.join(' '), /180000 was taken as 200000/);
  const auto = await fx.asLocalAgent(child, { settings: { auto_compact_window: 'auto' } });
  assert.deepEqual(auto.body.changed, ['auto_compact_window']);
  assert.equal(auto.body.settings.auto_compact_window, 'auto');
  assert.equal(fx.row(child).auto_compact_window, null);
});

test('a session the owner started: a paired agent needs owner_approved, a dry run says so and writes nothing', async () => {
  const fx = setup();
  const lead = await fx.owned();
  const dry = await fx.asPairedAgent(lead, { settings: { model: 'claude-opus-5' }, dry_run: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.ownerStarted, true);
  assert.deepEqual(dry.body.changed, ['model']);
  assert.notEqual(fx.row(lead).preferred_model, 'claude-opus-5');
  const refused = await fx.asPairedAgent(lead, { settings: { model: 'claude-opus-5' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'REMOTE_RELAY_PERMISSION');
  assert.notEqual(fx.row(lead).preferred_model, 'claude-opus-5');
  const local = await fx.asLocalAgent(lead, { settings: { model: 'claude-opus-5' } });
  assert.equal(local.status, 403, 'this relay\'s own agents too');
  const allowed = await fx.asPairedAgent(lead, { settings: { model: 'claude-opus-5' }, owner_approved: true });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(fx.row(lead).preferred_model, 'claude-opus-5');
  // The owner needs nobody's leave.
  const owner = await fx.call(ROUTE, { params: { id: lead }, body: { settings: { effort: 'low' } } });
  assert.equal(owner.status, 200);
});

test('free only for the conversation that started the session; a sibling, the creator, another worker and a paired agent need the Allow', async () => {
  const fx = setup();
  const { lead, child } = await fx.agentMade();
  const sibling = await fx.bootstrap({ title: 'Sibling', origin: LOCAL_ORIGIN(lead) }, loopbackHeaders, true);
  const worker = await fx.owned();
  const tryAs = (target, caller) => fx.asLocalAgent(target, { settings: { effort: 'low' } }, { caller });

  // The conversation that started it: free, and the dry run says so.
  const dry = await fx.asLocalAgent(child, { settings: { effort: 'high' }, dry_run: true }, { caller: lead });
  assert.equal(dry.body.startedByCaller, true);
  assert.equal(dry.body.approvalNeeded, false);
  assert.equal((await tryAs(child, lead)).status, 200);

  // A sibling started by the same lead, the child acting on its creator, and
  // a worker of another conversation: all need the Allow.
  for (const [target, caller, what] of [[sibling, child, 'a sibling'], [lead, child, 'the creator'], [child, worker, 'another conversation\'s worker'], [child, null, 'no origin at all']]) {
    const checked = await fx.asLocalAgent(target, { settings: { effort: 'medium' }, dry_run: true }, { caller });
    assert.equal(checked.body.approvalNeeded, true, what);
    const refused = await tryAs(target, caller);
    assert.equal(refused.status, 403, what);
    assert.equal(refused.body.code, 'REMOTE_RELAY_PERMISSION', what);
    const allowed = await fx.asLocalAgent(target, { settings: { effort: 'medium' }, owner_approved: true }, { caller });
    assert.equal(allowed.status, 200, what);
  }

  // A paired relay's agent: free on a session it started (same relay, same
  // conversation), not on one another of its conversations started, nor on
  // one this relay's agent started.
  const remoteMade = await fx.bootstrap({ title: 'From afar', origin: PAIRED_ORIGIN }, agentHeaders);
  assert.equal((await fx.asPairedAgent(remoteMade, { settings: { effort: 'low' } }, { origin: PAIRED_ORIGIN })).status, 200);
  const otherConversation = await fx.asPairedAgent(remoteMade, { settings: { effort: 'high' } }, { origin: { ...PAIRED_ORIGIN, conversationId: 'conv-other-on-that-relay' } });
  assert.equal(otherConversation.status, 403);
  const otherRelay = await fx.asPairedAgent(remoteMade, { settings: { effort: 'high' } }, { origin: { ...PAIRED_ORIGIN, relayId: 'relay-id-elsewhere' } });
  assert.equal(otherRelay.status, 403);
  const onLocal = await fx.asPairedAgent(child, { settings: { effort: 'high' } }, { origin: { ...PAIRED_ORIGIN, conversationId: lead } });
  assert.equal(onLocal.status, 403, 'a paired agent naming a local conversation is no local creator');
});

test('group: by id, by name (case-insensitive), a new name makes a group, none and null take it out', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  const other = await fx.owned();
  const hand = await fx.call('POST /api/conversation-groups', { body: { name: 'Docs batch', conversationIds: [other] } });
  const groupId = hand.body.group.id;

  const byId = await fx.asLocalAgent(child, { settings: { group: groupId } });
  assert.equal(byId.status, 200, JSON.stringify(byId.body));
  assert.deepEqual(byId.body.changed, ['group']);
  assert.equal(byId.body.settings.group.id, groupId);
  assert.ok(fx.events('conversation_group_changed').some((event) => event.groupId === groupId && event.conversationIds.includes(child)));

  const out = await fx.asLocalAgent(child, { settings: { group: null } });
  assert.deepEqual(out.body.changed, ['group']);
  assert.equal(out.body.settings.group, null);

  const byName = await fx.asLocalAgent(child, { settings: { group: 'docs BATCH' } });
  assert.equal(byName.body.settings.group.id, groupId);
  assert.equal((await fx.asLocalAgent(child, { settings: { group: 'Docs batch' } })).body.changed.length, 0);

  const made = await fx.asLocalAgent(child, { settings: { group: '  Release   prep ' } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.groupCreated.name, 'Release prep');
  assert.equal(made.body.settings.group.id, made.body.groupCreated.id);
  assert.equal(fx.conversationGroups.getGroup(made.body.groupCreated.id).name, 'Release prep');

  const none = await fx.asLocalAgent(child, { settings: { group: 'none' } });
  assert.equal(none.body.settings.group, null);
  // The group it made is gone with its only member.
  assert.equal(fx.conversationGroups.getGroup(made.body.groupCreated.id), null);
});

test('a group update_session made is one create_session can name, by name or id, and the list shows it', async () => {
  const fx = setup();
  const { lead, child } = await fx.agentMade();
  const made = await fx.asLocalAgent(child, { settings: { group: 'Release prep' } });
  const groupId = made.body.groupCreated.id;
  // Both resolve against the same list with the same rule.
  const byName = await fx.call('POST /api/conversation/bootstrap', {
    body: { title: 'Next part', relayMode: 'agent', origin: LOCAL_ORIGIN(lead), group: 'release PREP' }, headers: loopbackHeaders, loopback: true,
  });
  assert.equal(byName.status, 200, JSON.stringify(byName.body));
  assert.equal(byName.body.group.id, groupId);
  const list = await fx.call('GET /api/conversations', { query: {} });
  const rows = list.body.conversations.filter((entry) => entry.groupId === groupId).map((entry) => entry.id).sort();
  assert.deepEqual(rows, [child, byName.body.conversationId].sort());
  // create_session still takes an existing group only.
  const unknown = await fx.call('POST /api/conversation/bootstrap', {
    body: { title: 'Elsewhere', relayMode: 'agent', origin: LOCAL_ORIGIN(lead), group: 'Not there' }, headers: loopbackHeaders, loopback: true,
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'SESSION_GROUP_NOT_FOUND');
});

test('group: an unknown id and an ambiguous name are refused with the groups listed, nothing changed', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  const a = await fx.owned();
  const b = await fx.owned();
  await fx.call('POST /api/conversation-groups', { body: { name: 'Release', conversationIds: [a] } });
  await fx.call('POST /api/conversation-groups', { body: { name: 'release', conversationIds: [b] } });
  const unknown = await fx.asLocalAgent(child, { settings: { group: 'grp_missing', model: 'claude-opus-5' } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'SESSION_GROUP_NOT_FOUND');
  assert.match(unknown.body.error, /Nothing was changed\./);
  assert.notEqual(fx.row(child).preferred_model, 'claude-opus-5', 'the other settings are not written either');
  const ambiguous = await fx.asLocalAgent(child, { settings: { group: 'RELEASE' } });
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.body.code, 'SESSION_GROUP_AMBIGUOUS');
  assert.equal(ambiguous.body.groups.length, 2);
  const long = await fx.asLocalAgent(child, { settings: { group: 'x'.repeat(61) } });
  assert.equal(long.status, 400);
  assert.match(long.body.error, /at most 60 characters/);
});

test('the settings route refuses an unknown session, a bad value and a mode the relay lacks', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  const missing = await fx.asLocalAgent('conv-missing', { settings: { effort: 'high' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'SESSION_NOT_FOUND');
  assert.equal((await fx.asLocalAgent(child, { settings: {} })).status, 400);
  assert.equal((await fx.asLocalAgent(child, { settings: 'model' })).status, 400);
  assert.match((await fx.asLocalAgent(child, { settings: { thinking_display: 'raw' } })).body.error, /thinking_display/);
});

test('cwd: a session that never ran saves the folder; a busy one is refused with the reason', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  const saved = await fx.asLocalAgent(child, { settings: { cwd: FOLDER_A } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.changed, ['cwd']);
  assert.equal(saved.body.relaunched, false);
  assert.equal(saved.body.settings.cwd, FOLDER_A);
  assert.ok(fx.events('conversation_workspace_root_updated').some((event) => event.conversationId === child));
  // The same folder again: nothing to do.
  assert.deepEqual((await fx.asLocalAgent(child, { settings: { cwd: FOLDER_A } })).body.changed, []);

  fx.db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES ('q-busy', ?, 'work', 'processing', '2026-10-13T10:00:00.000Z')`).run(child);
  const busy = await fx.asLocalAgent(child, { settings: { cwd: FOLDER_B, effort: 'low' } });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'SESSION_BUSY');
  assert.match(busy.body.reason, /turn is queued or running/);
  assert.notEqual(fx.row(child).preferred_reasoning_effort, 'low', 'nothing else is written');

  const relative = await fx.asLocalAgent(child, { settings: { cwd: 'relative/folder' } });
  assert.equal(relative.status, 400);
});

test('cwd: a session with a CLI is relaunched in the new folder through the owner\'s relaunch path', async () => {
  const fx = setup({ sdkSessionId: 'sess-fixture' });
  const { child } = await fx.agentMade();
  const moved = await fx.asLocalAgent(child, { settings: { cwd: FOLDER_B } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.relaunched, true);
  assert.equal(moved.body.settings.cwd, FOLDER_B);
  assert.ok(fx.calls.some(([kind]) => kind === 'ensureWorker'));
});

test('cwd: a failed relaunch is reported and nothing else is written', async () => {
  const fx = setup({ sdkSessionId: 'sess-fixture', launchOk: false });
  const { child } = await fx.agentMade();
  const failed = await fx.asLocalAgent(child, { settings: { cwd: FOLDER_A, effort: 'low' } });
  assert.notEqual(failed.status, 200);
  assert.equal(failed.body.ok, false);
  assert.notEqual(fx.row(child).preferred_reasoning_effort, 'low');
});

// ─── Groups the owner made (fix round 1) ─────────────────────────────────────

test('an agent never removes a group the owner made: "none" on its last member leaves it, empty, kept through the repair, and nameable', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  const hand = await fx.call('POST /api/conversation-groups', { body: { name: 'Owner batch', conversationIds: [child] } });
  const groupId = hand.body.group.id;
  const out = await fx.asLocalAgent(child, { settings: { group: 'none' } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.settings.group, null);
  const kept = fx.conversationGroups.getGroup(groupId);
  assert.ok(kept, 'the owner\'s group stays');
  assert.ok(kept.keptEmptyAt);
  assert.equal(kept.agentMade, false);
  // The boot repair and the sweep pass it by; agents still see and name it.
  assert.equal(fx.conversationGroups.repair().groupsRemoved, 0);
  assert.equal(fx.conversationGroups.sweepEmpty(), 0);
  assert.deepEqual(fx.conversationGroups.listGroups().find((group) => group.id === groupId), { id: groupId, name: 'Owner batch', memberCount: 0 });
  const back = await fx.asLocalAgent(child, { settings: { group: 'owner batch' } });
  assert.equal(back.body.settings.group.id, groupId);
  assert.equal(fx.conversationGroups.getGroup(groupId).keptEmptyAt, null, 'a member back: an ordinary group again');
});

test('moving the last member of an owner\'s group into another group or a new one keeps the owner\'s group too', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  const other = await fx.owned();
  const owner = (await fx.call('POST /api/conversation-groups', { body: { name: 'Owner batch', conversationIds: [child] } })).body.group.id;
  const target = (await fx.call('POST /api/conversation-groups', { body: { name: 'Target batch', conversationIds: [other] } })).body.group.id;
  assert.equal((await fx.asLocalAgent(child, { settings: { group: target } })).status, 200);
  assert.ok(fx.conversationGroups.getGroup(owner), 'kept after a join elsewhere');
  await fx.asLocalAgent(child, { settings: { group: owner } });
  const made = await fx.asLocalAgent(child, { settings: { group: 'Fresh batch' } });
  assert.equal(made.status, 200);
  assert.ok(fx.conversationGroups.getGroup(owner), 'kept after a move into a new group');
  assert.equal(fx.conversationGroups.getGroup(made.body.groupCreated.id).agentMade, true);
});

test('a group the agent path made goes once its last member leaves; the owner\'s own moves still remove an empty group', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  const made = await fx.asLocalAgent(child, { settings: { group: 'Agent batch' } });
  const madeId = made.body.groupCreated.id;
  await fx.asLocalAgent(child, { settings: { group: null } });
  assert.equal(fx.conversationGroups.getGroup(madeId), null);
  // By hand, as before: the owner's own move out deletes the empty group.
  const hand = (await fx.call('POST /api/conversation-groups', { body: { name: 'Hand batch', conversationIds: [child] } })).body.group.id;
  await fx.call('DELETE /api/conversation/:id/group', { params: { id: child } });
  assert.equal(fx.conversationGroups.getGroup(hand), null);
});

test('two calls that make the same group name side by side end in one group', async () => {
  const fx = setup();
  const { lead, child } = await fx.agentMade();
  const second = await fx.bootstrap({ title: 'Second', origin: LOCAL_ORIGIN(lead) }, loopbackHeaders, true);
  // A folder change makes each call wait once, so the two interleave.
  const [a, b] = await Promise.all([
    fx.asLocalAgent(child, { settings: { group: 'Shared batch', cwd: FOLDER_A } }),
    fx.asLocalAgent(second, { settings: { group: 'Shared batch', cwd: FOLDER_B } }),
  ]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(a.body.settings.group.id, b.body.settings.group.id);
  assert.equal(fx.conversationGroups.listGroups().filter((group) => group.name === 'Shared batch').length, 1);
});

// ─── Partial writes and the folder's last checks (fix round 1) ───────────────

test('a step that fails after another wrote answers changed with what was written', async () => {
  let groupToDrop = null;
  const fx = setup({
    sdkSessionId: 'sess-fixture',
    // The group goes while the CLI relaunches: the join after it fails.
    onLaunch: (db) => {
      db.prepare('UPDATE conversations SET group_id = NULL WHERE group_id = ?').run(groupToDrop);
      db.prepare('DELETE FROM conversation_groups WHERE id = ?').run(groupToDrop);
    },
  });
  const { child } = await fx.agentMade();
  const other = await fx.owned();
  groupToDrop = (await fx.call('POST /api/conversation-groups', { body: { name: 'Doomed batch', conversationIds: [other] } })).body.group.id;
  const result = await fx.asLocalAgent(child, { settings: { cwd: FOLDER_A, effort: 'low', group: groupToDrop } });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'SESSION_GROUP_NOT_FOUND');
  assert.deepEqual(result.body.changed, ['cwd', 'effort']);
  assert.match(result.body.error, /These settings were changed before: cwd, effort\./);
});

test('an unreadable process list is its own error, and nothing is written', async () => {
  const fx = setup({ sdkSessionId: 'sess-fixture', processListThrows: true });
  const { child } = await fx.agentMade();
  const result = await fx.asLocalAgent(child, { settings: { cwd: FOLDER_A, effort: 'low' } });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'PROCESS_LIST_UNREADABLE');
  assert.match(result.body.error, /could not read its process list/);
  assert.notEqual(fx.row(child).preferred_reasoning_effort, 'low');
});

test('the folder change asks again whether the session is busy right before the relaunch', async () => {
  // Armed once the sessions exist: the plan reads the folder once, the
  // relaunch path once more; a turn starts in between.
  let reads = null;
  const fx = setup({
    sdkSessionId: 'sess-fixture',
    onWorkspaceState: (_count, conversationId, db) => {
      if (reads === null) return;
      reads += 1;
      if (reads === 2) db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES ('q-late', ?, 'work', 'pending', '2026-10-13T10:00:00.000Z')`).run(conversationId);
    },
  });
  const { child } = await fx.agentMade();
  reads = 0;
  const result = await fx.asLocalAgent(child, { settings: { cwd: FOLDER_B } });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'SESSION_BUSY');
  assert.equal(fx.calls.some(([kind]) => kind === 'ensureWorker'), false, 'nothing relaunched');
});

// ─── Round 2: kept groups shown to the owner, the auto group, a late ambiguity ─

test('the owner sees a kept empty group in the list\'s first page, and dissolves or renames it as usual', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  const groupId = (await fx.call('POST /api/conversation-groups', { body: { name: 'Owner batch', conversationIds: [child] } })).body.group.id;
  await fx.asLocalAgent(child, { settings: { group: 'none' } });
  const first = await fx.call('GET /api/conversations', { query: {} });
  const listed = first.body.groups[groupId];
  assert.ok(listed, 'the first page names the kept group');
  assert.ok(listed.keptEmptyAt);
  assert.equal(listed.memberCount, 0);
  assert.equal(listed.displayName, 'Owner batch');
  assert.equal(first.body.conversations.some((row) => row.groupId === groupId), false);
  // Not on a later page, not in the Archived view.
  const later = await fx.call('GET /api/conversations', { query: { beforeConversationId: first.body.conversations.at(-1).id, beforeUpdatedAt: first.body.conversations.at(-1).activityAt } });
  assert.equal(groupId in (later.body.groups || {}), false);
  const archived = await fx.call('GET /api/conversations', { query: { archived: 'only' } });
  assert.equal(groupId in (archived.body.groups || {}), false);
  // The event that emptied it told the open pages already.
  assert.ok(fx.events('conversation_group_changed').some((event) => event.groupId === groupId && event.group?.keptEmptyAt));
  // Renamed and dissolved by hand like any group; nothing removes it by itself.
  assert.equal((await fx.call('PATCH /api/conversation-groups/:id', { params: { id: groupId }, body: { name: 'Renamed batch' } })).status, 200);
  assert.equal((await fx.call('GET /api/conversations', { query: {} })).body.groups[groupId].displayName, 'Renamed batch');
  assert.equal((await fx.call('DELETE /api/conversation-groups/:id', { params: { id: groupId } })).status, 200);
  assert.equal(groupId in ((await fx.call('GET /api/conversations', { query: {} })).body.groups || {}), false);
  assert.equal(fx.conversationGroups.getGroup(groupId), null);
});

test('a kept group without a name keeps the default label', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  const groupId = (await fx.call('POST /api/conversation-groups', { body: { conversationIds: [child] } })).body.group.id;
  await fx.asLocalAgent(child, { settings: { group: 'none' } });
  assert.equal((await fx.call('GET /api/conversations', { query: {} })).body.groups[groupId].displayName, 'Group');
});

test('the group an agent\'s create_session forms counts as agent-made and goes once the agent path empties it', async () => {
  const fx = setup();
  const { lead, child } = await fx.agentMade();
  const groupId = fx.row(child).group_id;
  assert.ok(groupId);
  assert.equal(fx.conversationGroups.getGroup(groupId).agentMade, true);
  await fx.asLocalAgent(child, { settings: { group: 'none' } });
  // The creator (head) is the owner's session: changing it needs the Allow.
  const out = await fx.asLocalAgent(lead, { settings: { group: 'none' }, owner_approved: true }, { caller: child });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(fx.conversationGroups.getGroup(groupId), null, 'removed, not kept');
});

test('a group name that became ambiguous before the write is refused, not created', async () => {
  let twins = null;
  const fx = setup({
    sdkSessionId: 'sess-fixture',
    // Two groups of that name appear while the CLI relaunches.
    onLaunch: () => twins?.(),
  });
  const { child } = await fx.agentMade();
  const a = await fx.owned();
  const b = await fx.owned();
  twins = () => {
    twins = null;
    fx.conversationGroups.createGroup({ name: 'Twin batch', conversationIds: [a] });
    fx.conversationGroups.createGroup({ name: 'twin batch', conversationIds: [b] });
  };
  const result = await fx.asLocalAgent(child, { settings: { cwd: FOLDER_A, group: 'Twin batch' } });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, 'SESSION_GROUP_AMBIGUOUS');
  assert.equal(result.body.groups.length, 2);
  assert.deepEqual(result.body.changed, ['cwd']);
  assert.match(result.body.error, /names several session groups.*These settings were changed before: cwd\./);
  assert.equal(fx.conversationGroups.listGroups().filter((group) => /twin batch/i.test(group.name)).length, 2, 'no third group');
});

// ─── Plan-only ─────────────────────────────────────────────────────

test('a session starts plan-only through create_session\'s bootstrap: in plan, refused with another mode', async () => {
  const fx = setup();
  const lead = await fx.owned();
  const id = await fx.bootstrap({ title: 'Plan lane', relayMode: undefined, planOnly: true, origin: LOCAL_ORIGIN(lead) }, loopbackHeaders, true);
  assert.equal(fx.row(id).plan_only, 1);
  assert.equal(fx.row(id).preferred_relay_mode, 'plan', 'no mode named: plan');
  const named = await fx.bootstrap({ title: 'Plan lane 2', relayMode: 'plan', planOnly: true });
  assert.equal(fx.row(named).plan_only, 1);
  const refused = await fx.call('POST /api/conversation/bootstrap', { body: { title: 'Bad', relayMode: 'agent', planOnly: true } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'PLAN_ONLY_MODE');
  const typed = await fx.call('POST /api/conversation/bootstrap', { body: { title: 'Bad', planOnly: 'yes' } });
  assert.equal(typed.status, 400);
  // Plan mode alone never sets it.
  const plain = await fx.bootstrap({ title: 'Plain plan', relayMode: 'plan' });
  assert.equal(fx.row(plain).plan_only, null);
  // The list and the detail show it.
  const list = await fx.call('GET /api/conversations', { query: {} });
  assert.equal(list.body.conversations.find((entry) => entry.id === id).planOnly, true);
  assert.equal(list.body.conversations.find((entry) => entry.id === plain).planOnly, false);
  const detail = await fx.call('GET /api/conversation/:id', { params: { id }, query: {} });
  assert.equal(detail.body.planOnly, true);
});

test('update_session cannot switch a plan-only session out of plan; the dry run refuses first', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  fx.db.prepare(`UPDATE conversations SET plan_only = 1, preferred_relay_mode = 'plan' WHERE id = ?`).run(child);
  for (const mode of ['agent', 'ask', 'autopilot']) {
    const refused = await fx.asLocalAgent(child, { settings: { mode, title: 'Renamed' } });
    assert.equal(refused.status, 409, mode);
    assert.equal(refused.body.code, 'plan_only');
    assert.match(refused.body.error, /plan-only; agents can't change its mode/);
  }
  const dry = await fx.asLocalAgent(child, { settings: { mode: 'agent' }, dry_run: true });
  assert.equal(dry.status, 409);
  const paired = await fx.asPairedAgent(child, { settings: { mode: 'agent' }, owner_approved: true });
  assert.equal(paired.status, 409);
  assert.equal(fx.row(child).preferred_relay_mode, 'plan');
  assert.equal(fx.row(child).title, 'Agent chat', 'nothing in the call was applied');
  // plan itself is fine, and so is a call that names no mode.
  assert.equal((await fx.asLocalAgent(child, { settings: { mode: 'plan', title: 'Plan lane' } })).status, 200);
  assert.equal(fx.row(child).title, 'Plan lane');
  // planOnly:true with another mode in the same call: still plan-only after it.
  const both = await fx.asLocalAgent(child, { settings: { planOnly: true, mode: 'agent' } });
  assert.equal(both.status, 409);
});

test('planOnly:false and a mode in one call frees the session; agents may set it again with plan', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  fx.db.prepare(`UPDATE conversations SET plan_only = 1, preferred_relay_mode = 'plan' WHERE id = ?`).run(child);
  const freed = await fx.asLocalAgent(child, { settings: { planOnly: false, mode: 'agent' } });
  assert.equal(freed.status, 200, JSON.stringify(freed.body));
  assert.deepEqual(freed.body.changed, ['mode', 'planOnly']);
  assert.equal(freed.body.settings.planOnly, false);
  assert.equal(fx.row(child).plan_only, 0);
  assert.equal(fx.row(child).preferred_relay_mode, 'agent');
  assert.equal(fx.events('conversation_preferences_updated').at(-1).planOnly, false);
  // Set again: an agent-mode session needs mode plan in the same call.
  const alone = await fx.asLocalAgent(child, { settings: { planOnly: true } });
  assert.equal(alone.status, 400);
  assert.match(alone.body.error, /add mode: "plan" in the same call/);
  const dry = await fx.asLocalAgent(child, { settings: { planOnly: true }, dry_run: true });
  assert.equal(dry.status, 400);
  assert.equal(fx.row(child).plan_only, 0);
  const locked = await fx.asLocalAgent(child, { settings: { planOnly: true, mode: 'plan' } });
  assert.equal(locked.status, 200, JSON.stringify(locked.body));
  assert.equal(fx.row(child).plan_only, 1);
  assert.equal(fx.row(child).preferred_relay_mode, 'plan');
  assert.equal(fx.events('conversation_preferences_updated').at(-1).planOnly, true);
  // A session in plan already takes planOnly alone.
  await fx.asLocalAgent(child, { settings: { planOnly: false, mode: 'agent' } });
  await fx.asLocalAgent(child, { settings: { mode: 'plan' } });
  assert.equal((await fx.asLocalAgent(child, { settings: { planOnly: true } })).status, 200);
  assert.equal(fx.row(child).plan_only, 1);
  const typed = await fx.asLocalAgent(child, { settings: { planOnly: 'maybe' } });
  assert.equal(typed.status, 400);
});

test('the owner changes a plan-only session\'s mode and the flag; agents get neither through the preferences route', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  fx.db.prepare(`UPDATE conversations SET plan_only = 1, preferred_relay_mode = 'plan' WHERE id = ?`).run(child);
  // The owner's composer: the mode changes, the flag stays.
  const owner = await fx.call(PREFERENCES, { params: { id: child }, body: { clientId: 'client-a', preferredRelayMode: 'agent', preferredModel: 'gpt-5.4-mini' } });
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.equal(fx.row(child).preferred_relay_mode, 'agent');
  assert.equal(fx.row(child).plan_only, 1);
  assert.equal(owner.body.planOnly, true);
  // An agent through the same route: no mode other than plan, no flag at all.
  fx.db.prepare(`UPDATE conversations SET preferred_relay_mode = 'plan' WHERE id = ?`).run(child);
  for (const headers of [agentHeaders, loopbackHeaders]) {
    const loopback = headers === loopbackHeaders;
    const mode = await fx.call(PREFERENCES, { params: { id: child }, body: { preferredRelayMode: 'agent' }, headers, loopback });
    assert.equal(mode.status, 409);
    assert.equal(mode.body.code, 'plan_only');
    const flag = await fx.call(PREFERENCES, { params: { id: child }, body: { planOnly: false }, headers, loopback });
    assert.equal(flag.status, 403);
  }
  assert.equal(fx.row(child).preferred_relay_mode, 'plan');
  assert.equal(fx.row(child).plan_only, 1);
  // The owner's toggle, off and on; another write leaves it alone.
  const off = await fx.call(PREFERENCES, { params: { id: child }, body: { clientId: 'client-a', planOnly: false } });
  assert.equal(off.body.planOnly, false);
  assert.equal(fx.events('conversation_preferences_updated').at(-1).planOnly, false);
  const on = await fx.call(PREFERENCES, { params: { id: child }, body: { planOnly: true } });
  assert.equal(on.body.planOnly, true);
  await fx.call(PREFERENCES, { params: { id: child }, body: { thinkingEnabled: false } });
  assert.equal(fx.row(child).plan_only, 1);
  assert.equal((await fx.call(PREFERENCES, { params: { id: child }, body: { planOnly: 'yes' } })).status, 400);
});
test('planOnly:false counts only with a new mode: alone or with plan it is passed over, and the answer says so', async () => {
  const fx = setup();
  const { child } = await fx.agentMade();
  fx.db.prepare(`UPDATE conversations SET plan_only = 1, preferred_relay_mode = 'plan' WHERE id = ?`).run(child);
  for (const settings of [{ planOnly: false }, { planOnly: false, mode: 'plan' }]) {
    const passed = await fx.asLocalAgent(child, { settings });
    assert.equal(passed.status, 200, JSON.stringify(passed.body));
    assert.deepEqual(passed.body.changed, []);
    assert.ok(passed.body.notes.includes('planOnly unchanged: clear it in the same call as the new mode.'), JSON.stringify(settings));
    assert.equal(fx.row(child).plan_only, 1);
  }
  // A caller that sends every property, false for the empty ones: its title still changes, the lock stays.
  const filled = await fx.asLocalAgent(child, { settings: { title: 'Plan lane', planOnly: false, thinking_enabled: false } });
  assert.equal(filled.status, 200, JSON.stringify(filled.body));
  assert.ok(filled.body.changed.includes('title'));
  assert.ok(!filled.body.changed.includes('planOnly'));
  assert.equal(fx.row(child).plan_only, 1);
  assert.equal(fx.row(child).title, 'Plan lane');
  // The dry run says the same.
  const dry = await fx.asLocalAgent(child, { settings: { planOnly: false }, dry_run: true });
  assert.deepEqual(dry.body.changed, []);
  assert.ok(dry.body.notes.includes('planOnly unchanged: clear it in the same call as the new mode.'));
  // A session that is not plan-only: nothing to say.
  fx.db.prepare(`UPDATE conversations SET plan_only = NULL WHERE id = ?`).run(child);
  const free = await fx.asLocalAgent(child, { settings: { planOnly: false, title: 'Free' } });
  assert.equal(free.body.notes, undefined);
});