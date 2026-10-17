import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./public/app/bootstrap.js', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');

test('shared conversation polling has in-flight and sequence guards', () => {
  assert.match(source, /let sharedConversationPollInFlight = false;/);
  assert.match(source, /let sharedConversationRequestSeq = 0;/);
  assert.match(source, /let sharedConversationAppliedSeq = 0;/);
  assert.match(source, /if \(sharedConversationPollInFlight \|\| sharedConversationEnded\) return;/);
  assert.match(source, /const requestSeq = \+\+sharedConversationRequestSeq;/);
  assert.match(source, /if \(requestSeq < sharedConversationAppliedSeq\) return;/);
  assert.match(source, /sharedConversationAppliedSeq = requestSeq;/);
  assert.match(source, /sharedConversationPollInFlight = false;/);
});

test('a stopped or renewed share ends the shared reader instead of polling on', () => {
  // 404 is what a revoked or renewed token answers: the timers stop and the
  // transcript is cleared, once; the first load is the one logged as an open.
  assert.match(source, /if \(response\?\.status === 404\) \{\s*endSharedConversationReader\(\);\s*return;/);
  assert.match(source, /function endSharedConversationReader\(\) \{\s*if \(sharedConversationEnded\) return;\s*sharedConversationEnded = true;\s*stopSharedModeTimers\(\);/);
  assert.match(source, /await refreshSharedConversation\(\{ open: true \}\);[\s\S]*?if \(sharedConversationEnded\) return;\s*sharedConversationPollTimer = setInterval/);
});
