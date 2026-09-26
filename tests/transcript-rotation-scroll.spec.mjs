import { expect, test, devices } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// Rotating a phone reflows every transcript row (twice the width, half the
// height), and the browser keeps scrollTop as pixels: a reader at the end of
// the conversation used to land screens above it, and a reader mid-history
// drifted on every rotation. The transcript keeper re-pins by content.

const { defaultBrowserType: _ignored, ...pixelPortrait } = devices["Pixel 7"];
test.use({ ...pixelPortrait });

const PORTRAIT = { width: 412, height: 839 };
const LANDSCAPE = { width: 839, height: 412 };
const FILLER = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function dequeue(request, headers, messageId, ownerSessionId) {
  const claimHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const pending = await request.get("/api/pending", { headers: claimHeaders });
    const message = (await pending.json())?.message || null;
    if (!message) { await sleep(120); continue; }
    if (String(message.id) === String(messageId)) return message;
    await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(100);
  }
  throw new Error(`timed out dequeuing ${messageId}`);
}

// A long conversation: each turn is a question and an answer of several
// wrapped lines, so the portrait transcript is many screens tall.
async function seedLongConversation(request, headers, turns) {
  let conversationId = "";
  let ownerSessionId = "";
  for (let index = 0; index < turns; index += 1) {
    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: `Question ${index}. ${FILLER.repeat(4)}`,
        relayMode: "agent",
        model: "gpt-5.4-mini",
        conversationId: conversationId || undefined,
      },
    });
    expect(queued.ok()).toBeTruthy();
    const body = await queued.json();
    if (!conversationId) {
      conversationId = String(body.conversationId || "");
      ownerSessionId = String(body.ownerSessionId || "");
      await dequeue(request, headers, body.messageId, ownerSessionId);
      const bound = await request.post("/api/session-sync", {
        headers,
        data: { sdk_session_id: `pw-rotation-${Date.now()}`, conversation_id: conversationId },
      });
      expect(bound.ok()).toBeTruthy();
    } else {
      await dequeue(request, headers, body.messageId, ownerSessionId);
    }
    const answered = await request.post("/api/response", {
      headers,
      data: {
        messageId: body.messageId,
        conversationId,
        text: `Answer ${index}. ${FILLER.repeat(4)}`,
        model: "gpt-5.4-mini",
        reasoningEffort: "high",
        mode: "agent",
      },
    });
    expect(answered.ok()).toBeTruthy();
  }
  return conversationId;
}

function readTranscriptPosition(page) {
  return page.evaluate(() => {
    const el = document.getElementById("messages");
    const rect = el.getBoundingClientRect();
    const rows = Array.from(el.querySelectorAll(".msg[data-message-id]"));
    const topRow = rows.find((row) => row.getBoundingClientRect().bottom > rect.top + 1);
    const topRect = topRow?.getBoundingClientRect();
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      distanceFromBottom: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
      topMessageId: topRow?.dataset.messageId || null,
      // Share of the top-most row scrolled past its top edge (0..1).
      topHiddenShare: topRect ? (rect.top - topRect.top) / Math.max(1, topRect.height) : null,
    };
  });
}

function readFieldPlacement(page, selector) {
  return page.evaluate((fieldSelector) => {
    const el = document.getElementById("messages");
    const box = el.getBoundingClientRect();
    const field = document.querySelector(fieldSelector).getBoundingClientRect();
    return {
      visible: field.top >= box.top - 1 && field.bottom <= box.bottom + 1,
      fieldTop: Math.round(field.top - box.top),
      fieldBottom: Math.round(field.bottom - box.top),
      clientHeight: el.clientHeight,
      distanceFromBottom: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
    };
  }, selector);
}

async function rotateTo(page, size) {
  await page.setViewportSize(size);
  // The keeper settles 500ms after the last resize event.
  await page.waitForTimeout(800);
}

