import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// The transcript's jump-to-bottom button and the re-pin under the composer,
// end to end without a model: the spec queues messages with POST
// /api/message (an agent's prompt carries its `origin`), takes them off the
// queue with GET /api/pending and answers with POST /api/response, as a
// worker does, while the page is open, so every row arrives live. The
// background-task panel is published with POST /api/background-tasks.
//
// - The button fades in once the reader is a screen above the end and its
//   badge counts the rows that arrived since; a folded agent exchange (its
//   prompt, live bubble and reply) is one row.
// - A click goes back to the end, smoothly up to three screens away and at
//   once beyond, and the transcript follows new rows again.
// - The panel appearing, opening or growing under a reader who follows the
//   end leaves them at the end: it shrank the transcript from below, and the
//   next live row used to find them that many pixels short and stop following.
//   The same with the agent's reply streaming in (POST /api/stream).

const FILLER = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
const REMOTE_ORIGIN = {
  relayId: "relay-fixture-jump",
  relayName: "jump-test",
  conversationId: "conv-fixture-jump-lead",
  conversationTitle: "nightly digest",
  model: "claude-fixture",
  hops: 1,
};
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

  async function queue(text, extra = {}) {
    const queued = await request.post("/api/message", {
      headers,
      data: { text, relayMode: "agent", model: "gpt-5.4-mini", conversationId: conversationId || undefined, ...extra },
    });
    expect(queued.ok(), await queued.text()).toBeTruthy();
    const body = await queued.json();
    if (!conversationId) {
      conversationId = String(body.conversationId || "");
      ownerSessionId = String(body.ownerSessionId || "");
      await dequeue(body.messageId);
      const bound = await request.post("/api/session-sync", {
        headers,
        data: { sdk_session_id: `pw-jump-${Date.now()}`, conversation_id: conversationId },
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

  // A question and its answer.
  async function turn(text, reply = `Answer to ${text}. ${FILLER.repeat(3)}`, extra = {}) {
    const queued = await queue(text, extra);
    if (!queued.taken) await dequeue(queued.messageId);
    await answer(queued.messageId, reply);
    return queued.messageId;
  }

  // The reply so far, as a worker streams it.
  async function stream(messageId, text) {
    const streamed = await request.post("/api/stream", {
      headers,
      data: { messageId, conversationId, text, mode: "agent", done: false },
    });
    expect(streamed.ok(), await streamed.text()).toBeTruthy();
  }

  async function backgroundTasks(count) {
    const now = Date.now();
    const tasks = Array.from({ length: count }, (_, index) => ({
      taskId: `jump-${now}-${index}`,
      taskType: "local_agent",
      subagentType: "general-purpose",
      description: `Index the fixtures ${index}`,
      startedAt: now,
      model: "claude-opus-5-5",
      lastToolCall: "Tool (Bash): npm test -- --grep fixtures",
      totalTokens: 1000,
    }));
    const published = await request.post("/api/background-tasks", { headers, data: { conversationId, tasks } });
    expect(published.ok()).toBeTruthy();
  }

  async function cleanup() {
    if (!conversationId) return;
    await request.post("/api/background-tasks", { headers, data: { conversationId, tasks: [] } }).catch(() => {});
    await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers }).catch(() => {});
  }

  return {
    queue, dequeue, answer, turn, stream, backgroundTasks, cleanup,
    get conversationId() { return conversationId; },
  };
}

async function openConversation(page, conversationId) {
  await page.addInitScript((id) => localStorage.setItem("copilot_last_conv", id), conversationId);
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForLoadState("networkidle");
}

function transcript(page) {
  return page.evaluate(() => {
    const el = document.getElementById("messages");
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: Math.round(el.scrollTop),
      distance: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
    };
  });
}

function scrollToScreensAbove(page, screens) {
  return page.evaluate((count) => {
    const el = document.getElementById("messages");
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - Math.round(el.clientHeight * count));
  }, screens);
}

// The page reloads the conversation once a turn ends; the steps after a turn
// let that reload land first.
function settleAfterTurn(page) {
  return page.waitForTimeout(1_500);
}

