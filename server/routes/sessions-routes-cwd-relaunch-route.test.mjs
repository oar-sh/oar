import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerSessionsRoutes } from './sessions-routes.mjs';

// Route-level coverage for the two CWD endpoints. These were previously only
// exercised through the pure evaluateWorkspaceRootRelaunch helper, which meant
// the concurrency and reporting rules were untested.

const RELAUNCH_ROUTE = 'POST /api/conversation/:id/relaunch-with-workspace-root';
const SAVE_ROUTE = 'POST /api/conversation/:id/workspace-root';
const LAUNCH_ROUTE = 'POST /api/session-worker/:sdkSessionId/launch';
const SID = 'sess-1';
const CONV = 'conv-1';

let tempRoot = '';
let ROOT_A = '';
let ROOT_B = '';

test.before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-route-'));
  ROOT_A = path.join(tempRoot, 'alpha');
  ROOT_B = path.join(tempRoot, 'beta');
  fs.mkdirSync(ROOT_A);
  fs.mkdirSync(ROOT_B);
});

test.after(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers);
  return { routes, get: record('GET'), post: record('POST'), patch: record('PATCH'), delete: record('DELETE') };
}

function createMockDb(activeQueueCount = 0) {
  const noopStmt = { run() {}, get() { return null; }, all() { return []; } };
  // The route counts active queue rows through a prepared statement, not a dep.
  const queueCountStmt = { ...noopStmt, get: () => ({ count: activeQueueCount }) };
  return {
    prepare: (sql) => (
      String(sql).includes('FROM queue') && String(sql).includes('COUNT(*) AS count')
        ? queueCountStmt
        : noopStmt
    ),
    transaction: (fn) => (...args) => fn(...args),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(overrides = {}) {
  const calls = [];
  const emitted = [];
  const {
    workerStatus = 'ready',
    activeQueueCount = 0,
    liveProcess = { processId: 4242 },
    workerPid = 0,
    ensureWorkerImpl = null,
    stopWindowsPidsImpl = null,
    processAlive = () => false,
    // The stop path branches on the platform. Pin it to win32 by default so the
    // suite is deterministic on any host OS; the POSIX branch has its own test.
    stopPlatform = 'win32',
    stopOverrides = {},
    runtimeWorkspaceRootPath = '',
    pendingSessionCwd = '',
    workspaceRootAllowList = [],
    sdkSessionId = SID,
  } = overrides;

  const app = createMockApp();
  let configuredRootPath = '';
  let runtimeRootPath = runtimeWorkspaceRootPath || '';
  let pendingCwd = pendingSessionCwd || '';

  // Mirrors buildConversationWorkspaceRootState: a running session reports its
  // runtime root as the current CWD, falling back to the pending/configured root.
  const buildState = () => ({
    sdkSessionId,
    configuredWorkspaceRootPath: configuredRootPath || null,
    runtimeWorkspaceRootPath: runtimeRootPath || null,
    currentWorkspaceRootPath: runtimeRootPath || pendingCwd || configuredRootPath || null,
  });

  const deps = {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emitted.push([event, payload]); } },
    db: createMockDb(activeQueueCount),
    stmts: {},
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
    queueCounts: () => ({ pending: 0, processing: 0 }),
    getModelCatalogState: () => ({}),
    updateModelCatalog: () => ({}),
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => ({}),
    setEnabledModelVariants: () => ({}),
    SUPPORTED_REASONING_EFFORTS: ['none'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => ({ recentWorkspaceRoots: [] }),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),

    resolveConversationWorkspaceState: () => buildState(),
    updateConversationConfiguredWorkspaceRoot: ({ rootPath }) => {
      calls.push(['persist', rootPath]);
      configuredRootPath = rootPath;
      return { ok: true, state: buildState() };
    },
    learnConversationWorkspaceRoot: ({ rootPath, seedConfigured }) => {
      calls.push(['learnRuntimeRoot', rootPath, seedConfigured]);
      runtimeRootPath = rootPath;
      return { ok: true, learned: true, state: buildState() };
    },
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => {
      calls.push(['consumePendingSessionCwd']);
      const previous = pendingCwd;
      pendingCwd = '';
      return previous || null;
    },
    getPendingSessionCwd: () => pendingCwd || null,
    workspaceRootAllowList,

    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => true,
    touchCli: () => {},
    markCliOffline: () => {},
    fetchUsageSummary: () => {},
    readSessionTranscriptMessages: () => [],
    ensureRuntimeSessionBinding: () => ({ ok: true }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent'],
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

    countActiveConversationQueueRows: { get: () => ({ count: activeQueueCount }) },
    sessionWorkerSupervisor: {
      getWorkerState: () => (workerStatus ? { status: workerStatus, pid: workerPid } : null),
      markKilled: () => calls.push(['markKilled']),
      cancelPendingStart: async () => calls.push(['cancelPendingStart']),
      clearRestartSchedule: (_sid, options) => calls.push(['clearRestartSchedule', options?.resetKilledMarker === true]),
      resetHealth: () => {},
      ensureWorker: ensureWorkerImpl || (async (_sid, options) => {
        calls.push(['ensureWorker', options?.allowProcessReuse]);
        return { ok: true, worker: { pid: 9999 }, lifecycle: {} };
      }),
    },
    sessionWorkerRegistry: { getWorker: () => null, removeWorker: () => calls.push(['removeWorker']) },
    sessionWorkerProcessInspector: {
      findProcessForSession: () => liveProcess,
      findProcessesForSession: () => (liveProcess ? [liveProcess] : []),
      findWindowsProcessTreeForSession: () => (liveProcess ? [liveProcess] : []),
      stopWindowsPids: stopWindowsPidsImpl || ((pids) => calls.push(['stopWindowsPids', [...pids]])),
    },
    // Never let the stop service touch real processes: the mock PIDs may exist
    // on the host. Every seam records into `calls` instead.
    sessionWorkerStopOverrides: {
      platform: stopPlatform,
      isPidAliveImpl: () => false,
      killImpl: (pid, signal) => calls.push(['killPid', pid, signal]),
      killTmuxSessionImpl: (sid) => calls.push(['killTmuxSession', sid]),
      ...stopOverrides,
    },
  };

  registerSessionsRoutes(app, deps);
  return {
    app,
    calls,
    emitted,
    getConfiguredRootPath: () => configuredRootPath,
    getRuntimeRootPath: () => runtimeRootPath,
    getPendingCwd: () => pendingCwd,
    processAlive,
  };
}

async function callRoute(app, routeKey, req = {}) {
  const handlers = app.routes.get(routeKey);
  assert.ok(handlers, `route ${routeKey} must be registered`);
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
  };
  const request = { params: {}, body: {}, headers: {}, ...req };
  for (const handler of handlers) {
    let next = false;
    await handler(request, res, () => { next = true; });
    if (!next) break;
  }
  return res;
}

