import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerSessionsRoutes } from './sessions-routes.mjs';
import { claudeProjectDirSlug, createClaudeSessionRootResolver } from '../services/claude-session-root-service.mjs';

// DELETE /api/conversation/:id — a conversation that is still working cannot
// be deleted; an idle one has its worker stopped first, then its CLI session
// and its rows are removed. Deleting used to leave the worker running (and
// holding its workspace) until the relay restarted, and SDK-worker CLI sessions
// were never deleted at all.

const DEAD_PID = 2_147_483_000;

function createMockApp() {
  const routes = new Map();
  return {
    routes,
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
    patch(route, ...handlers) { routes.set(`PATCH ${route}`, handlers); },
    delete(route, ...handlers) { routes.set(`DELETE ${route}`, handlers); },
  };
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, response, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return response;
}

/**
 * A database whose statements answer from `state` and record every write, in
 * order, into the shared `events` log.
 */
function createRecordingDb(state, events) {
  const normalize = (sql) => String(sql).replace(/\s+/g, ' ').trim();
  return {
    prepare(sql) {
      const text = normalize(sql);
      return {
        get(...args) {
          if (/COUNT\(\*\) AS count FROM queue WHERE conversation_id = \? AND status = 'processing'/.test(text)) {
            return { count: state.processingCount || 0 };
          }
          if (/FROM conversations WHERE sdk_session_id = \? AND id != \? AND status != 'deleted'/.test(text)) {
            return state.sharedWithConversationId ? { id: state.sharedWithConversationId } : null;
          }
          return null;
        },
        all() { return []; },
        run(...args) {
          if (/^(DELETE|UPDATE conversations SET status = 'deleted')/.test(text)) events.push(`sql:${text.split(' WHERE')[0]}`);
          if (/^DELETE FROM conversations/.test(text)) state.conversationDeleted = true;
          return { changes: 1 };
        },
      };
    },
    transaction(fn) { return (...args) => fn(...args); },
  };
}

