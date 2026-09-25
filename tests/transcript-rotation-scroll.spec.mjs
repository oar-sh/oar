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
