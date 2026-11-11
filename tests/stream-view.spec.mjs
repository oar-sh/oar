import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { relayDbPath, relayToken } from "./e2e-env.mjs";

// The stream view, against the shared e2e relay. A turn is queued and taken
// off the queue; its thoughts and tool lines are posted through the routes a
// session worker uses (no CLI runs on the test server): thought, Read,
// thought, Grep, narration thought, Agent spawn, then the reply.
//
// On: live, the rows come in that order, the streaming text below; the
// finished bubble lists them in that order with the reply last, and a reload
// shows the same. Off: the grouped layout. A turn whose rows have no order
// (recorded before the relay numbered them) keeps the grouped layout with the
// view on. A Copilot-style turn (reasoning thoughts, no narration) streams in
// arrival order with the reply after. With OAR_E2E_SCREENSHOT_DIR set, each
// view is shot dark and light.

const SHOT_DIR = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim();
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const REPLY = "The cache evicts the oldest widget first; the tests cover it.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dequeue(request, headers, messageId, ownerSessionId) {
  const dequeueHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const dequeued = await request.get("/api/pending", { headers: dequeueHeaders });
    expect(dequeued.ok()).toBeTruthy();
    const message = (await dequeued.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

async function startTurn(request, headers, text) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "");
  const messageId = String(body?.messageId || "");
  await dequeue(request, headers, messageId, String(body?.ownerSessionId || ""));
  return { conversationId, messageId };
}

// The worker's heartbeat while the turn runs: without it the CLI reads as
// offline after a while and the live bubble goes with it.
function keepWorkerAlive(request, headers, messageId) {
  const beat = () => request.post("/api/heartbeat", { headers, data: { activeQueueMessageId: messageId } }).catch(() => {});
  void beat();
  const timer = setInterval(beat, 2_000);
  return () => clearInterval(timer);
}

async function openConversationPage(page, token, conversationId, { stream = true } = {}) {
  await page.addInitScript(({ id, stream: on }) => {
    window.localStorage.setItem("copilot_last_conv", id);
    window.localStorage.setItem("copilot_stream_view", on ? "1" : "0");
  }, { id: conversationId, stream });
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
  await expect(page.locator("#cli-dot")).toHaveClass("online");
}

