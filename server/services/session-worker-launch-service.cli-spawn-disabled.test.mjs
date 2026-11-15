// COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN (test relays): the relay launches no
// worker, and a launch asked for under it is deferred for good, not failed.
// The supervisor and the claim are the real ones; the launch is the deferral
// server-runtime.mjs returns from spawnSessionWorkerCli, whose wiring is
// pinned by source inspection at the end (the runtime boots a server on
// import).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { dequeuePendingMessageForWorkerLoop } from '../routes/messages-routes.mjs';
import { createPendingWorkerPrimer } from './queue-waker.mjs';
import { createSessionWorkerRegistry } from './session-worker-registry-service.mjs';
import { createSessionWorkerSupervisor } from './session-worker-supervisor-service.mjs';
import {
  CLI_SPAWN_DISABLED,
  createCliSpawnDisabledDeferral,
  isCliSpawnDisabled,
} from './session-worker-launch-service.mjs';

const SID = '4c1e7d20-spawnless';
const OTHER_SID = '9a07b3e1-spawnless';
const CONV = 'conv-spawnless-4c1e';
const NOW = '2026-03-02T09:00:00.000Z';

function bootSupervisor({ spawnWorker }) {
  const registry = createSessionWorkerRegistry();
  const timers = [];
  const supervisor = createSessionWorkerSupervisor({
    registry,
    spawnWorker,
    maxRestartRetries: 2,
    setTimeoutImpl: (fn, ms) => { timers.push(ms); return { unref() {} }; },
    clearTimeoutImpl: () => {},
    isPidAlive: (pid) => pid === process.pid,
  });
  return { registry, supervisor, timers };
}

function deferral() {
  const lines = [];
  const deferLaunch = createCliSpawnDisabledDeferral({ log: (line) => lines.push(line) });
  return { lines, deferLaunch };
}

