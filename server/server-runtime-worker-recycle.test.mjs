'use strict';

// server-runtime.mjs boots a live server on import, so the wiring of the
// worker recycle is pinned by source inspection, like the other runtime
// suites. The recycle and the archived sweep themselves are covered by
// services/worker-recycle-service.test.mjs, the stop and the launch by
// services/worker-replacement.test.mjs, and the archived list's SQL by
// repositories/session-repository.archived-sessions.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(start, end) {
  const from = runtimeSource.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = runtimeSource.indexOf(end, from);
  assert.notEqual(to, -1, `missing ${end} after ${start}`);
  return runtimeSource.slice(from, to);
}

test('the recycle compares with the relay build id and asks the registry, the queue and the supervisor', () => {
  const service = sliceBetween('const workerRecycleService = createWorkerRecycleService({', '\n});');
  assert.match(service, /relayBuildId: BUILD_ID,/);
  assert.match(service, /listWorkers: \(\) => sessionWorkerRegistry\.listWorkers\(\),/);
  assert.match(service, /getWorker: \(sid\) => sessionWorkerRegistry\.getWorker\(sid\),/);
  assert.match(service, /hasRunningTurn: \(sid\) => \(stmts\.listProcessingRowsForOwner\?\.all\?\.\(sid\) \|\| \[\]\)\.length > 0,/);
  // Any heartbeat counts, not the supervisor's first-observed one: the
  // workers that reconnect after a restart never get that.
  assert.match(service, /const lc = sessionWorkerSupervisor\.getLifecycleState\(sid\);\n    return !!lc\?\.lastHeartbeatAt && !lc\?\.awaitingHeartbeat;/);
  assert.doesNotMatch(service, /lc\?\.firstObservedHeartbeatAt/);
  assert.match(service, /isArchived: \(sid\) => isWorkerSessionArchived\(sid\),/);
  assert.match(service, /stopWorker: recycleWorkerReplacement\.stopWorker,/);
  assert.match(service, /launchWorker: recycleWorkerReplacement\.launchWorker,/);
  // Its own replacement instance: a failed stop's warning names the recycle.
  assert.match(runtimeSource, /const recycleWorkerReplacement = createRuntimeWorkerReplacement\('WORKER RECYCLE'\);/);
});