async function shoot(page, name, locator = null) {
  if (!SHOT_DIR) return;
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => window.updateTheme(value), theme);
    if (locator) await locator.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${theme}.png` });
  }
  await page.evaluate(() => window.updateTheme("dark"));
}

// What the stream list holds, as kind:text-start (a tool line's emoji and a
// thought's 💭 left off).
function streamRows(locator) {
  return locator.evaluateAll((nodes) => nodes.map((node) => {
    const kind = node.classList.contains("msg-stream-thought") || node.classList.contains("thinking-thought") ? "thought"
      : node.classList.contains("msg-stream-reply") ? "reply" : "tool";
    const text = (node.querySelector("summary")?.textContent || node.textContent || "").replace(/^[^\p{L}]+/u, "").trim();
    return `${kind}:${text.slice(0, 18)}`;
  }));
}

// The same for the fixture's rows, in order.
const expectedRows = (rows) => rows.map(([kind, a, b]) => `${kind}:${(kind === "thought" ? b : a).slice(0, 18)}`);

const FIXTURE = [
  ["thought", "s1", "Find where the widget cache lives."],
  ["tool", "Tool (Read): src/widget-cache.js"],
  ["thought", "s2", "Eviction is in widget-cache.js; search for it."],
  ["tool", "Tool (Grep): evictOldest"],
  ["thought", "s3", "I will have an agent check the widget tests."],
  ["tool", "Tool (Agent): Check the widget cache tests"],
];

test.describe("stream view", () => {
  test.use({ viewport: PHONE });

  test("a turn in the order it happened: live, finished, after a reload; off is grouped", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const { conversationId, messageId } = await startTurn(request, headers, `Audit the widget cache ${stamp}`);
    const post = (route, data) => request.post(route, { headers, data: { messageId, conversationId, mode: "agent", ...data } });
    const stopBeating = keepWorkerAlive(request, headers, messageId);
    try {
      await openConversationPage(page, token, conversationId);
      for (const [kind, a, b] of FIXTURE.slice(0, 4)) {
        if (kind === "thought") expect((await post("/api/thought", { reasoningId: `${a}-${stamp}`, text: b, done: true })).ok()).toBeTruthy();
        else expect((await post("/api/activity", { text: a })).ok()).toBeTruthy();
      }
      // Live, mid-way: four rows in order; the streaming text below them.
      const liveRows = page.locator("#thinking-stream-list > *");
      await expect(liveRows).toHaveCount(4);
      expect((await post("/api/stream", { text: "Writing up the eviction findings", done: false })).ok()).toBeTruthy();
      await expect(page.locator("#thinking-stream")).toContainText("Writing up");
      expect(await streamRows(liveRows)).toEqual(expectedRows(FIXTURE.slice(0, 4)));
      await shoot(page, "live-midway-phone", page.locator("#thinking-indicator"));

      for (const [kind, a, b] of FIXTURE.slice(4)) {
        if (kind === "thought") expect((await post("/api/thought", { reasoningId: `${a}-${stamp}`, text: b, done: true })).ok()).toBeTruthy();
        else expect((await post("/api/activity", { text: a })).ok()).toBeTruthy();
      }
      await expect(liveRows).toHaveCount(6);
      // Two poll replays later the order holds.
      const isPoll = (response) => response.url().includes(`/api/conversation/${conversationId}?`);
      await page.waitForResponse(isPoll);
      await page.waitForResponse(isPoll);
      expect(await streamRows(liveRows)).toEqual(expectedRows(FIXTURE));

      expect((await post("/api/response", { text: REPLY, model: "gpt-5.4-mini" })).ok()).toBeTruthy();
      const finished = page.locator(".msg.assistant .msg-turn-stream > *");
      await expect(finished).toHaveCount(7);
      const kinds = await streamRows(finished);
      expect(kinds).toEqual([...expectedRows(FIXTURE), `reply:${REPLY.slice(0, 18)}`]);
      await expect(page.locator(".msg.assistant .msg-turn-stream > .msg-stream-reply")).toContainText(REPLY);
      await expect(page.locator(".msg.assistant .msg-thoughts")).toHaveCount(0);

      // A reload shows the same.
      await page.reload();
      await expect(page.locator("#cli-dot")).toHaveClass("online");
      await expect(finished).toHaveCount(7);
      expect(await streamRows(finished)).toEqual(kinds);
      for (const [name, viewport] of [["phone", PHONE], ["desktop", DESKTOP]]) {
        await page.setViewportSize(viewport);
        await shoot(page, `finished-stream-${name}`, page.locator(".msg.assistant").last());
      }

      // Off: the grouped layout of the same turn.
      await page.setViewportSize(PHONE);
      await openConversationPage(page, token, conversationId, { stream: false });
      await expect(page.locator(".msg.assistant .msg-thoughts")).toHaveCount(1);
      await expect(page.locator(".msg.assistant details.msg-activity")).toHaveCount(1);
      await expect(page.locator(".msg.assistant .msg-turn-stream")).toHaveCount(0);
      for (const [name, viewport] of [["phone", PHONE], ["desktop", DESKTOP]]) {
        await page.setViewportSize(viewport);
        await shoot(page, `finished-grouped-${name}`, page.locator(".msg.assistant").last());
      }

      // Switching it in Settings changes the transcript at once.
      await page.evaluate(() => window.openSettingsModal("appearance"));
      await page.locator("#stream-view-toggle").check();
      await page.keyboard.press("Escape");
      await expect(page.locator(".msg.assistant .msg-turn-stream > *")).toHaveCount(7);
      // Closing the dialog steps back over its history entry; a navigation
      // started before that lands is aborted.
      await expect(page.locator("#settings-modal")).not.toHaveClass(/visible/);
      await page.waitForFunction(() => !history.state?.oarOverlay);

      // A turn whose rows have no order (from before the relay numbered
      // them): the grouped layout even with the view on.
      const db = new Database(relayDbPath());
      try {
        db.prepare("UPDATE relay_activity SET turn_seq = NULL WHERE queue_message_id = ?").run(messageId);
        db.prepare("UPDATE relay_thought SET turn_seq = NULL WHERE queue_message_id = ?").run(messageId);
      } finally {
        db.close();
      }
      await openConversationPage(page, token, conversationId, { stream: true });
      await expect(page.locator(".msg.assistant .msg-thoughts")).toHaveCount(1);
      await expect(page.locator(".msg.assistant .msg-turn-stream")).toHaveCount(0);
    } finally {
      stopBeating();
      await post("/api/response", { text: "cleanup", model: "gpt-5.4-mini" }).catch(() => {});
    }
  });

  test("a Copilot-style turn (no narration) streams in arrival order with the reply after", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const { conversationId, messageId } = await startTurn(request, headers, `Count the widget files ${stamp}`);
    const post = (route, data) => request.post(route, { headers, data: { messageId, conversationId, mode: "agent", ...data } });
    expect((await post("/api/activity", { text: "Tool (glob): src/**/widget*.js" })).ok()).toBeTruthy();
    expect((await post("/api/thought", { reasoningId: `copilot-thought-${stamp}`, text: "Twelve files match; check the tests too.", done: true })).ok()).toBeTruthy();
    expect((await post("/api/activity", { text: "Tool (glob): tests/**/widget*.test.js" })).ok()).toBeTruthy();
    expect((await post("/api/response", { text: "There are twelve widget files and four tests.", model: "gpt-5.4-mini" })).ok()).toBeTruthy();

    await openConversationPage(page, token, conversationId);
    const finished = page.locator(".msg.assistant .msg-turn-stream > *");
    await expect(finished).toHaveCount(4);
    expect(await streamRows(finished)).toEqual([
      ...expectedRows([
        ["tool", "Tool (glob): src/**/widget*.js"],
        ["thought", "", "Twelve files match; check the tests too."],
        ["tool", "Tool (glob): tests/**/widget*.test.js"],
      ]),
      "reply:There are twelve w",
    ]);
  });
});
