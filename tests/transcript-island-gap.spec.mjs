import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// Live rows for a window that ends above the conversation's end, end to end
// without a model: the spec queues messages with POST /api/message, takes
// them off the queue with GET /api/pending and answers with POST
// /api/response, as a worker does, while the page is open, so every row
// arrives live.
//
// - A jump into the history (here: to an early message, as a pin or a search
//   result does) puts a window on the page that ends above the end. Live rows
//   are not put under it, and no live bubble either: the jump-to-bottom
//   button counts them.
// - Scrolling down loads the newer pages up to the end, every row once and
//   in order; from there live rows join the page as usual.
// - The button loads the end, clears the count, and the transcript follows
//   new rows again.
// - With more than a hundred rows loaded, a turn that runs and ends keeps
//   them all and puts its reply at the end (the live poll merges its capped
//   answer into the window).

const FILLER = "The tide tables for the estuary list two low waters a day, and the mudflats open for an hour either side of each one. ";
const DEVICES = {
  desktop: { viewport: { width: 1280, height: 860 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRelay(request) {
  const headers = { Authorization: `Bearer ${relayToken()}` };
  let conversationId = "";
  let ownerSessionId = "";

  async function dequeue(messageId) {
    const claimHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const pending = await request.get("/api/pending", { headers: claimHeaders });
      const message = (await pending.json())?.message || null;
      if (!message) { await sleep(120); continue; }
      if (String(message.id) === String(messageId)) return;
      await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
      await sleep(100);
    }
    throw new Error(`timed out dequeuing ${messageId}`);
  }

  async function queue(text) {
    const queued = await request.post("/api/message", {
      headers,
      data: { text, relayMode: "agent", model: "gpt-5.4-mini", conversationId: conversationId || undefined },
    });
    expect(queued.ok(), await queued.text()).toBeTruthy();
    const body = await queued.json();
    if (!conversationId) {
      conversationId = String(body.conversationId || "");
      ownerSessionId = String(body.ownerSessionId || "");
      await dequeue(body.messageId);
      const bound = await request.post("/api/session-sync", {
        headers,
        data: { sdk_session_id: `pw-island-${Date.now()}`, conversation_id: conversationId },
      });
      expect(bound.ok()).toBeTruthy();
      return { messageId: String(body.messageId), taken: true };
    }
    return { messageId: String(body.messageId), taken: false };
  }

  async function answer(messageId, text) {
    const answered = await request.post("/api/response", {
      headers,
      data: { messageId, conversationId, text, model: "gpt-5.4-mini", mode: "agent" },
    });
    expect(answered.ok(), await answered.text()).toBeTruthy();
  }

  // A question and its answer, taken off the queue as a worker does.
  async function turn(text, reply = `Answer to ${text}. ${FILLER.repeat(2)}`) {
    const queued = await queue(text);
    if (!queued.taken) await dequeue(queued.messageId);
    await answer(queued.messageId, reply);
    return queued.messageId;
  }

  // A question and its answer written before the page opens: no worker.
  async function seedTurn(text, reply) {
    const queued = await queue(text);
    await answer(queued.messageId, reply);
    return queued.messageId;
  }

  // The conversation's rows in their order, as the relay has them (up to 100).
  async function messageIds() {
    const response = await request.get(`/api/conversation/${encodeURIComponent(conversationId)}?limit=100`, { headers });
    expect(response.ok()).toBeTruthy();
    return ((await response.json())?.messages || []).map((message) => String(message.id));
  }

  async function cleanup() {
    if (!conversationId) return;
    await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers }).catch(() => {});
  }

  return {
    queue, dequeue, answer, turn, seedTurn, messageIds, cleanup,
    get conversationId() { return conversationId; },
  };
}

async function openPage(page, conversationId) {
  await page.addInitScript((id) => localStorage.setItem("copilot_last_conv", id), conversationId);
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
  await page.waitForLoadState("networkidle");
}

function pageRows(page) {
  return page.evaluate(() => [...document.querySelectorAll("#messages > .msg:not(#thinking-indicator)[data-message-id]")]
    .map((node) => node.dataset.messageId));
}

function transcript(page) {
  return page.evaluate(() => {
    const el = document.getElementById("messages");
    return {
      clientHeight: el.clientHeight,
      distance: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
    };
  });
}

async function expectAtBottom(page) {
  await expect.poll(async () => (await transcript(page)).distance, { timeout: 5_000 }).toBeLessThanOrEqual(1);
}

// A jump to an early message, as from a pin or a search result: a window
// around it, which ends above the conversation's end.
async function jumpInto(page, conversationId, messageId) {
  await page.evaluate(([id, focus]) => window.openConversation(id, { focusMessageId: focus }), [conversationId, messageId]);
  await expect(page.locator(`#messages > .msg[data-message-id="${messageId}"]`)).toBeAttached();
  await page.waitForTimeout(800);
}