function setup(state = {}) {
  const events = [];
  const alivePids = new Set(state.alivePids || []);
  const conversation = {
    id: 'conv-1',
    sdk_session_id: 'sdk-1',
    status: 'active',
    runtime_workspace_root_path: state.workspaceRootPath || '',
    ...(state.conversation || {}),
  };
  const deps = {
    auth: (_req, _res, next) => next(),
    io: { emit(name, payload) { events.push(`emit:${name}:${payload?.conversationId || ''}`); } },
    db: createRecordingDb(state, events),
    stmts: {
      getConvAnyStatus: { get: (id) => (id === conversation.id && !state.conversationDeleted ? conversation : null) },
      markDeletedSdkSession: { run: (id) => events.push(`tombstone:${id}`) },
      getMessages: { all: () => [] },
      getRuntimeSessionByConversation: { get: () => state.runtimeSession || null },
      upsertSdkDeleteRequest: { run: (sid, convId) => events.push(`queued-sdk-delete:${sid}:${convId}`) },
      deleteSdkDeleteRequest: { run: (sid) => events.push(`cleared-sdk-delete:${sid}`) },
    },
    runtimeState: {},
    config: {},
    parseAttachments: () => [],
    hydrateAttachment: (value) => value,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => [],
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({}),
    updateModelCatalog: () => ({}),
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => ({}),
    setEnabledModelVariants: () => ({}),
    SUPPORTED_REASONING_EFFORTS: ['none'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => null,
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => null,
    updateConversationConfiguredWorkspaceRoot: () => ({ changed: false }),
    learnConversationWorkspaceRoot: () => ({ learned: false }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => 'session-id',
    touchCli() {},
    markCliOffline() {},
    fetchUsageSummary() {},
    readSessionTranscriptMessages: () => [],
    ensureRuntimeSessionBinding: () => ({ id: 'runtime-1' }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'isolated',
    SUPPORTED_RELAY_MODES: ['agent'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['isolated'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'isolated',
    DEFAULT_MODEL: 'gpt-5',
    remotePath: '',
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    backgroundTaskStore: {
      get: (id) => state.backgroundTasks?.[id] || [],
      replace: (id, tasks) => events.push(`tasks-cleared:${id}:${tasks.length}`),
    },
    sessionWorkerSupervisor: {
      markKilled: (sid) => events.push(`mark-killed:${sid}`),
      cancelPendingStart: state.cancelPendingStart || (async () => false),
      clearRestartSchedule() {},
      resetHealth() {},
    },
    sessionWorkerRegistry: {
      getWorker: (sid) => (sid === (conversation.sdk_session_id || conversation.id) ? state.worker || null : null),
      removeWorker: (sid) => events.push(`registry-removed:${sid}`),
    },
    sessionWorkerProcessInspector: {
      findProcessesForSession: () => (state.processPids || []).map((processId) => ({ processId })),
    },
    sessionWorkerStopOverrides: {
      platform: 'linux',
      killImpl: (pid) => {
        events.push(`kill:${pid}`);
        if (!state.survivors) alivePids.delete(pid);
      },
      isPidAliveImpl: (pid) => alivePids.has(pid),
      killTmuxSessionImpl: () => {},
      sleepImpl: async () => {},
      gracefulTimeoutMs: 5,
      escalationTimeoutMs: 5,
      pollIntervalMs: 1,
    },
    sdkSessionImportService: state.sdkSessionImportService || null,
    resolveClaudeSessionRoot: state.resolveClaudeSessionRoot || null,
    resolveSessionStateRoot: () => state.sessionStateRoot || path.join(os.tmpdir(), 'oar-delete-lifecycle-state'),
    markSharedViewerPresence: () => ({ ok: true, watcherCount: 0 }),
    getSharedWatcherCount: () => 0,
    statusEventService: { recordSharedAccess: () => ({ event: null }) },
    windowsAutostartService: null,
    isSha256: () => false,
    uploadPathForSha: () => '',
  };
  const app = createMockApp();
  registerSessionsRoutes(app, deps);
  const del = () => callRoute(app.routes.get('DELETE /api/conversation/:id'), { params: { id: 'conv-1' }, headers: {}, body: {} });
  return { del, events };
}

const deletedRows = (events) => events.filter((event) => event.startsWith('sql:DELETE'));

async function withTmpDir(run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-delete-lifecycle-'));
  try {
    return await run(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a running turn blocks the delete, and nothing is touched', async () => {
  const { del, events } = setup({
    worker: { status: 'processing', pid: process.pid },
    processingCount: 1,
    processPids: [4242],
    alivePids: [4242],
  });
  const response = await del();
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, 'conversation-active');
  assert.equal(response.body.reason, 'turn-running');
  assert.match(response.body.message, /Stop it, then delete it/);
  assert.deepEqual(events, []);
});

test('live background tasks block the delete', async () => {
  const { del, events } = setup({
    worker: { status: 'ready', pid: process.pid },
    backgroundTasks: { 'conv-1': [{ taskId: 'task-1', taskType: 'local_agent' }] },
  });
  const response = await del();
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.reason, 'background-tasks');
  assert.match(response.body.message, /task panel/);
  assert.deepEqual(events, []);
});

test('a dead worker\'s leftover rows and tasks do not make a conversation undeletable', async () => {
  for (const worker of [{ status: 'ready', pid: DEAD_PID }, { status: 'stopped', pid: null }, { status: 'error', pid: null }]) {
    const { del, events } = setup({
      worker,
      processingCount: 1,
      backgroundTasks: { 'conv-1': [{ taskId: 'stale-task' }] },
    });
    const response = await del();
    assert.equal(response.statusCode, 200, `worker ${JSON.stringify(worker)}`);
    assert.ok(events.includes('emit:conversation_deleted:conv-1'));
  }
});

test('a processing row of a session the registry never saw still counts as a running turn', async () => {
  const { del } = setup({ worker: null, processingCount: 1 });
  const response = await del();
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.reason, 'turn-running');
});

test('an idle worker is stopped before the conversation is deleted', async () => {
  const { del, events } = setup({
    worker: { status: 'ready', pid: 4242 },
    processPids: [4242, 4243],
    alivePids: [4242, 4243],
    runtimeSession: { provider_type: 'cursor' },
  });
  const response = await del();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, workerStopped: true, cliSessionDeleted: null });
  assert.ok(events.includes('kill:4242') && events.includes('kill:4243'), events.join(' | '));
  assert.ok(events.includes('registry-removed:sdk-1'));
  // Stopped first, then tombstoned, then the rows go.
  const order = (prefix) => events.findIndex((event) => event.startsWith(prefix));
  assert.ok(order('kill:') < order('sql:UPDATE conversations SET status = \'deleted\''));
  assert.ok(order('sql:UPDATE conversations SET status = \'deleted\'') < order('sql:DELETE FROM conversations'));
  // The kill block is re-armed after the stop, and the task set cleared.
  assert.ok(events.lastIndexOf('mark-killed:sdk-1') > order('kill:'));
  assert.ok(events.includes('tasks-cleared:conv-1:0'));
  assert.ok(events.includes('tombstone:sdk-1') && events.includes('emit:conversation_deleted:conv-1'));
});

test('a second delete of the same conversation waits for the first and finds it gone', async () => {
  let releaseStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  const { del, events } = setup({
    worker: { status: 'ready', pid: 4242 },
    processPids: [4242],
    alivePids: [4242],
    cancelPendingStart: () => stopGate,
  });
  const first = del();
  const second = del();
  await new Promise((resolve) => setImmediate(resolve));
  // The second delete is queued behind the first's stop, not running beside it.
  assert.equal(events.filter((event) => event === 'mark-killed:sdk-1').length, 1);
  releaseStop(false);
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.deepEqual(firstResponse.body, { ok: true, workerStopped: true, cliSessionDeleted: null });
  assert.deepEqual(secondResponse.body, { ok: true, alreadyDeleted: true });
  assert.equal(events.filter((event) => event === 'sql:DELETE FROM conversations').length, 1);
});

test('a worker that survives the stop leaves the conversation intact', async () => {
  const { del, events } = setup({
    worker: { status: 'ready', pid: 4242 },
    processPids: [4242],
    alivePids: [4242],
    survivors: true,
  });
  const response = await del();
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, 'worker-stop-failed');
  assert.deepEqual(response.body.remainingPids, [4242]);
  assert.deepEqual(deletedRows(events), []);
  assert.ok(!events.some((event) => event.startsWith('tombstone:') || event.includes("status = 'deleted'")));
  assert.ok(!events.includes('emit:conversation_deleted:conv-1'));
});