async function expectAtBottom(page) {
  await expect.poll(async () => (await transcript(page)).distance, { timeout: 5_000 }).toBeLessThanOrEqual(1);
}

// The button sits above the composer, inside the viewport, and nothing
// covers it.
async function expectButtonPlacement(page) {
  const placement = await page.evaluate(() => {
    const button = document.getElementById("jump-to-bottom-btn").getBoundingClientRect();
    const composer = document.getElementById("input-area").getBoundingClientRect();
    const messages = document.getElementById("messages").getBoundingClientRect();
    const hit = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
    return {
      aboveComposer: button.bottom <= composer.top,
      insideTranscript: button.top >= messages.top && button.right <= messages.right,
      inViewport: button.left >= 0 && button.right <= innerWidth && button.bottom <= innerHeight,
      rightSide: button.left > innerWidth / 2,
      onTop: !!hit?.closest?.("#jump-to-bottom-btn"),
      round: Math.abs(button.width - button.height) < 1,
    };
  });
  expect(placement).toEqual({ aboveComposer: true, insideTranscript: true, inViewport: true, rightSide: true, onTop: true, round: true });
}

async function press(page, locator, touch) {
  if (touch) await locator.tap();
  else await locator.click();
}

for (const [name, device] of Object.entries(DEVICES)) {
  test.describe(name, () => {
    test.use(device);
    const touch = !!device.hasTouch;

    test("scrolling up shows the button, its badge counts new rows, a folded prompt and its reply each, and a click follows the end again", async ({ page, request }) => {
      test.setTimeout(120_000);
      const relay = createRelay(request);
      try {
        for (let index = 0; index < 10; index += 1) await relay.turn(`Question ${index}. ${FILLER.repeat(3)}`);
        await openConversation(page, relay.conversationId);
        await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(20);
        const button = page.locator("#jump-to-bottom-btn");
        const badge = button.locator(".jump-to-bottom-badge");

        await page.evaluate(() => { const el = document.getElementById("messages"); el.scrollTop = el.scrollHeight; });
        await expectAtBottom(page);
        await expect(button).toBeHidden();
        const { clientHeight, scrollHeight } = await transcript(page);
        expect(scrollHeight).toBeGreaterThan(clientHeight * 4);

        // Half a screen up: not yet. Two screens up: it fades in.
        await scrollToScreensAbove(page, 0.5);
        await page.waitForTimeout(300);
        await expect(button).toBeHidden();
        await scrollToScreensAbove(page, 2);
        await expect(button).toBeVisible();
        await expect(badge).toBeHidden();
        await expectButtonPlacement(page);

        // Live rows while the reader is up there: they stay up there.
        const question = await relay.queue("A question from the other device");
        await expect(badge).toHaveText("1");
        await relay.dequeue(question.messageId);
        await relay.answer(question.messageId, `Its answer. ${FILLER}`);
        await expect(badge).toHaveText("2");
        expect((await transcript(page)).distance).toBeGreaterThan(clientHeight);
        await settleAfterTurn(page);

        // An agent's prompt folds into a row and counts once; its live
        // bubble and then its reply are a row of their own, as in any turn.
        const prompt = await relay.queue("report builder: list the totals", { origin: REMOTE_ORIGIN });
        const fold = page.locator(`#messages > .msg[data-message-id="${prompt.messageId}"] details.agent-exchange-row`);
        await expect(fold).toHaveCount(1);
        await expect(badge).toHaveText("3");
        await relay.dequeue(prompt.messageId);
        await expect(fold.locator(".agent-exchange-status")).toHaveText("working…");
        await expect(page.locator("#thinking-indicator")).toHaveCount(1);
        await expect(badge).toHaveText("4");
        await relay.answer(prompt.messageId, "Totals: 42 rows, 3 sheets.");
        await expect(fold.locator(".agent-exchange-status")).toHaveText("answered below");
        await page.waitForTimeout(300);
        await expect(badge).toHaveText("4");
        await expect(button).toHaveAttribute("aria-label", "Jump to the latest message (4 new)");
        await settleAfterTurn(page);

        // Two to three screens away the click scrolls smoothly: right after
        // it the transcript is still on its way.
        await scrollToScreensAbove(page, 2.5);
        await page.waitForTimeout(200);
        const smoothStart = await page.evaluate(() => {
          document.getElementById("jump-to-bottom-btn").click();
          const el = document.getElementById("messages");
          return Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
        });
        expect(smoothStart).toBeGreaterThan(clientHeight);
        await expectAtBottom(page);
        await expect(button).toBeHidden();
        await expect(badge).toBeHidden();

        // Further than three screens it jumps at once.
        await page.evaluate(() => { document.getElementById("messages").scrollTop = 0; });
        await expect(button).toBeVisible();
        const instantStart = await page.evaluate(() => {
          document.getElementById("jump-to-bottom-btn").click();
          const el = document.getElementById("messages");
          return Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
        });
        expect(instantStart).toBeLessThanOrEqual(1);

        // Up again, a row arrives, and the button (tap on the phone) brings
        // the reader back: the next rows are followed.
        await scrollToScreensAbove(page, 2);
        await expect(button).toBeVisible();
        await relay.turn("One more question", `One more answer. ${FILLER}`);
        await expect(badge).toHaveText("2");
        await press(page, button, touch);
        await expectAtBottom(page);
        await expect(button).toBeHidden();
        await relay.turn("Following again", `Followed. ${FILLER.repeat(3)}`);
        await expect(page.locator("#messages .msg.assistant").last()).toContainText("Followed.");
        await expectAtBottom(page);
        await expect(button).toBeHidden();
      } finally {
        await relay.cleanup();
      }
    });

    test("the background-task panel appearing, opening and growing keeps a following reader at the end", async ({ page, request }) => {
      test.setTimeout(120_000);
      const relay = createRelay(request);
      try {
        for (let index = 0; index < 8; index += 1) await relay.turn(`Question ${index}. ${FILLER.repeat(3)}`);
        await openConversation(page, relay.conversationId);
        await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(16);
        await page.evaluate(() => { const el = document.getElementById("messages"); el.scrollTop = el.scrollHeight; });
        await expectAtBottom(page);

        const panel = page.locator("#background-tasks-panel");
        const rows = page.locator("#background-tasks-list .bg-task-row");
        const lastReply = page.locator("#messages .msg.assistant").last();
        const composerTop = () => page.evaluate(() => document.getElementById("input-area").getBoundingClientRect().top);

        // No turn runs yet, so nothing polls: only the re-pin can keep the
        // reader at the end when the panel appears.
        const top0 = await composerTop();
        await relay.backgroundTasks(1);
        await expect(panel).toBeVisible();
        expect(await composerTop()).toBeLessThan(top0);
        await expectAtBottom(page);

        // Opened, then growing.
        if ((await panel.getAttribute("open")) === null) await press(page, page.locator("#background-tasks-summary"), touch);
        await expect(panel).toHaveAttribute("open", "");
        await expectAtBottom(page);
        const top1 = await composerTop();
        await relay.backgroundTasks(3);
        await expect(rows).toHaveCount(3);
        expect(await composerTop()).toBeLessThan(top1);
        await expectAtBottom(page);
        await expect(page.locator("#jump-to-bottom-btn")).toBeHidden();

        // So the next live rows are followed.
        await relay.turn("And the next one", `Next answer. ${FILLER.repeat(2)}`);
        await expect(lastReply).toContainText("Next answer.");
        await expectAtBottom(page);
        await settleAfterTurn(page);

        // The agent at work: its live bubble is up and the page polls. The
        // panel grows again, and two poll rounds later the reader is still
        // at the end, where the turn's reply is followed.
        const running = await relay.queue("Build the report");
        await relay.dequeue(running.messageId);
        await expect(page.locator("#thinking-indicator")).toHaveCount(1);
        await expectAtBottom(page);
        const top2 = await composerTop();
        await relay.backgroundTasks(5);
        await expect(rows).toHaveCount(5);
        expect(await composerTop()).toBeLessThan(top2);
        await expectAtBottom(page);
        await page.waitForTimeout(2_000);
        await expectAtBottom(page);
        await relay.answer(running.messageId, `The report is built. ${FILLER.repeat(3)}`);
        await expect(lastReply).toContainText("The report is built.");
        await expectAtBottom(page);

        // A reader who scrolled up is left where they are when it changes.
        await settleAfterTurn(page);
        await scrollToScreensAbove(page, 1.5);
        await page.waitForTimeout(300);
        const up = await transcript(page);
        expect(up.distance).toBeGreaterThan(up.clientHeight);
        await relay.backgroundTasks(1);
        await expect(rows).toHaveCount(1);
        await page.waitForTimeout(300);
        const after = await transcript(page);
        expect(after.clientHeight).toBeGreaterThan(up.clientHeight);
        expect(after.scrollTop).toBe(up.scrollTop);
      } finally {
        await relay.cleanup();
      }
    });

    // The case as it was seen: the agent is writing its reply, the reader
    // follows it, and a background task starts.
    test("a reader following a streaming reply stays at the end when background tasks start and grow", async ({ page, request }) => {
      test.setTimeout(120_000);
      const relay = createRelay(request);
      try {
        for (let index = 0; index < 8; index += 1) await relay.turn(`Question ${index}. ${FILLER.repeat(3)}`);
        await openConversation(page, relay.conversationId);
        await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(16);
        await page.evaluate(() => { const el = document.getElementById("messages"); el.scrollTop = el.scrollHeight; });
        await expectAtBottom(page);

        const running = await relay.queue("Build the report");
        await relay.dequeue(running.messageId);
        await expect(page.locator("#thinking-indicator")).toHaveCount(1);
        const live = page.locator("#thinking-stream");
        const panel = page.locator("#background-tasks-panel");
        const rows = page.locator("#background-tasks-list .bg-task-row");
        let reply = "";
        const streamPart = async (index) => {
          reply += `Part ${index} of the report. ${FILLER.repeat(2)}\n\n`;
          await relay.stream(running.messageId, reply);
          await expect(live).toContainText(`Part ${index} of the report.`);
          await expectAtBottom(page);
        };

        await streamPart(1);
        await streamPart(2);
        await relay.backgroundTasks(1);
        await expect(panel).toBeVisible();
        await streamPart(3);
        await streamPart(4);
        if ((await panel.getAttribute("open")) === null) await press(page, page.locator("#background-tasks-summary"), touch);
        await expect(panel).toHaveAttribute("open", "");
        await streamPart(5);
        await relay.backgroundTasks(4);
        await expect(rows).toHaveCount(4);
        await streamPart(6);
        await streamPart(7);
        await expect(page.locator("#jump-to-bottom-btn")).toBeHidden();

        await relay.answer(running.messageId, `${reply}The report is built.`);
        await expect(page.locator("#messages .msg.assistant").last()).toContainText("The report is built.");
        await expectAtBottom(page);
      } finally {
        await relay.cleanup();
      }
    });

    // The same case without its timing: a row is followed to the end, and
    // before the next frame (which brings its scroll event and the resize
    // round) the composer grows and the next update asks whether it follows.
    // It runs in one task, so the order is the one a busy page sees at times.
    test("an update between a scroll to the end and the next frame follows when the composer grew", async ({ page, request }) => {
      test.setTimeout(90_000);
      const relay = createRelay(request);
      try {
        for (let index = 0; index < 8; index += 1) await relay.turn(`Question ${index}. ${FILLER.repeat(3)}`);
        await openConversation(page, relay.conversationId);
        await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(16);
        await page.evaluate(() => { const el = document.getElementById("messages"); el.scrollTop = el.scrollHeight; });
        await expectAtBottom(page);
        await page.waitForTimeout(300);
        const asked = await page.evaluate(async () => {
          const { followsTranscriptEnd } = await import("/app/transcript-jump-bottom-view.mjs");
          const el = document.getElementById("messages");
          const row = document.createElement("div");
          row.style.height = "60px";
          el.appendChild(row);
          el.scrollTop = el.scrollHeight;
          const grown = document.createElement("div");
          grown.style.height = "200px";
          document.getElementById("input-area").prepend(grown);
          const distance = Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
          const follows = followsTranscriptEnd();
          row.remove();
          grown.remove();
          return { distance, follows };
        });
        expect(asked.distance).toBeGreaterThan(100);
        expect(asked.follows).toBe(true);
      } finally {
        await relay.cleanup();
      }
    });
  });
}

