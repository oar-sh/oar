import test from 'node:test';
import assert from 'node:assert/strict';

import { consumeConversationDeepLink, readConversationDeepLink } from './conversation-deep-link.mjs';

test('?conv= opens that conversation and is stripped, keeping everything else', () => {
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/?conv=conv-123'),
    { conversationId: 'conv-123', cleanedPath: '/' },
  );
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/oar/?theme=light&conv=conv%20a#top'),
    { conversationId: 'conv a', cleanedPath: '/oar/?theme=light#top' },
  );
});

test('?push_conv= keeps working and wins over ?conv=; both are stripped', () => {
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/?push_conv=from-push&conv=from-link'),
    { conversationId: 'from-push', cleanedPath: '/' },
  );
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/?push_conv=&conv=from-link'),
    { conversationId: 'from-link', cleanedPath: '/' },
  );
});

test('a URL without the parameters is left alone', () => {
  assert.deepEqual(readConversationDeepLink('https://relay-b.example.test/?token=x'), { conversationId: '', cleanedPath: null });
  assert.deepEqual(readConversationDeepLink('not a url'), { conversationId: '', cleanedPath: null });
  // Present but empty: nothing to open, but the leftover is still cleaned up.
  assert.deepEqual(readConversationDeepLink('https://relay-b.example.test/?conv='), { conversationId: '', cleanedPath: '/' });
});

test('consume rewrites the address bar once', () => {
  const calls = [];
  const history = { replaceState: (...args) => calls.push(args) };
  const id = consumeConversationDeepLink({
    location: { href: 'https://relay-b.example.test/?conv=conv-9' },
    history,
    title: 'OAR',
  });
  assert.equal(id, 'conv-9');
  assert.deepEqual(calls, [[null, 'OAR', '/']]);

  const none = consumeConversationDeepLink({ location: { href: 'https://relay-b.example.test/' }, history, title: 'OAR' });
  assert.equal(none, '');
  assert.equal(calls.length, 1);
});
