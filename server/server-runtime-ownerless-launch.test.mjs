'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A row with no owner anywhere belongs to the session named like its
// conversation (repositories/message-repository.mjs, QUEUE_ROW_SESSION_SQL),
// and the waker launches a worker under that id: a chat that was never bound
// (a schedule, an event subscription or a board follow-up into it). The
// launch then finds the chat by that id for its provider, its cwd and the
// Claude API check. server-runtime.mjs boots a live server on import, so
// these tests read the source as text, like the other runtime suites.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(startMarker, endMarker) {
  const start = runtimeSource.indexOf(startMarker);
  assert.notEqual(start, -1, `expected server-runtime.mjs to contain ${startMarker}`);
  const end = runtimeSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected ${endMarker} after ${startMarker}`);
  return runtimeSource.slice(start, end);
}

test('the launch reads the provider of a chat that was never bound by its conversation id', () => {
  const env = sliceBetween('function buildSessionWorkerLaunchEnvForSession(targetSessionId) {', '\n}\n');
  assert.match(env, /stmts\.getRuntimeSessionBySdkSessionId\.get\(normalizedTargetSessionId\)\n\s*\|\| stmts\.getRuntimeSessionByConversation\.get\(normalizedTargetSessionId\)/);
});

test('the launch cwd is the configured root of the chat named like the session', () => {
  const cwd = sliceBetween('function resolveLaunchWorkspaceRootForSession(sdkSessionId) {', '\n}\n');
  assert.match(cwd, /resolveConversationWorkspaceState\(\{ conversationId: sdkSessionId, sdkSessionId \}\)/);
  // The record lookup tries the conversation id first and skips a deleted one.
  const record = sliceBetween('function resolveConversationRecord({', '\n}\n');
  assert.ok(record.indexOf('stmts.getConvAnyStatus.get(convId)') < record.indexOf('stmts.getConvBySdkSessionId.get(sid)'));
});

test('no Claude API worker is launched for a never-bound chat while Claude API cannot run a turn', () => {
  const skip = sliceBetween('function failClaudeApiRowsWithoutLaunch(sdkSessionId) {', '\n}\n');
  assert.match(skip, /stmts\.getRuntimeSessionBySdkSessionId\.get\(sdkSessionId\)\n\s*\|\| stmts\.getRuntimeSessionByConversation\.get\(sdkSessionId\)/);
  // The session's rows as the claim reads them, ownerless ones included.
  assert.match(skip, /stmts\.listPendingClaudeApiRowsForSession\.all\(sdkSessionId, 'claude-api'\)/);
  assert.equal(runtimeSource.includes('listPendingClaudeApiRowsForOwner'), false);
});

test('the waker\'s scan fails the rows of conversations that are gone', () => {
  const wiring = sliceBetween('const pendingWorkerPrimer = createPendingWorkerPrimer({', '\n});');
  assert.match(wiring, /failGoneRows: \(\) => failRowsOfGoneConversations\(\{ db, stmts, emit: \(event, payload\) => io\.emit\(event, payload\), log: \(line\) => console\.warn\(`\$\{runtimeLogPrefix\(\)\}\$\{line\}`\) \}\),/);
});

test('the rows of gone conversations are failed once at boot with no grace, before the first prime and the first queue wake', () => {
  const marker = 'failRowsOfGoneConversations({ db, stmts, graceMs: 0,';
  const sweep = runtimeSource.indexOf(`\n  ${marker}`);
  assert.notEqual(sweep, -1, 'a top-level call at start, not in a timer or a handler');
  assert.equal(runtimeSource.split(marker).length, 2, 'called once');
  assert.ok(runtimeSource.indexOf('\nrecoverStaleMessages(); // run immediately on startup\n') < sweep);
  assert.ok(sweep < runtimeSource.indexOf("void primePendingSessionWorkers('startup');"));
  assert.ok(sweep < runtimeSource.indexOf('queueWakeStarted = true;'));
  const block = sliceBetween('try {\n  failRowsOfGoneConversations({ db, stmts, graceMs: 0,', '\n}\n');
  assert.match(block, /emit: \(event, payload\) => io\.emit\(event, payload\)/);
  assert.match(runtimeSource.slice(sweep + 1),/^[^\n]*\n\} catch \(error\) \{\n  console\.warn\(`\$\{runtimeLogPrefix\(\)\}gone conversation rows check failed: /);
});

test('ownerless rows older than a day are failed once at boot, before the first prime can launch for them', () => {
  const guard = runtimeSource.indexOf('failStaleOwnerlessRowsAtBoot({');
  assert.notEqual(guard, -1);
  assert.ok(guard < runtimeSource.indexOf("void primePendingSessionWorkers('startup');"));
  assert.ok(guard < runtimeSource.indexOf('queueWakeStarted = true;'));
  const call = sliceBetween('failStaleOwnerlessRowsAtBoot({', '});');
  assert.match(call, /uuid: uuidv4,/);
  assert.match(call, /noteError: \(payload\) => relayEventService\?\.noteError\?\.\(payload\),/);
});
