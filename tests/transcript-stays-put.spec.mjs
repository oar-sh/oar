import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * The transcript stays where the reader is. It moves by itself in two cases
 * only: the reader is at the end, or the reader has just sent a message.
 *
 * Without a model, on a relay of the spec's own (the agent-sessions setting
 * is switched on for the approval card and the event row): the spec plays the
 * worker (GET /api/pending, POST /api/stream, POST /api/response), asks
 * questions (POST /api/relay-question), posts boards (POST /api/relay-board),
 * queues another relay's prompt (POST /api/message with an `origin`) and
 * subscribes one conversation to another (POST /api/remote-relays/tool).
 *
 * One test per thing that can land while the reader is scrolled up: an event
 * row, another agent's prompt, a question card, an approval card, a board, a
 * streamed reply, a reload of the conversation. Each waits until the thing is
 * on the page, then asserts that scrollTop did not change by a pixel, that
 * the row the reader looks at did not move, and that the jump-to-bottom
 * button shows the right state: `new` for something new below, `question`
 * for a card that waits for an answer.
 *
 * Where the rows are rebuilt with another height above the reader (a reload
 * that brings a longer message, the reply that takes the live bubble's
 * place, Hide on a message), scrollTop has to change: there the row the
 * reader looks at is what must not move.
 *
 * "At the end" is one margin (8% of the viewport, 12 to 48 px): a reader
 * ten pixels above the end is at the end.
 *
 * The counter-cases: at the end the transcript still follows, the reader's
 * own send jumps to the end once, and with the setting switched off it does
 * not.
 */

const FILLER = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
const REMOTE_ORIGIN = {
  relayId: "relay-fixture-stay",
  relayName: "win-test",
  conversationId: "conv-fixture-stay-lead",
  conversationTitle: "nightly digest",
  model: "claude-fixture",
  hops: 1,
};
const DEVICES = {
  desktop: { viewport: { width: 1280, height: 860 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
};
const SEND_SETTING_KEY = "copilot_scroll_on_send";

let relay = null;
let heartbeat = null;

async function api(route, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${relay.baseUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function post(route, body, headers) {
  const result = await api(route, { method: "POST", body, headers });
  expect(result.status, `${route}: ${JSON.stringify(result.payload)}`).toBe(200);
  return result.payload;
}

// A conversation and the worker's side of it.
function createConversation({ bound = true } = {}) {
  let conversationId = "";
  let ownerSessionId = "";

  async function dequeue(messageId) {
    const headers = ownerSessionId ? { "x-relay-session-id": ownerSessionId } : {};
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const message = (await api("/api/pending", { headers })).payload?.message || null;
      if (!message) { await sleep(120); continue; }
      if (String(message.id) === String(messageId)) return;
      await api("/api/requeue", { method: "POST", body: { messageId: String(message.id) } });
      await sleep(100);
    }
    throw new Error(`timed out dequeuing ${messageId}`);
  }

  async function queue(text, extra = {}) {
    const body = await post("/api/message", {
      text, relayMode: "agent", model: "gpt-5.4-mini", conversationId: conversationId || undefined, ...extra,
    });
    if (conversationId) return String(body.messageId);
    conversationId = String(body.conversationId || "");
    ownerSessionId = String(body.ownerSessionId || "");
    return String(body.messageId);
  }

  async function bind() {
    await post("/api/session-sync", { sdk_session_id: `pw-stay-${randomUUID()}`, conversation_id: conversationId });
  }

  function answer(messageId, text) {
    return post("/api/response", { messageId, conversationId, text, model: "gpt-5.4-mini", mode: "agent" });
  }

  async function turn(text, reply = `Answer to ${text}. ${FILLER.repeat(3)}`) {
    const first = !conversationId;
    const messageId = await queue(text);
    await dequeue(messageId);
    if (first && bound) await bind();
    await answer(messageId, reply);
    return messageId;
  }

  // A message the "worker" has taken: the turn runs until it is answered.
  async function runningTurn(text, extra = {}) {
    const first = !conversationId;
    const messageId = await queue(text, extra);
    await dequeue(messageId);
    if (first && bound) await bind();
    return messageId;
  }

  function stream(messageId, text) {
    return post("/api/stream", { messageId, conversationId, text, mode: "agent", done: false });
  }

  function ask(messageId, prompt, choices = ["Ship it", "Wait"]) {
    return post("/api/relay-question", {
      queueId: messageId, messageId, conversationId, mode: "agent", prompt, choices, allowFreeform: true, timeout_ms: 120_000,
    });
  }

  function board(messageId) {
    return post("/api/relay-board", {
      queueId: messageId,
      messageId,
      conversationId,
      mode: "plan",
      boardType: "plan_ready",
      title: "Plan ready for review",
      body: "1. Rename the module\n2. Update the imports",
      actions: [
        { id: "autopilot", label: "Implement in autopilot", mode: "autopilot" },
        { id: "exit_only", label: "Exit plan mode" },
      ],
      recommendedAction: "autopilot",
    });
  }

  function hideFromShares(messageId, hidden) {
    return api(`/api/conversation/${encodeURIComponent(conversationId)}/message/${encodeURIComponent(messageId)}/share-visibility`, {
      method: "PATCH", body: { hiddenFromShares: hidden },
    });
  }

  function backgroundTasks(count) {
    const now = Date.now();
    const tasks = Array.from({ length: count }, (_, index) => ({
      taskId: `stay-${now}-${index}`,
      taskType: "local_agent",
      subagentType: "general-purpose",
      description: `Index the fixtures ${index}`,
      startedAt: now,
      model: "claude-fixture",
      lastToolCall: "Tool (Bash): npm test -- --grep fixtures",
      totalTokens: 1000,
    }));
    return post("/api/background-tasks", { conversationId, tasks });
  }

  function tool(action, args = {}) {
    return api("/api/remote-relays/tool", { method: "POST", body: { conversationId, action, args } });
  }

  async function pendingCards() {
    const { payload } = await api(`/api/relay-questions?status=pending&conversationId=${encodeURIComponent(conversationId)}`);
    return payload?.questions || [];
  }

  async function approvalCard() {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const card = (await pendingCards()).find((question) => question?.context?.source === "remote_relay");
      if (card) return card;
      await sleep(150);
    }
    throw new Error("no approval card appeared");
  }

  function answerCard(card, answer) {
    return post(`/api/relay-question/${encodeURIComponent(card.id)}/answer`, {
      answer, ...(card.sdkSessionId ? { sdk_session_id: card.sdkSessionId } : {}),
    });
  }

  return {
    queue, dequeue, bind, answer, turn, runningTurn, stream, hideFromShares, backgroundTasks, ask, board, tool, pendingCards, approvalCard, answerCard,
    get conversationId() { return conversationId; },
  };
}

// Long enough for several screens on either viewport.
async function longConversation(turns = 8, { bound = true } = {}) {
  const conversation = createConversation({ bound });
  for (let index = 0; index < turns; index += 1) await conversation.turn(`Question ${index}. ${FILLER.repeat(3)}`);
  return conversation;
}

async function openConversation(page, conversationId, { storage = {} } = {}) {
  await page.addInitScript(({ id, entries }) => {
    localStorage.setItem("copilot_last_conv", id);
    for (const [key, value] of Object.entries(entries)) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    }
  }, { id: conversationId, entries: storage });
  await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("#messages .msg[data-message-id]").first()).toBeVisible();
}

