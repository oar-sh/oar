import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * Questions that don't block (remote_relay ask) and the Inbox, on two relays
 * of their own: relay A (where the browser is) and relay B, paired one way
 * (A knows B).
 *
 * - The sidebar's Inbox button counts what waits; the Inbox lists it per
 *   relay, newest first; Answer, an option, and Dismiss close an ask; what
 *   closed stays under a divider; the filter narrows to the owner's sessions
 *   or the agents'.
 * - Agent text is plain text: HTML in an ask's detail shows as written.
 * - The asking session gets question_answered as a relay event.
 * - The ask's card in its session does not block it and answers in place.
 * - On a phone the Inbox is one column with full-width buttons.
 * - An ask about a session on B, from A's agent: listed in A's Inbox under B,
 *   answered there through the pairing; B's session and A's asker are told.
 *
 * No worker runs: the sessions are conversations a message created, and a
 * "turn" for the one card a turn waits on is a message the spec took off the
 * queue (GET /api/pending).
 */

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const XSS_DETAIL = 'Background:\n<img src=x onerror="window.__inboxXss=1"><b>bold?</b>';

test.describe.serial("the Inbox", () => {
  test.describe.configure({ timeout: 180_000 });

  let relayA = null;
  let relayB = null;
  const suffix = Date.now();
  const sessions = {};

  function apiOf(relay) {
    return async (route, { method = "GET", body, headers = {} } = {}) => {
      const response = await fetch(`${relay.baseUrl}${route}`, {
        method,
        headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, payload: await response.json().catch(() => null) };
    };
  }
  const apiA = (...args) => apiOf(relayA)(...args);
  const apiB = (...args) => apiOf(relayB)(...args);
  const toolA = (conversationId, action, args = {}) => apiA("/api/remote-relays/tool", { method: "POST", body: { conversationId, action, args } });

  async function conversation(api, text) {
    const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    return queued.payload;
  }

  async function conversationWithRunningTurn(api, text) {
    const { conversationId, messageId, ownerSessionId } = await conversation(api, text);
    const synced = await api("/api/session-sync", { method: "POST", body: { sdk_session_id: conversationId, conversation_id: conversationId } });
    expect(synced.status).toBe(200);
    const headers = ownerSessionId ? { "x-relay-session-id": String(ownerSessionId) } : {};
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const dequeued = await api("/api/pending", { headers });
      if (String(dequeued.payload?.message?.id || "") === messageId) return { conversationId, messageId };
      await sleep(250);
    }
    throw new Error("The message was never handed out");
  }

  /** The relay events written into a conversation, as their texts. */
  async function eventTexts(api, conversationId) {
    const { payload } = await api(`/api/conversation/${encodeURIComponent(conversationId)}?limit=50`);
    return (payload?.messages || []).filter((message) => message.kind === "relay-event").map((message) => String(message.text || ""));
  }

  async function expectEvent(api, conversationId, pattern) {
    await expect.poll(async () => (await eventTexts(api, conversationId)).some((text) => pattern.test(text)), { timeout: 20_000 }).toBe(true);
  }

  async function openApp(page, viewport, relay = relayA) {
    await page.setViewportSize(viewport);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForFunction(() => typeof window.toggleInboxView === "function");
  }

  async function openInbox(page) {
    const button = page.locator("#inbox-btn");
    // On screen and the topmost element at its centre: a phone's drawer, or a
    // collapsed desktop sidebar, has to open first.
    const reachable = () => button.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || rect.left < 0 || rect.right > window.innerWidth) return false;
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(top && (top === node || node.contains(top)));
    });
    if (!(await reachable())) await page.locator("#sidebar-toggle").click();
    await expect.poll(reachable).toBe(true);
    await button.click();
    await expect(page.locator(".inbox-view")).toBeVisible();
  }

  test.beforeAll(async () => {
    relayA = await startRelayServer({ token: randomUUID() });
    relayB = await startRelayServer({ token: randomUUID() });
    expect((await apiA("/api/settings/pwa-app-name", { method: "POST", body: { appName: "win-test" } })).status).toBe(200);
    expect((await apiB("/api/settings/pwa-app-name", { method: "POST", body: { appName: "linux-test" } })).status).toBe(200);
    expect((await apiA("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).status).toBe(200);
    const added = await apiA("/api/remote-relays", { method: "POST", body: { url: relayB.baseUrl, token: relayB.token, pairBack: false } });
    expect(added.payload?.ok, JSON.stringify(added.payload)).toBe(true);
    // On A: a lead (its first message names linux-test, which unlocks it there),
    // a worker, and a session whose turn waits on a card.
    sessions.lead = (await conversation(apiA, `cache lead ${suffix}: plan the work with linux-test`)).conversationId;
    sessions.worker = (await conversation(apiA, `cache worker ${suffix}`)).conversationId;
    sessions.waiting = await conversationWithRunningTurn(apiA, `theme picker ${suffix}`);
    const card = await apiA("/api/relay-question", {
      method: "POST",
      body: { queueId: sessions.waiting.messageId, prompt: "Which theme?", choices: ["Light", "Dark"], allowFreeform: false, timeout_ms: 600_000 },
    });
    expect(card.status, JSON.stringify(card.payload)).toBe(200);
    sessions.cardId = card.payload.question.id;
    // On B: a session A's lead asks about.
    sessions.far = (await conversation(apiB, `far worker ${suffix}`)).conversationId;
  });

  test.afterAll(async () => {
    await Promise.all([relayA?.stop(), relayB?.stop()]);
    relayA = null;
    relayB = null;
  });

  test("desktop: count, list, answer, dismiss, filter; agent text stays text; the askers are told", async ({ page }) => {
    const own = await toolA(sessions.lead, "ask", {
      question: "Which database for the cache?",
      options: ["Postgres", "SQLite"],
      recommendation: "SQLite",
      detail: XSS_DETAIL,
    });
    expect(own.status, JSON.stringify(own.payload)).toBe(200);
    expect(own.payload.status).toBe("pending");
    const behalf = await toolA(sessions.lead, "ask", { session: sessions.worker, question: "May the worker rename the module?" });
    expect(behalf.status, JSON.stringify(behalf.payload)).toBe(200);

    await openApp(page, DESKTOP);
    await expect(page.locator("#inbox-count")).toHaveText("3");
    await openInbox(page);
    const inbox = page.locator(".inbox-view");
    const here = inbox.locator('.inbox-relay[data-relay-id="self"]');
    await expect(here.locator(".inbox-relay-name")).toHaveText("win-test (this relay)");
    await expect(here.locator(".inbox-item")).toHaveCount(3);
    // Newest first: the ask on the worker's behalf, then the lead's, then the card.
    await expect(here.locator(".inbox-item-question").first()).toHaveText("May the worker rename the module?");

    const ownCard = inbox.locator(`.inbox-item[data-item-id="${own.payload.question_id}"]`);
    await expect(ownCard.locator(".inbox-choice.recommended")).toHaveAttribute("data-choice", "SQLite");
    await ownCard.locator("details summary").click();
    await expect(ownCard.locator(".inbox-item-detail-text")).toHaveText(XSS_DETAIL);
    expect(await inbox.locator("img, b").count()).toBe(0);
    expect(await page.evaluate(() => window.__inboxXss)).toBeUndefined();

    // The filter: the worker's session is the owner's too here (a message made it).
    await inbox.locator('[data-inbox-filter="agents"]').click();
    await expect(here.locator(".inbox-item")).toHaveCount(0);
    await inbox.locator('[data-inbox-filter="all"]').click();
    await expect(here.locator(".inbox-item")).toHaveCount(3);

    // Answer with the recommended option: it moves under the divider.
    await ownCard.locator(".inbox-choice.recommended").click();
    await expect(page.locator("#inbox-count")).toHaveText("2");
    await expect(here.locator(".inbox-divider")).toHaveText("Answered in the last day");
    await expect(inbox.locator(`.inbox-item[data-item-id="${own.payload.question_id}"] .inbox-item-outcome`)).toHaveText("Answered: SQLite");
    await expectEvent(apiA, sessions.lead, /question_answered \(question_id ask_[0-9a-f]+\) "Which database for the cache\?" → the user answered "SQLite"/);

    // Dismiss the one asked on the worker's behalf: the worker and the lead hear of it.
    await inbox.locator(`.inbox-item[data-item-id="${behalf.payload.question_id}"] .inbox-dismiss`).click();
    await expect(page.locator("#inbox-count")).toHaveText("1");
    await expectEvent(apiA, sessions.worker, /question_answered .* → the user dismissed it/);
    await expectEvent(apiA, sessions.lead, /"May the worker rename the module\?" → the user dismissed it/);

    // The card a turn waits on, answered from here like in its session.
    const waiting = inbox.locator(`.inbox-item[data-item-id="${sessions.cardId}"]`);
    await expect(waiting.locator(".inbox-item-kind")).toHaveText("Question · the session waits");
    await waiting.locator('.inbox-choice[data-choice="Dark"]').click();
    await expect(page.locator("#inbox-count")).toHaveText("");
    const answered = await apiA(`/api/relay-question/${encodeURIComponent(sessions.cardId)}`);
    expect(answered.payload.question.status).toBe("answered");
    expect(answered.payload.question.answer).toBe("Dark");
  });

  test("the ask's card in its session does not block it and answers in place", async ({ page }) => {
    const asked = await toolA(sessions.worker, "ask", { question: "Keep the old API for a release?", options: ["Yes", "No"] });
    expect(asked.status, JSON.stringify(asked.payload)).toBe(200);
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, sessions.worker);
    await openApp(page, DESKTOP);
    const card = page.locator(`.relay-ask-container[data-ask-id="${asked.payload.question_id}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator(".inbox-item-kind")).toHaveText("Question for you · does not block this session");
    await expect(page.locator("#input-area")).toBeVisible();
    await card.locator(".inbox-answer-text").fill("Yes, until 2.0");
    await card.locator(".inbox-answer").click();
    await expect(card).toHaveCount(0);
    // Typed text that is no option carries none.
    await expectEvent(apiA, sessions.worker, /"Keep the old API for a release\?" → the user answered "Yes, until 2\.0" \(via relay "win-test"\)$/m);
  });

  test("phone: one column, buttons the full width", async ({ page }) => {
    const asked = await toolA(sessions.lead, "ask", { question: "Ship on Friday?", options: ["Yes", "No"], urgency: "now" });
    expect(asked.status).toBe(200);
    await openApp(page, PHONE);
    await openInbox(page);
    const item = page.locator(`.inbox-item[data-item-id="${asked.payload.question_id}"]`);
    await expect(item.locator(".inbox-item-urgent")).toHaveText("urgent");
    const itemBox = await item.boundingBox();
    expect(itemBox.x).toBeGreaterThanOrEqual(0);
    expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(PHONE.width);
    const yes = await item.locator('.inbox-choice[data-choice="Yes"]').boundingBox();
    const no = await item.locator('.inbox-choice[data-choice="No"]').boundingBox();
    const answer = await item.locator(".inbox-answer").boundingBox();
    // Stacked, each as wide as the others and nearly the card's width.
    expect(no.y).toBeGreaterThan(yes.y);
    expect(Math.abs(yes.width - no.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(yes.width - answer.width)).toBeLessThanOrEqual(1);
    expect(yes.width).toBeGreaterThan(itemBox.width * 0.8);
    await item.locator('.inbox-choice[data-choice="No"]').click();
    await expect(item.locator(".inbox-item-outcome")).toHaveText("Answered: No");
  });

  test("an ask about a session on a paired relay: listed under it, answered through the pairing, both sides told", async ({ page }) => {
    const asked = await toolA(sessions.lead, "ask", { relay: "linux-test", session: sessions.far, question: "Run the migration tonight?", options: ["Tonight", "Tomorrow"] });
    expect(asked.status, JSON.stringify(asked.payload)).toBe(200);
    const id = asked.payload.question_id;
    // Stored on B, with its card there.
    const onB = await apiB(`/api/relay-question/${encodeURIComponent(id)}`);
    expect(onB.payload.question.kind).toBe("ask");
    expect(onB.payload.question.askedBy.relay).toBe("win-test");

    await openApp(page, DESKTOP);
    await openInbox(page);
    const there = page.locator('.inbox-relay:has(.inbox-relay-name:text-is("linux-test"))');
    const item = there.locator(`.inbox-item[data-item-id="${id}"]`);
    await expect(item).toBeVisible();
    await expect(item.locator(".inbox-item-relay")).toHaveText("linux-test");
    await expect(item.locator(".inbox-open-there")).toHaveAttribute("href", `${relayB.baseUrl}/?conv=${sessions.far}`);
    await item.locator('.inbox-choice[data-choice="Tomorrow"]').click();
    await expect(item.locator(".inbox-item-outcome")).toHaveText("Answered: Tomorrow (from win-test)");

    const after = await apiB(`/api/relay-question/${encodeURIComponent(id)}`);
    expect(after.payload.question.status).toBe("answered");
    await expectEvent(apiB, sessions.far, /"Run the migration tonight\?" → the user answered "Tomorrow" \(via relay "win-test"\)/);
    // A's lead learns it through the link (a fetch every few seconds).
    await expectEvent(apiA, sessions.lead, /linux-test · session .*question_answered \(question_id ask_[0-9a-f]+\) "Run the migration tonight\?" → the user answered "Tomorrow" \(via relay "win-test"\)/);
    // B's agent cannot answer it, nor can A's with answer_question.
    const byTool = await toolA(sessions.lead, "answer_question", { relay: "linux-test", question_id: id, choices: ["Tonight"] });
    expect(byTool.status).toBe(403);
  });
});
