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

test('the live poll leaves a window in the middle of the history alone, also when the jump raced it', () => {
  const poll = functionBody(readSource('./bootstrap.js'), 'pollAuthenticatedCurrentConversationLive');
  const bootstrap = readSource('./bootstrap.js');
  assert.match(
    functionBody(bootstrap, 'transcriptIsInHistory'),
    /return !isConversationWindowAtTail\(\) && !hasPendingUserMessageForConversation\(conversationId\);/,
    'a message sent from the history window still gets its poll',
  );
  assert.ok(
    poll.indexOf('if (transcriptIsInHistory(currentId)) return;') >= 0
      && poll.indexOf('if (transcriptIsInHistory(currentId)) return;') < poll.indexOf('await loadConversation('),
    'no request is made for a window that will not be replaced',
  );
  // An answer that was on its way during the jump is dropped.
  assert.match(
    poll,
    /const jumpEpoch = getTranscriptJumpEpoch\(\);\s*\n\s*const response = await loadConversation\(currentId, \{ limit: requestLimit \}\);[\s\S]*?if \(getTranscriptJumpEpoch\(\) !== jumpEpoch\) return;[\s\S]*?applyLoadedConversationState\(/,
  );
  // Only a jump counts, and it counts when its window is put on the page: an
  // ordinary reload must still be able to correct another one.
  const open = functionBody(readSource('./journal-view.js'), 'openConversation');
  assert.match(open, /if \(forceFreshWindow\) noteTranscriptJump\(\);\s*\n\s*applyLoadedConversationState\(id, r, \{ restoreScroll, savedScrollTop \}\);/);
  assert.doesNotMatch(functionBody(readSource('./conversation-view.js'), 'renderMessages'), /transcriptJumpEpoch/);
  assert.match(
    readSource('./conversation-view.js'),
    /export function isConversationWindowAtTail\(\) \{\s*\n\s*return !conversationHistoryState\.hasMoreNewer;/,
  );
});

test('a view refresh after a jump into the history refreshes everything but the transcript', () => {
  const refresh = functionBody(readSource('./bootstrap.js'), 'refreshCurrentView');
  assert.ok(
    refresh.indexOf('const jumpEpoch = getTranscriptJumpEpoch();') >= 0
      && refresh.indexOf('const jumpEpoch = getTranscriptJumpEpoch();') < refresh.indexOf('await refreshConversations()'),
    'the epoch is taken before the first await',
  );
  assert.match(
    refresh,
    /const keepTranscript = getTranscriptJumpEpoch\(\) !== jumpEpoch \|\| transcriptIsInHistory\(currentId\);/,
  );
  assert.match(refresh, /followLiveUpdates: preserveBottom && !keepTranscript,\s*\n\s*keepTranscript,/);
  assert.match(refresh, /if \(messagesEl && !keepTranscript && /, 'the saved scroll position is not put back over the jump');
  const apply = functionBody(readSource('./journal-view.js'), 'applyLoadedConversationState');
  assert.match(apply, /const didRenderMessages = keepTranscript\s*\n\s*\? false\s*\n\s*: renderMessages\(response\.messages, !restoreScroll, response\);/);
  assert.match(apply, /setConversationBackgroundTasks\(id, response\.backgroundTasks \|\| \[\]\);/, 'the rest still applies');
});

test('the sidebar spinner tick updates only the dot spans', () => {
  const body = functionBody(readSource('./journal-view.js'), 'ensureProcessingDotTimer');
  assert.doesNotMatch(body, /renderConvList\(\)/);
  assert.match(body, /conv-processing-dots/);
});