function distanceFromEnd(page) {
  return page.evaluate(() => {
    const el = document.getElementById("messages");
    return Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
  });
}

async function expectAtEnd(page) {
  await expect.poll(() => distanceFromEnd(page), { timeout: 5_000 }).toBeLessThanOrEqual(1);
}

async function goToEnd(page) {
  await page.evaluate(() => { const el = document.getElementById("messages"); el.scrollTop = el.scrollHeight; });
  await expectAtEnd(page);
}

// What the reader sees: scrollTop, and where the first row that starts
// inside the viewport sits. Content of another height above the reader moves
// the second while a check of the first alone passes, and the other way
// round.
function readingPosition(page) {
  return page.evaluate(() => {
    const el = document.getElementById("messages");
    const box = el.getBoundingClientRect();
    const rows = Array.from(el.querySelectorAll(".msg[data-message-id]")).filter((node) => node.id !== "thinking-indicator");
    // A row taller than the viewport has no row starting in it: then the one
    // that crosses its top edge.
    const row = rows.find((node) => node.getBoundingClientRect().top >= box.top && node.getBoundingClientRect().top < box.bottom)
      || rows.find((node) => node.getBoundingClientRect().bottom > box.top);
    return {
      scrollTop: el.scrollTop,
      row: row?.dataset.messageId || "",
      rowTop: row ? Math.round((row.getBoundingClientRect().top - box.top) * 100) / 100 : null,
    };
  });
}

// Scrolls the reader `screens` above the end (or `pixels`), lets the page
// settle, and starts a log of every scroll position that differs from that
// one.
async function readFromAbove(page, screens = 2, { pixels = null } = {}) {
  await page.evaluate(({ count, px }) => {
    const el = document.getElementById("messages");
    const up = px === null ? Math.round(el.clientHeight * count) : px;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - up);
  }, { count: screens, px: pixels });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const el = document.getElementById("messages");
    const start = el.scrollTop;
    window.__transcriptMoves = [];
    el.addEventListener("scroll", () => {
      if (el.scrollTop !== start) window.__transcriptMoves.push(el.scrollTop);
    }, { passive: true });
  });
  const position = await readingPosition(page);
  expect(position.scrollTop).toBeGreaterThan(0);
  expect(position.row).not.toBe("");
  return position;
}

// Not a pixel: the position is the same, and no scroll event saw another one
// in between. Call it once what was sent is on the page (a row, a card, the
// streamed text): on a busy machine "nothing moved" is also true of an event
// that has not arrived yet. It is asserted at once and again a moment later,
// for what the page does after the event (a reload, a second restore).
async function expectStayedPut(page, position) {
  const read = async () => ({ moves: await page.evaluate(() => window.__transcriptMoves), ...(await readingPosition(page)) });
  expect(await read()).toEqual({ moves: [], ...position });
  await page.waitForTimeout(1_200);
  expect(await read()).toEqual({ moves: [], ...position });
}

// For rebuilds that change the height of what is above the reader: the row
// they look at is where it was; scrollTop is whatever that takes.
// scrollTop is set here, and a phone's screen has three device pixels to
// one: the row may land a fraction of a pixel off, never a whole one.
async function expectRowStayedPut(page, position) {
  const check = async () => {
    const now = await readingPosition(page);
    expect(now.row).toBe(position.row);
    expect(Math.abs(now.rowTop - position.rowTop)).toBeLessThan(1);
  };
  await check();
  await page.waitForTimeout(1_200);
  await check();
}

// The next load of the conversation the page makes, after `trigger`.
async function reloadAfter(page, conversationId, trigger) {
  const loaded = page.waitForResponse((response) => response.url().includes(`/api/conversation/${conversationId}`)
    && response.request().method() === "GET");
  await trigger();
  await loaded;
  // The answer is put on the page in the same task that reads it.
  await page.waitForTimeout(150);
}

// From now on every load of the conversation brings its first message with
// more text: what is above the reader comes back taller.
async function growEarlierMessage(page, conversationId) {
  const state = { on: false };
  await page.route(`**/api/conversation/${conversationId}?*`, async (route) => {
    if (route.request().method() !== "GET" || !state.on) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const target = (body.messages || [])[0];
    if (target) target.text = `${target.text}\n\nAdded since. ${FILLER.repeat(6)}`;
    return route.fulfill({ response, json: body });
  });
  return { start() { state.on = true; } };
}

// Where a block of text sits inside the transcript's viewport, and a scroll
// that puts it `offset` pixels below the top edge.
function blockTop(page, tag, prefix) {
  return page.evaluate(({ selector, starts }) => {
    const el = document.getElementById("messages");
    const node = Array.from(el.querySelectorAll(selector)).find((candidate) => candidate.textContent.startsWith(starts));
    return node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
  }, { selector: tag, starts: prefix });
}

// The block is `offset` pixels below the top edge. scrollTop takes whole
// pixels and text sits on fractions of one, so the page puts a block back up
// to half a pixel off (and leaves half a pixel alone), never a whole one.
async function expectBlockAt(page, tag, prefix, offset) {
  const top = await blockTop(page, tag, prefix);
  expect(top).not.toBeNull();
  expect(Math.abs(top - offset)).toBeLessThan(1);
}

// Scrolls the block to about `offset` pixels below the top edge and returns
// where it is: the whole-pixel scrollTop puts it a fraction of a pixel off
// that, and what has to stay put is where the reader reads it.
async function readBlockAt(page, tag, prefix, offset = 40) {
  await page.evaluate(({ selector, starts, at }) => {
    const el = document.getElementById("messages");
    const node = Array.from(el.querySelectorAll(selector)).find((candidate) => candidate.textContent.startsWith(starts));
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - at;
  }, { selector: tag, starts: prefix, at: offset });
  await page.waitForTimeout(500);
  const top = await blockTop(page, tag, prefix);
  expect(top).not.toBeNull();
  expect(Math.abs(top - offset)).toBeLessThan(1);
  return top;
}