test("rotating keeps a reader at the end at the end, and mid-history on the same row", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  let conversationId = "";
  try {
    conversationId = await seedLongConversation(request, headers, 10);
    await page.addInitScript((id) => localStorage.setItem("copilot_last_conv", id), conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(20);

    // Reader at the end (the app opens conversations at the bottom, but be
    // explicit: a user scroll commits the position to the keeper).
    await page.evaluate(() => { const el = document.getElementById("messages"); el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(300);
    const portraitEnd = await readTranscriptPosition(page);
    expect(portraitEnd.distanceFromBottom).toBe(0);
    expect(portraitEnd.scrollHeight).toBeGreaterThan(portraitEnd.clientHeight * 5);

    await rotateTo(page, LANDSCAPE);
    const landscapeEnd = await readTranscriptPosition(page);
    expect(landscapeEnd.clientHeight).toBeLessThan(portraitEnd.clientHeight);
    expect(landscapeEnd.distanceFromBottom).toBeLessThanOrEqual(1);

    await rotateTo(page, PORTRAIT);
    expect((await readTranscriptPosition(page)).distanceFromBottom).toBeLessThanOrEqual(1);

    // Reader mid-history: the same message stays the top-most visible row
    // with the same share of it scrolled past, through a rotation and back.
    await page.evaluate(() => { const el = document.getElementById("messages"); el.scrollTop = Math.round(el.scrollHeight * 0.4); });
    await page.waitForTimeout(300);
    const portraitMid = await readTranscriptPosition(page);
    expect(portraitMid.topMessageId).toBeTruthy();
    expect(portraitMid.distanceFromBottom).toBeGreaterThan(portraitMid.clientHeight);

    await rotateTo(page, LANDSCAPE);
    const landscapeMid = await readTranscriptPosition(page);
    expect(landscapeMid.topMessageId).toBe(portraitMid.topMessageId);
    expect(Math.abs(landscapeMid.topHiddenShare - portraitMid.topHiddenShare)).toBeLessThan(0.05);

    await rotateTo(page, PORTRAIT);
    const portraitMidBack = await readTranscriptPosition(page);
    expect(portraitMidBack.topMessageId).toBe(portraitMid.topMessageId);
    expect(Math.abs(portraitMidBack.topHiddenShare - portraitMid.topHiddenShare)).toBeLessThan(0.05);
  } finally {
    if (conversationId) {
      await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers }).catch(() => {});
    }
  }
});

// Android resizes the layout for the keyboard (interactive-widget=
// resizes-content), so the keyboard is a resize the keeper re-pins through.
// A focused question-card reply box must stay in view, not be restored away
// to where the reader was before the keyboard opened. Playwright cannot open
// a keyboard; shrinking the viewport is the same resize.
test("the keyboard opening keeps a focused question-card reply box in view", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const keyboardOpen = { width: PORTRAIT.width, height: PORTRAIT.height - 300 };
  let conversationId = "";
  let messageId = "";
  try {
    conversationId = await seedLongConversation(request, headers, 4);
    const queued = await request.post("/api/message", {
      headers,
      data: { text: "Question with cards", relayMode: "agent", model: "gpt-5.4-mini", conversationId },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    messageId = String(queuedBody.messageId || "");
    await dequeue(request, headers, messageId, String(queuedBody.ownerSessionId || ""));
    const questionIds = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await request.post("/api/relay-question", {
        headers,
        data: {
          queueId: messageId,
          messageId,
          conversationId,
          mode: "agent",
          prompt: `Card ${index}: which option should the build use?`,
          choices: ["Option A", "Option B"],
          allowFreeform: true,
          timeout_ms: 120000,
        },
      });
      expect(created.ok()).toBeTruthy();
      questionIds.push(String((await created.json())?.question?.id || ""));
    }

    await page.addInitScript((id) => localStorage.setItem("copilot_last_conv", id), conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#messages .relay-question-container")).toHaveCount(3);
    const replyBox = `#relay-question-input-${questionIds[0]}`;

    // The first card's reply box 70% down the transcript, well short of the end.
    await page.evaluate((selector) => {
      const el = document.getElementById("messages");
      const field = document.querySelector(selector).getBoundingClientRect();
      el.scrollTop += field.bottom - el.getBoundingClientRect().top - el.clientHeight * 0.7;
    }, replyBox);
    await page.waitForTimeout(300);
    const before = await readFieldPlacement(page, replyBox);
    expect(before.visible).toBe(true);
    expect(before.distanceFromBottom).toBeGreaterThan(48);
    // ...and below where the transcript will end once the keyboard is up.
    expect(before.fieldBottom).toBeGreaterThan(before.clientHeight - 300);

    await page.evaluate((selector) => document.querySelector(selector).focus({ preventScroll: true }), replyBox);
    await page.waitForTimeout(300);
    await rotateTo(page, keyboardOpen);
    const typing = await readFieldPlacement(page, replyBox);
    expect(typing.clientHeight).toBeLessThan(before.clientHeight);
    expect(typing.visible, `reply box at ${typing.fieldTop}–${typing.fieldBottom} of ${typing.clientHeight}`).toBe(true);

    await rotateTo(page, PORTRAIT);
    expect((await readFieldPlacement(page, replyBox)).visible).toBe(true);

    // The composer is outside the transcript: a reader at the end stays pinned.
    await page.evaluate(() => { const el = document.getElementById("messages"); el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(300);
    await page.locator("#msg-input").focus();
    await rotateTo(page, keyboardOpen);
    expect((await readTranscriptPosition(page)).distanceFromBottom).toBeLessThanOrEqual(1);
    await rotateTo(page, PORTRAIT);
    expect((await readTranscriptPosition(page)).distanceFromBottom).toBeLessThanOrEqual(1);
  } finally {
    if (messageId && conversationId) {
      await request.post("/api/response", {
        headers,
        data: { messageId, conversationId, text: "playwright cleanup", model: "gpt-5.4-mini", mode: "agent" },
      }).catch(() => {});
    }
    if (conversationId) {
      await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers }).catch(() => {});
    }
  }
});