async function press(page, locator, touch) {
  if (touch) await locator.tap();
  else await locator.click();
}

for (const [name, device] of Object.entries(DEVICES)) {
  test.describe(name, () => {
    test.use(device);
    const touch = !!device.hasTouch;

    test("live rows wait below a window in the history, scrolling down brings them in order, and the button loads the end", async ({ page, request }) => {
      test.setTimeout(180_000);
      const relay = createRelay(request);
      try {
        const questions = [];
        // Long enough that the window of the jump, and the page or two the
        // loader adds below it straight away, stay above the end.
        for (let index = 0; index < 42; index += 1) {
          questions.push(await relay.seedTurn(`Low water ${index}. ${FILLER}`, `Mudflats open ${index}. ${FILLER.repeat(2)}`));
        }
        await openPage(page, relay.conversationId);
        await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(20);
        const button = page.locator("#jump-to-bottom-btn");
        const badge = button.locator(".jump-to-bottom-badge");

        // (a) A window around an early message: rows arriving now wait.
        await jumpInto(page, relay.conversationId, questions[1]);
        const islandRows = await pageRows(page);
        const allBefore = await relay.messageIds();
        expect(islandRows.at(-1), "the window ends above the end").not.toBe(allBefore.at(-1));

        await relay.turn("Where is the heron roost");
        const { messageId: third } = await relay.queue("When does the ferry run");
        await expect(badge).toHaveText("3");
        await expect(button).toBeVisible();
        await expect(button).toHaveAttribute("aria-label", "Jump to the latest message (3 new)");
        expect(await pageRows(page), "nothing was put under the window").toEqual(islandRows);
        // The turn starts: no live bubble under the window.
        await relay.dequeue(third);
        await page.waitForTimeout(800);
        await expect(page.locator("#thinking-indicator")).toHaveCount(0);
        await relay.answer(third, `The ferry runs on the hour. ${FILLER}`);
        await expect(badge).toHaveText("4");
        expect(await pageRows(page)).toEqual(islandRows);
        await page.waitForTimeout(1_500);
        expect(await pageRows(page), "the end of the turn left the window alone").toEqual(islandRows);

        // (b) Scrolling down loads the newer pages until the end.
        const all = await relay.messageIds();
        await expect.poll(async () => {
          await page.evaluate(() => { const el = document.getElementById("messages"); el.scrollTop = el.scrollHeight; });
          return (await pageRows(page)).at(-1);
        }, { timeout: 30_000, intervals: [400] }).toBe(all.at(-1));
        const filled = await pageRows(page);
        const start = all.indexOf(filled[0]);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(filled, "every row once, in order, up to the end").toEqual(all.slice(start));
        await expectAtBottom(page);
        await expect(button).toBeHidden();
        // From here a live row joins the page and is followed.
        await relay.turn("Is the causeway open", `The causeway opens at noon. ${FILLER}`);
        await expect(page.locator("#messages .msg.assistant").last()).toContainText("The causeway opens at noon.");
        await expectAtBottom(page);
        await expect(button).toBeHidden();
        // And a reader above the end counts rows as before.
        await page.evaluate(() => { const el = document.getElementById("messages"); el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight * 3); });
        await expect(button).toBeVisible();
        await relay.turn("Are the seals out", `Seals on the sandbank. ${FILLER}`);
        await expect(badge).toHaveText("2");

        // (c) Into the history again; the button loads the end.
        await jumpInto(page, relay.conversationId, questions[1]);
        const secondIsland = await pageRows(page);
        await relay.turn("How deep is the channel", `Two fathoms at low water. ${FILLER}`);
        await expect(badge).toHaveText("2");
        expect(await pageRows(page)).toEqual(secondIsland);
        await press(page, button, touch);
        await expect(page.locator("#messages .msg.assistant").last()).toContainText("Two fathoms at low water.");
        await expectAtBottom(page);
        await expect(button).toBeHidden();
        await expect(badge).toBeHidden();
        await relay.turn("Which way is the wind", `A westerly, light. ${FILLER}`);
        await expect(page.locator("#messages .msg.assistant").last()).toContainText("A westerly, light.");
        await expectAtBottom(page);
        await expect(button).toBeHidden();
        const end = await pageRows(page);
        const allAfter = await relay.messageIds();
        expect(end, "the end, every row once").toEqual(allAfter.slice(allAfter.indexOf(end[0])));
      } finally {
        await relay.cleanup();
      }
    });

    // (e) The reader's own message from such a window goes to the end: the
    // end is loaded, with the rows that waited, and the message, its live
    // bubble and its reply follow there.
    test("an own send from a window in the history lands at the end, after the rows that waited, and its reply follows", async ({ page, request }) => {
      test.setTimeout(180_000);
      const relay = createRelay(request);
      try {
        const questions = [];
        for (let index = 0; index < 42; index += 1) {
          questions.push(await relay.seedTurn(`High water ${index}. ${FILLER}`, `Saltmarsh covered ${index}. ${FILLER.repeat(2)}`));
        }
        // Switched off on one of the two: the end is where the message is,
        // whatever the scroll-on-send setting says.
        if (!touch) await page.addInitScript(() => localStorage.setItem("copilot_scroll_on_send", "0"));
        await openPage(page, relay.conversationId);
        await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(20);
        const button = page.locator("#jump-to-bottom-btn");
        const badge = button.locator(".jump-to-bottom-badge");

        await jumpInto(page, relay.conversationId, questions[1]);
        const islandRows = await pageRows(page);
        await relay.turn("Where do the oystercatchers feed", `On the mussel beds. ${FILLER}`);
        await expect(badge).toHaveText("2");
        expect(await pageRows(page), "nothing was put under the window").toEqual(islandRows);

        const posted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/message"));
        await page.fill("#msg-input", "When is the next spring tide");
        await press(page, page.locator("#send-btn"), touch);
        const sentResponse = await posted;
        expect(sentResponse.ok()).toBeTruthy();
        const own = String((await sentResponse.json())?.messageId || "");
        expect(own).not.toBe("");
        // The user row: the live bubble carries its prompt's id too.
        await expect(page.locator(`#messages > .msg.user[data-message-id="${own}"]`)).toBeAttached();
        await expectAtBottom(page);
        await expect(button).toBeHidden();

        // The worker takes it: the live bubble is drawn at the end.
        await relay.dequeue(own);
        await expect(page.locator("#thinking-indicator")).toHaveCount(1);
        await relay.answer(own, `Spring tide on Thursday morning. ${FILLER}`);
        await expect(page.locator("#messages .msg.assistant").last()).toContainText("Spring tide on Thursday morning.");
        await expect(page.locator("#thinking-indicator")).toHaveCount(0);
        await expectAtBottom(page);
        // A few rounds of the live poll and the end-of-turn refresh.
        await page.waitForTimeout(1_500);
        const end = await pageRows(page);
        const all = await relay.messageIds();
        expect(new Set(end).size, "no row twice").toBe(end.length);
        expect(end, "the end, every row once, in order").toEqual(all.slice(all.indexOf(end[0])));
        // The two rows that waited, then the own message and its reply.
        expect(end.slice(-4)).toEqual(all.slice(-4));
        expect(end.at(-2)).toBe(own);
      } finally {
        await relay.cleanup();
      }
    });
  });
}

