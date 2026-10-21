'use strict';

// server-runtime.mjs boots a live server on import, so the wiring of the
// queued-shutdown gate is pinned by source inspection, like the other runtime
// suites. The gate itself is covered by routes/messages-routes-shutdown-gate.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8');

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test('a queued shutdown fires once nothing is processing, whatever is pending or parked', () => {
  // The state machine (services/relay-restart-queue.mjs, unit-tested there)
  // asks the gate; the runtime only wires it.
  const queueSource = fs.readFileSync(path.join(__dirname, 'services', 'relay-restart-queue.mjs'), 'utf8');
  const evaluate = sliceBetween(queueSource, 'function evaluate() {', '\n  function ensurePolling');
  assert.match(evaluate, /if \(queuedShutdownCanProceed\(queue\)\) \{\s*fire\(\);/);
  assert.doesNotMatch(evaluate, /pendingCount[^\n]*processingCount[^\n]*parkedCount[^\n]*<= 0/, 'pending and parked rows no longer hold the restart');
  assert.match(runtimeSource, /const relayRestartQueue = createRelayRestartQueue\(\{\s*getCounts: \(\) => queueCounts\(\),/);
  const request = sliceBetween(runtimeSource, 'function requestRelayShutdown(options = {}) {', '\n}\n');
  assert.match(request, /const result = relayRestartQueue\.request\(options\);[\s\S]*return result;/);
  assert.doesNotMatch(runtimeSource, /countPendingRowsOfStoppedSessions/);
});

test('relay_restarted is wired: the loop guard before the request, the end on the way out, the start at boot', () => {
  const request = sliceBetween(runtimeSource, 'function requestRelayShutdown(options = {}) {', '\n}\n');
  const guard = request.indexOf('relayEventService?.noteRestartRequested()');
  assert.notEqual(guard, -1);
  assert.ok(guard < request.indexOf('relayRestartQueue.request('), 'noted first: an immediate request exits inside the call');
  assert.match(request, /if \(!relayRestartQueue\.isQueued\(\) && !runtimeShutdownStarted\) relayEventService\?\.noteRestartCancelled\(\);/);
  const cancel = sliceBetween(runtimeSource, 'function cancelRelayShutdown(', '\n}\n');
  assert.match(cancel, /if \(result\?\.cancelled\) relayEventService\?\.noteRestartCancelled\(\);/);
  const startShutdown = sliceBetween(runtimeSource, 'startShutdown: ({ action, reason, requestedBy, requestedAt }) => {', 'void shutdownRuntime(');
  assert.match(startShutdown, /relayEventService\?\.noteRelayExit\(\{ action, reason, requestedBy, requestedAt \}\)/);
  const shutdown = sliceBetween(runtimeSource, 'function shutdownRuntime(', 'runtimeShutdownPromise = new Promise(');
  assert.ok(shutdown.indexOf('relayEventService.noteRelayExit(') !== -1 && shutdown.indexOf('relayEventService.noteRelayExit(') < shutdown.indexOf('relayEventService.stop()'),
    'the generic end is written before the service stops');
  const listening = sliceBetween(runtimeSource, 'httpServer.listen(config.port, listenHost, () => {', 'buildRelayReadyBannerData();');
  assert.match(listening, /relayEventService\.noteRelayStarted\(\);/, 'the start is noted once the relay listens');
  assert.equal(runtimeSource.split('relayEventService.noteRelayStarted();').length, 2, 'and only there');
});

test('the socket delivery path refuses rows while a shutdown is queued, before any dequeue', () => {
  const body = sliceBetween(runtimeSource, 'async function requestSessionWorkerSocketDelivery(', '\n}\n');
  const gate = body.indexOf('if (isRelayShutdownQueued(runtimeState)) {');
  const dequeue = body.indexOf('dequeuePendingMessageForWorkerLoop(');
  assert.notEqual(gate, -1, 'the gate is in the socket delivery path');
  assert.ok(gate < dequeue, 'the gate comes before the dequeue');
  assert.match(body.slice(gate, gate + 200), /return relayShutdownGateReply\(runtimeState\);/);
});

test('the runtime state tells the routes whether a shutdown is queued', () => {
  assert.match(runtimeSource, /get relayShutdownQueued\(\) \{ return relayRestartQueue\.isQueued\(\); \}/);
});