test('a Claude conversation loses its transcript and session folder, and only those', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-delete-claude-'));
  try {
    const workspace = path.join(tmp, 'workspace');
    const projectDir = path.join(tmp, 'config', 'projects', claudeProjectDirSlug(workspace));
    const transcript = path.join(projectDir, 'native-abc.jsonl');
    const sessionDir = path.join(projectDir, 'native-abc');
    const otherTranscript = path.join(projectDir, 'native-other.jsonl');
    const memoryDir = path.join(projectDir, 'memory');
    fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(transcript, '{}\n');
    fs.writeFileSync(path.join(sessionDir, 'subagents', 'a.jsonl'), '{}\n');
    fs.writeFileSync(otherTranscript, '{}\n');
    const resolver = createClaudeSessionRootResolver({
      env: { CLAUDE_CONFIG_DIR: path.join(tmp, 'config') },
      homedir: () => path.join(tmp, 'home'),
    });

    const { del } = setup({
      workspaceRootPath: workspace,
      conversation: { sdk_session_id: 'conv-1' },
      runtimeSession: { provider_type: 'claude', claude_native_session_id: 'native-abc' },
      resolveClaudeSessionRoot: resolver.resolveClaudeSessionRoot,
    });
    const response = await del();
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.cliSessionDeleted, true);
    assert.equal(fs.existsSync(transcript), false);
    assert.equal(fs.existsSync(sessionDir), false);
    assert.equal(fs.existsSync(otherTranscript), true, 'another session of the workspace stays');
    assert.equal(fs.existsSync(memoryDir), true, 'the project memory stays');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a CLI session that cannot be removed does not leave the conversation half deleted', async () => {
  const { del, events } = setup({
    conversation: { sdk_session_id: 'conv-1' },
    runtimeSession: { provider_type: 'claude', claude_native_session_id: 'native-abc' },
    resolveClaudeSessionRoot: () => { throw new Error('EBUSY: resource busy or locked'); },
  });
  const response = await del();
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.cliSessionDeleted, false);
  assert.ok(events.includes('sql:DELETE FROM conversations'));
  assert.ok(events.includes('emit:conversation_deleted:conv-1'));
});

test('a Copilot conversation\'s session is deleted through the runtime', async () => {
  await withTmpDir(async (stateRoot) => {
    fs.mkdirSync(path.join(stateRoot, 'sdk-1'));
    const deleted = [];
    const { del, events } = setup({
      sessionStateRoot: stateRoot,
      runtimeSession: { provider_type: 'github' },
      sdkSessionImportService: {
        deleteSession: async (sid) => {
          deleted.push(sid);
          fs.rmSync(path.join(stateRoot, sid), { recursive: true });
        },
      },
    });
    const response = await del();
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.cliSessionDeleted, true);
    assert.deepEqual(deleted, ['sdk-1']);
    assert.ok(events.includes('cleared-sdk-delete:sdk-1'));
    assert.ok(!events.some((event) => event.startsWith('queued-sdk-delete:')));
  });
});

