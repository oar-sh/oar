import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Structural pins for wiring outside the transcript (repo-tree refresh paths,
// the live poll's arming and deferral, the sidebar's working mark) — the pattern used
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
      && poll.indexOf('if (transcriptIsInHistory(currentId)) return;') < poll.indexOf('loadConversation(currentId, { limit: requestLimit })'),
    'no request is made for a window that will not be replaced',
  );
  // An answer that was on its way during the jump is dropped.
  assert.match(
    poll,
    /const jumpEpoch = getTranscriptJumpEpoch\(\);\s*\n\s*const \{ response, stale \} = await loadKeepingLiveRows\(\s*\n\s*\(\) => loadConversation\(currentId, \{ limit: requestLimit \}\),\s*\n\s*getTranscriptLiveRowEpoch,\s*\n\s*\);[\s\S]*?if \(getTranscriptJumpEpoch\(\) !== jumpEpoch\) return;[\s\S]*?if \(stale\) return;[\s\S]*?applyLoadedConversationState\(/,
  );
  // Only a jump counts, and it counts when its window is put on the page: an
  // ordinary reload must still be able to correct another one.
  const open = functionBody(readSource('./journal-view.js'), 'openConversation');
  // A window centred on the place read after a reload is one such jump.
  assert.match(open, /if \(forceFreshWindow \|\| anchorFound\) noteTranscriptJump\(\);\s*\n\s*applyLoadedConversationState\(id, r, \{/);
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
    /const keepTranscript = getTranscriptJumpEpoch\(\) !== jumpEpoch \|\| transcriptIsInHistory\(currentId\) \|\| stale;/,
  );
  assert.match(refresh, /followLiveUpdates: preserveBottom && !keepTranscript,\s*\n\s*keepTranscript,/);
  assert.match(refresh, /if \(messagesEl && !keepTranscript && /, 'the saved scroll position is not put back over the jump');
  const apply = functionBody(readSource('./journal-view.js'), 'applyLoadedConversationState');
  assert.match(apply, /let didRenderMessages = false;\s*\n\s*if \(!keepTranscript\) \{\s*\n\s*didRenderMessages = mergeFrom\s*\n\s*\? mergeMessagesIntoTranscript\(mergeFrom, response\.messages, response\)\s*\n\s*: renderMessages\(response\.messages, !restoreScroll, response\);/);
  assert.match(apply, /setConversationBackgroundTasks\(id, response\.backgroundTasks \|\| \[\]\);/, 'the rest still applies');
});

test('the sidebar shows work by title colour: no dot spans and no timer for them', () => {
  const source = readSource('./journal-view.js');
  assert.doesNotMatch(source, /conv-processing-dots|ensureProcessingDotTimer/);
  assert.match(functionBody(source, 'paintConvList'), /view\.working \? ' conv-working' : ''/);
});

test('every row the socket puts on the page moves the live-row count the reloads check', () => {
  const handlers = readSource('./socket-handlers.js');
  for (const event of ['user_message', 'assistant_message', 'message_updated']) {
    const start = handlers.indexOf(`socket.on('${event}'`);
    assert.ok(start >= 0, event);
    const body = handlers.slice(start, handlers.indexOf('\n  });', start));
    assert.match(body, /appendMessage\([^;]*\);[\s\S]*?noteTranscriptLiveRow\(\);/, `${event} counts its row`);
  }
  const bootstrap = readSource('./bootstrap.js');
  for (const name of ['pollAuthenticatedCurrentConversationLive', 'refreshCurrentView', 'refreshSharedConversation']) {
    assert.match(functionBody(bootstrap, name), /await loadKeepingLiveRows\(/, `${name} reloads through the guard`);
  }
});

test('the live poll and a view refresh merge a capped answer into a larger loaded window', () => {
  const bootstrap = readSource('./bootstrap.js');
  const merge = functionBody(bootstrap, 'reloadMergeFor');
  assert.match(merge, /mergeReloadIntoWindow\(conversationPayloadCache\.peekWindow\(conversationId\), response, \{ windowPredatesPage: true \}\)/);
  assert.match(merge, /canMergeIntoTranscript\(merge\.mergeFrom, conversationId\)/, 'the full render where a merge cannot be placed');
  const poll = functionBody(bootstrap, 'pollAuthenticatedCurrentConversationLive');
  assert.match(poll, /const merge = reloadMergeFor\(currentId, response\);\s*\n\s*applyLoadedConversationState\(currentId, merge\?\.payload \|\| response, \{[\s\S]*?mergeFrom: merge\?\.mergeFrom \|\| null,/);
  const refresh = functionBody(bootstrap, 'refreshCurrentView');
  assert.match(refresh, /const merge = keepTranscript \? null : reloadMergeFor\(currentId, r\);\s*\n\s*applyLoadedConversationState\(currentId, merge\?\.payload \|\| r, \{[\s\S]*?mergeFrom: merge\?\.mergeFrom \|\| null,/);
  for (const body of [poll, refresh]) {
    assert.match(body, /if \(merge && preserveBottom && messagesEl\) messagesEl\.scrollTop = messagesEl\.scrollHeight;/, 'a merge does not scroll by itself');
  }
});

test('an in-place rewrite updates the kept window on screen and drops the others', () => {
  const handlers = readSource('./socket-handlers.js');
  const start = handlers.indexOf("socket.on('message_updated'");
  const body = handlers.slice(start, handlers.indexOf('\n  });', start));
  assert.match(body, /if \(!messageId \|\| conversationId !== currentConvId \|\| !message\) \{\s*\n\s*conversationPayloadCache\.forget\(conversationId\);\s*\n\s*return;\s*\n\s*\}/);
  assert.match(body, /noteTranscriptLiveRow\(\);\s*\n\s*keepLiveRow\(conversationId, message, messageId\);/);
  assert.equal(body.match(/conversationPayloadCache\.forget\(/g)?.length, 1, 'not forgotten for the conversation on screen');
});