test('a recycle stuck for stuckAfter tries leaves a note in the chat, as the billing swap does', () => {
  const service = sliceBetween('const workerRecycleService = createWorkerRecycleService({', '\n});');
  assert.match(service, /onStuck: \(stuck\) => noteWorkerRecycleStuck\(stuck\),/);
  const note = sliceBetween('function noteWorkerRecycleStuck(stuck = {}) {', '\n}\n');
  assert.match(note, /if \(stuck\.archived\) return;/);
  assert.match(note, /const conversationId = workerSessionConversationId\(stuck\.sdkSessionId\);/);
  assert.match(note, /const text = workerRecycleStuckNoteText\(stuck\);/);
  assert.match(note, /stmts\.insertMsg\.run\(messageId, conversationId, 'assistant', text,/);
  assert.match(note, /stmts\.setMessageKind\?\.run\?\.\('worker-recycle-stuck', messageId\);/);
  assert.match(note, /io\.emit\('assistant_message', \{/);
  assert.match(note, /kind: 'worker-recycle-stuck'/);
  const conversation = sliceBetween('function workerSessionConversationId(sid) {', '\n}\n');
  assert.match(conversation, /stmts\.getRuntimeSessionBySdkSessionId\?\.get\?\.\(sid\)/);
  assert.match(conversation, /stmts\.getConvBySdkSessionId\?\.get\?\.\(sid\)\?\.id/);
});

test('a session is archived for the recycle only when no conversation in use stands behind it', () => {
  const body = sliceBetween('function isWorkerSessionArchived(sid) {', '\n}\n');
  assert.match(body, /stmts\.getRuntimeSessionBySdkSessionId\?\.get\?\.\(sid\)/);
  assert.match(body, /stmts\.getConvAnyStatus\?\.get\?\.\(runtime\.conversation_id\)/);
  assert.match(body, /stmts\.getConvBySdkSessionId\?\.get\?\.\(sid\)/);
  assert.match(body, /Number\(conversation\.archived \|\| 0\) !== 1/);
  assert.match(body, /!== 'deleted'/);
  assert.match(body, /return !inUse\(viaRuntime\) && !inUse\(viaSessionId\);/);
});

test('the recycle starts under routing only, and stops with the runtime timers', () => {
  assert.match(runtimeSource, /\nif \(featureFlags\?\.SESSION_WORKER_ROUTING_ENABLED === true\) workerRecycleService\.start\(\);\n/);
  assert.equal(runtimeSource.split('workerRecycleService.start()').length, 2, 'started in one place');
  const clear = sliceBetween('function clearRuntimeTimers() {', '\n}\n');
  assert.match(clear, /try \{ workerRecycleService\.stop\(\); \} catch \{\}/);
  assert.match(clear, /runtimeTimers\.archivedWorkerSweep = null;/);
  const shutdown = sliceBetween('function shutdownRuntime(', 'runtimeShutdownPromise = new Promise(');
  assert.match(shutdown, /clearRuntimeTimers\(\);/);
});

test('the runtime state hands the recycle status to the routes as a function', () => {
  const state = sliceBetween('const runtimeState = {', '\n};');
  assert.match(state, /workerRecycle: \(\) => workerRecycleService\.status\(\),/);
});

test('the archived sweep runs once, 30 s after the relay listens, under routing, on an unref\'d timer', () => {
  const listening = sliceBetween('httpServer.listen(config.port, listenHost, () => {', '\n});');
  assert.match(listening, /if \(featureFlags\?\.SESSION_WORKER_ROUTING_ENABLED === true\) \{\n    runtimeTimers\.archivedWorkerSweep = setTimeout\(\(\) => \{/);
  assert.match(listening, /sweepArchivedSessionWorkersAtStart\(\)\.catch\(/);
  assert.match(listening, /\}, 30_000\);\n    runtimeTimers\.archivedWorkerSweep\.unref\?\.\(\);/);
  const sweep = sliceBetween('async function sweepArchivedSessionWorkersAtStart() {', '\n}\n');
  assert.match(sweep, /if \(featureFlags\?\.SESSION_WORKER_ROUTING_ENABLED !== true\) return null;/);
  assert.match(sweep, /if \(runtimeShutdownStarted\) return null;/);
  assert.match(sweep, /stmts\.listArchivedRuntimeSessionIds\?\.all\?\.\(\)/);
  // A live process is the registry's live pid or one the process list shows.
  assert.match(sweep, /isProcessAlive\(pid\)/);
  assert.match(sweep, /sessionWorkerProcessInspector\?\.findProcessForSessionAsync\?\.\(sid, \{ fresh \}\)/);
  assert.match(sweep, /isArchived: \(sid\) => isWorkerSessionArchived\(sid\),/);
  assert.match(sweep, /stopWorker: recycleWorkerReplacement\.stopWorker,/);
});

test('the archived sweep stops under the launch mutex with the replacement fence up for the worker\'s pid', () => {
  const sweep = sliceBetween('async function sweepArchivedSessionWorkersAtStart() {', '\n}\n');
  assert.match(sweep, /fence: workerReplacementFence,/);
  assert.match(sweep, /runExclusive: \(sid, fn\) => sessionLaunchMutex\.runExclusive\(sid, fn\),/);
  // The pid: the registry's live one, else the process list's.
  assert.match(sweep, /workerPid: async \(sid\) => \{/);
  assert.match(sweep, /if \(Number\.isInteger\(pid\) && pid > 0 && isProcessAlive\(pid\)\) return pid;/);
  assert.match(sweep, /return Number\(found\?\.processId\) \|\| null;/);
});

// The replacement fence, on the socket delivery and shared with /api/pending.
test('the socket delivery refuses work to a process the recycle is replacing, past the killed marker', () => {
  const delivery = sliceBetween('async function requestSessionWorkerSocketDelivery(', '\n}\n');
  const killed = delivery.indexOf("blockedReason: 'session-killed'");
  const fenced = delivery.indexOf('if (workerReplacementFence.isHeld(requesterSessionId, pid)) {');
  const dequeue = delivery.indexOf('await dequeuePendingMessageForWorkerLoop(');
  assert.notEqual(killed, -1);
  assert.notEqual(fenced, -1, 'the fence is checked');
  assert.ok(killed < fenced && fenced < dequeue, 'after the killed check, before any row is claimed');
  assert.match(delivery.slice(fenced, dequeue), /blockedReason: 'worker-replacement',/);
  // Asked again before every claim, past ensureWorker and a retry's backoff.
  assert.match(delivery.slice(dequeue), /isReplacementFenced: \(\) => workerReplacementFence\.isHeld\(requesterSessionId, pid\),/);
});

test('one replacement fence: both replacements, the recycle and /api/pending share it', () => {
  // One fence, wrapped so that its release wakes the queue.
  assert.match(runtimeSource, /\nconst workerReplacementFence = \(\(\) => \{\n  const fence = createWorkerReplacementFence\(\);\n/);
  assert.equal((runtimeSource.match(/createWorkerReplacementFence\(\)/g) || []).length, 1);
  const factory = sliceBetween('function createRuntimeWorkerReplacement(tag) {', '\n}\n');
  assert.match(factory, /fence: workerReplacementFence,/);
  const service = sliceBetween('const workerRecycleService = createWorkerRecycleService({', '\n});');
  assert.match(service, /fence: recycleWorkerReplacement\.fence,/);
  const routeDeps = sliceBetween('const sharedRouteDeps = {', '\n};');
  assert.match(routeDeps, /\n  workerReplacementFence,\n/);
});

test('the recycle stops and launches under the relay-wide launch mutex the sessions routes take', () => {
  assert.match(runtimeSource, /import \{ sessionLaunchMutex \} from '\.\/services\/session-launch-mutex-service\.mjs';/);
  const service = sliceBetween('const workerRecycleService = createWorkerRecycleService({', '\n});');
  assert.match(service, /runExclusive: \(sid, fn\) => sessionLaunchMutex\.runExclusive\(sid, fn\),/);
  const routesSource = fs.readFileSync(path.join(__dirname, 'routes', 'sessions-routes.mjs'), 'utf8');
  assert.match(routesSource, /import \{ sessionLaunchMutex \} from '\.\.\/services\/session-launch-mutex-service\.mjs';/);
  assert.doesNotMatch(routesSource, /const sessionLaunchMutex = /, 'no route-local mutex the recycle could not take');
  assert.doesNotMatch(routesSource, /createKeyedMutex/);
});

test('the recycle knows the agent-SDK kinds from the launch gate\'s own map', () => {
  const service = sliceBetween('const workerRecycleService = createWorkerRecycleService({', '\n});');
  // Only where the SDK comes from the store: a checkout's own node_modules
  // survive a restart on new code (staleWorkerLosesAgentSdk).
  assert.match(service, /isAgentSdkWorker: \(worker\) => staleWorkerLosesAgentSdk\(worker\?\.kind, \{ sdkForWorkerKind: agentSdkForWorkerKind, fromCheckout: \(sdk\) => agentSdkFromCheckout\(sdk\) \}\),/);
  assert.match(runtimeSource, /import \{ agentSdkForWorkerKind, [^}]*\} from '\.\/services\/session-worker-launch-service\.mjs';/);
});

test('a worker hello registers the process with its kind and build id, then runs the recycle sweep, before the hello asks for work', () => {
  const socket = sliceBetween('const sessionWorkerWebSocketService = createSessionWorkerWebSocketService({', '\n});');
  assert.match(socket, /\n  onWorkerHello: noteSessionWorkerHello,\n/);
  const hello = sliceBetween('function noteSessionWorkerHello(', '\n}\n');
  assert.match(hello, /if \(featureFlags\?\.SESSION_WORKER_ROUTING_ENABLED !== true \|\| runtimeShutdownStarted\) return;/);
  assert.match(hello, /if \(sessionWorkerSupervisor\?\.isKillBlocked\?\.\(sid\) !== true\) \{/);
  // An entry with no process behind it (a launch the agent SDK gate
  // deferred) is made ready, as a heartbeat would.
  assert.match(hello, /if \(!worker \|\| worker\.status === 'new' \|\| \(!worker\.workerId && !worker\.pid\)\) \{/);
  const register = hello.indexOf("status: 'ready',\n        pid: statedPid || worker?.pid || null,");
  const stated = hello.indexOf('...(buildId ? { buildId } : {})');
  const sweep = hello.indexOf('void workerRecycleService.sweepNow();');
  assert.ok(register !== -1 && stated !== -1 && sweep !== -1);
  assert.ok(register < stated && stated < sweep, 'registered, then the kind and build id, then the sweep');
  // The service's start sweeps at once; the hello sweep only while it runs.
  const serviceSource = fs.readFileSync(path.join(__dirname, 'services', 'worker-recycle-service.mjs'), 'utf8');
  assert.match(serviceSource, /function sweepNow\(\) \{\n    if \(!started\) return Promise\.resolve\(\);/);
});

test('the recycle\'s quiet window reads the session\'s last delivery or turn end from the queue', () => {
  const service = sliceBetween('const workerRecycleService = createWorkerRecycleService({', '\n});');
  assert.match(service, /quietSince: \(sid\) => \{\n    const at = Date\.parse\(stmts\.getOwnerLastActivityAt\?\.get\?\.\(sid\)\?\.last_activity_at \|\| ''\);\n    return Number\.isFinite\(at\) \? at : null;\n  \},/);
});

test('a launch reuses a listed worker only by its identity: the listed process can have ended and its pid gone to another', () => {
  const spawn = sliceBetween('async function spawnSessionWorkerCli(', '\n}\n');
  assert.match(spawn, /findProcessForSessionAsync\(normalizedTargetSessionId, \{ fresh: true \}\)/);
  // On Windows the fresh row is the identity; elsewhere the reader is asked.
  assert.match(spawn, /const liveIdentity = liveWorker\?\.processId\n      \? await identityOfListedWorker\(liveWorker, \{ platform: process\.platform, identityOf: readWorkerProcessIdentity \}\)\n      : null;/);
  assert.match(spawn, /if \(liveWorker\?\.processId && mayReuseSessionWorkerRow\(\{\n      row: liveWorker,\n      current: liveIdentity,\n      sdkSessionId: normalizedTargetSessionId,/);
  assert.doesNotMatch(spawn, /liveWorker\?\.processId && isProcessAlive\(/, 'liveness alone never decides');
  // The launcher's own reuse check reads with the same reader.
  assert.match(spawn, /readProcessIdentity: readWorkerProcessIdentity,/);
});

test('the recycle and the stop read what the process at a pid is, from one reader over the inspector\'s list', () => {
  assert.match(runtimeSource, /const readWorkerProcessIdentity = createProcessIdentityReader\(\{\n  platform: process\.platform,\n  readProcessSnapshot: \(options\) => sessionWorkerProcessInspector\.readProcessSnapshot\(options\),\n\}\);/);
  const replacement = sliceBetween('function createRuntimeWorkerReplacement(tag) {', '\n}\n');
  assert.match(replacement, /readProcessIdentity: readWorkerProcessIdentity,/);
  const service = sliceBetween('const workerRecycleService = createWorkerRecycleService({', '\n});');
  assert.match(service, /readProcessIdentity: \(pid\) => readWorkerProcessIdentity\(pid, \{ fresh: true \}\),/);
});