test.describe("phone keyboard", () => {
  test.use(DEVICES.phone);

  // Playwright cannot open a keyboard; Android resizes the layout for it
  // (interactive-widget=resizes-content), which shrinking the viewport with
  // the composer focused stands in for.
  test("the button stays above the composer with the keyboard open", async ({ page, request }) => {
    test.setTimeout(90_000);
    const relay = createRelay(request);
    try {
      for (let index = 0; index < 8; index += 1) await relay.turn(`Question ${index}. ${FILLER.repeat(3)}`);
      await openConversation(page, relay.conversationId);
      await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(16);
      await page.locator("#msg-input").focus();
      await page.setViewportSize({ width: DEVICES.phone.viewport.width, height: DEVICES.phone.viewport.height - 320 });
      await page.waitForTimeout(800);
      await scrollToScreensAbove(page, 2);
      const button = page.locator("#jump-to-bottom-btn");
      await expect(button).toBeVisible();
      await expectButtonPlacement(page);
      await button.tap();
      await expectAtBottom(page);
      // The tap leaves the composer focused (and the keyboard up).
      await expect(page.locator("#msg-input")).toBeFocused();
    } finally {
      await relay.cleanup();
    }
  });

  // A focused composer shows no keyboard until the next tap that leaves the
  // focus there: the page must not focus it on load, and with the keyboard
  // down the button lets the focus go.
  test("the button raises no keyboard: the composer is not focused on load, and a tap lets its focus go", async ({ page, request }) => {
    test.setTimeout(90_000);
    const relay = createRelay(request);
    try {
      for (let index = 0; index < 8; index += 1) await relay.turn(`Question ${index}. ${FILLER.repeat(3)}`);
      await openConversation(page, relay.conversationId);
      await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(16);
      const input = page.locator("#msg-input");
      const button = page.locator("#jump-to-bottom-btn");
      await expect(input).not.toBeFocused();

      await scrollToScreensAbove(page, 2);
      await expect(button).toBeVisible();
      await button.tap();
      await expectAtBottom(page);
      await expect(input).not.toBeFocused();

      // Focused with the keyboard down (the viewport keeps its height).
      await input.focus();
      await scrollToScreensAbove(page, 2);
      await expect(button).toBeVisible();
      await button.tap();
      await expectAtBottom(page);
      await expect(input).not.toBeFocused();
    } finally {
      await relay.cleanup();
    }
  });
});

