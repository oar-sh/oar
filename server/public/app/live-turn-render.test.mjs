import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// These modules touch window/document at module scope, so they cannot be
// imported under plain node. The behaviour pinned here is structural — the
// pattern used by attachments-view.repo-refresh.test.mjs. The live bubble and
// pending-bubble rebuild behaviour is pinned on a real DOM in
// conversation-view.transcript-dom.test.mjs.
function readSource(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function functionBody(source, name) {
  const start = [`export function ${name}(`, `export async function ${name}(`, `async function ${name}(`, `function ${name}(`]
    .map((signature) => source.indexOf(signature))
    .find((index) => index !== -1 && index !== undefined) ?? -1;
  assert.notEqual(start, -1, `expected to find function ${name}`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('the live poll no longer reloads the repo tree from applyLoadedConversationState', () => {
  const body = functionBody(readSource('./journal-view.js'), 'applyLoadedConversationState');
  assert.doesNotMatch(body, /loadRepoBrowserTree\(\)/);
});

test('only terminal statuses tear down the live bubble and refresh the view', () => {
  const source = readSource('./socket-handlers.js');
  assert.match(source, /isTerminalStatus = \['done', 'failed', 'dropped', 'cancelled'\]/);
  const teardownIndex = source.indexOf('conversationId === currentConvId && isTerminalStatus');
  assert.notEqual(teardownIndex, -1, 'the teardown block must gate on isTerminalStatus');
  const teardownBlock = source.slice(teardownIndex, teardownIndex + 600);
  assert.match(teardownBlock, /refreshCurrentView\(\)/);
  assert.match(teardownBlock, /refreshRepoBrowserIfWorkspaceOpen\(\)/, 'end of turn refreshes the tree through the restoring path');
});

test('mid-turn tree refreshes route through the restoring path, never the bare reload', () => {
  const bootstrap = readSource('./bootstrap.js');
  const rootUpdate = functionBody(bootstrap, 'applyConversationWorkspaceRootUpdate');
  assert.doesNotMatch(rootUpdate, /void loadRepoBrowserTree\(\)/);
  assert.match(rootUpdate, /refreshRepoBrowser\(\)/);
  assert.match(functionBody(readSource('./attachments-view.js'), 'refreshRepoBrowserIfWorkspaceOpen'), /refreshRepoBrowser\(\)/);
});

test('child loads survive a tree swap by re-resolving the node by path', () => {
  const body = functionBody(readSource('./attachments-view.js'), 'ensureRepoChildrenLoaded');
  assert.match(body, /treeAtRequest = repoBrowserState\.tree/);
  assert.match(body, /repoBrowserState\.tree === treeAtRequest/);
  assert.match(body, /repoBrowserState\.nodeMap\.get\(nodePath\) \|\| null/);
});

test('a background conversation finishing its turn cannot wipe the viewed live bubble', () => {
  const source = readSource('./socket-handlers.js');
  const handlerIndex = source.indexOf("socket.on('assistant_message'");
  assert.notEqual(handlerIndex, -1, 'expected the assistant_message handler');
  const handler = source.slice(handlerIndex, handlerIndex + 700);
  assert.match(
    handler,
    /if \(isCurrentConversation\) \{\s*collapseThinkingThoughts\(\);\s*removeThinking\(\);\s*\}/,
    'the live-bubble teardown must be gated on the viewed conversation',
  );
});

test('message_status blacklists live streaming only on terminal statuses', () => {
  const source = readSource('./socket-handlers.js');
  assert.match(source, /if \(messageId && isTerminalStatus\) clearRelayStreamStateForMessage\(messageId\);/);
  assert.match(
    source,
    /else if \(messageId\) clearRelayStreamState\(messageId\);/,
    "the enqueue-time 'pending' ack may reset stream bookkeeping but never mark the message complete",
  );
});

test('the live poll stays armed while a locally-sent message is still queued', () => {
  const poll = functionBody(readSource('./bootstrap.js'), 'pollAuthenticatedCurrentConversationLive');
  assert.match(poll, /hasPendingUserMessageForConversation\(currentId\)/);
});

test('the live poll defers while the user selects or drags in the chat', () => {
  const bootstrap = readSource('./bootstrap.js');
  const poll = functionBody(bootstrap, 'pollAuthenticatedCurrentConversationLive');
  assert.match(poll, /isChatInteractionHeld\(\)/);
  assert.match(bootstrap, /chatSelectionGuard\.onRelease\(/);
  assert.match(bootstrap, /flushDeferredMessageRender\(\)/);
});

test('auto-scroll yields to an active selection or drag', () => {
  const body = functionBody(readSource('./store.js'), 'scrollBottom');
  assert.match(body, /isChatInteractionHeld\(\)/);
});

test('the sidebar spinner tick updates only the dot spans', () => {
  const body = functionBody(readSource('./journal-view.js'), 'ensureProcessingDotTimer');
  assert.doesNotMatch(body, /renderConvList\(\)/);
  assert.match(body, /conv-processing-dots/);
});
