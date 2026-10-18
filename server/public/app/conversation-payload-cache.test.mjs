import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERSATION_PAYLOAD_CACHE_LIMIT,
  cacheablePayload,
  createConversationPayloadCache,
  mergeReloadIntoWindow,
  payloadHasMoreNewer,
  payloadHasMoreOlder,
  windowPageInfo,
} from './conversation-payload-cache.mjs';

function payload(id, overrides = {}) {
  return {
    id,
    title: `Chat ${id}`,
    messages: [
      { id: `${id}-m1`, role: 'user', text: 'Hello there' },
      { id: `${id}-m2`, role: 'assistant', text: 'Hi' },
    ],
    pageInfo: { hasMoreOlder: false, hasMoreNewer: false },
    ...overrides,
  };
}

test('a kept payload reads back as an equal copy, not the same object', () => {
  const cache = createConversationPayloadCache();
  const original = payload('conv-a');
  assert.equal(cache.remember('conv-a', original), true);
  const first = cache.read('conv-a');
  assert.deepEqual(first.messages, original.messages);
  assert.equal(first.title, original.title);
  assert.notEqual(first, original);
  assert.notEqual(first.messages, original.messages);
  // Changing what was read leaves the kept payload alone.
  first.messages.push({ id: 'extra' });
  first.messages[0].text = 'changed by the reader';
  const second = cache.read('conv-a');
  assert.equal(second.messages.length, 2);
  assert.equal(second.messages[0].text, 'Hello there');
  assert.notEqual(second, first);
});

test('remember keeps a reference and makes no copy; the copy is made on read', () => {
  const cache = createConversationPayloadCache();
  const original = payload('conv-a', { inFlight: { thoughts: [{ text: 'step' }] } });
  let clones = 0;
  const realClone = globalThis.structuredClone;
  globalThis.structuredClone = (value) => {
    clones += 1;
    return realClone(value);
  };
  try {
    for (let poll = 0; poll < 5; poll += 1) cache.remember('conv-a', original);
    assert.equal(clones, 0);
    const read = cache.read('conv-a');
    assert.equal(clones, 1);
    assert.equal('inFlight' in read, false);
  } finally {
    globalThis.structuredClone = realClone;
  }
  // The stored payload itself keeps its live fields; only the copy drops them.
  assert.ok(original.inFlight);
});

test('the live fields of a payload are not kept', () => {
  const cache = createConversationPayloadCache();
  cache.remember('conv-a', payload('conv-a', {
    inFlight: { messageId: 'conv-a-m1', text: 'working' },
    activeTurn: true,
    sessionState: 'running',
    backgroundTasks: [{ id: 'task-1' }],
    usageLimitPause: { until: '2030-01-01T00:00:00.000Z' },
    draftText: 'half a sentence',
    draftAttachments: [{ name: 'notes.txt' }],
    draftUpdatedAt: '2030-01-01T00:00:00.000Z',
    draftUpdatedByClientId: 'client-x',
    previews: [{ id: 'preview-1' }],
    pins: [{ messageId: 'conv-a-m2' }],
    pinsRevision: 3,
  }));
  const read = cache.read('conv-a');
  for (const field of ['inFlight', 'activeTurn', 'sessionState', 'backgroundTasks', 'usageLimitPause',
    'draftText', 'draftAttachments', 'draftUpdatedAt', 'draftUpdatedByClientId', 'previews']) {
    assert.equal(field in read, false, `${field} should be dropped`);
  }
  // Revision-guarded lists stay: an older revision cannot overwrite a newer one.
  assert.deepEqual(read.pins, [{ messageId: 'conv-a-m2' }]);
  assert.equal(read.pinsRevision, 3);
  assert.equal(read.title, 'Chat conv-a');
});

test('a window in the middle of the history is kept with its edges', () => {
  const cache = createConversationPayloadCache();
  assert.equal(cache.remember('conv-a', payload('conv-a', { pageInfo: { hasMoreOlder: true, hasMoreNewer: true } })), true);
  const read = cache.read('conv-a');
  assert.equal(read.hasMoreOlder, true);
  assert.equal(read.hasMoreNewer, true);
  assert.equal(read.pageInfo.hasMoreNewer, true);
  assert.deepEqual(read.pageInfo.olderCursor, { beforeMessageId: 'conv-a-m1', beforeTimestamp: null });
  assert.deepEqual(read.pageInfo.newerCursor, { afterMessageId: 'conv-a-m2', afterTimestamp: null });
});

