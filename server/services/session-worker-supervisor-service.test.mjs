import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionWorkerRegistry } from './session-worker-registry-service.mjs';
import { createSessionWorkerSupervisor } from './session-worker-supervisor-service.mjs';

test('supervisor waits for startup heartbeat when launched pid is unknown', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 1_000;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    heartbeatTimeoutMs: 1_000,
    spawnWorker: async () => ({ workerId: 'worker-abc123', pid: null }),
  });

  const ensureResult = await supervisor.ensureWorker('abc-123');
  assert.equal(ensureResult.ok, true);
  assert.equal(ensureResult.lifecycle?.awaitingHeartbeat, true);
  assert.equal(ensureResult.lifecycle?.degradedReason, null);

  nowMs += 500;
  const beforeTimeout = supervisor.getLifecycleState('abc-123');
  assert.equal(beforeTimeout?.degradedReason, null);

  nowMs += 600;
  const afterTimeout = supervisor.getLifecycleState('abc-123');
  assert.equal(afterTimeout?.degradedReason, 'startup-heartbeat-timeout');
  assert.equal(afterTimeout?.uiState, 'yellow');
});

test('ensureWorker can force a fresh process launch', async () => {
  const spawnOptions = [];
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({
    sdkSessionId: 'fresh-session',
    pid: process.pid,
    status: 'ready',
  });
  const supervisor = createSessionWorkerSupervisor({
    registry,
    isPidAlive: () => true,
    spawnWorker: async (_sessionId, options) => {
      spawnOptions.push(options);
      return { workerId: 'worker-fresh', pid: 12345 };
    },
  });

  const result = await supervisor.ensureWorker('fresh-session', {
    allowProcessReuse: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.deepEqual(spawnOptions, [{ allowProcessReuse: false }]);
});

test('supervisor marks stale pid when known launched pid is dead and work is pending', async () => {
  const registry = createSessionWorkerRegistry();
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => 2_000,
    heartbeatTimeoutMs: 5_000,
    isPidAlive: () => false,
    spawnWorker: async () => ({ workerId: 'worker-xyz789', pid: 98765 }),
  });

  const ensureResult = await supervisor.ensureWorker('xyz-789');
  assert.equal(ensureResult.ok, true);
  const status = supervisor.snapshot({
    pendingQuestionSessionIds: ['xyz-789'],
  });
  const lifecycle = status.lifecycle.find((entry) => entry.sdkSessionId === 'xyz-789');
  assert.equal(lifecycle?.degradedReason, 'stale-pid');
  assert.equal(lifecycle?.uiState, 'yellow');
  assert.equal(lifecycle?.stalePidDetected, true);
});

test('supervisor does not reuse worker after startup heartbeat timeout', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 10_000;
  let spawnCount = 0;
  const spawnOptions = [];
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    heartbeatTimeoutMs: 1_000,
    spawnWorker: async (_sessionId, options = {}) => {
      spawnCount += 1;
      spawnOptions.push(options);
      return { workerId: `worker-timeout-${spawnCount}`, pid: null };
    },
  });

  const first = await supervisor.ensureWorker('retry-timeout');
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(spawnCount, 1);

  nowMs += 1_500;
  const lifecycleAfterTimeout = supervisor.getLifecycleState('retry-timeout');
  assert.equal(lifecycleAfterTimeout?.degradedReason, 'startup-heartbeat-timeout');

  const second = await supervisor.ensureWorker('retry-timeout');
  assert.equal(second.ok, true);
  assert.equal(second.reused, false);
  assert.equal(spawnCount, 2);
  assert.equal(spawnOptions[0]?.allowProcessReuse, true);
  assert.equal(spawnOptions[1]?.allowProcessReuse, false);
});

test('markKilled blocks ensureWorker within grace period', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 5_000;
  let spawnCount = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    killBlockGraceMs: 10_000,
    spawnWorker: async () => {
      spawnCount += 1;
      return { workerId: `worker-killed-${spawnCount}`, pid: null };
    },
  });

  // Spawn the worker first
  const first = await supervisor.ensureWorker('killed-session');
  assert.equal(first.ok, true);
  assert.equal(spawnCount, 1);

  // Simulate kill: remove from registry, clear schedule, then mark killed
  registry.removeWorker('killed-session');
  supervisor.clearRestartSchedule('killed-session');
  supervisor.markKilled('killed-session');

  // ensureWorker should now be blocked
  const blocked = await supervisor.ensureWorker('killed-session');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'session-killed');
  assert.equal(spawnCount, 1, 'no new spawn should occur while kill-blocked');

  // Lifecycle should report killedAt
  const lifecycle = supervisor.getLifecycleState('killed-session');
  assert.ok(lifecycle?.killedAt, 'killedAt should be set');
});