// Marks the message rows on the page now. A render rebuilds them, so the
// returned locator finds none once one has landed.
async function markRowsDrawnBefore(page) {
  await page.evaluate(() => {
    for (const row of document.querySelectorAll("#messages > .msg[data-message-id]")) row.dataset.drawnBefore = "1";
  });
  return page.locator("#messages > .msg[data-message-id][data-drawn-before]");
}

// Requests to `pattern` wait until release() is called; release() returns
// once the first of them is answered (`awaitAnswer: false`: at once).
async function holdRequests(page, pattern, method = null, { awaitAnswer = true } = {}) {
  let open = null;
  const held = new Promise((resolve) => { open = resolve; });
  await page.route(pattern, async (route) => {
    if (method && route.request().method() !== method) return route.continue();
    await held;
    return route.continue();
  });
  const answered = page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    const glob = pattern.replace(/^\*\*/, "").split("*");
    return glob.every((part) => path.includes(part)) && (!method || response.request().method() === method);
  });
  answered.catch(() => {});
  return { async release() { open(); if (awaitAnswer) await answered; } };
}

function jumpButton(page) {
  return page.locator("#jump-to-bottom-btn");
}

async function expectButton(page, state, { badge = null, label = null } = {}) {
  const button = jumpButton(page);
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("data-state", state);
  if (badge !== null) await expect(button.locator(".jump-to-bottom-badge")).toHaveText(badge);
  if (label !== null) await expect(button).toHaveAttribute("aria-label", label);
}

async function press(page, locator, touch) {
  if (touch) await locator.tap();
  else await locator.click();
}

test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  relay = await startRelayServer({ token: randomUUID() });
  // A relay that hears from no worker hands running turns back to the queue.
  heartbeat = setInterval(() => { api("/api/heartbeat", { method: "POST", body: {} }).catch(() => {}); }, 2_000);
  await post("/api/models/snapshot", { source: "e2e-harness:copilot-ready", models: ["gpt-5.4-mini"] });
  await post("/api/settings/pwa-app-name", { appName: "bench-relay" });
  await post("/api/settings/agent-sessions", { enabled: true });
});

test.afterAll(async () => {
  clearInterval(heartbeat);
  heartbeat = null;
  if (relay) await relay.stop();
  relay = null;
});