test('a payload without messages is not kept', () => {
  const cache = createConversationPayloadCache();
  assert.equal(cache.remember('conv-a', null), false);
  assert.equal(cache.remember('conv-a', { id: 'conv-a' }), false);
  assert.equal(cache.remember('', payload('conv-a')), false);
  assert.equal(cache.size, 0);
  assert.equal(cacheablePayload({ messages: 'nope' }), null);
});

test('ids are trimmed', () => {
  const cache = createConversationPayloadCache();
  cache.remember(' conv-a ', payload('conv-a'));
  assert.equal(cache.has('conv-a'), true);
  assert.ok(cache.read('conv-a  '));
  assert.equal(cache.forget(' conv-a'), true);
  assert.equal(cache.has('conv-a'), false);
  assert.equal(cache.read(''), null);
});

test('the least recently used conversation goes first once the limit is reached', () => {
  const cache = createConversationPayloadCache({ limit: 3 });
  cache.remember('conv-a', payload('conv-a'));
  cache.remember('conv-b', payload('conv-b'));
  cache.remember('conv-c', payload('conv-c'));
  // Reading conv-a makes it the most recent: conv-b is the oldest now.
  cache.read('conv-a');
  cache.remember('conv-d', payload('conv-d'));
  assert.deepEqual(cache.keys(), ['conv-c', 'conv-a', 'conv-d']);
  // Storing again counts as use too.
  cache.remember('conv-c', payload('conv-c'));
  cache.remember('conv-e', payload('conv-e'));
  assert.deepEqual(cache.keys(), ['conv-d', 'conv-c', 'conv-e']);
  assert.equal(cache.size, 3);
});

test('the default limit is eight conversations', () => {
  assert.equal(CONVERSATION_PAYLOAD_CACHE_LIMIT, 8);
  const cache = createConversationPayloadCache();
  for (let index = 0; index < 12; index += 1) cache.remember(`conv-${index}`, payload(`conv-${index}`));
  assert.equal(cache.size, 8);
  assert.equal(cache.has('conv-3'), false);
  assert.equal(cache.has('conv-4'), true);
  assert.equal(cache.has('conv-11'), true);
});

