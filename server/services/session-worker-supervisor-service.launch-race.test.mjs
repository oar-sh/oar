// A worker that registers for its session while a launch for that session
// is still running (its heartbeat, socket hello or claim sets the pid, and a
// claim's ensureWorker reuses it) keeps its registry entry, however that
// launch ends. The registration writes below are the ones those routes make
// (messages-routes.mjs heartbeat and /api/pending, the runtime's
// noteSessionWorkerHello); the liveness check is the registry-pid step of
// the dead-worker sweep (isWorkerSessionProcessAlive in server-runtime.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionWorkerRegistry } from './session-worker-registry-service.mjs';
import { createSessionWorkerSupervisor } from './session-worker-supervisor-service.mjs';

const SID = '7e31c0d2-launch-race';
const CONV = 'conv-launch-race-7e31';
const LIVE_PID = process.pid;
const DEAD_PID = 999_999_001;

function boot({ spawnWorker }) {
  const registry = createSessionWorkerRegistry();
  const logs = [];
  const launchStates = [];
  const supervisor = createSessionWorkerSupervisor({
    registry,
    spawnWorker,
    onLaunchState: (event) => launchStates.push(event.type),
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
    isPidAlive: (pid) => pid === LIVE_PID,
    log: (line) => logs.push(line),
  });
  return { registry, supervisor, logs, launchStates };
}

// The heartbeat's registration: a 'new' or identity-less entry is promoted
// to ready with the pid, any other entry only takes the new pid.
function heartbeat(registry, pid) {
  const existing = registry.getWorker(SID);
  if (!existing || existing.status === 'new' || (!existing.workerId && !existing.pid)) {
    registry.upsertWorker({ ...(existing || {}), sdkSessionId: SID, status: 'ready', conversationId: CONV, pid });
  } else if (existing.pid !== pid) {
    registry.upsertWorker({ ...existing, sdkSessionId: SID, pid });
  }
}

// The sweep's first, cheapest proof of life: a registry pid that probes alive.
function sweepSeesAlive(registry) {
  const pid = Number(registry.getWorker(SID)?.pid || 0);
  return pid > 0 && pid === LIVE_PID;
}

test('a launch that throws after a worker registered leaves that worker\'s pid and status alone', async () => {
  let fx = null;
  fx = boot({
    spawnWorker: async () => {
      heartbeat(fx.registry, LIVE_PID);
      // The worker's claim asks for its worker and is given the live one.
      const claimed = await fx.supervisor.ensureWorker(SID);
      assert.equal(claimed.ok, true);
      assert.equal(claimed.reused, true);
      throw new Error('spawn ENOENT');
    },
  });

  const result = await fx.supervisor.ensureWorker(SID);
  const worker = fx.registry.getWorker(SID);
  assert.equal(worker.pid, LIVE_PID, 'the registered pid survives');
  assert.equal(worker.status, 'ready');
  assert.equal(worker.conversationId, CONV);
  assert.equal(sweepSeesAlive(fx.registry), true, 'the sweep finds the worker alive');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.worker.pid, LIVE_PID);
  const lifecycle = fx.supervisor.getLifecycleState(SID);
  assert.equal(lifecycle.retryCount, 0, 'the failed launch does not count toward the restart limit');
  assert.equal(lifecycle.nextRestartAt, null, 'and schedules no restart');
  assert.equal(fx.logs.filter((line) => /launch failed/.test(line)).length, 1, 'the failed launch is logged once');
});

test('a relaunch over a dead worker\'s entry: a new pid registered meanwhile survives the throw', async () => {
  let fx = null;
  fx = boot({
    spawnWorker: async () => {
      // The entry still names the dead process, so the heartbeat only swaps
      // the pid in and the status stays 'starting'.
      heartbeat(fx.registry, LIVE_PID);
      throw new Error('spawn ENOENT');
    },
  });
  fx.registry.upsertWorker({ sdkSessionId: SID, workerId: 'worker-7e31c0d2', pid: DEAD_PID, status: 'error', conversationId: CONV });

  const result = await fx.supervisor.ensureWorker(SID);
  const worker = fx.registry.getWorker(SID);
  assert.equal(worker.pid, LIVE_PID);
  assert.notEqual(worker.status, 'error');
  assert.equal(sweepSeesAlive(fx.registry), true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fx.supervisor.getLifecycleState(SID).retryCount, 0);
});

test('a launch that succeeds without a pid keeps the pid a worker registered meanwhile', async () => {
  let fx = null;
  fx = boot({
    spawnWorker: async () => {
      heartbeat(fx.registry, LIVE_PID);
      return { workerId: 'worker-7e31c0d2', pid: null };
    },
  });
  const result = await fx.supervisor.ensureWorker(SID);
  assert.equal(result.ok, true);
  assert.equal(fx.registry.getWorker(SID).pid, LIVE_PID);
  assert.equal(fx.registry.getWorker(SID).conversationId, CONV);
  assert.equal(fx.registry.getWorker(SID).status, 'ready');
  assert.equal(sweepSeesAlive(fx.registry), true);
});