test("on a desktop the composer is focused on load and keeps its focus through a click on the button", async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.setViewportSize(DEVICES.desktop.viewport);
  const relay = createRelay(request);
  try {
    for (let index = 0; index < 10; index += 1) await relay.turn(`Question ${index}. ${FILLER.repeat(3)}`);
    await openConversation(page, relay.conversationId);
    await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(20);
    const input = page.locator("#msg-input");
    await expect(input).toBeFocused();
    await scrollToScreensAbove(page, 2);
    const button = page.locator("#jump-to-bottom-btn");
    await expect(button).toBeVisible();
    await button.click();
    await expectAtBottom(page);
    await expect(input).toBeFocused();
  } finally {
    await relay.cleanup();
  }
});

// A turn ending reloads the conversation. The reload used to keep the
// position it found when it was asked for, so a reader who scrolled up and
// pressed the button while it was on its way was put back up there, and the
// next rows were not followed.
test("a reload on its way when the button is pressed leaves the reader at the end", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(DEVICES.desktop.viewport);
  const relay = createRelay(request);
  try {
    for (let index = 0; index < 10; index += 1) await relay.turn(`Question ${index}. ${FILLER.repeat(3)}`);
    await openConversation(page, relay.conversationId);
    await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(20);
    await page.evaluate(() => { const el = document.getElementById("messages"); el.scrollTop = el.scrollHeight; });
    await expectAtBottom(page);
    await scrollToScreensAbove(page, 2);
    const button = page.locator("#jump-to-bottom-btn");
    await expect(button).toBeVisible();

    const held = [];
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const isConversationLoad = (url) => url.pathname === `/api/conversation/${relay.conversationId}`;
    await page.route(isConversationLoad, async (route) => {
      held.push(route.request().url());
      await gate;
      await route.continue();
    });
    await relay.turn("Asked while the reader is up", `Answered. ${FILLER}`);
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await button.click();
    await expectAtBottom(page);
    release();
    await page.waitForTimeout(1_000);
    await page.unroute(isConversationLoad);
    await expectAtBottom(page);

    await relay.turn("And the next one", `Followed after the reload. ${FILLER.repeat(3)}`);
    await expect(page.locator("#messages .msg.assistant").last()).toContainText("Followed after the reload.");
    await expectAtBottom(page);
  } finally {
    await relay.cleanup();
  }
});