for (const [name, device] of Object.entries(DEVICES)) {
  test.describe(name, () => {
    test.use(device);
    const touch = !!device.hasTouch;

    test("a relay event row arrives: the reader stays, the button counts it", async ({ page }) => {
      const watched = createConversation();
      const watchedTurn = await watched.runningTurn(`orbit camera ${randomUUID().slice(0, 8)}`);
      const reader = await longConversation();
      // The subscription is asked for inside a turn and approved on its card.
      const subscribingTurn = await reader.runningTurn("Watch the orbit camera session");
      const subscribing = reader.tool("subscribe", { sessions: [watched.conversationId] });
      await reader.answerCard(await reader.approvalCard(), "Allow");
      expect((await subscribing).status).toBe(200);
      await reader.answer(subscribingTurn, `Watching it. ${FILLER}`);

      await openConversation(page, reader.conversationId);
      await goToEnd(page);
      const position = await readFromAbove(page);

      await watched.ask(watchedTurn, "Merge the orbit camera branch now?", ["Merge", "Wait"]);
      await expect(page.locator("#messages .msg.relay-event")).toHaveCount(1);
      await expectStayedPut(page, position);
      await expectButton(page, "new", { badge: "1", label: "Jump to the latest message (1 new)" });
    });

    test("another agent's prompt arrives: the reader stays, the button counts it", async ({ page }) => {
      const reader = await longConversation();
      await openConversation(page, reader.conversationId);
      await goToEnd(page);
      const position = await readFromAbove(page);

      const prompt = await reader.queue("report builder: list the totals", { origin: REMOTE_ORIGIN });
      await expect(page.locator(`#messages > .msg[data-message-id="${prompt}"]`)).toHaveCount(1);
      await expectStayedPut(page, position);
      await expectButton(page, "new", { badge: "1" });

      // The worker takes it and answers: still not a pixel, through the
      // reload that follows the turn.
      await reader.dequeue(prompt);
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      await reloadAfter(page, reader.conversationId, () => reader.answer(prompt, "Totals: 42 rows, 3 sheets."));
      await expect(page.locator("#messages .msg.assistant").last()).toContainText("Totals: 42 rows");
      await expectStayedPut(page, position);
      await expectButton(page, "new");
    });

    test("a question card arrives: the reader stays, the button says a question waits", async ({ page }) => {
      const reader = await longConversation();
      const running = await reader.runningTurn("Prepare the release");
      await openConversation(page, reader.conversationId);
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      await goToEnd(page);
      const position = await readFromAbove(page);

      await reader.ask(running, "Ship the release today?");
      const card = page.locator("#messages .relay-question-container");
      await expect(card).toHaveCount(1);
      await expectStayedPut(page, position);
      await expectButton(page, "question", { label: "A question is waiting for your answer. Jump to it" });
      await expect(page.locator("#jump-to-bottom-status")).toHaveText("A question is waiting for your answer below.");

      // A second card while the first still waits.
      await reader.ask(running, "And tag it?");
      await expect(card).toHaveCount(2);
      await expectStayedPut(page, position);
      await expectButton(page, "question");

      // The button brings the reader to the cards, and is done.
      await press(page, jumpButton(page), touch);
      await expectAtEnd(page);
      await expect(jumpButton(page)).toBeHidden();
      await expect(card.last()).toBeInViewport();
    });

    test("ten pixels above the end is at the end: a card that arrives is shown", async ({ page }) => {
      const reader = await longConversation();
      const running = await reader.runningTurn("Prepare the release");
      await openConversation(page, reader.conversationId);
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      await goToEnd(page);
      await page.evaluate(() => { document.getElementById("messages").scrollTop -= 10; });
      await page.waitForTimeout(400);
      expect(await distanceFromEnd(page)).toBe(10);

      await reader.ask(running, "Ship the release today?");
      const card = page.locator("#messages .relay-question-container");
      await expect(card).toHaveCount(1);
      await expect(card.locator(".relay-question-choice").first()).toBeInViewport();
      await expect(jumpButton(page)).toBeHidden();

      // And a row that arrives is followed from there too.
      const [pending] = await reader.pendingCards();
      await reader.answerCard(pending, "Wait");
      await expect(card).toHaveCount(0);
      await goToEnd(page);
      await page.evaluate(() => { document.getElementById("messages").scrollTop -= 10; });
      await page.waitForTimeout(400);
      const prompt = await reader.queue("report builder: list the totals", { origin: REMOTE_ORIGIN });
      await expect(page.locator(`#messages > .msg[data-message-id="${prompt}"]`)).toHaveCount(1);
      await expectAtEnd(page);
    });

    test("a question answered elsewhere clears the question state", async ({ page }) => {
      const reader = await longConversation();
      const running = await reader.runningTurn("Prepare the release");
      await openConversation(page, reader.conversationId);
      await goToEnd(page);
      const position = await readFromAbove(page);

      await reader.ask(running, "Ship the release today?");
      await expectButton(page, "question");
      const [card] = await reader.pendingCards();
      await reader.answerCard(card, "Wait");
      await expect(page.locator("#messages .relay-question-container")).toHaveCount(0);
      await expectStayedPut(page, position);
      await expect(jumpButton(page)).not.toHaveAttribute("data-state", "question");

      // Another conversation starts plain.
      const other = await longConversation(2);
      await reader.ask(running, "Ship it tomorrow then?");
      await expectButton(page, "question");
      await page.evaluate((id) => window.openConversation(id), other.conversationId);
      await expect(page.locator("#messages .relay-question-container")).toHaveCount(0);
      await expect(jumpButton(page)).toBeHidden();
      await expect(jumpButton(page)).toHaveAttribute("data-state", "plain");
    });

    test("an approval card arrives: the reader stays, the button says a question waits", async ({ page }) => {
      const watched = createConversation();
      await watched.runningTurn(`dolly track ${randomUUID().slice(0, 8)}`);
      const reader = await longConversation();
      await reader.runningTurn("Watch the dolly track session");
      await openConversation(page, reader.conversationId);
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      await goToEnd(page);
      const position = await readFromAbove(page);

      const subscribing = reader.tool("subscribe", { sessions: [watched.conversationId] }).catch(() => null);
      try {
        const card = page.locator("#messages .relay-question-container");
        await expect(card).toHaveCount(1);
        await expect(card).toContainText("wants to watch");
        await expectStayedPut(page, position);
        await expectButton(page, "question");
      } finally {
        // The tool call waits for the card's answer.
        await reader.answerCard(await reader.approvalCard(), "Deny");
        await subscribing;
      }
    });

    test("a board arrives: the reader stays, the button says a question waits", async ({ page }) => {
      const reader = await longConversation();
      const running = await reader.runningTurn("Plan the change");
      await openConversation(page, reader.conversationId);
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      await goToEnd(page);
      const position = await readFromAbove(page);

      await reader.board(running);
      await expect(page.locator("#messages .relay-board-inline")).toHaveCount(1);
      await expectStayedPut(page, position);
      await expectButton(page, "question");
    });

    test("a reply streams in and ends: the reader stays, the button says there is news", async ({ page }) => {
      const reader = await longConversation();
      const running = await reader.runningTurn("Write the summary");
      await openConversation(page, reader.conversationId);
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      await goToEnd(page);
      // Half a screen up: closer than the plain button shows at.
      const position = await readFromAbove(page, 0.5);
      await expect(jumpButton(page)).toBeHidden();

      let text = "";
      for (let step = 0; step < 6; step += 1) {
        text += `Paragraph ${step}. ${FILLER.repeat(2)}\n\n`;
        await reader.stream(running, text);
        await expect(page.locator("#thinking-indicator")).toContainText(`Paragraph ${step}.`);
      }
      await expectStayedPut(page, position);
      await expectButton(page, "new", { label: "Jump to the latest message (new below)" });
      await expect(page.locator("#jump-to-bottom-status")).toHaveText("New messages below.");

      await reloadAfter(page, reader.conversationId, () => reader.answer(running, text));
      await expect(page.locator("#messages .msg.assistant").last()).toContainText("Paragraph 5.");
      await expect(page.locator("#thinking-indicator")).toHaveCount(0);
      await expectStayedPut(page, position);
      await expectButton(page, "new");
    });

    test("a stream frame the page drops is no news", async ({ page }) => {
      const reader = await longConversation();
      const done = await reader.runningTurn("Write the summary");
      const frames = { count: 0 };
      page.on("websocket", (socket) => socket.on("framereceived", (frame) => {
        if (String(frame.payload).includes("relay_stream")) frames.count += 1;
      }));
      await openConversation(page, reader.conversationId);
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      await goToEnd(page);
      // The turn ends while the reader is at the end; then they scroll up.
      await reloadAfter(page, reader.conversationId, () => reader.answer(done, `Summary. ${FILLER}`));
      await expect(page.locator("#messages .msg.assistant").last()).toContainText("Summary.");
      await expect(page.locator("#thinking-indicator")).toHaveCount(0);
      await page.waitForTimeout(1_000);
      const position = await readFromAbove(page);
      await expectButton(page, "plain");
      frames.count = 0;

      // A frame for a turn that has ended, as a slow worker sends it; the
      // test reads the socket's frames to know that it arrived.
      await post("/api/stream", { messageId: done, conversationId: reader.conversationId, text: "Late text", mode: "agent", done: false });
      await expect.poll(() => frames.count).toBeGreaterThan(0);
      await page.waitForTimeout(300);
      await expect(page.locator("#thinking-indicator")).toHaveCount(0);
      await expectStayedPut(page, position);
      await expectButton(page, "plain");
    });

    for (const block of ["paragraph", "code block"]) {
      test(`the reply lands while the reader reads its streamed text: the ${block} they read stays`, async ({ page }) => {
        const reader = await longConversation(4);
        const running = await reader.runningTurn("Write the long summary");
        await openConversation(page, reader.conversationId);
        await expect(page.locator("#thinking-indicator")).toHaveCount(1);
        await goToEnd(page);
        let text = "";
        for (let step = 0; step < 14; step += 1) {
          text += step === 3 && block === "code block"
            ? `\`\`\`js\n${Array.from({ length: 9 }, (_, line) => `const fixture${line} = ${line};`).join("\n")}\n\`\`\`\n\n`
            : `Paragraph ${step}. ${FILLER.repeat(3)}\n\n`;
        }
        await reader.stream(running, text);
        await expect(page.locator("#thinking-indicator")).toContainText("Paragraph 13.");

        const selector = block === "code block" ? "pre" : "p";
        const starts = block === "code block" ? "const fixture0" : "Paragraph 3.";
        const read = await readBlockAt(page, selector, starts);
        expect(await distanceFromEnd(page)).toBeGreaterThan(200);

        await reloadAfter(page, reader.conversationId, () => reader.answer(running, text));
        await expect(page.locator("#thinking-indicator")).toHaveCount(0);
        await expect(page.locator("#messages .msg.assistant").last()).toContainText("Paragraph 13.");
        await expectBlockAt(page, selector, starts, read);
        await page.waitForTimeout(1_200);
        await expectBlockAt(page, selector, starts, read);
      });
    }

    test("the reply lands while the reader looks at rows below the live bubble: they stay", async ({ page }) => {
      const reader = await longConversation(4);
      const running = await reader.runningTurn("Write the long summary");
      await openConversation(page, reader.conversationId);
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      // Messages sent during the turn wait below its live bubble.
      const waiting = [];
      for (let index = 0; index < 6; index += 1) waiting.push(await reader.queue(`While you work, item ${index}. ${FILLER.repeat(3)}`));
      await expect(page.locator(`#messages > .msg[data-message-id="${waiting[5]}"]`)).toHaveCount(1);
      let text = "";
      for (let step = 0; step < 8; step += 1) text += `Paragraph ${step}. ${FILLER.repeat(3)}\n\n`;
      await reader.stream(running, text);
      await expect(page.locator("#thinking-indicator")).toContainText("Paragraph 7.");
      await goToEnd(page);
      const position = await readFromAbove(page, 0, { pixels: 200 });
      expect(await page.evaluate(() => {
        const el = document.getElementById("messages");
        return document.getElementById("thinking-indicator").getBoundingClientRect().bottom <= el.getBoundingClientRect().top;
      })).toBe(true);

      await reloadAfter(page, reader.conversationId, () => reader.answer(running, `Short answer. ${FILLER}`));
      await expect(page.locator("#thinking-indicator")).toHaveCount(0);
      await expect(page.locator("#messages .msg.assistant").last()).toContainText("Short answer.");
      await expectRowStayedPut(page, position);
      expect(await distanceFromEnd(page)).toBeGreaterThan(150);
    });

    test("the conversation reloads with a longer message above the reader: the row they read stays", async ({ page }) => {
      const reader = await longConversation();
      // A running turn keeps the live poll reloading the conversation.
      await reader.runningTurn("Keep working");
      const grow = await growEarlierMessage(page, reader.conversationId);
      await openConversation(page, reader.conversationId);
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      await goToEnd(page);
      const position = await readFromAbove(page);

      grow.start();
      await expect(page.locator("#messages .msg[data-message-id]").first()).toContainText("Added since.");
      await expectRowStayedPut(page, position);
      expect((await readingPosition(page)).scrollTop).toBeGreaterThan(position.scrollTop);
      // A reload is no news.
      await expectButton(page, "plain");
    });

    test("a worker binds the conversation's session: the page opens it again where the reader was", async ({ page }) => {
      // A conversation takes no second message before it is bound: one
      // turn, with a reply long enough to scroll in.
      const reader = createConversation({ bound: false });
      let reply = "";
      for (let step = 0; step < 24; step += 1) reply += `Paragraph ${step}. ${FILLER.repeat(3)}\n\n`;
      await reader.turn(`Summarise this. ${FILLER.repeat(4)}`, reply);
      const grow = await growEarlierMessage(page, reader.conversationId);
      await openConversation(page, reader.conversationId);
      await goToEnd(page);
      const read = await readBlockAt(page, "p", "Paragraph 9.");

      // Opened again, the question above the reader has grown.
      grow.start();
      await reloadAfter(page, reader.conversationId, () => reader.bind());
      await expect(page.locator("#messages .msg[data-message-id]").first()).toContainText("Added since.");
      await expectBlockAt(page, "p", "Paragraph 9.", read);
      await page.waitForTimeout(1_200);
      await expectBlockAt(page, "p", "Paragraph 9.", read);
    });

    test("Hide on a message while scrolled up leaves the reader where they are", async ({ page }) => {
      const reader = await longConversation();
      await openConversation(page, reader.conversationId);
      await goToEnd(page);
      const position = await readFromAbove(page);

      const row = page.locator(`#messages > .msg[data-message-id="${position.row}"]`);
      const toggle = row.locator('[data-action="toggle-share-visibility"]');
      await reloadAfter(page, reader.conversationId, () => toggle.evaluate((node) => node.click()));
      await expect(row.locator('[data-action="toggle-share-visibility"]')).toHaveAttribute("data-hidden-from-shares", "true");
      await expectRowStayedPut(page, position);
      expect((await readingPosition(page)).scrollTop).toBeGreaterThan(position.scrollTop - 60);

      // And Unhide.
      await reloadAfter(page, reader.conversationId, () => row.locator('[data-action="toggle-share-visibility"]').evaluate((node) => node.click()));
      await expect(row.locator('[data-action="toggle-share-visibility"]')).toHaveAttribute("data-hidden-from-shares", "false");
      await expectRowStayedPut(page, position);
    });

    test("a render held back by a text selection lands where the reader is", async ({ page }) => {
      const reader = await longConversation();
      await openConversation(page, reader.conversationId);
      await goToEnd(page);
      const position = await readFromAbove(page);

      // The reader selects a word of the row they read; rebuilds wait.
      await page.evaluate((id) => {
        const paragraph = document.querySelector(`#messages > .msg[data-message-id="${id}"] p`)
          || document.querySelector(`#messages > .msg[data-message-id="${id}"]`);
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }, position.row);
      await page.waitForTimeout(300);
      // Meanwhile a message of theirs is hidden on another device, and a turn
      // runs and ends: the reload that follows it is held back.
      const first = await page.locator("#messages > .msg.user[data-message-id]").first().getAttribute("data-message-id");
      expect((await reader.hideFromShares(first, true)).status).toBe(200);
      const turn = await reader.queue("One more question from the other device");
      await reader.dequeue(turn);
      await reloadAfter(page, reader.conversationId, () => reader.answer(turn, `Its answer. ${FILLER}`));
      await page.waitForTimeout(600);
      // The Hide is drawn in place from the hidden list, the selection kept;
      // the render waits, so the rows are still the ones drawn before it.
      await expect(page.locator(`#messages > .msg[data-message-id="${first}"] .msg-hidden-label`)).toHaveCount(1);
      expect(await page.evaluate(() => window.getSelection().isCollapsed)).toBe(false);
      const drawnBefore = await markRowsDrawnBefore(page);
      await page.waitForTimeout(300);
      await expect(drawnBefore).not.toHaveCount(0);

      // The selection is released: the held render lands.
      await page.evaluate(() => window.getSelection().removeAllRanges());
      await expect(drawnBefore).toHaveCount(0);
      await expect(page.locator(`#messages > .msg[data-message-id="${first}"] .msg-hidden-label`)).toHaveCount(1);
      await expectRowStayedPut(page, position);
      expect((await readingPosition(page)).scrollTop).toBeGreaterThan(position.scrollTop - 60);
    });

    test("at the end the transcript still follows every one of them", async ({ page }) => {
      const reader = await longConversation();
      await openConversation(page, reader.conversationId);
      await goToEnd(page);

      const prompt = await reader.queue("report builder: list the totals", { origin: REMOTE_ORIGIN });
      await expect(page.locator(`#messages > .msg[data-message-id="${prompt}"]`)).toHaveCount(1);
      await expectAtEnd(page);
      await reader.dequeue(prompt);
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      await expectAtEnd(page);

      let text = "";
      for (let step = 0; step < 4; step += 1) {
        text += `Paragraph ${step}. ${FILLER.repeat(2)}\n\n`;
        await reader.stream(prompt, text);
        await expect(page.locator("#thinking-indicator")).toContainText(`Paragraph ${step}.`);
        await expectAtEnd(page);
      }

      await reader.ask(prompt, "Ship the release today?");
      const card = page.locator("#messages .relay-question-container");
      await expect(card).toHaveCount(1);
      await expect(card).toBeInViewport();
      await expect(jumpButton(page)).toBeHidden();
      const [pending] = await reader.pendingCards();
      await reader.answerCard(pending, "Wait");
      await expect(card).toHaveCount(0);

      await reader.board(prompt);
      const board = page.locator("#messages .relay-board-inline");
      await expect(board).toHaveCount(1);
      await expect(board.locator(".relay-board-action").last()).toBeInViewport();

      await reloadAfter(page, reader.conversationId, () => reader.answer(prompt, text));
      await expect(page.locator("#thinking-indicator")).toHaveCount(0);
      await expect(page.locator("#messages .msg.assistant").last()).toContainText("Paragraph 3.");
      await expectAtEnd(page);
      await expect(jumpButton(page)).toBeHidden();
    });

    test("the reader's own send jumps to the end; with the setting off it stays", async ({ page }) => {
      const reader = await longConversation();
      await openConversation(page, reader.conversationId);
      await goToEnd(page);
      await readFromAbove(page);

      const input = page.locator("#msg-input");
      await input.fill("My own first message");
      await press(page, page.locator("#send-btn"), touch);
      await expect(page.locator("#messages .msg.user").last()).toContainText("My own first message");
      await expectAtEnd(page);
      await expect(jumpButton(page)).toBeHidden();
      // The worker takes it and answers; the reader is at the end and follows.
      const pendingId = await page.locator("#messages .msg.user").last().getAttribute("data-message-id");
      await reader.dequeue(pendingId);
      await reloadAfter(page, reader.conversationId, () => reader.answer(pendingId, `Answered. ${FILLER}`));
      await expect(page.locator("#messages .msg.assistant").last()).toContainText("Answered.");
      await expectAtEnd(page);

      // Switched off in Settings › General.
      await page.evaluate(() => window.openSettingsModal("general"));
      const toggle = page.locator("#scroll-on-send-toggle");
      await expect(toggle).toBeChecked();
      await press(page, toggle, touch);
      await expect(toggle).not.toBeChecked();
      expect(await page.evaluate((key) => localStorage.getItem(key), SEND_SETTING_KEY)).toBe("0");
      await page.evaluate(() => window.closeSettingsModal());

      const position = await readFromAbove(page);
      await input.fill("My own second message");
      await press(page, page.locator("#send-btn"), touch);
      const sent = page.locator("#messages .msg.user").last();
      await expect(sent).toContainText("My own second message");
      await expectStayedPut(page, position);
      await expectButton(page, "new", { badge: "1" });
    });

    test("a reader at the end who sends is followed, whatever they touch before the relay answers", async ({ page }) => {
      const reader = await longConversation();
      // Large text: the live bubble the send puts up is taller than the
      // margin on either screen, so landing below the reader shows.
      await openConversation(page, reader.conversationId, { storage: { copilot_font_scale: "1.5" } });
      await goToEnd(page);
      const post = await holdRequests(page, "**/api/message", "POST");

      const input = page.locator("#msg-input");
      await input.fill("My own message");
      await press(page, page.locator("#send-btn"), touch);
      const sent = page.locator("#messages .msg.user").last();
      await expect(sent).toContainText("My own message");
      await expectAtEnd(page);

      // Inputs that move nothing, the reader being at the end already: a
      // wheel notch down, a key inside the transcript, a finger that drags.
      await page.evaluate(() => {
        const el = document.getElementById("messages");
        const row = el.querySelector(".msg.user:last-of-type") || el.lastElementChild;
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
        row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        if (typeof TouchEvent === "function") row.dispatchEvent(new TouchEvent("touchmove", { bubbles: true }));
      });
      if (!touch) {
        const box = await page.locator("#messages").boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 100);
      }
      await page.waitForTimeout(300);
      await expectAtEnd(page);

      // The relay answers, the worker takes the message, streams and replies:
      // the reader is at the end for all of it.
      // While the page's poll is held too, so the turn is running by the
      // time it next asks: the live bubble the send put up stays.
      const messageId = await sent.getAttribute("data-message-id");
      const poll = await holdRequests(page, `**/api/conversation/${reader.conversationId}?*`, "GET", { awaitAnswer: false });
      await post.release();
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      await reader.dequeue(messageId);
      await poll.release();
      await expect(page.locator("#thinking-indicator")).toHaveCount(1);
      await expectAtEnd(page);
      const text = `Paragraph 0. ${FILLER.repeat(4)}\n\nParagraph 1. ${FILLER.repeat(4)}`;
      await reader.stream(messageId, text);
      await expect(page.locator("#thinking-indicator")).toContainText("Paragraph 1.");
      await expectAtEnd(page);
      await reloadAfter(page, reader.conversationId, () => reader.answer(messageId, text));
      await expect(page.locator("#messages .msg.assistant").last()).toContainText("Paragraph 1.");
      await expectAtEnd(page);
      await expect(jumpButton(page)).toBeHidden();
    });
  });
}

