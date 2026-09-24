import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Structural pins for wiring outside the transcript (repo-tree refresh paths,
// the live poll's arming and deferral, the sidebar spinner) — the pattern used
// by attachments-view.repo-refresh.test.mjs. The live turn's rendering itself
// (live bubble, pending bubbles, status teardown, stream muting) is pinned by
// behaviour on a real DOM in conversation-view.transcript-dom.test.mjs.
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

test('the end of a turn refreshes the tree through the restoring path', () => {
  const source = readSource('./socket-handlers.js');
  const teardownIndex = source.indexOf('conversationId === currentConvId && isTerminalStatus');
  assert.notEqual(teardownIndex, -1, 'the teardown block must gate on isTerminalStatus');
  const teardownBlock = source.slice(teardownIndex, teardownIndex + 600);
  assert.match(teardownBlock, /refreshRepoBrowserIfWorkspaceOpen\(\)/);
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

test('the sidebar spinner tick updates only the dot spans', () => {
  const body = functionBody(readSource('./journal-view.js'), 'ensureProcessingDotTimer');
  assert.doesNotMatch(body, /renderConvList\(\)/);
  assert.match(body, /conv-processing-dots/);
});
