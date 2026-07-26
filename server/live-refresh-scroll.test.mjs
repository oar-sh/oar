import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const bootstrapPath = fileURLToPath(new URL('./public/app/bootstrap.js', import.meta.url));
const conversationViewPath = fileURLToPath(new URL('./public/app/conversation-view.js', import.meta.url));
const journalViewPath = fileURLToPath(new URL('./public/app/journal-view.js', import.meta.url));
const bootstrapSource = fs.readFileSync(bootstrapPath, 'utf8');
const conversationViewSource = fs.readFileSync(conversationViewPath, 'utf8');
const journalViewSource = fs.readFileSync(journalViewPath, 'utf8');

test('live refresh passes the captured bottom state through hydration', () => {
  const calls = bootstrapSource.match(/followLiveUpdates: preserveBottom/g) || [];
  assert.equal(calls.length, 3);
  assert.match(journalViewSource, /followLiveUpdates = !restoreScroll/);
  assert.match(journalViewSource, /restoreInFlightThinking\(response\.inFlight \|\| null, followLiveUpdates\)/);
});

test('in-flight hydration only follows activity when explicitly requested', () => {
  assert.match(conversationViewSource, /export function restoreInFlightThinking\(inFlight, autoScroll = true\)/);
  assert.match(conversationViewSource, /showThinking\(messageId, autoScroll\)/);
  assert.match(conversationViewSource, /updateThinkingStreamStatus\(messageId, streamState\.done \|\| !!inFlight\?\.streamDone, autoScroll\)/);
  assert.doesNotMatch(conversationViewSource, /restoreInFlightThinking[\s\S]*showThinking\(messageId\);/);
});