test.describe("the reader moves while something of theirs is still on its way", () => {
  test.use(DEVICES.desktop);

  // A wheel over the transcript, as the reader turns it.
  async function wheelUp(page, pixels) {
    const box = await page.locator("#messages").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -pixels);
    await expect.poll(() => distanceFromEnd(page)).toBeGreaterThan(pixels - 60);
  }

  test("a send jumps once: a reader who scrolls up before the relay answers is not pulled down again", async ({ page }) => {
    const reader = await longConversation();
    await openConversation(page, reader.conversationId);
    await goToEnd(page);
    // The relay takes its time with the message.
    let release = null;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/message", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await held;
      return route.continue();
    });
    const posted = page.waitForResponse((response) => response.url().endsWith("/api/message") && response.request().method() === "POST");

    await page.locator("#msg-input").fill("My own message");
    await page.locator("#send-btn").click();
    await expect(page.locator("#messages .msg.user").last()).toContainText("My own message");
    await expectAtEnd(page);
    await page.waitForTimeout(300);

    await wheelUp(page, 600);
    const position = await readingPosition(page);
    release();
    await posted;
    await page.waitForTimeout(1_000);
    expect(await readingPosition(page)).toEqual(position);
  });

  test("an answer on a card jumps once too, and not at all after the reader scrolled", async ({ page }) => {
    const reader = await longConversation();
    const running = await reader.runningTurn("Prepare the release");
    await openConversation(page, reader.conversationId);
    await expect(page.locator("#thinking-indicator")).toHaveCount(1);
    await goToEnd(page);
    await reader.ask(running, "Ship the release today?");
    const card = page.locator("#messages .relay-question-container");
    await expect(card).toHaveCount(1);
    let release = null;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/relay-question/*/answer", async (route) => { await held; return route.continue(); });
    const answered = page.waitForResponse((response) => response.url().includes("/api/relay-question/") && response.url().endsWith("/answer"));

    await card.locator(".relay-question-choice", { hasText: "Wait" }).click();
    await wheelUp(page, 600);
    const position = await readingPosition(page);
    release();
    await answered;
    await expect(card).toHaveCount(0);
    await page.waitForTimeout(600);
    expect((await readingPosition(page)).row).toBe(position.row);
    expect(await distanceFromEnd(page)).toBeGreaterThan(300);
  });

  test("the second restore after a reload leaves a reader who has scrolled meanwhile", async ({ page }) => {
    const reader = await longConversation();
    const running = await reader.runningTurn("Keep working");
    await openConversation(page, reader.conversationId);
    await expect(page.locator("#thinking-indicator")).toHaveCount(1);
    await goToEnd(page);
    await readFromAbove(page, 1);

    // The refresh at the end of a turn loads the conversation, then its
    // cards; the cards take their time.
    let release = null;
    const held = new Promise((resolve) => { release = resolve; });
    let holding = false;
    let heldRequests = 0;
    await page.route("**/api/relay-questions*", async (route) => {
      if (!holding) return route.continue();
      heldRequests += 1;
      await held;
      return route.continue();
    });
    holding = true;
    await reloadAfter(page, reader.conversationId, () => reader.answer(running, `Done. ${FILLER}`));
    await expect(page.locator("#messages .msg.assistant").last()).toContainText("Done.");
    await expect.poll(() => heldRequests).toBeGreaterThan(0);

    await wheelUp(page, 1_400);
    const position = await readingPosition(page);
    const cards = page.waitForResponse((response) => response.url().includes("/api/relay-questions"));
    release();
    await cards;
    await page.waitForTimeout(800);
    expect(await readingPosition(page)).toEqual(position);
  });

  test("PageUp with the focus outside the transcript counts as the reader scrolling", async ({ page }) => {
    const reader = await longConversation();
    await openConversation(page, reader.conversationId);
    await goToEnd(page);
    const post = await holdRequests(page, "**/api/message", "POST");

    await page.locator("#msg-input").fill("My own message");
    await page.locator("#send-btn").click();
    await expect(page.locator("#messages .msg.user").last()).toContainText("My own message");
    await expectAtEnd(page);
    await page.waitForTimeout(300);

    // A click on a message: the focus stays on the page (no element of the
    // transcript takes it), and the keys now scroll the transcript.
    const row = await page.locator("#messages .msg.assistant").last().boundingBox();
    await page.mouse.click(row.x + 30, row.y + 20);
    expect(await page.evaluate(() => document.getElementById("messages").contains(document.activeElement))).toBe(false);
    await page.keyboard.press("PageUp");
    await page.keyboard.press("PageUp");
    await expect.poll(() => distanceFromEnd(page)).toBeGreaterThan(300);
    await page.waitForTimeout(400);
    const position = await readingPosition(page);
    await post.release();
    await page.waitForTimeout(1_000);
    expect(await readingPosition(page)).toEqual(position);
  });

  test("Ctrl+Enter in a card's reply box is the reader's own send like the button", async ({ page }) => {
    const reader = await longConversation();
    const running = await reader.runningTurn("Prepare the release");
    await openConversation(page, reader.conversationId);
    await expect(page.locator("#thinking-indicator")).toHaveCount(1);
    await goToEnd(page);
    await reader.ask(running, "Ship the release today?");
    await reader.ask(running, "And tag it?");
    const cards = page.locator("#messages .relay-question-container");
    await expect(cards).toHaveCount(2);
    // The first card at the bottom edge; the second is below and waits.
    await page.evaluate(() => {
      const el = document.getElementById("messages");
      const first = el.querySelector(".relay-question-container");
      el.scrollTop -= el.getBoundingClientRect().bottom - first.getBoundingClientRect().bottom;
    });
    await page.waitForTimeout(400);
    expect(await distanceFromEnd(page)).toBeGreaterThan(100);

    const box = cards.first().locator("textarea");
    await box.fill("Not today");
    await box.press("Control+Enter");
    await expect(cards).toHaveCount(1);
    await expectAtEnd(page);
    await expect(cards.first()).toBeInViewport();
  });

  test("a render held back at the end lands where the reader has gone since", async ({ page }) => {
    const reader = await longConversation();
    const running = await reader.runningTurn("Write the summary");
    await openConversation(page, reader.conversationId);
    await expect(page.locator("#thinking-indicator")).toHaveCount(1);
    let text = "";
    for (let step = 0; step < 6; step += 1) text += `Paragraph ${step}. ${FILLER.repeat(3)}\n\n`;
    await reader.stream(running, text);
    await expect(page.locator("#thinking-indicator")).toContainText("Paragraph 5.");
    await goToEnd(page);
    await page.waitForTimeout(400);

    // At the end, the reader selects a word of an earlier message: rebuilds wait.
    const first = await page.locator("#messages > .msg.user[data-message-id]").first().getAttribute("data-message-id");
    await page.evaluate((id) => {
      const row = document.querySelector(`#messages > .msg[data-message-id="${id}"]`);
      const range = document.createRange();
      range.selectNodeContents(row.querySelector("p") || row);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, first);
    await page.waitForTimeout(300);
    // A message is hidden on another device, and the turn ends with a short
    // reply: the page is no longer than before, the reader still at its end,
    // and the reload after the turn is held back as one that follows.
    expect((await reader.hideFromShares(first, true)).status).toBe(200);
    await reloadAfter(page, reader.conversationId, () => reader.answer(running, "Done."));
    await expect(page.locator("#thinking-indicator")).toHaveCount(0);
    await page.waitForTimeout(600);
    // The Hide is drawn in place from the hidden list; the render waits, so
    // the rows are still the ones drawn before it.
    await expect(page.locator(`#messages > .msg[data-message-id="${first}"] .msg-hidden-label`)).toHaveCount(1);
    const drawnBefore = await markRowsDrawnBefore(page);
    await page.waitForTimeout(300);
    await expect(drawnBefore).not.toHaveCount(0);
    expect(await distanceFromEnd(page)).toBeLessThanOrEqual(48);

    // Then they scroll up, the selection still held, and release it there.
    await page.evaluate(() => { document.getElementById("messages").scrollTop -= 900; });
    await page.waitForTimeout(400);
    const position = await readingPosition(page);
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await expect(drawnBefore).toHaveCount(0);
    await expect(page.locator(`#messages > .msg[data-message-id="${first}"] .msg-hidden-label`)).toHaveCount(1);
    await expectRowStayedPut(page, position);
    expect(await distanceFromEnd(page)).toBeGreaterThan(600);
  });

  test("a closed fold is not what the reader reads: the anchor takes the text below it", async ({ page }) => {
    const reader = await longConversation(4);
    await openConversation(page, reader.conversationId);
    await goToEnd(page);
    const result = await page.evaluate(async () => {
      const { captureReadingBlock, restoreReadingBlock } = await import("/app/transcript-viewport-anchor.mjs");
      const el = document.getElementById("messages");
      const row = Array.from(el.querySelectorAll(".msg.assistant[data-message-id]")).at(-1);
      // What a reply's folded thoughts are: a closed fold above its text.
      const fold = document.createElement("details");
      fold.innerHTML = "<summary>Thoughts</summary><p>Folded thought, first.</p><p>Folded thought, second.</p>";
      const bubble = row.querySelector(".msg-bubble") || row;
      bubble.insertBefore(fold, bubble.firstChild);
      el.scrollTop += fold.getBoundingClientRect().top - el.getBoundingClientRect().top - 4;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const folded = fold.querySelector("p");
      const before = el.scrollTop;
      const anchor = captureReadingBlock(el);
      const restored = restoreReadingBlock(el, { messageId: row.dataset.messageId, tag: "p", text: "Folded thought, first.", occurrence: 0, offset: 0, offsetFraction: null });
      return {
        foldedBoxHeight: Math.round(folded.getBoundingClientRect().height),
        read: anchor?.text.slice(0, 40) || "",
        restored,
        moved: el.scrollTop !== before,
      };
    });
    // The browser does give the folded paragraph a box; the anchor passes it by.
    expect(result.foldedBoxHeight).toBeGreaterThan(0);
    expect(result.read).not.toContain("Folded thought");
    expect(result).toMatchObject({ restored: false, moved: false });
  });

  test("rows that were not followed, then the transcript shrinks: the reader is not taken to the end", async ({ page }) => {
    const reader = await longConversation();
    await openConversation(page, reader.conversationId);
    await goToEnd(page);
    await page.waitForTimeout(400);

    // The reader holds the mouse down in the transcript (the start of a
    // selection): nothing scrolls under a held pointer, so the rows that
    // land now are not followed, and no scroll event says so.
    const last = page.locator("#messages .msg.assistant").last();
    const box = await last.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 30);
    await page.mouse.down();
    const first = await reader.queue(`From the other device. ${FILLER.repeat(4)}`);
    const second = await reader.queue(`And one more. ${FILLER.repeat(4)}`);
    await expect(page.locator(`#messages > .msg[data-message-id="${second}"]`)).toHaveCount(1);
    await expect(page.locator(`#messages > .msg[data-message-id="${first}"]`)).toHaveCount(1);
    await page.mouse.up();
    await page.waitForTimeout(600);
    const position = await readingPosition(page);
    expect(await distanceFromEnd(page)).toBeGreaterThan(100);

    // The background-task panel appears under the transcript.
    await reader.backgroundTasks(2);
    await expect(page.locator("#background-tasks-panel")).toBeVisible();
    await page.waitForTimeout(600);
    expect(await readingPosition(page)).toEqual(position);
    expect(await distanceFromEnd(page)).toBeGreaterThan(100);
    await reader.backgroundTasks(0);
  });
});