test('markKilled block expires after grace period', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 5_000;
  let spawnCount = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    killBlockGraceMs: 10_000,
    spawnWorker: async () => {
      spawnCount += 1;
      return { workerId: `worker-expired-${spawnCount}`, pid: null };
    },
  });

  // Spawn first worker
  await supervisor.ensureWorker('grace-session');
  assert.equal(spawnCount, 1);

  // Kill the worker
  registry.removeWorker('grace-session');
  supervisor.clearRestartSchedule('grace-session');
  supervisor.markKilled('grace-session');

  // Still blocked inside grace window
  const stillBlocked = await supervisor.ensureWorker('grace-session');
  assert.equal(stillBlocked.ok, false);
  assert.equal(stillBlocked.error, 'session-killed');
  assert.equal(spawnCount, 1);

  // Advance past grace period
  nowMs += 11_000;

  // Should now allow respawn (grace expired)
  const respawned = await supervisor.ensureWorker('grace-session');
  assert.equal(respawned.ok, true);
  assert.equal(spawnCount, 2);
});

test('clearRestartSchedule preserves killedAtMs by default', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 3_000;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    killBlockGraceMs: 30_000,
    spawnWorker: async () => ({ workerId: 'worker-preserve', pid: null }),
  });

  await supervisor.ensureWorker('preserve-session');
  registry.removeWorker('preserve-session');
  supervisor.markKilled('preserve-session');

  // clearRestartSchedule without resetKilledMarker should keep the kill block
  supervisor.clearRestartSchedule('preserve-session');
  const stillBlocked = await supervisor.ensureWorker('preserve-session');
  assert.equal(stillBlocked.ok, false);
  assert.equal(stillBlocked.error, 'session-killed');

  // clearRestartSchedule with resetKilledMarker:true should clear it
  supervisor.clearRestartSchedule('preserve-session', { resetKilledMarker: true });
  let spawnCount = 0;
  // Need a fresh supervisor with spawn to verify it can spawn
  const registry2 = createSessionWorkerRegistry();
  const supervisor2 = createSessionWorkerSupervisor({
    registry: registry2,
    now: () => nowMs,
    killBlockGraceMs: 30_000,
    spawnWorker: async () => {
      spawnCount += 1;
      return { workerId: 'worker-reset', pid: null };
    },
  });
  supervisor2.markKilled('reset-session');
  supervisor2.clearRestartSchedule('reset-session', { resetKilledMarker: true });
  const unblocked = await supervisor2.ensureWorker('reset-session');
  assert.equal(unblocked.ok, true);
  assert.equal(spawnCount, 1);
});

test('markKilled prevents respawn even when registry entry is re-inserted with no identity', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 7_000;
  let spawnCount = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    killBlockGraceMs: 30_000,
    spawnWorker: async () => {
      spawnCount += 1;
      return { workerId: `worker-reinsert-${spawnCount}`, pid: null };
    },
  });

  // Spawn first worker
  await supervisor.ensureWorker('reinsert-session');
  assert.equal(spawnCount, 1);

  // Simulate kill sequence
  registry.removeWorker('reinsert-session');
  supervisor.clearRestartSchedule('reinsert-session');
  supervisor.markKilled('reinsert-session');

  // Simulate the heartbeat route re-inserting the worker WITHOUT workerId
  // (the exact bug that triggered the respawn: no workerId means shouldReuseLiveWorker=false)
  registry.upsertWorker({
    sdkSessionId: 'reinsert-session',
    status: 'ready',
    workerId: null,
    pid: null,
  });

  // ensureWorker must still be blocked despite the re-insertion
  const blocked = await supervisor.ensureWorker('reinsert-session');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'session-killed');
  assert.equal(spawnCount, 1, 'kill block must win over identity-less re-insertion');
});

test('cancelPendingStart prevents in-flight spawn from becoming ready', async () => {
  const registry = createSessionWorkerRegistry();
  let resolveSpawn = null;
  const spawnGate = new Promise((resolve) => {
    resolveSpawn = resolve;
  });
  let spawnCount = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    killBlockGraceMs: 30_000,
    spawnWorker: async () => {
      spawnCount += 1;
      await spawnGate;
      return { workerId: `worker-cancelled-${spawnCount}`, pid: null };
    },
  });

  const pendingEnsure = supervisor.ensureWorker('cancel-in-flight');
  supervisor.markKilled('cancel-in-flight');
  const cancelResult = await supervisor.cancelPendingStart('cancel-in-flight');
  assert.equal(cancelResult.cancelled, true);
  assert.equal(cancelResult.hadPending, true);
  resolveSpawn();

  const blocked = await pendingEnsure;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'session-killed');
  assert.ok(spawnCount <= 1, 'spawn should not continue past cancellation');
  assert.notEqual(supervisor.getWorkerState('cancel-in-flight')?.status, 'ready');
});

test('ensureWorker re-checks kill block before spawn begins', async () => {
  const registry = createSessionWorkerRegistry();
  let spawnCalled = false;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    killBlockGraceMs: 30_000,
    spawnWorker: async () => {
      spawnCalled = true;
      return { workerId: 'worker-should-not-spawn', pid: null };
    },
  });

  const pendingEnsure = supervisor.ensureWorker('kill-before-start');
  supervisor.markKilled('kill-before-start');
  await supervisor.cancelPendingStart('kill-before-start');
  const blocked = await pendingEnsure;

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'session-killed');
  assert.equal(spawnCalled, false);
});
