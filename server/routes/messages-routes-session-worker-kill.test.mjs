import test from 'node:test';
import assert from 'node:assert/strict';

import { registerMessagesRoutes } from './messages-routes.mjs';

const SESSION_ID = '2353a9eb-8245-4b9d-8bf7-b5763796ca94';

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

// registerMessagesRoutes prepares statements for every route it owns, so the db
// stub answers by SQL shape: only the two owned-row queries the kill route reads
// return anything.
function makeDb({ processingRows = [], nonProcessingRows = [] } = {}) {
  return {
    prepare: (sql) => {
      const text = normalizeSql(sql);
      const ownedProcessing = text.includes("owner_sdk_session_id = ?")
        && text.includes("status = 'processing'")
        && text.includes('SELECT * FROM queue')
        && !text.includes('LIMIT 1')
        && !text.includes('owner_last_claimed_at');
      const ownedNonProcessing = text.includes("status IN ('pending', 'parked')")
        && text.includes('SELECT id, conversation_id, status');
      return {
        all: () => {
          if (ownedProcessing) return processingRows;
          if (ownedNonProcessing) return nonProcessingRows;
          return [];
        },
        get: () => null,
        run: () => ({ changes: 0 }),
      };
    },
    transaction: (fn) => fn,
  };
}

function makeStmts(spies) {
  const generic = { run: () => ({ changes: 0 }), get: () => null, all: () => [] };
  return new Proxy({
    dropStaleContinuation: { run: (id) => { spies.droppedContinuations.push(id); return { changes: 1 }; } },
  }, {
    get: (target, key) => (key in target ? target[key] : generic),
  });
}

function killHandler(deps) {
  let handler = null;
  const app = {
    post(registeredPath, ...handlers) {
      if (registeredPath === '/api/session-worker/:sdkSessionId/kill') handler = handlers[handlers.length - 1];
    },
    get() {}, patch() {}, delete() {}, put() {}, use() {},
  };
  registerMessagesRoutes(app, deps);
  assert.ok(handler, 'kill route should be registered');
  return handler;
}

async function invokeKill(handler, sdkSessionId = SESSION_ID) {
  const captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return res; },
    json(payload) { captured.body = payload; return res; },
  };
  await handler({ params: { sdkSessionId }, body: {}, headers: {}, query: {} }, res);
  return captured;
}

function makeDeps({
  processingRows = [],
  emitted = [],
  calls = [],
  spies,
  cancelPendingStart = null,
  processInspector = null,
  stopOverrides = null,
} = {}) {
  return {
    auth: (_req, _res, next) => next(),
    db: makeDb({ processingRows }),
    stmts: makeStmts(spies),
    io: { emit: (event, payload) => emitted.push({ event, payload }) },
    touchCli: () => {},
    uuidv4: () => 'generated-id',
    normalizeRelayMode: (value) => String(value || '').trim().toLowerCase() || null,
    DEFAULT_RELAY_MODE: 'agent',
    MAX_UPLOAD_BYTES: 1024 * 1024,
    featureFlags: { SESSION_WORKER_ROUTING_ENABLED: true },
    sessionWorkerRegistry: {
      getWorker: () => ({ sdkSessionId: SESSION_ID, conversationId: 'conv-1', pid: null, status: 'ready' }),
      removeWorker: () => { calls.push('removeWorker'); },
    },
    sessionWorkerSupervisor: {
      markKilled: () => { calls.push('markKilled'); return null; },
      cancelPendingStart: cancelPendingStart
        || (async () => { calls.push('cancelPendingStart'); return { cancelled: true }; }),
      clearRestartSchedule: () => { calls.push('clearRestartSchedule'); return null; },
      resetHealth: () => { calls.push('resetHealth'); return null; },
    },
    // No live processes: keeps the handler off every platform-specific kill path.
    sessionWorkerProcessInspector: processInspector || {
      findWindowsProcessTreeForSessionAsync: () => [],
      findWindowsProcessesForSessionAsync: () => [],
      findProcessesForSessionAsync: () => [],
      stopWindowsPidsAsync: () => [],
    },
    // Seams for stopSessionWorkerProcesses so the test never signals real
    // processes and behaves identically on Windows and POSIX.
    sessionWorkerStopOverrides: stopOverrides || {
      platform: 'linux',
      killImpl: () => {},
      isPidAliveImpl: () => false,
      killTmuxSessionImpl: () => {},
      sleepImpl: async () => {},
    },
  };
}

test('a killed session re-arms its kill block after the processes are gone', async () => {
  // The marker set at the top of the route has already expired by the time the
  // synchronous Windows kill returns, so the next delivery check would spawn a
  // replacement. The teardown has to re-arm it.
  const calls = [];
  const spies = { droppedContinuations: [] };
  const handler = killHandler(makeDeps({ calls, spies }));

  const { status, body } = await invokeKill(handler);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(calls.filter((entry) => entry === 'markKilled').length, 2);
  assert.equal(calls.at(-1), 'markKilled', 'the kill block is re-armed last, after the registry teardown');
  assert.ok(calls.indexOf('removeWorker') < calls.lastIndexOf('markKilled'));
});

