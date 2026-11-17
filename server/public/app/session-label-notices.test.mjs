import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { providerDisplayName, providerSessionLabel } from './conversation-provider-indicator.mjs';

// The chat title's copy toast and the context modal's subtitle name the chat's
// own provider; both said "Copilot" for every chat. bootstrap.js touches
// window/document at module scope, so both are exercised through its source.
const source = fs.readFileSync(fileURLToPath(new URL('./bootstrap.js', import.meta.url)), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `expected bootstrap.js to contain ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected bootstrap.js to contain ${endMarker}`);
  return source.slice(start, end);
}

// Clicks the chat title the way initChatTitleCopy wires it, with the dataset
// updateSessionPill leaves, and returns the toast it shows.
async function copyToastFor(dataset) {
  let onClick = null;
  const title = {
    dataset: { ...dataset },
    addEventListener(type, handler) { if (type === 'click') onClick = handler; },
  };
  const notices = [];
  const init = new Function(
    'document', 'copyTextToClipboard', 'showTransientRelayNotice', 'providerDisplayName',
    `${sliceBetween('function initChatTitleCopy() {', '\nfunction getChatTitleElements(')}\nreturn initChatTitleCopy;`,
  )(
    { getElementById: (id) => (id === 'chat-title' ? title : null) },
    async () => true,
    (text) => notices.push(text),
    providerDisplayName,
  );
  init();
  onClick({ preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  return notices;
}

test('the copy toast names the chat\'s provider', async () => {
  assert.deepEqual(
    await copyToastFor({ sdkSessionId: 'abcdef1234567890', sdkSessionProvider: 'claude' }),
    ['Copied Claude session ID: abcdef12…'],
  );
  assert.deepEqual(
    await copyToastFor({ sdkSessionId: 'abcdef1234567890', sdkSessionProvider: 'github' }),
    ['Copied Copilot session ID: abcdef12…'],
  );
});

test('the copy toast of a chat whose provider is unknown names none', async () => {
  assert.deepEqual(
    await copyToastFor({ sdkSessionId: 'abcdef1234567890', sdkSessionProvider: '' }),
    ['Copied session ID: abcdef12…'],
  );
  assert.deepEqual(await copyToastFor({ sdkSessionId: 'abcdef1234567890' }), ['Copied session ID: abcdef12…']);
});

test('the context subtitle names the session\'s provider, and an unknown one none', () => {
  const subtitle = new Function(
    'providerSessionLabel',
    `${sliceBetween('function contextSummarySubtitle(', '\nasync function loadContextSummaryAndRender(')}\nreturn contextSummarySubtitle;`,
  )(providerSessionLabel);
  assert.equal(subtitle('claude', 'abcdef1234567890', 'conv-1'), 'Claude session abcdef12');
  assert.equal(subtitle('claude-cloud', 'abcdef1234567890', 'conv-1'), 'Claude Cloud session abcdef12');
  assert.equal(subtitle('github', 'abcdef1234567890', 'conv-1'), 'Copilot session abcdef12');
  assert.equal(subtitle('', 'abcdef1234567890', 'conv-1'), 'Session abcdef12');
  assert.equal(subtitle('claude', '', 'conversation-1234'), 'Conversation conversa');
  assert.equal(subtitle('claude', '', ''), 'No conversation selected');
});
