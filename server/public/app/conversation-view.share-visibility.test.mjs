import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('completed message bubbles expose owner-only hide and unhide controls', () => {
  const filePath = fileURLToPath(new URL('./conversation-view.js', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');

  assert.match(source, /!IS_SHARED_VIEW && !!msgId && !isQueuedUserMessage && !belongsToActiveTurn/);
  assert.match(source, /Hidden from shared viewers/);
  assert.match(source, /data-action="toggle-share-visibility"/);
  assert.match(source, /Hides this message from shared conversations/);
  assert.match(source, /Shows this message in shared conversations/);
  assert.match(source, /hiddenFromShares \? 'Unhide' : 'Hide'/);
  assert.match(source, /updateMessageShareVisibility\(conversationKey, targetMessageId, !hiddenFromShares\)/);
});

test('visible-message Hide control is revealed only while its bubble is hovered or focused', () => {
  const filePath = fileURLToPath(new URL('../index.html', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');

  assert.match(source, /\.msg-share-visibility-btn\[data-hidden-from-shares="false"\]\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/);
  assert.match(source, /\.msg-bubble:hover \.msg-share-visibility-btn\[data-hidden-from-shares="false"\],[\s\S]*?\.msg-bubble:focus-within/);
});