const relaunch = (app, body, headers = {}) => callRoute(app, RELAUNCH_ROUTE, {
  params: { id: CONV },
  body,
  headers,
});

// --- duplicate / concurrent requests -----------------------------------------

test('two concurrent identical relaunches run the work once and coalesce', async () => {
  const gate = deferred();
  let ensureCalls = 0;
  const { app, calls } = setup({
    ensureWorkerImpl: async (_sid, options) => {
      ensureCalls += 1;
      calls.push(['ensureWorker', options?.allowProcessReuse]);
      await gate.promise;
      return { ok: true, worker: { pid: 9999 }, lifecycle: {} };
    },
  });

  const first = relaunch(app, { rootPath: ROOT_A });
  const second = relaunch(app, { rootPath: ROOT_A });
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(ensureCalls, 1, 'the duplicate must not drive a second spawn');
  assert.equal(calls.filter(([name]) => name === 'stopWindowsPids').length, 1, 'the stop must run once');
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(b.body.coalesced, true);
});

test('a different rootPath while one is in flight is rejected, not interleaved', async () => {
  const gate = deferred();
  const { app } = setup({
    ensureWorkerImpl: async () => {
      await gate.promise;
      return { ok: true, worker: { pid: 9999 }, lifecycle: {} };
    },
  });

  const first = relaunch(app, { rootPath: ROOT_A });
  const second = await relaunch(app, { rootPath: ROOT_B });
  gate.resolve();
  await first;

  assert.equal(second.statusCode, 409);
  assert.equal(second.body.code, 'relaunch_in_progress');
});