test('killing a session drops its background continuation rows instead of answering the chat', async () => {
  const calls = [];
  const emitted = [];
  const spies = { droppedContinuations: [] };
  const handler = killHandler(makeDeps({
    calls,
    emitted,
    spies,
    processingRows: [{
      id: 'continuation-1',
      conversation_id: 'conv-1',
      kind: 'continuation',
      status: 'processing',
      relay_mode: 'autopilot',
      model: 'claude-opus-5',
    }],
  }));

  const { status, body } = await invokeKill(handler);

  assert.equal(status, 200);
  assert.deepEqual(spies.droppedContinuations, ['continuation-1']);
  assert.deepEqual(body.failedMessageIds, [], 'a continuation has no user prompt to answer');
  const statusEvents = emitted.filter((entry) => entry.event === 'message_status');
  assert.equal(statusEvents.length, 1);
  assert.equal(statusEvents[0].payload.messageId, 'continuation-1');
  assert.equal(statusEvents[0].payload.status, 'failed');
});

test('a kill during a spawn waits for the cancellation to settle before enumerating', async () => {
  // Cancelling without waiting let the in-flight spawn's child appear right
  // after the process scan, survive the kill, and still get an ok:true.
  const calls = [];
  const spies = { droppedContinuations: [] };
  const handler = killHandler(makeDeps({
    calls,
    spies,
    cancelPendingStart: async (_sid, options) => {
      calls.push('cancelPendingStart:begin');
      assert.equal(options?.wait, true, 'the route must ask for settlement');
      await new Promise((resolve) => setImmediate(resolve));
      calls.push('cancelPendingStart:settled');
      return { cancelled: true, hadPending: true, waited: true };
    },
    processInspector: {
      findWindowsProcessTreeForSessionAsync: () => [],
      findWindowsProcessesForSessionAsync: () => [],
      findProcessesForSessionAsync: () => { calls.push('enumerate'); return []; },
      stopWindowsPidsAsync: () => [],
    },
  }));

  const { status, body } = await invokeKill(handler);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const settledAt = calls.indexOf('cancelPendingStart:settled');
  const enumeratedAt = calls.indexOf('enumerate');
  assert.ok(settledAt >= 0 && enumeratedAt >= 0);
  assert.ok(settledAt < enumeratedAt, 'processes are enumerated only after the spawn cancellation settles');
});

test('a surviving process yields a degraded response and keeps queue ownership', async () => {
  const calls = [];
  const emitted = [];
  const spies = { droppedContinuations: [] };
  const handler = killHandler(makeDeps({
    calls,
    emitted,
    spies,
    processingRows: [{
      id: 'owned-turn-1',
      conversation_id: 'conv-1',
      kind: 'user',
      status: 'processing',
      relay_mode: 'agent',
      model: 'gpt-5.4-mini',
    }],
    processInspector: {
      findWindowsProcessTreeForSessionAsync: () => [],
      findWindowsProcessesForSessionAsync: () => [],
      findProcessesForSessionAsync: () => [{ processId: 4242 }],
      stopWindowsPidsAsync: () => [],
    },
    stopOverrides: {
      platform: 'linux',
      killImpl: () => {},
      // The process shrugs off SIGTERM and SIGKILL: the stop service times out
      // with a verified survivor.
      isPidAliveImpl: () => true,
      killTmuxSessionImpl: () => {},
      sleepImpl: async () => {},
      gracefulTimeoutMs: 0,
      escalationTimeoutMs: 0,
    },
  }));

  const { status, body } = await invokeKill(handler);

  assert.equal(status, 409);
  assert.equal(body.ok, false);
  assert.equal(body.processStatus, 'kill-incomplete');
  assert.deepEqual(body.remainingPids, [4242]);
  assert.equal(body.timedOut, true);
  // Ownership is retained: no registry teardown, no drained rows, no kill event.
  assert.equal(calls.includes('removeWorker'), false);
  assert.equal(calls.filter((entry) => entry === 'markKilled').length, 1, 'the kill block is not re-armed for a failed kill');
  assert.deepEqual(spies.droppedContinuations, []);
  assert.equal(emitted.some((entry) => entry.event === 'session_worker_killed'), false);
  assert.equal(emitted.some((entry) => entry.event === 'message_status'), false);
});

test('a kill with an unreadable process list answers 409 with the reason and kills nothing', async () => {
  const stopCalls = [];
  const deps = makeDeps({
    processingRows: [],
    processInspector: {
      findWindowsProcessTreeForSessionAsync: async () => { throw new Error('windows-process-snapshot-unreadable: Bad control character in string literal in JSON at position 144233'); },
      findProcessesForSessionAsync: async () => { throw new Error('windows-process-snapshot-unreadable: Bad control character in string literal in JSON at position 144233'); },
      stopWindowsPidsAsync: async (pids) => stopCalls.push([...pids]),
    },
  });
  const handler = killHandler(deps);
  const result = await invokeKill(handler);
  assert.equal(result.status, 409);
  assert.match(String(result.body?.error || ''), /process-list-unreadable: windows-process-snapshot-unreadable/);
  assert.deepEqual(stopCalls, []);
});
