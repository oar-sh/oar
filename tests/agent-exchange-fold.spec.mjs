import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { STEER_FOLDED_TEXT } from "../shared/steer-settle-markers.mjs";
import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * Agent exchanges, end to end without a model: a prompt another agent sent
 * this session folds into one row, "note from win-test · release checklist ·
 * answered below", which opens to the prompt. The session's reply to it is
 * never folded: it can carry a line for the user. The user's own messages
 * stay as they are, and so does an agent's prompt that was steered into a
 * running turn. A prompt still being worked on shows open and folds by itself
 * once replied, unless the user folded or opened it.
 *
 * A relay of the spec's own (the agent-sessions setting is switched on here).
 * No worker runs: the spec queues messages with POST /api/message (another
 * relay's agent's prompt carries its `origin` there), takes them off the
 * queue with GET /api/pending and answers with POST /api/response, as a
 * worker does. The prompt of an agent on this relay comes through the
 * relay_tool tool route, from a conversation whose turn is running.
 */

const REMOTE_ORIGIN = {
  relayId: "relay-fixture-win",
  relayName: "win-test",
  conversationId: "conv-fixture-lead",
  conversationTitle: "release checklist",
  model: "claude-fixture",
  hops: 1,
};
// A reply to an agent that carries a line for the user.
const REMOTE_REPLY = "Sam: the build is done. Two items are open: the export and the legend.";
const VIEWPORTS = {
  desktop: { width: 1280, height: 860 },
  phone: { width: 390, height: 844 },
};

function createApi(getRelay) {
  return async function api(route, { method = "GET", body, headers = {} } = {}) {
    const relay = getRelay();
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  };
}