test('an identical repeat inside the coalesce window replays the cached body', async () => {
  let ensureCalls = 0;
  const { app } = setup({
    ensureWorkerImpl: async () => {
      ensureCalls += 1;
      return { ok: true, worker: { pid: 9999 }, lifecycle: {} };
    },
  });
  const first = await relaunch(app, { rootPath: ROOT_A });
  const second = await relaunch(app, { rootPath: ROOT_A });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.cached, true);
  assert.equal(second.body.coalesced, true);
  assert.equal(ensureCalls, 1);
});

test('an explicit Idempotency-Key coalesces even across different paths', async () => {
  let ensureCalls = 0;
  const { app } = setup({
    ensureWorkerImpl: async () => {
      ensureCalls += 1;
      return { ok: true, worker: { pid: 9999 }, lifecycle: {} };
    },
  });
  await relaunch(app, { rootPath: ROOT_A }, { 'idempotency-key': 'gesture-1' });
  const second = await relaunch(app, { rootPath: ROOT_B }, { 'idempotency-key': 'gesture-1' });

  assert.equal(second.body.cached, true);
  assert.equal(ensureCalls, 1);
});

// --- stop determinism ---------------------------------------------------------

test('a stop that times out refuses to launch but still saves the CWD', async () => {
  let ensureCalls = 0;
  const { app, getConfiguredRootPath } = setup({
    // The process never dies, so the stop escalates and then times out.
    stopWindowsPidsImpl: () => {},
    stopOverrides: { isPidAliveImpl: () => true, gracefulTimeoutMs: 0, escalationTimeoutMs: 0 },
    ensureWorkerImpl: async () => {
      ensureCalls += 1;
      return { ok: true, worker: { pid: 1 }, lifecycle: {} };
    },
  });
  const res = await relaunch(app, { rootPath: ROOT_A });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'worker-stop-timeout');
  assert.deepEqual(res.body.remainingPids, [4242]);
  assert.equal(res.body.workspaceRootApplied, false);
  assert.equal(ensureCalls, 0, 'must not launch on top of a surviving process');
  assert.equal(getConfiguredRootPath(), ROOT_A, 'the CWD is still saved for the next launch');
});

// --- honest reporting ---------------------------------------------------------

test('a reused process reports workspaceRootApplied:false, never a bare ok', async () => {
  const { app } = setup({
    ensureWorkerImpl: async () => ({ ok: true, reused: true, worker: { pid: 4242 }, lifecycle: {} }),
  });
  const res = await relaunch(app, { rootPath: ROOT_A });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.workspaceRootApplied, false);
  assert.equal(res.body.relaunched, false);
  assert.equal(res.body.reusedExistingProcess, true);
  assert.equal(res.body.warning, 'cwd-not-applied');
  assert.match(res.body.message, /kept its current directory/);
});

test('a genuine relaunch reports workspaceRootApplied:true', async () => {
  const { app } = setup({ runtimeWorkspaceRootPath: '' });
  const res = await relaunch(app, { rootPath: ROOT_A });
  assert.equal(res.body.workspaceRootApplied, true);
  assert.equal(res.body.relaunched, true);
  assert.equal(res.body.reusedExistingProcess, false);
  assert.equal(res.body.warning, undefined);
});

// --- post-relaunch CWD reporting ---------------------------------------------

test('a relaunch out of a live CWD reports the new CWD, not the killed CLI\'s', async () => {
  // The session was running in ROOT_B; the pre-stop state therefore still names
  // ROOT_B. Reporting it back is what left the header and the file explorer
  // showing the old CWD until the next session-sync.
  const { app, getRuntimeRootPath } = setup({ runtimeWorkspaceRootPath: ROOT_B });
  const res = await relaunch(app, { rootPath: ROOT_A });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.workspaceRootApplied, true);
  assert.equal(res.body.currentWorkspaceRootPath, ROOT_A);
  assert.equal(res.body.runtimeWorkspaceRootPath, ROOT_A);
  assert.equal(res.body.configuredWorkspaceRootPath, ROOT_A);
  assert.equal(getRuntimeRootPath(), ROOT_A, 'the runtime root is persisted, not left stale');
});

