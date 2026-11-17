'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The dead-worker sweep (recoverDeadWorkerProcessingRows) decides per row what
// a dead worker's turn becomes. The decisions that read the database live in
// services/stale-turn-recovery.mjs and are tested there against a real
// database; server-runtime.mjs boots a live server on import, so the order of
// the steps is read from the source as text, like the other runtime suites.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(startMarker, endMarker) {
  const start = runtimeSource.indexOf(startMarker);
  assert.notEqual(start, -1, `expected server-runtime.mjs to contain ${startMarker}`);
  const end = runtimeSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected ${endMarker} after ${startMarker}`);
  return runtimeSource.slice(start, end);
}

test("the dead-worker sweep fails an archived chat's turn and a stopped turn instead of requeueing them", () => {
  const sweep = sliceBetween('function recoverDeadWorkerProcessingRows(sessionId, reason) {', '\n}\n');
  const steps = [
    "if (String(row.kind || '') === 'continuation') {",
    'if (row.consumed_at) {',
    'if (staleTurnRecovery.failIfArchived(row, `worker-died-${reason}`)) continue;',
    'if (Number(row.retry_count || 0) + 1 >= MAX_REQUEUE_RETRIES) {',
    'if (staleTurnRecovery.failIfStopRequested(row, `worker-died-${reason}`)) continue;',
    'stmts.recoverProcessingRowKeepOwner?.run?.(requeueAt, row.id);',
  ];
  let at = -1;
  for (const step of steps) {
    const next = sweep.indexOf(step);
    assert.notEqual(next, -1, `the sweep has: ${step}`);
    assert.ok(next > at, `in order: ${step}`);
    at = next;
  }
  // Inside the loop over the rows, read after the liveness probe's await.
  assert.ok(sweep.indexOf('for (const row of rows) {') < sweep.indexOf('failIfArchived'));
  assert.equal(sweep.includes('await'), false, 'nothing awaited between the read and the write');
  // The same service the stale sweep runs, built before the dead-worker code.
  assert.ok(runtimeSource.indexOf('const staleTurnRecovery = createStaleTurnRecovery({') < runtimeSource.indexOf('function recoverDeadWorkerProcessingRows('));
});

test('the dead-worker detection and the archive run one liveness probe; the detection reads unknown as not alive', () => {
  const probe = sliceBetween('async function isWorkerSessionProcessAlive(sessionId, hintPid = null) {', '\n}\n');
  assert.match(probe, /return \(await workerSessionLiveness\.probe\(sessionId, \{ hintPid \}\)\) === 'alive';/);
  const wiring = sliceBetween('const workerSessionLiveness = createWorkerSessionLiveness({', '\n});');
  assert.match(wiring, /hasLiveWorkerSocket: \(sid\) => sessionWorkerWebSocketService\?\.hasLiveWorkerSocket\?\.\(sid\) === true,/);
  assert.match(wiring, /getWorkerPid: \(sid\) => sessionWorkerRegistry\?\.getWorker\?\.\(sid\)\?\.pid,/);
  assert.match(wiring, /findProcessForSession: \(sid\) => sessionWorkerProcessInspector\?\.findProcessForSessionAsync\?\.\(sid\),/);
  // The archive's routes get the worker sockets through the shared deps.
  const deps = sliceBetween('const sharedRouteDeps = {', '\n};');
  assert.match(deps, /\n  hasLiveWorkerSocket: \(sid\) => sessionWorkerWebSocketService\.hasLiveWorkerSocket\(sid\) === true,\n/);
});