test.describe.serial("an agent's prompt folds into one row, the reply to it never", () => {
  test.describe.configure({ timeout: 120_000 });

  let relay = null;
  const api = createApi(() => relay);
  let session = "";
  let sessionOwner = "";
  let orchestrator = "";
  let orchestratorTitle = "";
  const ids = {};

  async function queue(text, extra = {}) {
    const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini", ...extra } });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    return queued.payload;
  }

  // What a worker does to start a turn. Only the message asked for is ever
  // pending when this runs, so the dequeue can return nothing else.
  async function take(messageId, owner = sessionOwner) {
    const headers = owner ? { "x-relay-session-id": String(owner) } : {};
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const dequeued = await api("/api/pending", { headers });
      const handed = String(dequeued.payload?.message?.id || "");
      if (handed === messageId) return;
      if (handed) throw new Error(`The queue handed out ${handed.slice(0, 8)} instead of ${messageId.slice(0, 8)}`);
      await sleep(250);
    }
    throw new Error(`Message ${messageId.slice(0, 8)} was never handed out`);
  }

  async function answer(messageId, text, extra = {}) {
    const posted = await api("/api/response", {
      method: "POST",
      body: { messageId, conversationId: session, text, model: "gpt-5.4-mini", ...extra },
    });
    expect(posted.status, JSON.stringify(posted.payload)).toBe(200);
    expect(posted.payload?.ignored, JSON.stringify(posted.payload)).toBeUndefined();
  }

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
    expect((await api("/api/settings/pwa-app-name", { method: "POST", body: { appName: "linux-test" } })).status).toBe(200);
    expect((await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).status).toBe(200);

    // The user starts the session.
    const first = await queue("report builder: collect the numbers");
    session = first.conversationId;
    sessionOwner = first.ownerSessionId || "";
    const synced = await api("/api/session-sync", { method: "POST", body: { sdk_session_id: session, conversation_id: session } });
    expect(synced.status, JSON.stringify(synced.payload)).toBe(200);
    ids.first = first.messageId;
    await take(ids.first);
    await answer(ids.first, "The numbers are collected.");

    // Another relay's agent prompts it.
    ids.remote = (await queue("sidebar polish: summarise the open work", { conversationId: session, origin: REMOTE_ORIGIN })).messageId;
    await take(ids.remote);
    await answer(ids.remote, REMOTE_REPLY);

    // An agent on this relay prompts it, from a conversation whose turn runs.
    const lead = await queue("nightly digest: ask the report builder for the totals");
    orchestrator = lead.conversationId;
    expect((await api("/api/session-sync", { method: "POST", body: { sdk_session_id: orchestrator, conversation_id: orchestrator } })).status).toBe(200);
    await take(lead.messageId, lead.ownerSessionId || "");
    const sent = await api("/api/remote-relays/tool", {
      method: "POST",
      body: { conversationId: orchestrator, action: "send", args: { relay: "this", session, text: "nightly digest: list the totals", wait_seconds: 0 } },
    });
    expect(sent.status, JSON.stringify(sent.payload)).toBe(200);
    ids.local = sent.payload.message_id;
    const leadAnswer = await api("/api/response", {
      method: "POST",
      body: { messageId: lead.messageId, conversationId: orchestrator, text: "Asked.", model: "gpt-5.4-mini" },
    });
    expect(leadAnswer.status).toBe(200);
    await take(ids.local);
    await answer(ids.local, "Totals: 42 rows, 3 sheets.");
    const listed = await api("/api/conversations");
    orchestratorTitle = listed.payload.conversations.find((conversation) => conversation.id === orchestrator).title;
    expect(orchestratorTitle).toBeTruthy();

    // The user's own message and its reply.
    ids.user = (await queue("sidebar polish: what is left?", { conversationId: session })).messageId;
    await take(ids.user);
    await answer(ids.user, "Only the legend.");

    // An agent's prompt with a message of the user's steered into its turn:
    // the reply answers both, the steer settles as a marker.
    ids.steeredHost = (await queue("report builder: add the totals row", { conversationId: session, origin: REMOTE_ORIGIN })).messageId;
    await take(ids.steeredHost);
    ids.steer = (await queue("and a column for May, please", { conversationId: session })).messageId;
    await answer(ids.steeredHost, "Totals row added, with a column for May.");
    await answer(ids.steer, STEER_FOLDED_TEXT, { kind: "folded" });

    // The other way round: an agent's prompt steered into the user's turn.
    ids.userHost = (await queue("report builder: draw the chart", { conversationId: session })).messageId;
    await take(ids.userHost);
    ids.agentSteer = (await queue("sidebar polish: use the dark palette", { conversationId: session, origin: REMOTE_ORIGIN })).messageId;
    await answer(ids.userHost, "The chart is drawn, in the dark palette.");
    await answer(ids.agentSteer, STEER_FOLDED_TEXT, { kind: "folded" });

    // An agent's prompt whose turn is running when the page opens.
    ids.running = (await queue("report builder: check the legend", { conversationId: session, origin: REMOTE_ORIGIN })).messageId;
    await take(ids.running);
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  const userRow = (page, id) => page.locator(`#messages > .msg.user[data-message-id="${id}"]`);
  const replyRow = (page, id) => page.locator(`#messages > .msg.assistant[data-source-message-id="${id}"]`);
  const foldOf = (page, id) => userRow(page, id).locator("details.agent-exchange-row");

  async function openSession(page, viewport) {
    await page.setViewportSize(viewport);
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, session);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await expect(userRow(page, ids.first)).toBeVisible({ timeout: 20_000 });
  }

  // Folded: the row in the place of the prompt's bubble, which is on the
  // page, hidden. What answers it shows under the row: the reply, or the live
  // bubble while the turn works.
  async function expectFolded(page, id, { text, status, reply }) {
    const fold = foldOf(page, id);
    await expect(fold).toBeVisible();
    await expect(fold).not.toHaveAttribute("open", "");
    await expect(fold.locator(".agent-exchange-text")).toHaveText(text);
    await expect(fold.locator(".agent-exchange-status")).toHaveText(status);
    await expect(userRow(page, id).locator(".msg-bubble")).toBeHidden();
    if (status === "working…") {
      await expect(replyRow(page, id)).toHaveCount(0);
      await expect(page.locator(`#thinking-indicator[data-message-id="${id}"]`)).toBeVisible();
      return;
    }
    await expect(replyRow(page, id)).toHaveCount(1);
    await expect(replyRow(page, id)).toBeVisible();
    await expect(replyRow(page, id).locator(".msg-bubble")).toContainText(reply);
    // Under the row, like a reply to the user under their message.
    const rowBox = await fold.boundingBox();
    const replyBox = await replyRow(page, id).boundingBox();
    expect(replyBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height);
  }

  // Working, and not folded by the user: the row, open, over the prompt and
  // the live bubble.
  async function expectWorkingOpen(page, id, promptText) {
    const fold = foldOf(page, id);
    await expect(fold).toHaveAttribute("open", "");
    await expect(fold.locator(".agent-exchange-status")).toHaveText("working…");
    await expect(userRow(page, id).locator(".msg-bubble")).toContainText(promptText);
    await expect(page.locator("#thinking-indicator")).toBeVisible();
  }

  async function expectShownAsIs(page, id, promptText, replyText) {
    await expect(foldOf(page, id)).toHaveCount(0);
    await expect(userRow(page, id).locator(".msg-bubble")).toContainText(promptText);
    await expect(replyRow(page, id).first()).toBeVisible();
    await expect(replyRow(page, id).first()).toContainText(replyText);
  }

  async function expectFitsWidth(page, locator, width) {
    const box = await locator.boundingBox();
    expect(box, "on screen").not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  }

  async function checkTranscript(page, viewport) {
    await expectFolded(page, ids.remote, { text: "note from win-test · release checklist", status: "answered below", reply: REMOTE_REPLY });
    await expectFolded(page, ids.local, { text: `note from linux-test · ${orchestratorTitle}`, status: "answered below", reply: "Totals: 42 rows, 3 sheets." });

    // The user's own exchanges, as ever.
    await expectShownAsIs(page, ids.first, "report builder: collect the numbers", "The numbers are collected.");
    await expectShownAsIs(page, ids.user, "sidebar polish: what is left?", "Only the legend.");
    // A turn the user steered a message into: the agent's prompt folds like
    // any other, the reply that answers both and the user's message show.
    await expectFolded(page, ids.steeredHost, { text: "note from win-test · release checklist", status: "answered below", reply: "Totals row added, with a column for May." });
    await expect(userRow(page, ids.steer)).toHaveClass(/\bmsg-steered\b/);
    await expect(userRow(page, ids.steer).locator(".msg-bubble")).toBeVisible();
    // An agent's prompt steered into the user's turn stays in that turn's
    // flow: its bubble and the marker under it.
    await expectShownAsIs(page, ids.userHost, "report builder: draw the chart", "The chart is drawn, in the dark palette.");
    await expectShownAsIs(page, ids.agentSteer, "sidebar polish: use the dark palette", "Handled together");
    await expect(userRow(page, ids.agentSteer).locator(".msg-origin-badge")).toContainText("from win-test");

    // Opened: the prompt with its badge, as it renders anyway; the reply is
    // where it was.
    const fold = foldOf(page, ids.remote);
    await expectFitsWidth(page, fold, viewport.width);
    await expectFitsWidth(page, fold.locator(".agent-exchange-status"), viewport.width);
    await fold.locator("summary").click();
    await expect(fold).toHaveAttribute("open", "");
    const prompt = userRow(page, ids.remote).locator(".msg-bubble");
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText("sidebar polish: summarise the open work");
    await expect(prompt.locator(".msg-origin-badge")).toContainText("from win-test");
    await expect(replyRow(page, ids.remote)).toBeVisible();
    await expect(replyRow(page, ids.remote)).toContainText(REMOTE_REPLY);
    await expectFitsWidth(page, prompt, viewport.width);
    // Folded again by the same click: the prompt goes, the reply stays.
    await fold.locator("summary").click();
    await expect(prompt).toBeHidden();
    await expect(replyRow(page, ids.remote)).toBeVisible();

    // A re-render builds every row anew: the one opened stays open, the
    // other stays folded.
    await fold.locator("summary").click();
    await expect(prompt).toBeVisible();
    await userRow(page, ids.remote).evaluate((node) => { node.dataset.specBefore = "1"; });
    await page.evaluate((id) => window.openConversation(id), orchestrator);
    await expect(userRow(page, ids.first)).toHaveCount(0);
    await page.evaluate((id) => window.openConversation(id), session);
    await expect(userRow(page, ids.remote)).toBeVisible();
    await expect(userRow(page, ids.remote)).not.toHaveAttribute("data-spec-before", "1");
    await expect(foldOf(page, ids.remote)).toHaveAttribute("open", "");
    await expect(userRow(page, ids.remote).locator(".msg-bubble")).toBeVisible();
    await expect(userRow(page, ids.local).locator(".msg-bubble")).toBeHidden();
    await expect(replyRow(page, ids.local)).toBeVisible();
  }

  test("desktop: agent prompts fold, their replies and the user's own turns do not, and a running one folds once replied", async ({ page }) => {
    await openSession(page, VIEWPORTS.desktop);
    // The running turn: open over its live bubble, saying so.
    await expectWorkingOpen(page, ids.running, "report builder: check the legend");
    await expect(page.locator("#thinking-indicator")).toHaveCount(1);

    await checkTranscript(page, VIEWPORTS.desktop);

    // Its reply lands: the row says so and folds by itself, over the reply.
    await answer(ids.running, "The legend is fine.");
    await expect(foldOf(page, ids.running).locator(".agent-exchange-status")).toHaveText("answered below");
    await expectFolded(page, ids.running, { text: "note from win-test · release checklist", status: "answered below", reply: "The legend is fine." });
  });

  test("phone: the same on a narrow screen, and a working prompt the user folds stays folded over its live bubble", async ({ page }) => {
    ids.folding = (await queue("report builder: rename the sheet", { conversationId: session, origin: REMOTE_ORIGIN })).messageId;
    await take(ids.folding);
    await openSession(page, VIEWPORTS.phone);
    await expectFolded(page, ids.running, { text: "note from win-test · release checklist", status: "answered below", reply: "The legend is fine." });

    // Open while it works; folded by the user, it stays folded through a
    // re-render while it still works, and the live bubble shows all along.
    await expectWorkingOpen(page, ids.folding, "report builder: rename the sheet");
    const fold = foldOf(page, ids.folding);
    await expectFitsWidth(page, fold, VIEWPORTS.phone.width);
    await fold.locator("summary").click();
    await expectFolded(page, ids.folding, { text: "note from win-test · release checklist", status: "working…" });
    await page.evaluate((id) => window.openConversation(id), orchestrator);
    await expect(userRow(page, ids.first)).toHaveCount(0);
    await page.evaluate((id) => window.openConversation(id), session);
    await expectFolded(page, ids.folding, { text: "note from win-test · release checklist", status: "working…" });
    await answer(ids.folding, "The sheet is renamed.");
    await expectFolded(page, ids.folding, { text: "note from win-test · release checklist", status: "answered below", reply: "The sheet is renamed." });

    await checkTranscript(page, VIEWPORTS.phone);
  });
});