test('the relaunch broadcast carries the new CWD so every client updates', async () => {
  const { app, emitted } = setup({ runtimeWorkspaceRootPath: ROOT_B });
  await relaunch(app, { rootPath: ROOT_A });

  const [, payload] = emitted.find(([event]) => event === 'conversation_workspace_root_updated') || [];
  assert.ok(payload, 'the relaunch must broadcast a workspace root update');
  assert.equal(payload.conversationId, CONV);
  assert.equal(payload.currentWorkspaceRootPath, ROOT_A);
  assert.equal(payload.runtimeWorkspaceRootPath, ROOT_A);
  assert.equal(payload.workspaceRootApplied, true);
});

test('the pending CWD of the killed CLI is dropped on a successful relaunch', async () => {
  const { app, getPendingCwd, calls } = setup({ pendingSessionCwd: ROOT_B });
  const res = await relaunch(app, { rootPath: ROOT_A });

  assert.equal(res.body.currentWorkspaceRootPath, ROOT_A);
  assert.equal(getPendingCwd(), '', 'a stale pending CWD would resurface as the current CWD');
  assert.ok(calls.some(([name]) => name === 'consumePendingSessionCwd'));
});

test('a reused process keeps reporting the directory it is actually in', async () => {
  const { app, emitted, getRuntimeRootPath } = setup({
    runtimeWorkspaceRootPath: ROOT_B,
    ensureWorkerImpl: async () => ({ ok: true, reused: true, worker: { pid: 4242 }, lifecycle: {} }),
  });
  const res = await relaunch(app, { rootPath: ROOT_A });

  assert.equal(res.body.workspaceRootApplied, false);
  assert.equal(res.body.activeWorkspaceRootPath, ROOT_B);
  assert.equal(res.body.currentWorkspaceRootPath, ROOT_B);
  assert.equal(getRuntimeRootPath(), ROOT_B, 'a reused process must not be relabelled with the new CWD');
  const [, payload] = emitted.find(([event]) => event === 'conversation_workspace_root_updated') || [];
  assert.equal(payload.currentWorkspaceRootPath, ROOT_B);
  assert.equal(payload.workspaceRootApplied, false);
});

test('the route disables process reuse and owns the kill-marker reset', async () => {
  const { app, calls } = setup();
  await relaunch(app, { rootPath: ROOT_A });

  const ensure = calls.find(([name]) => name === 'ensureWorker');
  assert.deepEqual(ensure, ['ensureWorker', false], 'reuse must be off so the new CWD applies');

  const resets = calls.filter(([name, didReset]) => name === 'clearRestartSchedule' && didReset === true);
  assert.equal(resets.length, 1, 'the kill block is cleared exactly once');

  const resetIndex = calls.findIndex(([name, didReset]) => name === 'clearRestartSchedule' && didReset === true);
  const stopIndex = calls.findIndex(([name]) => name === 'stopWindowsPids');
  const ensureIndex = calls.findIndex(([name]) => name === 'ensureWorker');
  assert.ok(stopIndex >= 0 && stopIndex < resetIndex, 'reset happens after the stop verified the process died');
  assert.ok(resetIndex < ensureIndex, 'reset happens before the launch');
});

test('on POSIX the stop signals the PIDs and tmux session instead of the Windows inspector', async () => {
  const { app, calls } = setup({ stopPlatform: 'linux' });
  const res = await relaunch(app, { rootPath: ROOT_A });

  assert.equal(res.statusCode, 200);
  assert.equal(calls.filter(([name]) => name === 'stopWindowsPids').length, 0, 'the Windows path must stay cold');
  assert.deepEqual(calls.find(([name]) => name === 'killPid'), ['killPid', 4242, 'SIGTERM']);
  assert.deepEqual(calls.find(([name]) => name === 'killTmuxSession'), ['killTmuxSession', SID]);

  const killIndex = calls.findIndex(([name]) => name === 'killPid');
  const resetIndex = calls.findIndex(([name, didReset]) => name === 'clearRestartSchedule' && didReset === true);
  const ensureIndex = calls.findIndex(([name]) => name === 'ensureWorker');
  assert.ok(killIndex >= 0 && killIndex < resetIndex, 'reset happens after the stop verified the process died');
  assert.ok(resetIndex < ensureIndex, 'reset happens before the launch');
});

