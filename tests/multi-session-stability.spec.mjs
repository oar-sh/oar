import { expect, test } from '@playwright/test';
import { relayToken } from './e2e-env.mjs';
import { respondAsWorker, settleFakeWorkers, startConversation } from './helpers/fake-worker.mjs';

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

async function createMessage(request, headers, { text, conversationId = null }) {
  const response = await request.post('/api/message', {
    headers,
    data: {
      text,
      conversationId: conversationId || undefined,
      relayMode: 'agent',
      model: 'gpt-5.4-mini',
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function openConversation(page, conversationId) {
  await page.waitForFunction(() => typeof window.openConversation === 'function');
  await page.evaluate(async (id) => {
    await window.openConversation(id);
  }, conversationId);
}

test('keeps stream/activity session-bound while switching and avoids duplicate user turn rows', async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const seedA = `multi-session-a-${stamp}`;
  const seedB = `multi-session-b-${stamp}`;
  const activityA = `tool-activity-a-${stamp}`;
  const activityB = `tool-activity-b-${stamp}`;
  const streamA = `thinking-a-${stamp}`;
  const streamB = `thinking-b-${stamp}`;
  const duplicateText = `duplicate-guard-${stamp}`;
  let convA = '';
  let convB = '';
  let msgA = '';
  let msgB = '';
  let followupA = '';

  try {
    // Made as the web client makes a chat: bound to its session from the start.
    const first = await startConversation({ text: seedA });
    convA = String(first?.conversationId || '').trim();
    msgA = String(first?.messageId || '').trim();
    expect(convA).toBeTruthy();
    expect(msgA).toBeTruthy();
    await first.worker.take(msgA);

    const second = await startConversation({ text: seedB });
    convB = String(second?.conversationId || '').trim();
    msgB = String(second?.messageId || '').trim();
    expect(convB).toBeTruthy();
    expect(msgB).toBeTruthy();
    await second.worker.take(msgB);

    const streamRespA = await request.post('/api/stream', {
      headers,
      data: { messageId: msgA, conversationId: convA, text: streamA, mode: 'agent', done: false },
    });
    expect(streamRespA.ok()).toBeTruthy();
    const activityRespA = await request.post('/api/activity', {
      headers,
      data: { messageId: msgA, conversationId: convA, text: activityA, mode: 'agent' },
    });
    expect(activityRespA.ok()).toBeTruthy();

    const streamRespB = await request.post('/api/stream', {
      headers,
      data: { messageId: msgB, conversationId: convB, text: streamB, mode: 'agent', done: false },
    });
    expect(streamRespB.ok()).toBeTruthy();
    const activityRespB = await request.post('/api/activity', {
      headers,
      data: { messageId: msgB, conversationId: convB, text: activityB, mode: 'agent' },
    });
    expect(activityRespB.ok()).toBeTruthy();

    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState('networkidle');

    await openConversation(page, convA);
    await expect(page.locator('#thinking-indicator')).toBeVisible();
    await expect(page.locator('#thinking-stream')).toContainText(streamA);
    await expect(page.locator('#thinking-activity .thinking-activity-item', { hasText: activityA })).toHaveCount(1);

    await openConversation(page, convB);
    await expect(page.locator('#thinking-indicator')).toBeVisible();
    await expect(page.locator('#thinking-stream')).toContainText(streamB);
    await expect(page.locator('#thinking-stream')).not.toContainText(streamA);
    await expect(page.locator('#thinking-activity .thinking-activity-item', { hasText: activityB })).toHaveCount(1);
    await expect(page.locator('#thinking-activity .thinking-activity-item', { hasText: activityA })).toHaveCount(0);

    await openConversation(page, convA);
    await expect(page.locator('#thinking-stream')).toContainText(streamA);
    await expect(page.locator('#thinking-stream')).not.toContainText(streamB);

    const firstFollowup = await createMessage(request, headers, { text: duplicateText, conversationId: convA });
    followupA = String(firstFollowup?.messageId || '').trim();
    expect(followupA).toBeTruthy();
    const secondFollowup = await createMessage(request, headers, { text: duplicateText, conversationId: convA });
    expect(secondFollowup?.duplicate).toBe(true);

    await openConversation(page, convA);
    await expect(page.locator('.msg.user .msg-bubble', { hasText: duplicateText })).toHaveCount(1);
  } finally {
    const finalize = async (conversationId, messageId) => {
      if (!conversationId || !messageId) return;
      await respondAsWorker(messageId, {
        conversationId,
        text: 'playwright cleanup',
        model: 'gpt-5.4-mini',
        mode: 'agent',
      }).catch(() => {});
    };
    await finalize(convA, msgA);
    await finalize(convB, msgB);
    await finalize(convA, followupA);
    if (convA) await request.delete(`/api/conversation/${convA}`, { headers }).catch(() => {});
    if (convB) await request.delete(`/api/conversation/${convB}`, { headers }).catch(() => {});
  }
});