test('a Copilot conversation deleted before its first turn has no CLI session to delete', async () => {
  await withTmpDir(async (stateRoot) => {
    const deleted = [];
    const { del, events } = setup({
      sessionStateRoot: stateRoot,
      runtimeSession: { provider_type: 'github' },
      sdkSessionImportService: { deleteSession: async (sid) => { deleted.push(sid); } },
    });
    const response = await del();
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.cliSessionDeleted, null);
    // Asking would only get "Session file not found" back.
    assert.deepEqual(deleted, []);
    assert.ok(!events.some((event) => event.startsWith('queued-sdk-delete:')));
    assert.ok(events.includes('sql:DELETE FROM conversations'));
  });
});

test('a session folder the runtime keeps no session file for is removed directly', async () => {
  await withTmpDir(async (stateRoot) => {
    const sessionDir = path.join(stateRoot, 'sdk-1');
    const otherSessionDir = path.join(stateRoot, 'sdk-2');
    fs.mkdirSync(path.join(sessionDir, 'files'), { recursive: true });
    fs.mkdirSync(otherSessionDir);
    const { del, events } = setup({
      sessionStateRoot: stateRoot,
      runtimeSession: { provider_type: 'github' },
      sdkSessionImportService: {
        deleteSession: async (sid) => { throw new Error(`Failed to delete session ${sid}: Session file not found for ${sid}`); },
      },
    });
    const response = await del();
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.cliSessionDeleted, true);
    assert.equal(fs.existsSync(sessionDir), false);
    assert.equal(fs.existsSync(otherSessionDir), true, 'another session stays');
    assert.ok(!events.some((event) => event.startsWith('queued-sdk-delete:')));
  });
});

test('a Copilot session the runtime cannot delete goes on the SDK delete queue, and the conversation is still deleted', async () => {
  // A runtime that is itself "not found" is no answer about the session.
  const failures = [
    'runtime unavailable',
    'Copilot SDK runtime not found (a compatible version). Install Copilot CLI or configure sdkPath and cliPath.',
  ];
  for (const failure of failures) {
    await withTmpDir(async (stateRoot) => {
      const sessionDir = path.join(stateRoot, 'sdk-1');
      fs.mkdirSync(sessionDir);
      const { del, events } = setup({
        sessionStateRoot: stateRoot,
        runtimeSession: { provider_type: 'github' },
        sdkSessionImportService: { deleteSession: async () => { throw new Error(failure); } },
      });
      const response = await del();
      assert.equal(response.statusCode, 200, failure);
      assert.equal(response.body.cliSessionDeleted, false, failure);
      assert.ok(events.includes('queued-sdk-delete:sdk-1:conv-1'), failure);
      assert.ok(!events.includes('cleared-sdk-delete:sdk-1'), failure);
      assert.ok(events.includes('sql:DELETE FROM conversations'), failure);
      assert.equal(fs.existsSync(sessionDir), true, `left for the queue: ${failure}`);
    });
  }
});

test('a session id that is not a plain folder name is never joined into a path', async () => {
  await withTmpDir(async (tmp) => {
    const stateRoot = path.join(tmp, 'session-state');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(stateRoot);
    fs.mkdirSync(outside);
    const { del, events } = setup({
      sessionStateRoot: stateRoot,
      conversation: { sdk_session_id: '../outside' },
      runtimeSession: { provider_type: 'github' },
      sdkSessionImportService: {
        deleteSession: async (sid) => { throw new Error(`Session file not found for ${sid}`); },
      },
    });
    const response = await del();
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.cliSessionDeleted, null);
    assert.equal(fs.existsSync(outside), true);
    assert.ok(!events.some((event) => event.startsWith('queued-sdk-delete:')));
  });
});

test('a session another live conversation shares keeps its worker and CLI session', async () => {
  const deleted = [];
  const { del, events } = setup({
    sharedWithConversationId: 'conv-2',
    worker: { status: 'ready', pid: 4242 },
    processPids: [4242],
    alivePids: [4242],
    runtimeSession: { provider_type: 'github' },
    sdkSessionImportService: { deleteSession: async (sid) => { deleted.push(sid); } },
  });
  const response = await del();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, workerStopped: false, cliSessionDeleted: null });
  assert.ok(!events.some((event) => event.startsWith('kill:') || event.startsWith('registry-removed:')));
  assert.deepEqual(deleted, []);
  assert.ok(events.includes('sql:DELETE FROM conversations'));
});
