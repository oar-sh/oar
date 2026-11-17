'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// getOrCreateConversation creates the conversation of a message that opens a
// new chat. A message into an existing archived chat brings it back in the
// queue write's transaction (repositories/queue-insert.mjs), so the runtime's
// helper has no unarchive of its own. server-runtime.mjs boots a live server
// on import, so these tests read the sources as text.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n');
const runtimeSource = read('server-runtime.mjs');
const intakeSource = read(path.join('routes', 'messages-intake-routes.mjs'));

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `expected ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

test('getOrCreateConversation only inserts and reads the conversation: it unarchives nothing', () => {
  const create = sliceBetween(runtimeSource, 'function getOrCreateConversation(id, firstLine) {', '\n}\n');
  assert.match(create, /stmts\.insertConv\.run\(id, \(firstLine \|\| 'Untitled'\)\.slice\(0, 80\), now, now\);/);
  assert.match(create, /return stmts\.getConv\.get\(id\);/);
  assert.doesNotMatch(create, /unarchive|archived|io\.emit/);
});

test('the intake calls it only for a new conversation, under a fresh id', () => {
  const calls = intakeSource.split('getOrCreateConversation(').length - 1;
  assert.equal(calls, 1, 'one call');
  const branch = sliceBetween(intakeSource, '    const convId = shouldCreateConversation ? uuidv4() : conversationId;\n    if (shouldCreateConversation) {', '\n    }\n');
  assert.match(branch, /getOrCreateConversation\(convId, /);
});