// --- eligibility --------------------------------------------------------------

test('active work blocks a relaunch', async () => {
  const queued = await relaunch(setup({ activeQueueCount: 1 }).app, { rootPath: ROOT_A });
  assert.equal(queued.statusCode, 409);
  const processing = await relaunch(setup({ workerStatus: 'processing' }).app, { rootPath: ROOT_A });
  assert.equal(processing.statusCode, 409);
  const unbound = await relaunch(setup({ sdkSessionId: '' }).app, { rootPath: ROOT_A });
  assert.equal(unbound.statusCode, 409);
});

test('a live process forces a stop even when the worker status is error', async () => {
  const { app, calls } = setup({ workerStatus: 'error' });
  await relaunch(app, { rootPath: ROOT_A });
  assert.ok(calls.some(([name]) => name === 'stopWindowsPids'), 'a live process must be stopped first');
});

// --- payload aliases ----------------------------------------------------------

test('both endpoints accept every documented rootPath alias', async () => {
  for (const key of ['rootPath', 'workspaceRootPath', 'workspace_root_path', 'cwd']) {
    const relaunchSetup = setup();
    const relaunched = await relaunch(relaunchSetup.app, { [key]: ROOT_A });
    assert.equal(relaunched.statusCode, 200, `relaunch must accept ${key}`);
    assert.equal(relaunchSetup.getConfiguredRootPath(), ROOT_A);

    const saveSetup = setup();
    const saved = await callRoute(saveSetup.app, SAVE_ROUTE, { params: { id: CONV }, body: { [key]: ROOT_B } });
    assert.equal(saved.statusCode, 200, `save must accept ${key}`);
    assert.equal(saveSetup.getConfiguredRootPath(), ROOT_B);
  }
});

// --- validation ---------------------------------------------------------------

test('relative paths are rejected with 400 and a code', async () => {
  const res = await relaunch(setup().app, { rootPath: './relative' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'relative-root-path');
});

test('an allow list rejects outside paths with 403 and permits inside ones', async () => {
  const blocked = await relaunch(setup({ workspaceRootAllowList: [ROOT_B] }).app, { rootPath: ROOT_A });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.body.code, 'root-path-not-allowed');

  const allowed = await relaunch(setup({ workspaceRootAllowList: [ROOT_A] }).app, { rootPath: ROOT_A });
  assert.equal(allowed.statusCode, 200);

  const noList = await relaunch(setup().app, { rootPath: ROOT_A });
  assert.equal(noList.statusCode, 200, 'an empty allow list must not restrict anything');
});

// --- rate limit ---------------------------------------------------------------

test('the CWD endpoints are rate limited with Retry-After', async () => {
  const { app } = setup();
  const seen = [];
  for (let index = 0; index < 8; index += 1) {
    // Distinct paths so the coalescer does not absorb them; alternate to avoid
    // tripping relaunch_in_progress, which only applies while one is in flight.
    seen.push(await callRoute(app, SAVE_ROUTE, { params: { id: CONV }, body: { rootPath: index % 2 ? ROOT_A : ROOT_B } }));
  }
  const limited = seen.filter((res) => res.statusCode === 429);
  assert.ok(limited.length >= 1, 'the limiter must eventually reject');
  assert.equal(limited[0].body.code, 'rate-limited');
  assert.ok(limited[0].headers['Retry-After']);
});

// --- shared lock with the plain launch endpoint --------------------------------

test('the plain launch endpoint shares the relaunch lock', async () => {
  const gate = deferred();
  const { app } = setup({
    ensureWorkerImpl: async () => {
      await gate.promise;
      return { ok: true, worker: { pid: 9999 }, lifecycle: {} };
    },
  });

  const inFlight = relaunch(app, { rootPath: ROOT_A });
  const launch = await callRoute(app, LAUNCH_ROUTE, { params: { sdkSessionId: SID } });
  gate.resolve();
  await inFlight;

  assert.equal(launch.statusCode, 409);
  assert.equal(launch.body.code, 'relaunch_in_progress');
});
