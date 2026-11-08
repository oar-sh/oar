import test from 'node:test';
import assert from 'node:assert/strict';

import { createReasoningStreamHandlers } from './reasoning-stream.mjs';

const MAX_THOUGHT_CHARS = 16 * 1024;

test('a long reasoning stream stops posting once the capped text stops changing', async () => {
  const posts = [];
  const handlers = createReasoningStreamHandlers({
    api: async (method, routePath, body) => { posts.push(body); },
    getRelayTurnActive: () => true,
    getActiveMessage: () => ({ id: 'q-1', conversationId: 'conv-1' }),
  });
  let afterCap = 0;
  for (let i = 0; i < 2 * MAX_THOUGHT_CHARS; i += 1) {
    const before = posts.length;
    await handlers.onReasoningDelta({ data: { reasoningId: 'r-1', deltaContent: '考' } });
    if (i >= MAX_THOUGHT_CHARS) afterCap += posts.length - before;
  }
  assert.equal(afterCap, 0, 'the same capped text is not posted again');
  assert.ok(posts.length <= Math.ceil(MAX_THOUGHT_CHARS / 24) + 1, `${posts.length} posts`);
  // The complete block is the final frame, with the whole capped text.
  await handlers.onReasoning({ data: { reasoningId: 'r-1', content: '考'.repeat(2 * MAX_THOUGHT_CHARS) } });
  assert.equal(posts.at(-1).done, true);
  assert.equal(posts.at(-1).text.length, MAX_THOUGHT_CHARS);
});