// The reload at the end of a turn rebuilds the transcript from its answer. A
// row from another client that landed while the request was on its way was
// not in that answer, and the rebuild took it off the page again.
test("a row that arrives while a reload is on its way stays on the page", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(DEVICES.desktop.viewport);
  const relay = createRelay(request);
  const isConversationLoad = (url) => url.pathname === `/api/conversation/${relay.conversationId}`;
  try {
    for (let index = 0; index < 4; index += 1) await relay.turn(`Question ${index}. ${FILLER}`);
    await openConversation(page, relay.conversationId);
    await expect(page.locator("#messages .msg[data-message-id]")).toHaveCount(8);

    // Each answer is read from the relay at once and handed to the page only
    // once the gate opens, so what the page gets is the conversation as it
    // was when it asked.
    const held = [];
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route(isConversationLoad, async (route) => {
      const response = await route.fetch();
      held.push(route.request().url());
      await gate;
      await route.fulfill({ response });
    });
    await relay.turn("Asked before the row", `Answered. ${FILLER}`);
    await expect.poll(() => held.length).toBeGreaterThan(0);

    const late = await relay.queue("A question from the other device");
    const row = page.locator(`#messages .msg[data-message-id="${late.messageId}"]`);
    await expect(row).toHaveCount(1);
    release();
    await page.waitForTimeout(1_500);
    await expect(row).toHaveCount(1);
    await expect(page.locator("#messages .msg.assistant").last()).toContainText("Answered.");

    await relay.dequeue(late.messageId);
    await relay.answer(late.messageId, `Late answer. ${FILLER}`);
    await expect(page.locator("#messages .msg.assistant").last()).toContainText("Late answer.");
  } finally {
    await page.unroute(isConversationLoad).catch(() => {});
    await relay.cleanup();
  }
});

test("a jump into the history comes back to the conversation's end", async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(DEVICES.desktop.viewport);
  const relay = createRelay(request);
  try {
    const ids = [];
    for (let index = 0; index < 32; index += 1) ids.push(await relay.turn(`Question ${index}. ${FILLER}`, `Answer ${index}. ${FILLER}`));
    await openConversation(page, relay.conversationId);
    await page.evaluate(({ id, focus }) => window.openConversation(id, { focusMessageId: focus }), { id: relay.conversationId, focus: ids[2] });
    await expect(page.locator(`#messages .msg[data-message-id="${ids[2]}"]`)).toBeVisible();
    await expect(page.locator(`#messages .msg[data-message-id="${ids[31]}"]`)).toHaveCount(0);
    const button = page.locator("#jump-to-bottom-btn");
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.locator(`#messages .msg[data-message-id="${ids[31]}"]`)).toHaveCount(1);
    await expect(page.locator("#messages .msg.assistant").last()).toContainText("Answer 31.");
    await expectAtBottom(page);
    await expect(button).toBeHidden();
  } finally {
    await relay.cleanup();
  }
});
