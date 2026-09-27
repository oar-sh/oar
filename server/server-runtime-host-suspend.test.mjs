'use strict';

// server-runtime.mjs boots a live server on import, so the deferred-suspend
// wiring is pinned by source inspection, the same way the other runtime
// suites do it. The state machine itself is covered by
// services/host-suspend-service.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8');
const sessionsSource = fs.readFileSync(path.join(__dirname, 'routes', 'sessions-routes.mjs'), 'utf8');
const messagesSource = fs.readFileSync(path.join(__dirname, 'routes', 'messages-routes.mjs'), 'utf8');
const socketSource = fs.readFileSync(path.join(__dirname, 'public', 'app', 'socket-handlers.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(__dirname, 'public', 'app', 'bootstrap.js'), 'utf8');

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test('runtime builds the host-suspend service on the real activity collector and suspend command', () => {
  assert.match(runtimeSource, /const hostSuspendService = createHostSuspendService\(\{\s*collectActivity: collectHostActivity,\s*runSuspend: \(\) => runHostSuspendToRam\(/);
  assert.match(runtimeSource, /io\.emit\('host_suspend_state', state\)/);
  assert.match(runtimeSource, /pushDispatchService\.notifyHostSuspend\(/);
});

test('the activity collector reads turns, live background tasks and CI', () => {
  const body = sliceBetween(runtimeSource, 'function collectHostActivity(', '\nconst hostSuspendService');
  assert.match(body, /stmts\.listActiveQueueCountsByConversation/);
  assert.match(body, /backgroundTaskStore\.sets/);
  assert.match(body, /hostActivityWorkerAlive\(key\)/, 'background tasks only count for live workers');
  assert.match(body, /stmts\.countRunningSubagentRuns/);
  assert.match(body, /githubCiActivityService\.describeRuns\(roots\)/);
  assert.match(body, /githubCiActivityService\.snapshot\(roots\)/);
});

test('routes, status, socket connect and shutdown are wired', () => {
  const deps = sliceBetween(runtimeSource, 'const sharedRouteDeps = {', '\nregisterMessagesRoutes(app, sharedRouteDeps);');
  for (const name of ['hostSuspendService', 'collectHostActivity', 'cancelRelayShutdown', 'relayShutdownStatePayload']) {
    assert.match(deps, new RegExp(`\\b${name},`), `${name} in sharedRouteDeps`);
  }
  assert.match(runtimeSource, /get hostSuspend\(\) \{ return hostSuspendService\.getState\(\); \}/);
  const connect = sliceBetween(runtimeSource, "io.on('connection', (socket) => {", '\n});');
  assert.match(connect, /socket\.emit\('host_suspend_state'/);
  assert.match(connect, /socket\.emit\('relay_shutdown_state'/);
  const shutdown = sliceBetween(runtimeSource, 'function shutdownRuntime(', 'const importerShutdown');
  assert.match(shutdown, /hostSuspendService\.dispose\(\{ reason \}\)/);
});

test('relay shutdown state is announced on request, drain and cancel', () => {
  const body = sliceBetween(runtimeSource, 'function cancelRelayShutdown(', '\nfunction toNullableInt');
  assert.match(body, /pendingRelayShutdownRequest = null;[\s\S]*emitRelayShutdownState\(\);/);
  assert.match(body, /void shutdownRuntime\([\s\S]*?\);\s*emitRelayShutdownState\(\);/);
  assert.match(body, /if \(pendingRelayShutdownRequest\) emitRelayShutdownState\(\);/);
});

test('HTTP surface: GET/POST/cancel for host suspend, cancel for relay shutdown, status field', () => {
  assert.match(sessionsSource, /app\.get\('\/api\/host\/suspend', auth/);
  assert.match(sessionsSource, /app\.post\('\/api\/host\/suspend', auth/);
  assert.match(sessionsSource, /app\.post\('\/api\/host\/suspend\/cancel', auth/);
  assert.match(sessionsSource, /hostSuspend: runtimeState\.hostSuspend \|\| null,/);
  assert.doesNotMatch(sessionsSource, /function runHostSuspendToRam/, 'the command moved to services/host-suspend-command.mjs');
  assert.match(messagesSource, /app\.post\('\/api\/relay\/shutdown\/cancel', auth/);
});

test('client listens for both states and re-reads them from status polls', () => {
  assert.match(socketSource, /socket\.on\('host_suspend_state'/);
  assert.match(socketSource, /socket\.on\('relay_shutdown_state'/);
  assert.match(bootstrapSource, /applyPendingActionsFromStatus\(status\);/);
  assert.match(bootstrapSource, /initHostSuspendUi\(\);/);
});