test.describe("the send setting", () => {
  test.use(DEVICES.desktop);

  test("is on by default, is stored in the browser and survives a reload", async ({ page }) => {
    const reader = await longConversation(2);
    await openConversation(page, reader.conversationId);
    expect(await page.evaluate((key) => localStorage.getItem(key), SEND_SETTING_KEY)).toBeNull();
    await page.evaluate(() => window.openSettingsModal("general"));
    const toggle = page.locator("#scroll-on-send-toggle");
    await expect(page.locator('label[for="scroll-on-send-toggle"]')).toHaveText("Jump to the end when I send a message");
    await expect(toggle).toBeChecked();

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.reload();
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate((key) => localStorage.getItem(key), SEND_SETTING_KEY)).toBe("0");
    // Set by bootstrap.js, which loads after the page (a dynamic import):
    // networkidle can come first on a slow runner.
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await page.evaluate(() => window.openSettingsModal("general"));
    await expect(toggle).not.toBeChecked();

    await toggle.click();
    await expect(toggle).toBeChecked();
    await page.reload();
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate((key) => localStorage.getItem(key), SEND_SETTING_KEY)).toBe("1");
    // Set by bootstrap.js, which loads after the page (a dynamic import):
    // networkidle can come first on a slow runner.
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await page.evaluate(() => window.openSettingsModal("general"));
    await expect(toggle).toBeChecked();
  });

  test("a quick answer on a question card is the reader's own send too", async ({ page }) => {
    const reader = await longConversation();
    const running = await reader.runningTurn("Prepare the release");
    await openConversation(page, reader.conversationId);
    await expect(page.locator("#thinking-indicator")).toHaveCount(1);
    await goToEnd(page);
    await reader.ask(running, "Ship the release today?");
    await reader.ask(running, "And tag it?");
    const cards = page.locator("#messages .relay-question-container");
    await expect(cards).toHaveCount(2);

    // The reader scrolls up until the first card is at the bottom edge and
    // answers it from there: the second card is below and waits.
    await page.evaluate(() => {
      const el = document.getElementById("messages");
      const first = el.querySelector(".relay-question-container");
      el.scrollTop -= el.getBoundingClientRect().bottom - first.getBoundingClientRect().bottom;
    });
    await page.waitForTimeout(400);
    expect(await distanceFromEnd(page)).toBeGreaterThan(100);
    await cards.first().locator(".relay-question-choice", { hasText: "Wait" }).click();
    await expect(cards).toHaveCount(1);
    await expectAtEnd(page);
    await expect(cards.first()).toBeInViewport();
  });
});