test('a worker that registered and claimed a turn meanwhile stays processing after a launch that reports no pid', async () => {
  let fx = null;
  fx = boot({
    spawnWorker: async () => {
      heartbeat(fx.registry, LIVE_PID);
      fx.supervisor.noteSessionHeartbeat(SID);
      // Its claim took a row (the pending route marks the worker busy).
      fx.supervisor.markProcessing(SID, 1);
      return { workerId: 'worker-7e31c0d2', pid: null };
    },
  });
  const result = await fx.supervisor.ensureWorker(SID);
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  const worker = fx.registry.getWorker(SID);
  assert.equal(worker.status, 'processing', 'its held turn does not read as idle');
  assert.equal(worker.pid, LIVE_PID);
  assert.equal(worker.conversationId, CONV);
  assert.equal(result.worker.status, 'processing');
  assert.equal(sweepSeesAlive(fx.registry), true);
  // Observers hear what a reused live worker gives them, not a fresh boot.
  assert.deepEqual(fx.launchStates, ['launched']);
  const lifecycle = fx.supervisor.getLifecycleState(SID);
  assert.notEqual(lifecycle.launchMode, 'spawned');
  assert.equal(lifecycle.retryCount, 0);
  assert.equal(lifecycle.nextRestartAt, null);
});

test('a launch that knows its pid records that pid, as before', async () => {
  const fx = boot({ spawnWorker: async () => ({ workerId: 'worker-7e31c0d2', pid: LIVE_PID }) });
  const result = await fx.supervisor.ensureWorker(SID);
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(fx.registry.getWorker(SID).pid, LIVE_PID);
  assert.equal(fx.registry.getWorker(SID).status, 'ready');
});

test('a deferred launch over a dead worker\'s entry keeps a pid registered meanwhile', async () => {
  let fx = null;
  fx = boot({
    spawnWorker: async () => {
      heartbeat(fx.registry, LIVE_PID);
      return { deferred: 'cli-spawn-disabled' };
    },
  });
  fx.registry.upsertWorker({ sdkSessionId: SID, workerId: 'worker-7e31c0d2', pid: DEAD_PID, status: 'error', conversationId: CONV });
  const result = await fx.supervisor.ensureWorker(SID);
  assert.equal(result.ok, true);
  assert.equal(fx.registry.getWorker(SID).pid, LIVE_PID);
  assert.equal(sweepSeesAlive(fx.registry), true);
});

test('with no worker registering meanwhile, a failed launch is an error with a restart backoff, as before', async () => {
  const fx = boot({ spawnWorker: async () => { throw new Error('spawn ENOENT'); } });
  const result = await fx.supervisor.ensureWorker(SID);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'spawn-failed');
  const worker = fx.registry.getWorker(SID);
  assert.equal(worker.status, 'error');
  assert.equal(worker.pid, null);
  assert.equal(worker.lastError, 'spawn ENOENT');
  const lifecycle = fx.supervisor.getLifecycleState(SID);
  assert.equal(lifecycle.retryCount, 1);
  assert.notEqual(lifecycle.nextRestartAt, null);
  assert.equal(fx.logs.filter((line) => /launch failed/.test(line)).length, 0);
});

test('a dead worker\'s pid left in the entry is not taken for a worker registered meanwhile', async () => {
  const fx = boot({ spawnWorker: async () => { throw new Error('spawn ENOENT'); } });
  fx.registry.upsertWorker({ sdkSessionId: SID, workerId: 'worker-7e31c0d2', pid: DEAD_PID, status: 'error', conversationId: CONV });
  const result = await fx.supervisor.ensureWorker(SID);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'spawn-failed');
  assert.equal(fx.registry.getWorker(SID).status, 'error');
  assert.equal(fx.supervisor.getLifecycleState(SID).retryCount, 1);
});

// A status change alone is no registration: the send route's markIdle (or a
// stop's, or a requeue's) touches the entry without any worker reporting.
test('an entry with a worker id and no pid, marked idle during the launch, still reports the failed launch', async () => {
  let fx = null;
  fx = boot({
    spawnWorker: async () => {
      fx.supervisor.markIdle(SID, 1);
      throw new Error('spawn ENOENT');
    },
  });
  fx.registry.upsertWorker({ sdkSessionId: SID, workerId: 'worker-7e31c0d2', pid: null, status: 'error', conversationId: CONV });
  const result = await fx.supervisor.ensureWorker(SID);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, 'spawn-failed');
  assert.equal(fx.registry.getWorker(SID).status, 'error');
  const lifecycle = fx.supervisor.getLifecycleState(SID);
  assert.equal(lifecycle.retryCount, 1);
  assert.notEqual(lifecycle.nextRestartAt, null);
});

test('a relaunch over a hung worker, with a message queued meanwhile, still reports the failed launch', async () => {
  let fx = null;
  fx = boot({
    spawnWorker: async () => {
      // A send while the relaunch runs marks the session's worker idle.
      fx.supervisor.markIdle(SID, 1);
      throw new Error('spawn ENOENT');
    },
  });
  // The hung worker: alive, busy, and relaunched on purpose without reuse.
  fx.registry.upsertWorker({ sdkSessionId: SID, workerId: 'worker-7e31c0d2', pid: LIVE_PID, status: 'processing', conversationId: CONV });
  const result = await fx.supervisor.ensureWorker(SID, { allowProcessReuse: false });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, 'spawn-failed');
  assert.equal(fx.registry.getWorker(SID).status, 'error');
  const lifecycle = fx.supervisor.getLifecycleState(SID);
  assert.equal(lifecycle.retryCount, 1);
  assert.notEqual(lifecycle.nextRestartAt, null);
});
