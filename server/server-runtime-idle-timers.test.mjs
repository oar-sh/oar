'use strict';

// server-runtime.mjs boots a live server on import, so the wiring of the
// timers an idle relay no longer runs is pinned by source inspection. The
// pieces are covered by services/idle-timers-cli-presence.test.mjs and
// services/idle-timers-armable-interval.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8');

function sliceBetween(start, end) {
  const from = runtimeSource.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = runtimeSource.indexOf(end, from);
  assert.notEqual(to, -1, `missing ${end}`);
  return runtimeSource.slice(from, to);
}

test('the CLI status has no polling interval: presence touches and a deadline decide it', () => {
  assert.doesNotMatch(runtimeSource, /checkCliStatus/);
  assert.doesNotMatch(runtimeSource, /cliLastSeen/);
  assert.doesNotMatch(sliceBetween('const runtimeTimers = {', '\n};'), /cliStatus/);
  const presence = sliceBetween('const cliPresence = createCliPresence({', '\n});');
  assert.match(presence, /if \(cliOnline\) markCliOffline\('heartbeat-timeout'\);/);
  assert.match(sliceBetween('function touchCli() {', '\n}\n'), /cliPresence\.touch\(\);/);
  assert.match(sliceBetween('function markCliOffline(', '\n}\n'), /cliPresence\.clear\(\);/);
  assert.match(runtimeSource, /onSocketCountChange: \(count\) => cliPresence\.noteWorkerSocketCount\(count\),/);
});

