import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * Questions that don't block (relay_tool ask) and the Inbox, on two relays
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
 * - An approval card on B: A's Inbox row says what it is about,
 *   "Open there" only; A's badge follows within its ~20 s watch of B, not
 *   the Inbox's minute; with push on A only, A pushes it once (web-push
 *   stubbed: tests/web-push-capture-preload.mjs records the payload).
 *
 * No worker runs: the sessions are conversations a message created, and a
 * "turn" for the one card a turn waits on is a message the spec took off the
 * queue (GET /api/pending).
 */

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const PUSH_CAPTURE_PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), "web-push-capture-preload.mjs");
const XSS_DETAIL = 'Background:\n<img src=x onerror="window.__inboxXss=1"><b>bold?</b>';

test.describe.serial("the Inbox", () => {
  test.describe.configure({ timeout: 180_000 });

  let relayA = null;
  let relayB = null;
  // What relay A's web-push sender would have sent, one JSON line per push.
  let pushCaptureA = "";
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

  async function conversation(api, text, relayMode = "agent") {
    const queued = await api("/api/message", { method: "POST", body: { text, relayMode, model: "gpt-5.4-mini" } });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    return queued.payload;
  }

  async function conversationWithRunningTurn(api, text, relayMode = "agent") {
    const { conversationId, messageId, ownerSessionId } = await conversation(api, text, relayMode);
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
    relayA = await startRelayServer({
      token: randomUUID(),
      overrides: ({ stateRoot }) => {
        pushCaptureA = path.join(stateRoot, "pushes.jsonl");
        return {
          RELAY_E2E_PUSH_CAPTURE: pushCaptureA,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${pathToFileURL(PUSH_CAPTURE_PRELOAD).href}`.trim(),
        };
      },
    });
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

  test("the Inbox opens at the top, and comes back where it was left", async ({ page }, testInfo) => {
    // A short window: the Inbox overflows, so there is a scroll height to
    // remember. A long session is open first and scrolled down, as it is
    // when the Inbox is used: its height must not become the Inbox's.
    const { conversationId: long, messageId: first } = await conversation(apiA, `long chat ${suffix}`);
    // Bound to its session, so later messages are accepted into it.
    expect((await apiA("/api/session-sync", { method: "POST", body: { sdk_session_id: long, conversation_id: long } })).status).toBe(200);
    let messageId = first;
    for (let turn = 0; turn < 8; turn += 1) {
      expect((await apiA("/api/response", { method: "POST", body: { messageId, conversationId: long, text: `reply ${turn}`, model: "gpt-5.4-mini", mode: "agent" } })).status).toBe(200);
      const next = await apiA("/api/message", { method: "POST", body: { conversationId: long, text: `message ${turn}`, relayMode: "agent", model: "gpt-5.4-mini" } });
      expect(next.status, JSON.stringify(next.payload)).toBe(200);
      messageId = next.payload.messageId;
    }
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, long);
    await openApp(page, { width: 1280, height: 360 });
    const messages = page.locator("#messages");
    await expect.poll(() => messages.locator("[data-message-id]").count()).toBeGreaterThan(10);
    await messages.evaluate((node) => { node.scrollTop = 300; });
    expect(await messages.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await openInbox(page);
    expect(await messages.evaluate((node) => node.scrollTop)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("inbox-opens-at-top.png") });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.screenshot({ path: testInfo.outputPath("inbox-opens-at-top-light.png") });
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    await messages.evaluate((node) => { node.scrollTop = 120; });
    const kept = await messages.evaluate((node) => node.scrollTop);
    expect(kept).toBeGreaterThan(0);
    // The button again leaves the Inbox; opening it once more finds the height.
    await page.locator("#inbox-btn").click();
    await expect(page.locator(".inbox-view")).toHaveCount(0);
    await openInbox(page);
    await expect.poll(() => messages.evaluate((node) => node.scrollTop)).toBe(kept);
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

  // Every change of a question (socket) and the minute's poll draw the Inbox
  // anew; an open Details fold used to come back closed. Made-up texts only.
  test("an open Details fold stays open when the Inbox is drawn again in the background", async ({ page }, testInfo) => {
    const stub = await toolA(sessions.lead, "ask", {
      question: "Approve the plan for the cache layer?",
      options: ["Approve", "Revise"],
      detail: "Plan draft (made up):\n1. Add a read-through cache in front of the store\n2. Expire entries after 10 minutes\n3. Count hits and misses in the status view",
    });
    expect(stub.status, JSON.stringify(stub.payload)).toBe(200);
    const shotDir = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim() || testInfo.outputPath();
    let later = 0;
    for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
      await openApp(page, viewport);
      await openInbox(page);
      const card = page.locator(`.inbox-item[data-item-id="${stub.payload.question_id}"]`);
      const fold = card.locator("details.inbox-item-detail");
      await card.locator("details summary").click();
      await expect(fold).toHaveAttribute("open", "");
      // Marks this drawing of the card: a re-render replaces the node.
      await card.evaluate((node) => { node.dataset.drawing = "before"; });
      // A background change: another session's question comes in.
      later += 1;
      const other = await toolA(sessions.worker, "ask", { question: `Background question ${later}?` });
      expect(other.status).toBe(200);
      await expect(page.locator(`.inbox-item[data-item-id="${other.payload.question_id}"]`)).toBeVisible();
      await expect(card).not.toHaveAttribute("data-drawing", "before");
      await expect(fold).toHaveAttribute("open", "");
      await expect(card.locator(".inbox-item-detail-text")).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shotDir}/inbox-details-open-after-update-${name}.png` });
    }
    // Closed by hand, it stays closed through the next update.
    const card = page.locator(`.inbox-item[data-item-id="${stub.payload.question_id}"]`);
    await card.locator("details summary").click();
    await expect(card.locator("details.inbox-item-detail")).not.toHaveAttribute("open", "");
    const last = await toolA(sessions.worker, "ask", { question: "Background question 3?" });
    await expect(page.locator(`.inbox-item[data-item-id="${last.payload.question_id}"]`)).toBeVisible();
    await expect(card.locator("details.inbox-item-detail")).not.toHaveAttribute("open", "");
  });

  // ─── Other relays' approval cards ──────────────────────────────

  /** B knows A too, so an agent on B can act on A (and needs an approval card for it in ask mode). */
  async function pairBWithA() {
    const listed = await apiB("/api/remote-relays");
    if ((listed.payload?.relays || []).some((relay) => relay.url === relayA.baseUrl)) return;
    const added = await apiB("/api/remote-relays", { method: "POST", body: { url: relayA.baseUrl, token: relayA.token, pairBack: false } });
    expect(added.payload?.ok, JSON.stringify(added.payload)).toBe(true);
  }

  /**
   * An agent on B in ask mode asks for a new session on A: B puts an
   * approval card on its turn, and the tool call waits for it. Resolves the
   * card's id, its session and the waiting call.
   */
  async function approvalCardOnB(label) {
    await pairBWithA();
    const turn = await conversationWithRunningTurn(apiB, `${label} ${suffix}: start a docs session on win-test`, "ask");
    const waiting = apiB("/api/remote-relays/tool", {
      method: "POST",
      body: { conversationId: turn.conversationId, action: "create_session", args: { relay: "win-test", title: "Docs pass", text: "Draft the release notes from the merged pull requests" } },
    });
    let id = "";
    await expect.poll(async () => {
      const { payload } = await apiB(`/api/relay-questions?conversationId=${encodeURIComponent(turn.conversationId)}`);
      id = String((payload?.questions || []).find((question) => question.status === "pending")?.id || "");
      return id;
    }, { timeout: 20_000 }).not.toBe("");
    return { id, conversationId: turn.conversationId, waiting };
  }

  async function denyOnB(card) {
    const answered = await apiB(`/api/relay-question/${encodeURIComponent(card.id)}/answer`, { method: "POST", body: { answer: "Deny" } });
    expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
    await card.waiting;
  }

  function pushesOfA() {
    try {
      return fs.readFileSync(pushCaptureA, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).payload);
    } catch {
      return [];
    }
  }

  test("an approval card on B: A's row says what it is about, Open there only; the badge follows without the minute's poll", async ({ page }) => {
    await openApp(page, DESKTOP);
    const count = page.locator("#inbox-count");
    const countNow = async () => Number((await count.textContent()) || 0) || 0;
    await expect.poll(countNow).toBeGreaterThan(0);
    const before = await countNow();
    const loadedAt = Date.now();

    const card = await approvalCardOnB("docs lead");
    // A's watch of B (every ~20 s) tells the page; the Inbox's own poll is a minute.
    await expect.poll(countNow, { timeout: 40_000 }).toBe(before + 1);
    expect(Date.now() - loadedAt).toBeLessThan(60_000);

    await openInbox(page);
    const item = page.locator(`.inbox-relay:has(.inbox-relay-name:text-is("linux-test")) .inbox-item[data-item-id="${card.id}"]`);
    await expect(item).toBeVisible();
    await expect(item.locator(".inbox-item-kind")).toHaveText("New session · the session waits");
    await expect(item.locator(".inbox-item-summary")).toHaveText(/^linux-test · New session requested by '.+': Docs pass$/);
    await expect(item.locator(".inbox-open-there-button")).toHaveAttribute("href", `${relayB.baseUrl}/?conv=${card.conversationId}`);
    await expect(item.locator("button")).toHaveCount(0);
    await expect(page.locator(".inbox-view")).not.toContainText("Draft the release notes");

    await denyOnB(card);
    await expect.poll(countNow, { timeout: 40_000 }).toBe(before);
  });

  test("push on A only: A pushes B's card once, titled by B, with the link there and no answer buttons", async () => {
    // No browser is open: no device is active, and A's watch runs for its push subscriber.
    const subscribed = await apiA("/api/push/subscribe", {
      method: "POST",
      body: {
        deviceId: `e2e-phone-${suffix}`,
        label: "phone",
        subscription: { endpoint: `https://push.example.test/e2e-phone-${suffix}`, keys: { p256dh: "e2e-p256dh", auth: "e2e-auth" } },
        preferences: { content: { preview: "full" } },
      },
    });
    expect(subscribed.status, JSON.stringify(subscribed.payload)).toBe(200);
    const card = await approvalCardOnB("notes lead");
    const remote = () => pushesOfA().filter((payload) => payload.data?.remoteRelayId);
    await expect.poll(() => remote().length, { timeout: 40_000 }).toBe(1);
    const [payload] = remote();
    expect(payload.title).toBe('Approval waiting on relay "linux-test"');
    expect(payload.body).toMatch(/^New session requested by '.+': Docs pass$/);
    expect(payload.data.url).toBe(`${relayB.baseUrl}/?conv=${card.conversationId}`);
    expect(payload.data.questionId).toBeUndefined();
    expect(payload.data.choices).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("Draft the release notes");
    // The next sweeps push it no more.
    await sleep(25_000);
    expect(remote()).toHaveLength(1);
    if (process.env.INBOX_PUSH_PAYLOAD_OUT) fs.writeFileSync(process.env.INBOX_PUSH_PAYLOAD_OUT, `${JSON.stringify(payload, null, 2)}\n`);
    await denyOnB(card);
  });
});
