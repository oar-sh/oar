import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  normalizeShareToken,
  buildConversationShareToken,
  normalizeSharedViewerId,
  filterMessagesVisibleToSharedView,
  buildConversationMessages,
  selectConversationHistoryPage,
} from './sessions-routes.mjs';

test('normalizeShareToken accepts valid hex tokens', () => {
  const value = normalizeShareToken('A'.repeat(32));
  assert.equal(value, 'a'.repeat(32));
});

test('normalizeShareToken rejects invalid or short tokens', () => {
  assert.equal(normalizeShareToken(''), '');
  assert.equal(normalizeShareToken('abc123'), '');
  assert.equal(normalizeShareToken('g'.repeat(64)), '');
  assert.equal(normalizeShareToken('a'.repeat(129)), '');
});

test('normalizeShareToken accepts upper-bound token length', () => {
  assert.equal(normalizeShareToken('b'.repeat(128)), 'b'.repeat(128));
});

test('buildConversationShareToken returns long lowercase hex token', () => {
  const token = buildConversationShareToken();
  assert.match(token, /^[a-f0-9]{64}$/);
});

test('normalizeSharedViewerId sanitizes unsafe characters', () => {
  const sanitized = normalizeSharedViewerId(' viewer:abc<>/\\$%__\n ');
  assert.equal(sanitized, 'viewer:abc__');
  assert.equal(normalizeSharedViewerId(''), '');
});

test('normalizeSharedViewerId limits identifier length', () => {
  assert.equal(normalizeSharedViewerId('x'.repeat(256)).length, 128);
});

test('shared message filtering excludes hidden rows without changing owner rows', () => {
  const rows = [
    { id: 'visible', hidden_from_shares: 0 },
    { id: 'hidden', hidden_from_shares: 1 },
  ];
  assert.deepEqual(filterMessagesVisibleToSharedView(rows).map((row) => row.id), ['visible']);
  assert.equal(rows.length, 2);
});

test('owner message payload retains shared visibility metadata', () => {
  const messages = buildConversationMessages({
    dbMessages: [{
      id: 'hidden',
      role: 'user',
      text: 'private',
      hidden_from_shares: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
    }],
  });
  assert.equal(messages[0]?.hiddenFromShares, true);
});

test('shared lazy-load pagination never surfaces hidden messages on any page', () => {
  const rows = [];
  for (let index = 0; index < 8; index += 1) {
    rows.push({
      id: `m${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `message ${index}`,
      hidden_from_shares: index === 2 || index === 5 ? 1 : 0,
      timestamp: `2026-01-01T00:0${index}:00.000Z`,
    });
  }
  const sharedMessages = filterMessagesVisibleToSharedView(rows);

  // Newest page first, then paginate older with the returned cursor, exactly
  // like the shared-view infinite loader does against /api/shared/:token.
  const seenIds = [];
  let cursor = {};
  for (let guard = 0; guard < 10; guard += 1) {
    const page = selectConversationHistoryPage(sharedMessages, { limit: 2, ...cursor });
    seenIds.push(...page.messages.map((message) => message.id));
    if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
    cursor = {
      beforeMessageId: page.pageInfo.nextCursor.beforeMessageId,
      beforeTimestamp: page.pageInfo.nextCursor.beforeTimestamp,
    };
  }

  assert.deepEqual(seenIds.slice().sort(), ['m0', 'm1', 'm3', 'm4', 'm6', 'm7']);
  assert.ok(!seenIds.includes('m2'));
  assert.ok(!seenIds.includes('m5'));
});

test('shared conversation view paginates through the shared token endpoint, not the owner API', () => {
  const filePath = fileURLToPath(new URL('../public/app/conversation-view.js', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');
  assert.match(source, /async function loadConversationHistoryPage\(conversationId, options = \{\}\) \{\s*\n\s*if \(!IS_SHARED_VIEW\) \{\s*\n\s*return loadConversationApi\(conversationId, options\);/);
  assert.match(source, /loadSharedConversation\(SHARED_CONVERSATION_TOKEN, options\)/);
  const loaderCalls = source.match(/await loadConversationHistoryPage\(conversationId, \{/g) || [];
  assert.equal(loaderCalls.length, 2, 'both history loaders must route through loadConversationHistoryPage');
});

test('authenticated message share visibility route is registered', () => {
  const filePath = fileURLToPath(new URL('./sessions-routes.mjs', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');
  assert.match(source, /app\.patch\('\/api\/conversation\/:id\/message\/:messageId\/share-visibility', auth/);
  assert.match(source, /typeof req\.body\?\.hiddenFromShares !== 'boolean'/);
  assert.match(source, /stmts\.getMessageByConversation\?\.get\(messageId, conversationId\)/);
  assert.match(source, /getActiveQueueForMessage\.get\(conversationId, messageId, messageId\)/);
  assert.match(source, /stmts\.setMessageShareVisibility\.run\(/);
});

test('shared upload route is registered at top level (not nested inside presence route)', () => {
  const filePath = fileURLToPath(new URL('./sessions-routes.mjs', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');
  const presenceStart = source.indexOf("app.post('/api/shared/:token/presence'");
  const uploadStart = source.indexOf("app.get('/api/shared/:token/upload/:sha256/content'");
  assert.ok(presenceStart >= 0, 'presence route must exist');
  assert.ok(uploadStart >= 0, 'shared upload route must exist');
  const presenceEnd = source.indexOf('\n  });', presenceStart);
  assert.ok(presenceEnd > presenceStart, 'presence route terminator must exist');
  assert.ok(uploadStart > presenceEnd, 'shared upload route must be declared after presence route closes');
});

test('shared presence route applies rate limit responses', () => {
  const filePath = fileURLToPath(new URL('./sessions-routes.mjs', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');
  assert.match(source, /const SHARED_PRESENCE_RATE_WINDOW_MS = 10_000;/);
  assert.match(source, /const SHARED_PRESENCE_RATE_LIMIT = 24;/);
  assert.match(source, /res\.setHeader\('Retry-After', String\(rateLimit\.retryAfterSeconds \|\| 1\)\);/);
  assert.match(source, /return res\.status\(429\)\.json\(\{/);
});

test('shared access status event is created only after a successful shared payload is built', () => {
  const filePath = fileURLToPath(new URL('./sessions-routes.mjs', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');
  const sharedRouteStart = source.indexOf("app.get('/api/shared/:token'");
  const sharedRouteEnd = source.indexOf("\n  });", sharedRouteStart);
  const sharedRoute = source.slice(sharedRouteStart, sharedRouteEnd);
  assert.ok(sharedRouteStart >= 0, 'shared read route must exist');
  assert.match(sharedRoute, /if \(!payload\) return res\.status\(404\)\.json\(\{ error: 'Shared conversation not found' \}\);[\s\S]*statusEventService\.recordSharedAccess/);
  assert.match(sharedRoute, /io\.emit\('shared_access', sharedAccess\.event\)/);
});

test('shared upload route handles stream errors explicitly', () => {
  const filePath = fileURLToPath(new URL('./sessions-routes.mjs', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');
  assert.match(source, /const stream = fs\.createReadStream\(filePath\);/);
  assert.match(source, /stream\.on\('error', \(\) => \{/);
  assert.match(source, /res\.status\(500\)\.json\(\{ error: 'Failed to stream shared attachment' \}\);/);
});