test.describe("desktop", () => {
  test.use(DEVICES.desktop);

  // (d) The live poll's answer is capped at a hundred rows: merged into the
  // window, it keeps every row loaded.
  test("a turn that runs and ends under more than a hundred loaded rows keeps them and adds its reply at the end", async ({ page, request }) => {
    test.setTimeout(240_000);
    const relay = createRelay(request);
    try {
      for (let index = 0; index < 70; index += 1) {
        await relay.seedTurn(`Tide ${index}`, `Height ${index}. ${index % 4 === 0 ? FILLER : "Short."}`);
      }
      await openPage(page, relay.conversationId);
      await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(20);
      for (let pass = 0; pass < 6 && (await pageRows(page)).length < 120; pass += 1) {
        const before = (await pageRows(page)).length;
        await page.evaluate(() => window.loadOlderConversationMessages());
        await expect.poll(async () => (await pageRows(page)).length).toBeGreaterThan(before);
        await page.waitForTimeout(300);
      }
      const loaded = await pageRows(page);
      expect(loaded.length).toBeGreaterThanOrEqual(120);
      await page.evaluate(() => { const el = document.getElementById("messages"); el.scrollTop = el.scrollHeight; });
      await expectAtBottom(page);

      const asked = await relay.queue("What is the spring tide range");
      await relay.dequeue(asked.messageId);
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      // A few rounds of the live poll while the turn runs.
      await page.waitForTimeout(2_500);
      await relay.answer(asked.messageId, "Spring tides range over five metres.");
      await expect(page.locator("#messages .msg.assistant").last()).toContainText("Spring tides range over five metres.");
      await page.waitForTimeout(1_500);
      const after = await pageRows(page);
      expect(after.length, "every loaded row kept, the turn's two added").toBe(loaded.length + 2);
      expect(after.slice(0, loaded.length)).toEqual(loaded);
      expect(after.slice(-2)[0]).toBe(asked.messageId);
      await expectAtBottom(page);
    } finally {
      await relay.cleanup();
    }
  });
});