test('the switch is read from the launch environment: any non-blank value', () => {
  assert.equal(isCliSpawnDisabled({ COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1' }), true);
  assert.equal(isCliSpawnDisabled({ COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: 'yes' }), true);
  assert.equal(isCliSpawnDisabled({ COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '  ' }), false);
  assert.equal(isCliSpawnDisabled({}), false);
  assert.equal(isCliSpawnDisabled(undefined), false);
});

test('the deferral answers deferred every time and logs one line per session', () => {
  const { lines, deferLaunch } = deferral();
  for (let i = 0; i < 5; i += 1) assert.deepEqual(deferLaunch(SID), { deferred: CLI_SPAWN_DISABLED });
  deferLaunch(OTHER_SID);
  deferLaunch(OTHER_SID);
  assert.deepEqual(lines, [
    'worker launcher: not launched session=4c1e7d20 (COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN), waiting for a worker to report',
    'worker launcher: not launched session=9a07b3e1 (COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN), waiting for a worker to report',
  ]);
});

test('with the switch set, ensureWorker answers ok and deferred, again and again, with no restart counting', async () => {
  const { lines, deferLaunch } = deferral();
  let launches = 0;
  const { supervisor, timers } = bootSupervisor({ spawnWorker: async (sid) => { launches += 1; return deferLaunch(sid); } });
  for (let i = 0; i < 10; i += 1) {
    const result = await supervisor.ensureWorker(SID);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.deferred, CLI_SPAWN_DISABLED);
    assert.equal(result.worker.status, 'new');
    assert.equal(result.worker.pid, null);
  }
  assert.equal(launches, 10);
  const lifecycle = supervisor.getLifecycleState(SID);
  assert.equal(lifecycle.retryCount, 0);
  assert.equal(lifecycle.restartExhausted, false);
  assert.equal(lifecycle.nextRestartAt, null);
  assert.deepEqual(timers, [], 'no restart timer');
  assert.equal(lines.length, 1, 'one log line for the session');
});

test('without the switch a failed launch still fails as spawn-failed and counts toward the restart limit', async () => {
  const { supervisor } = bootSupervisor({ spawnWorker: async () => { throw new Error('spawn ENOENT'); } });
  const first = await supervisor.ensureWorker(SID);
  assert.equal(first.ok, false);
  assert.equal(first.error, 'spawn-failed');
  assert.equal(first.worker.status, 'error');
  assert.equal(supervisor.getLifecycleState(SID).retryCount, 1);
  assert.notEqual(supervisor.getLifecycleState(SID).nextRestartAt, null, 'a restart backoff');
});

test('with the switch set the row stays queued, nothing primes, and a worker that reports by itself takes it', async () => {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createMessageRepository(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at) VALUES (?, 'Spawnless', ?, 'active', ?, ?)`)
    .run(CONV, SID, NOW, NOW);
  db.prepare(`
    INSERT INTO queue (id, conversation_id, is_new_conversation, text, status, timestamp, retry_count, owner_sdk_session_id, relay_mode)
    VALUES ('q-spawnless', ?, 0, 'hello', 'pending', ?, 0, ?, 'agent')
  `).run(CONV, NOW, SID);

  const { lines, deferLaunch } = deferral();
  const { registry, supervisor, timers } = bootSupervisor({ spawnWorker: async (sid) => deferLaunch(sid) });

  // The new chat's own launch (bootstrap, send): deferred, the row waits.
  const ensured = await supervisor.ensureWorker(SID);
  assert.equal(ensured.ok, true);
  assert.equal(ensured.deferred, CLI_SPAWN_DISABLED);
  assert.equal(stmts.findQById.get('q-spawnless').status, 'pending');

  // The prime, as the runtime wires it under the switch: off.
  const primed = [];
  let armed = 0;
  const prime = createPendingWorkerPrimer({
    isEnabled: () => !isCliSpawnDisabled({ COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1' }),
    listPendingOwnerSessionIds: (limit) => stmts.listPendingWorkerOwnerSessionIds.all(limit),
    ensureWorker: async (sid) => { primed.push(sid); return supervisor.ensureWorker(sid); },
    onRowsWaiting: () => { armed += 1; },
  });
  for (let i = 0; i < 3; i += 1) assert.equal(await prime('maintenance'), 0);
  assert.deepEqual(primed, []);
  assert.equal(armed, 0, 'no maintenance pass armed by the prime');
  assert.equal(stmts.findQById.get('q-spawnless').status, 'pending');

  // A worker reports by itself (what its heartbeat registers), then claims.
  registry.upsertWorker({ sdkSessionId: SID, status: 'ready', pid: process.pid, conversationId: CONV });
  const claimed = await dequeuePendingMessageForWorkerLoop({
    db,
    stmts,
    nowIso: new Date(Date.parse(NOW) + 1_000).toISOString(),
    requesterSessionId: SID,
    sessionWorkerSupervisor: supervisor,
  });
  assert.equal(claimed.message?.id, 'q-spawnless', JSON.stringify(claimed));
  const row = stmts.findQById.get('q-spawnless');
  assert.equal(row.status, 'processing');
  assert.equal(row.owner_sdk_session_id, SID);

  assert.equal(supervisor.getLifecycleState(SID).retryCount, 0);
  assert.deepEqual(timers, []);
  assert.equal(lines.length, 1);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'server-runtime.mjs'), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(start, end) {
  const from = runtimeSource.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = runtimeSource.indexOf(end, from);
  assert.notEqual(to, -1, `missing ${end} after ${start}`);
  return runtimeSource.slice(from, to);
}

test('the runtime defers the launch under the switch before the SDK gate and the launcher, and primes nothing', () => {
  const spawn = sliceBetween('async function spawnSessionWorkerCli(', '\n}\n');
  const deferAt = spawn.indexOf('if (isCliSpawnDisabled(sessionWorkerLaunchEnv)) return deferLaunchWhileCliSpawnDisabled(normalizedTargetSessionId);');
  assert.notEqual(deferAt, -1);
  assert.ok(deferAt < spawn.indexOf('buildSessionWorkerLaunchEnvWithAgentToken('), 'before the launch environment (and its agent token) is built');
  assert.ok(deferAt < spawn.indexOf('agentSdkLaunchGate.check('), 'before the SDK gate');
  assert.ok(deferAt < spawn.indexOf('await launchSessionCli('), 'before the launcher');
  assert.match(runtimeSource, /\nconst deferLaunchWhileCliSpawnDisabled = createCliSpawnDisabledDeferral\(\{\n  log: \(line\) => console\.log\(`\$\{runtimeLogPrefix\(\)\}\$\{line\}`\),\n\}\);\n/);
  const primer = sliceBetween('const pendingWorkerPrimer = createPendingWorkerPrimer({', '\n});');
  assert.match(primer, /&& !isCliSpawnDisabled\(sessionWorkerLaunchEnv\)\n/);
});