test('the share-viewer prune is armed by a viewer and disarms once none is left', () => {
  const timer = sliceBetween('const sharedViewerPruneTimer = createArmableInterval({', '\n});');
  assert.match(timer, /intervalMs: 5_000/);
  assert.match(timer, /pruneSharedViewerPresence\(\);\n {4}return sharedViewersByConversation\.size > 0;/);
  assert.match(sliceBetween('function markSharedViewerPresence(', '\n}\n'), /viewers\.set\(key, \{ lastSeenAt: now \}\);\n {2}sharedViewerPruneTimer\.arm\(\);/);
  assert.doesNotMatch(runtimeSource, /setInterval\(pruneSharedViewerPresence/);
});

test('the worker prime runs only while a pending row waits for its worker', () => {
  const timer = sliceBetween('const pendingWorkerPrimeTimer = createArmableInterval({', '\n});');
  assert.match(timer, /intervalMs: 5_000/);
  assert.match(timer, /primePendingSessionWorkers\('maintenance'\)/);
  assert.match(timer, /detachedWorkerWatch\.sweep\(\)/);
  assert.match(timer, /return hasPendingWorkerOwnerRows\(\);/);
  assert.match(sliceBetween('function hasPendingWorkerOwnerRows() {', '\n}\n'), /listPendingWorkerOwnerSessionIds\?\.all\?\.\(1\)/);
  // Armed by a prime that finds rows, by every wake, by the poll while rows
  // are pending, and at boot.
  assert.match(sliceBetween('const pendingWorkerPrimer = createPendingWorkerPrimer({', '\n});'), /onRowsWaiting: \(\) => pendingWorkerPrimeTimer\.arm\(\),/);
  assert.match(sliceBetween('queueWaker = createQueueWaker({', '\n});'), /armPrime: \(\) => pendingWorkerPrimeTimer\.arm\(\),/);
  assert.match(runtimeSource, /onQueueSnapshot: \(snapshot\) => \{\n {4}if \(snapshot\.pendingCount > 0\) queueWaker\?\.primeFromBackstop\('backstop'\);/);
  assert.match(runtimeSource, /void primePendingSessionWorkers\('startup'\);[\s\S]*?\npendingWorkerPrimeTimer\.arm\(\);\n/);
  assert.doesNotMatch(runtimeSource, /runtimeTimers\.pendingWorkerPrime\b/);
});

test('shutdown stops both armable timers', () => {
  const clear = sliceBetween('function clearRuntimeTimers() {', '\n}\n');
  assert.match(clear, /pendingWorkerPrimeTimer\.stop\(\);/);
  assert.match(clear, /sharedViewerPruneTimer\.stop\(\);/);
  assert.match(clear, /cliPresence\.clear\(\);/);
});

test('stale recovery keeps its tick but skips the work while nothing is processing', () => {
  const body = sliceBetween('function recoverStaleMessages() {', '\n}\n');
  const guardAt = body.indexOf('staleRecoveryClockGuard.tick()');
  const skipAt = body.indexOf('if (!stmts.hasProcessingRow.get() && !restartResumeService.pending().length) return;');
  assert.ok(guardAt > 0 && skipAt > guardAt, 'the guard ticks before the skip, so its gaps stay regular');
  assert.ok(skipAt < body.indexOf('recoverProcessingOlderThan('));
  assert.match(runtimeSource, /runtimeTimers\.staleRecovery = setInterval\(recoverStaleMessages, STALE_RECOVERY_INTERVAL_MS\);/);
});

test('the queue wake hook is installed before any route or startup write', () => {
  const at = runtimeSource.indexOf('const queueWakeHook = installQueueWakeHook(db, {');
  assert.ok(at > runtimeSource.indexOf('applySchema(db);'));
  assert.ok(at > runtimeSource.indexOf('const stmts = {'));
  for (const later of ['app.use(', 'restartResumeService.captureBoot();', 'sessionWorkerWebSocketService.start();', "primePendingSessionWorkers('startup')"]) {
    const laterAt = runtimeSource.indexOf(later);
    assert.ok(laterAt > at, `${later} comes after the hook`);
  }
  // A write wake hands out and arms; the prime is the maintenance pass's.
  assert.match(sliceBetween('const queueWakeHook = installQueueWakeHook(db, {', '\n});'), /onWake: \(reason\) => \{ queueWaker\?\.wake\(reason, \{ prime: false \}\); \}/);
  // Without the hook the poll is what it was.
  assert.match(runtimeSource, /pollIntervalMs: queueWakeHook\.installed \? 10_000 : 500,/);
});

test('every wake goes through wakeSessionWorkerQueue; no prime/emit pair is left', () => {
  assert.doesNotMatch(runtimeSource, /emitQueueChanged/);
  const primeCalls = runtimeSource.match(/primePendingSessionWorkers\(/g) || [];
  // The definition, the maintenance pass, the waker's prime and the startup prime.
  assert.equal(primeCalls.length, 4);
  for (const reason of ['restart-resume', 'relay-event', 'relay-schedule', 'worker-ws-send-failed']) {
    assert.match(runtimeSource, new RegExp(`wakeSessionWorkerQueue\\('${reason}'\\);`), reason);
  }
  assert.match(runtimeSource, /wakeSessionWorkerQueue\(`worker-died:\$\{reason\}`\);/);
  assert.match(runtimeSource, /onQueueChanged: \(reason\) => \{ wakeSessionWorkerQueue\(reason\); \},/);
});

test('a retry come due wakes the queue with a prime', () => {
  const ws = sliceBetween('const sessionWorkerWebSocketService = createSessionWorkerWebSocketService({', '\n});');
  assert.match(ws, /onDue: \(reason\) => \{ wakeSessionWorkerQueue\(reason\); \},/);
  assert.match(ws, /stmts\.nextPendingAttemptAt\?\.get\?\.\(new Date\(\)\.toISOString\(\)\)/);
  assert.match(ws, /if \(runtimeShutdownStarted\) return null;/, 'no due timer once the shutdown began');
  assert.match(sliceBetween('function wakeSessionWorkerQueue(', '\n}\n'), /return queueWaker\?\.wake\(reason\) === true;/);
  assert.match(sliceBetween('queueWaker = createQueueWaker({', '\n});'), /isReady: \(\) => queueWakeStarted && !runtimeShutdownStarted,/);
});

test('every gate that lifts without a queue write wakes the queue', () => {
  assert.match(sliceBetween('set relayPaused(value) {', '\n  },'), /if \(wasPaused && !relayPaused\) wakeSessionWorkerQueue\('relay-resumed'\);/);
  assert.match(sliceBetween('function cancelRelayShutdown(', '\n}\n'), /wakeSessionWorkerQueue\('restart-cancelled'\);/);
  assert.match(sliceBetween('const sshTunnelManager = createSshTunnelManager({', '\n});'), /onBlockingLifted: \(\) => \{ wakeSessionWorkerQueue\('ssh-tunnel-connected'\); \},/);
  assert.match(sliceBetween('const cloudflaredTunnelManager = createCloudflaredTunnelManager({', '\n});'), /onBlockingLifted: \(\) => \{ wakeSessionWorkerQueue\('cloudflared-tunnel-connected'\); \},/);
  assert.match(sliceBetween('const sessionWorkerSupervisor = createSessionWorkerSupervisor({', '\n});'), /onKillBlockLifted: \(\) => \{ wakeSessionWorkerQueue\('kill-block-lifted'\); \},/);
  assert.match(sliceBetween('const workerReplacementFence = (() => {', '\n})();'), /if \(released\) wakeSessionWorkerQueue\('replacement-fence-lifted'\);/);
});