test('forget and clear drop entries', () => {
  const cache = createConversationPayloadCache();
  cache.remember('conv-a', payload('conv-a'));
  cache.remember('conv-b', payload('conv-b'));
  assert.equal(cache.forget('conv-a'), true);
  assert.equal(cache.forget('conv-a'), false);
  assert.deepEqual(cache.keys(), ['conv-b']);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('payloadHasMoreNewer reads the flag where the transcript does', () => {
  assert.equal(payloadHasMoreNewer(null), false);
  assert.equal(payloadHasMoreNewer({}), false);
  assert.equal(payloadHasMoreNewer({ pageInfo: { hasMoreNewer: true } }), true);
  // A top-level boolean wins over pageInfo, as in renderMessages.
  assert.equal(payloadHasMoreNewer({ hasMoreNewer: false, pageInfo: { hasMoreNewer: true } }), false);
  assert.equal(payloadHasMoreNewer({ hasMoreNewer: true }), true);
});

function rows(prefix, from, to) {
  const list = [];
  for (let index = from; index <= to; index += 1) {
    list.push({
      id: `${prefix}-${String(index).padStart(3, '0')}`,
      role: index % 2 ? 'user' : 'assistant',
      text: `row ${index}`,
      timestamp: new Date(Date.UTC(2030, 0, 1, 0, 0, index)).toISOString(),
    });
  }
  return list;
}

test('payloadHasMoreOlder reads the flag where the transcript does', () => {
  assert.equal(payloadHasMoreOlder(null), false);
  assert.equal(payloadHasMoreOlder({ pageInfo: { hasMore: true } }), true);
  assert.equal(payloadHasMoreOlder({ pageInfo: { hasMoreOlder: true } }), true);
  assert.equal(payloadHasMoreOlder({ hasMoreHistory: false, pageInfo: { hasMoreOlder: true } }), false);
  assert.equal(payloadHasMoreOlder({ hasMoreOlder: true }), true);
});

test('older and newer pages join the window; the payload stays as it came', () => {
  const cache = createConversationPayloadCache();
  const original = { id: 'conv-a', messages: rows('m', 41, 60), pageInfo: { hasMoreOlder: true, hasMoreNewer: false } };
  cache.remember('conv-a', original);
  assert.equal(cache.addOlder('conv-a', rows('m', 21, 41), { hasMoreOlder: true }), true);
  assert.equal(cache.addOlder('conv-a', rows('m', 1, 20), { hasMoreOlder: false }), true);
  const read = cache.read('conv-a');
  assert.equal(read.messages.length, 60);
  assert.equal(read.messages[0].id, 'm-001');
  assert.equal(read.messages[59].id, 'm-060');
  assert.equal(read.hasMoreOlder, false);
  assert.equal(read.pageInfo.olderCursor.beforeMessageId, 'm-001');
  assert.equal(original.messages.length, 20);
  assert.equal(cache.addNewer('conv-b', rows('m', 61, 62)), false);
});

test('a live row replaces its message or joins the end of a window at the end', () => {
  const cache = createConversationPayloadCache();
  cache.remember('conv-a', { id: 'conv-a', messages: rows('m', 1, 3), pageInfo: {} });
  assert.equal(cache.upsertMessage('conv-a', { ...rows('m', 3, 3)[0], text: 'finished reply' }), true);
  assert.equal(cache.upsertMessage('conv-a', rows('m', 4, 4)[0]), true);
  const read = cache.read('conv-a');
  assert.deepEqual(read.messages.map((m) => m.text), ['row 1', 'row 2', 'finished reply', 'row 4']);

  cache.remember('conv-b', { id: 'conv-b', messages: rows('m', 1, 3), pageInfo: { hasMoreNewer: true } });
  assert.equal(cache.upsertMessage('conv-b', rows('m', 9, 9)[0]), false);
  assert.equal(cache.read('conv-b').messages.length, 3);
  assert.equal(cache.upsertMessage('conv-c', rows('m', 1, 1)[0]), false);
});

test('a window that lost the end says so', () => {
  const cache = createConversationPayloadCache();
  cache.remember('conv-a', { id: 'conv-a', messages: rows('m', 1, 3), pageInfo: {} });
  assert.equal(cache.detachFromTail('conv-a'), true);
  assert.equal(cache.read('conv-a').hasMoreNewer, true);
});

test('trimming keeps the newest at the end, else the rows around the place read', () => {
  const cache = createConversationPayloadCache();
  cache.remember('conv-a', { id: 'conv-a', messages: rows('m', 1, 120), pageInfo: { hasMoreOlder: true } });
  assert.equal(cache.trim('conv-a', { cap: 200, anchorMessageId: 'm-011' }), false);
  assert.equal(cache.trim('conv-a', { cap: 100, anchorMessageId: 'm-011' }), true);
  let read = cache.read('conv-a');
  assert.equal(read.messages.length, 100);
  assert.equal(read.messages[0].id, 'm-001');
  assert.equal(read.messages[99].id, 'm-100');
  assert.equal(read.hasMoreOlder, true);
  assert.equal(read.hasMoreNewer, true);

  cache.remember('conv-b', { id: 'conv-b', messages: rows('m', 1, 120), pageInfo: {} });
  cache.trim('conv-b', { cap: 100, atTail: true, anchorMessageId: 'm-011' });
  read = cache.read('conv-b');
  assert.equal(read.messages[0].id, 'm-021');
  assert.equal(read.hasMoreOlder, true);
  assert.equal(read.hasMoreNewer, false);
});

test('trimAll cuts every kept window but the one named', () => {
  const cache = createConversationPayloadCache();
  cache.remember('conv-a', { id: 'conv-a', messages: rows('a', 1, 150), pageInfo: {} });
  cache.remember('conv-b', { id: 'conv-b', messages: rows('b', 1, 150), pageInfo: {} });
  const anchors = { 'conv-a': { messageId: 'a-075', atTail: false } };
  assert.equal(cache.trimAll(100, (id) => anchors[id], { except: 'conv-b' }), 1);
  assert.equal(cache.windowSize('conv-a'), 100);
  assert.equal(cache.windowSize('conv-b'), 150);
  const read = cache.read('conv-a');
  assert.equal(read.messages[0].id, 'a-025');
  assert.equal(cache.trimAll(Infinity), 0);
});

test('windowPageInfo has the relay page shape', () => {
  const info = windowPageInfo(rows('m', 1, 2), { hasMoreOlder: true });
  assert.equal(info.hasMore, true);
  assert.equal(info.nextCursor.beforeMessageId, 'm-001');
  assert.equal(info.newerCursor.afterMessageId, 'm-002');
  assert.equal(windowPageInfo([]).olderCursor, null);
});

test('peekWindow hands out the window uncopied and without counting as use', () => {
  const cache = createConversationPayloadCache({ limit: 2 });
  const original = { id: 'conv-a', messages: rows('m', 1, 3), pageInfo: { hasMoreOlder: true } };
  cache.remember('conv-a', original);
  cache.remember('conv-b', { id: 'conv-b', messages: rows('m', 1, 2), pageInfo: {} });
  const peeked = cache.peekWindow('conv-a');
  assert.equal(peeked.messages, original.messages);
  assert.equal(peeked.hasMoreOlder, true);
  assert.equal(peeked.hasMoreNewer, false);
  // conv-a is still the least recently used: the next one pushes it out.
  cache.remember('conv-c', { id: 'conv-c', messages: rows('m', 1, 2), pageInfo: {} });
  assert.equal(cache.has('conv-a'), false);
  assert.equal(cache.peekWindow('conv-a'), null);
});

test('a reload capped below the loaded window is merged into it', () => {
  const kept = { messages: rows('m', 1, 130), hasMoreOlder: true, hasMoreNewer: false };
  const answer = {
    id: 'conv-a',
    title: 'Chat conv-a',
    messages: [...rows('m', 33, 130).filter((m) => m.id !== 'm-120'), ...rows('m', 131, 132)],
    pageInfo: { hasMore: true, hasMoreOlder: true, hasMoreNewer: false },
  };
  const merge = mergeReloadIntoWindow(kept, answer);
  assert.equal(merge.mergeFrom, kept.messages);
  assert.equal(merge.payload.title, 'Chat conv-a');
  // All 130 loaded rows stay, less the one deleted, plus the two new ones.
  assert.equal(merge.payload.messages.length, 131);
  assert.equal(merge.payload.messages[0].id, 'm-001');
  assert.equal(merge.payload.messages.some((m) => m.id === 'm-120'), false);
  assert.equal(merge.payload.hasMoreOlder, true);
  assert.equal(merge.payload.hasMoreNewer, false);
  assert.equal(merge.payload.pageInfo.olderCursor.beforeMessageId, 'm-001');
  assert.equal(merge.payload.pageInfo.newerCursor.afterMessageId, 'm-132');
  assert.equal(kept.messages.length, 130);
});

test('a reload no live row overtook drops the window\'s newest row when the relay deleted it', () => {
  // The conversation on screen ends with the relay's held follow-up; a Cancel
  // deletes it, and the refresh after it answers without it. The kept window
  // (more rows than the answer) must lose it, page and kept copy alike.
  const kept = { messages: rows('m', 1, 130), hasMoreOlder: false };
  const answer = { id: 'conv-a', messages: rows('m', 30, 129), pageInfo: { hasMoreOlder: true, hasMoreNewer: false } };
  const merge = mergeReloadIntoWindow(kept, answer, { windowPredatesPage: true });
  assert.equal(merge.payload.messages.length, 129);
  assert.equal(merge.payload.messages.at(-1).id, 'm-129');
  assert.equal(merge.payload.pageInfo.newerCursor.afterMessageId, 'm-129');
  assert.equal(merge.mergeFrom, kept.messages);
  // A window the socket may have added to after the read keeps the row.
  assert.equal(mergeReloadIntoWindow(kept, answer).payload.messages.at(-1).id, 'm-130');
});

test('a reload is rendered as it is when there is nothing to merge', () => {
  const answer = { id: 'conv-a', messages: rows('m', 31, 130), pageInfo: { hasMoreOlder: true } };
  assert.equal(mergeReloadIntoWindow(null, answer), null);
  // The answer holds the whole window: its render loses nothing.
  assert.equal(mergeReloadIntoWindow({ messages: rows('m', 61, 130), hasMoreOlder: true }, answer), null);
  // A window in the middle of the history, or an answer that is not the end.
  assert.equal(mergeReloadIntoWindow({ messages: rows('m', 1, 130), hasMoreNewer: true }, answer), null);
  assert.equal(mergeReloadIntoWindow({ messages: rows('m', 1, 130) }, { ...answer, hasMoreNewer: true }), null);
  // More was written than the answer holds: it does not meet the window.
  const ahead = { id: 'conv-a', messages: rows('m', 201, 300), pageInfo: { hasMoreOlder: true } };
  assert.equal(mergeReloadIntoWindow({ messages: rows('m', 1, 130) }, ahead), null);
  assert.equal(mergeReloadIntoWindow({ messages: rows('m', 1, 130) }, { id: 'conv-a' }), null);
});
