import test from 'node:test';
import assert from 'node:assert/strict';

import { consumeConversationDeepLink, readConversationDeepLink } from './conversation-deep-link.mjs';

test('?conv= opens that conversation and stays in the address bar', () => {
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/?conv=conv-123'),
    { conversationId: 'conv-123', cleanedPath: null },
  );
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/oar/?theme=light&conv=conv-a#top'),
    { conversationId: 'conv-a', cleanedPath: null },
  );
});

test('an id that needs encoding is read decoded; the address settles on the + form and stays there', () => {
  // The query is written back form-encoded: %20 becomes +, once.
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/oar/?theme=light&conv=conv%20a#top'),
    { conversationId: 'conv a', cleanedPath: '/oar/?theme=light&conv=conv+a#top' },
  );
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/oar/?theme=light&conv=conv+a#top'),
    { conversationId: 'conv a', cleanedPath: null },
  );
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/?push_conv=conv%2Fb%26c'),
    { conversationId: 'conv/b&c', cleanedPath: '/?conv=conv%2Fb%26c' },
  );
});

test('?push_conv= is consumed and becomes ?conv=, keeping everything else', () => {
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/?push_conv=from-push'),
    { conversationId: 'from-push', cleanedPath: '/?conv=from-push' },
  );
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/oar/?theme=light&push_conv=from-push#top'),
    { conversationId: 'from-push', cleanedPath: '/oar/?theme=light&conv=from-push#top' },
  );
});

test('?push_conv= wins over ?conv=; an empty one gives way to it', () => {
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/?push_conv=from-push&conv=from-link'),
    { conversationId: 'from-push', cleanedPath: '/?conv=from-push' },
  );
  assert.deepEqual(
    readConversationDeepLink('https://relay-b.example.test/?push_conv=&conv=from-link'),
    { conversationId: 'from-link', cleanedPath: '/?conv=from-link' },
  );
});

test('a URL without the parameters is left alone', () => {
  assert.deepEqual(readConversationDeepLink('https://relay-b.example.test/?token=x'), { conversationId: '', cleanedPath: null });
  assert.deepEqual(readConversationDeepLink('not a url'), { conversationId: '', cleanedPath: null });
  // Present but empty: nothing to open, but the leftover is still cleaned up.
  assert.deepEqual(readConversationDeepLink('https://relay-b.example.test/?conv='), { conversationId: '', cleanedPath: '/' });
});

test('consume rewrites the address bar only for a notification link, and keeps the entry\'s state', () => {
  const calls = [];
  const history = { state: { oarApp: true }, replaceState: (...args) => calls.push(args) };
  const id = consumeConversationDeepLink({
    location: { href: 'https://relay-b.example.test/?push_conv=conv-9' },
    history,
    title: 'OAR',
  });
  assert.equal(id, 'conv-9');
  assert.deepEqual(calls, [[{ oarApp: true }, 'OAR', '/?conv=conv-9']]);

  const kept = consumeConversationDeepLink({ location: { href: 'https://relay-b.example.test/?conv=conv-9' }, history, title: 'OAR' });
  assert.equal(kept, 'conv-9');
  assert.equal(calls.length, 1, '?conv= is already the address it should be');

  const none = consumeConversationDeepLink({ location: { href: 'https://relay-b.example.test/' }, history, title: 'OAR' });
  assert.equal(none, '');
  assert.equal(calls.length, 1);
});
