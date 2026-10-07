import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (relative) => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('completed message bubbles carry the pin control in the corner row, beside Hide', () => {
  const source = read('./conversation-view.js');

  assert.match(source, /<div class="msg-share-visibility">\s*\$\{buildMessagePinControlsHtml\(msgId, pinned\)\}/);
  assert.match(source, /const pinned = isMessagePinned\(currentConvId, msgId\);/);
  assert.match(source, /class="msg-pin-btn" data-action="toggle-pin"/);
  assert.match(source, /<span class="msg-pinned-label">📍 Pinned<\/span>/);
  assert.match(source, /\$\{pinned \? 'Unpin' : 'Pin'\}<\/button>/);
});

test('the bubble click handler routes the pin control to the pin view', () => {
  const source = read('./conversation-view.js');

  assert.match(source, /closest\('\.bubble-action-btn, \.msg-share-visibility-btn, \.msg-pin-btn, /);
  assert.match(source, /action === 'toggle-pin' && messageId[\s\S]{0,160}toggleMessagePin\(currentConvId, messageId, btn\.dataset\.pinned === 'true'\)/);
});

test('a pin change patches the bubbles instead of rebuilding the transcript, and a jump finds the bubble, not a button in it', () => {
  const source = read('./conversation-view.js');

  assert.doesNotMatch(source, /pinned: item\?\.pinned === true/, 'a pin is not part of the rebuild key');
  assert.match(source, /export function syncRenderedPinState\(pinnedIds\)/);
  assert.match(source, /el\.querySelector\(`\.msg\[data-message-id="\$\{CSS\.escape\(id\)\}"\]`\);\s*\n\s*if \(!target\) return false;\s*\n\s*target\.scrollIntoView/);
});

test('the pin list reaches the page from the conversation payload and from the socket', () => {
  // Before the messages are rendered: their bubbles are drawn from the list.
  assert.match(read('./journal-view.js'), /if \('pins' in response\) setConversationPins\(id, response\.pins, response\.pinsRevision\);\s*\n\s*setPinsConversation\(id\);\s*\n\s*const didRenderMessages = keepTranscript/);
  assert.match(read('./socket-handlers.js'), /socket\.on\('conversation_pins_updated', \(\{ conversationId, pins, revision \}\) => \{\s*\n\s*setConversationPins\(conversationId, pins, revision\);/);
  assert.match(read('./bootstrap.js'), /initPinnedMessagesView\(\{\s*\n\s*openConversation,\s*\n\s*focusMessage: focusConversationMessageById,\s*\n\s*syncRenderedPinState,/);
});

test('Pin is revealed only while its bubble is hovered or focused; a pinned message keeps its controls', () => {
  const source = read('../index.html');

  assert.match(source, /\.msg-pin-btn\[data-pinned="false"\]\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/);
  assert.match(source, /\.msg-bubble:hover \.msg-pin-btn\[data-pinned="false"\],[\s\S]*?\.msg-bubble:focus-within \.msg-pin-btn\[data-pinned="false"\]/);
  assert.doesNotMatch(source, /\.msg-pin-btn\[data-pinned="true"\]\s*\{[^}]*opacity:\s*0/);
});

test('on a touch screen a tap on the bubble holds the reveal, independent of the emulated hover', () => {
  const css = read('../index.html');
  const source = read('./conversation-view.js');

  // The class reveals Pin the same way :hover does, for the plain and the user bubble.
  assert.match(css, /\.msg-bubble:focus-within \.msg-pin-btn\[data-pinned="false"\],\s*\n\s*\.msg-bubble\.msg-actions-revealed \.msg-pin-btn\[data-pinned="false"\] \{\s*\n\s*opacity: 1;\s*\n\s*pointer-events: auto;/);
  assert.match(css, /\.msg\.user \.msg-bubble\.msg-actions-revealed \.msg-pin-btn\[data-pinned="false"\] \{ opacity: 0\.8; \}/);
  // Set by a click inside a bubble on a hover-less pointer, cleared by one outside; never in the shared view.
  assert.match(source, /const REVEALED_BUBBLE_CLASS = 'msg-actions-revealed';/);
  assert.match(source, /if \(revealed !== bubble\) revealed\.classList\.remove\(REVEALED_BUBBLE_CLASS\);/);
  assert.match(source, /if \(!bubble \|\| IS_SHARED_VIEW\) return;\s*\n\s*if \(!window\.matchMedia\?\.\('\(hover: none\)'\)\?\.matches\) return;\s*\n\s*bubble\.classList\.add\(REVEALED_BUBBLE_CLASS\);/);
  assert.match(source, /document\.addEventListener\('click', handleBubbleTapReveal\);/);
});

test('the pin list keeps its title on a phone, where the shared modal gives the header to its buttons', () => {
  const store = read('./store.js');
  assert.match(store, /if \(modalEl\?\.dataset\) modalEl\.dataset\.kind = summaryModalState\.kind;/);
  assert.match(store, /if \(modal\?\.dataset\) delete modal\.dataset\.kind;/);
  assert.match(read('../index.html'), /#summary-modal\[data-kind="pinned-messages"\] \.summary-header-actions \{\s*\n\s*width: auto;/);
});

test('the header button is in the page hidden, before search, and its [hidden] is honoured', () => {
  const source = read('../index.html');

  assert.match(source, /<button id="pinned-messages-btn" class="header-icon-btn has-count" type="button"[^>]* hidden>📍<span class="header-icon-count"><\/span><\/button>\s*\n\s*<button id="message-search-btn"/);
  assert.match(source, /#pinned-messages-btn\[hidden\] \{ display: none; \}/);
});
