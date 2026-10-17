import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Structural pins for the rule "the transcript moves by itself only when the
// reader is at the end, or has just sent something": who asks which of the
// two questions. The behaviour is tested in the browser
// (tests/transcript-stays-put.spec.mjs).
function readSource(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

const OWN_SEND = /\b(beginOwnSend|ownSendFollows|scrollAfterOwnSend|isScrollOnSendEnabled)\b/;

function sourceFiles() {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  return fs.readdirSync(dir).filter((name) => /\.(js|mjs)$/.test(name) && !/\.test\.(js|mjs)$/.test(name));
}

test('what the socket puts into a conversation never counts as the reader\'s own send', () => {
  const source = readSource('./socket-handlers.js');
  assert.doesNotMatch(source, OWN_SEND);
  // Every live update asks whether the reader follows the end.
  for (const event of ['user_message', 'assistant_message', 'message_updated', 'relay_activity', 'relay_stream', 'relay_thought', 'message_status']) {
    const start = source.indexOf(`socket.on('${event}'`);
    assert.notEqual(start, -1, `expected a handler for ${event}`);
    const next = source.indexOf('\n  socket.on(', start + 1);
    assert.match(source.slice(start, next === -1 ? source.length : next), /followsTranscriptEnd\(\)/, `${event} asks the follow rule`);
  }
});

test('only the reader\'s own actions ask the own-send rule', () => {
  const asking = sourceFiles().filter((name) => OWN_SEND.test(readSource(`./${name}`))).sort();
  assert.deepEqual(asking, [
    // The answer on a question card.
    'ask-user-view.js',
    // The composer (a steer included) and Resend.
    'conversation-view.js',
    // A board's action.
    'relay-board-view.js',
    'transcript-jump-bottom-view.mjs',
    'transcript-jump-bottom.mjs',
  ]);
});

test('one rule for "at the end": nothing decides it by a margin of its own', () => {
  for (const name of sourceFiles()) {
    const source = readSource(`./${name}`);
    assert.doesNotMatch(source, /isMessagesAtBottom/, `${name}: the exact-pixel test is gone`);
    assert.doesNotMatch(source, /isMessagesNearBottom\(\s*[^)\s]/, `${name}: no caller passes a margin of its own`);
    // A scroll through a window global that nobody sets does nothing, silently.
    assert.doesNotMatch(source, /window\.scrollBottom\b/, `${name} scrolls through the module, not a global`);
  }
});
