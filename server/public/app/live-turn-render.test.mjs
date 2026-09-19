import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// These modules touch window/document at module scope, so they cannot be
// imported under plain node. The behaviour pinned here is structural — the
// pattern used by attachments-view.repo-refresh.test.mjs.
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

test('renderMessages preserves optimistic pending bubbles the payload does not carry', () => {
  // Regression (2026-09-19 steering): a poll whose response predates a just-sent
  // message rebuilt the transcript without it and dropped the optimistic bubble
  // until the next poll ("vanishes then reappears"). renderMessages must capture
  // pending bubbles absent from the payload and re-append the live nodes.
  const body = functionBody(readSource('./conversation-view.js'), 'renderMessages');
  assert.match(body, /preservedPendingNodes/, 'renderMessages must collect pending bubbles missing from the payload');
  assert.match(body, /pendingUserMessageIds/, 'the pending set drives which bubbles to preserve');
  assert.match(body, /messageById\.has\(pendingId\)/, 'a bubble already in the payload is left to the rebuild');
  assert.match(body, /conversationKey.*!==.*renderConversationKey|renderConversationKey/, 'a pending bubble from another conversation is never dragged in');
  assert.match(body, /for \(const node of preservedPendingNodes\) el\.appendChild\(node\)/, 'preserved nodes are re-appended after the rebuild');
  // The live thinking bubble survives the rebuild too, so a re-render mid-turn
  // never blanks the in-progress thoughts/stream.
  assert.match(body, /thinkingNode = document\.getElementById\('thinking-indicator'\)/, 'the live thinking bubble is captured before the wipe');
  assert.match(body, /thinkingNode\.parentNode === el/, 'only a thinking bubble genuinely in the transcript is preserved');
  assert.match(body, /if \(preservedThinkingNode\) el\.appendChild\(preservedThinkingNode\)/, 'the live thinking bubble is re-appended after the rebuild');
  // The empty-state must not claim the transcript is empty while a pending
  // bubble is still on screen.
  assert.match(body, /!ordered\.length && !preservedPendingNodes\.length/);
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

test('showThinking reuses the live bubble for the same message id', () => {
  const body = functionBody(readSource('./conversation-view.js'), 'showThinking');
  assert.match(body, /getElementById\('thinking-indicator'\)/);
  const reuseIndex = body.indexOf('existing.dataset.messageId');
  const removeIndex = body.indexOf('existing?.remove()');
  assert.notEqual(reuseIndex, -1, 'expected a same-message reuse branch');
  assert.ok(reuseIndex < removeIndex, 'the reuse branch must run before the rebuild');
});

test('restoreInFlightThinking skips identical payloads via the snapshot key', () => {
  const body = functionBody(readSource('./conversation-view.js'), 'restoreInFlightThinking');
  assert.match(body, /buildInFlightSnapshotKey\(inFlight\)/);
  assert.match(body, /lastInFlightSnapshotKey/);
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
