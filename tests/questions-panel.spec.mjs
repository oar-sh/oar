import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * 📓 Questions on a relay of its own: the header icon with its count (the
 * urgent count in red while an urgent ask waits), the list that drops down
 * under it (under ︙ when the icon went into the menu), the phone's sheet
 * with half-width buttons over a dim backdrop, the Inbox badge's red count,
 * back and Escape, and the Inbox's "open" landing on the ask.
 *
 * No worker runs: the sessions are conversations a message created; the
 * asks come through the relay tool route as an agent's would.
 *
 * With OAR_E2E_SCREENSHOT_DIR set, every view is shot dark and light.
 */

const DESKTOP = { width: 1280, height: 900 };
const NARROW = { width: 760, height: 900 };
const PHONE = { width: 390, height: 844 };
const SHOT_DIR = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim();

test.describe.serial("📓 Questions", () => {
  test.describe.configure({ timeout: 180_000 });

  let relay = null;
  const suffix = Date.now();
  const sessions = {};
  const asks = {};

  async function api(route, { method = "GET", body } = {}) {
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  }

  async function conversation(text) {
    const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    return queued.payload.conversationId;
  }

  async function ask(conversationId, args) {
    const result = await api("/api/remote-relays/tool", { method: "POST", body: { conversationId, action: "ask", args: { relay: "this", ...args } } });
    expect(result.status, JSON.stringify(result.payload)).toBe(200);
    const id = result.payload?.question_id || result.payload?.result?.question_id;
    expect(id, JSON.stringify(result.payload)).toBeTruthy();
    return id;
  }

  async function openApp(page, viewport) {
    await page.setViewportSize(viewport);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function" && typeof window.toggleInboxView === "function");
  }

  async function openSession(page, id) {
    await page.evaluate((conversationId) => window.openConversation(conversationId), id);
    await expect(page.locator("#questions-btn, #chat-menu-questions").first()).toBeAttached();
  }

  async function shoot(page, name) {
    if (!SHOT_DIR) return;
    for (const theme of ["dark", "light"]) {
      await page.evaluate((wanted) => window.updateTheme(wanted), theme);
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${SHOT_DIR}/${name}-${theme}.png` });
    }
    await page.evaluate(() => window.updateTheme("dark"));
  }

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
    sessions.main = await conversation(`Tide gauge calibration ${suffix}`);
    sessions.other = await conversation(`Lighthouse lamp log ${suffix}`);
    asks.first = await ask(sessions.main, { question: "Which gauge goes first?", options: ["North pier", "South pier"], recommendation: "North pier" });
    asks.urgent = await ask(sessions.main, {
      question: "Keep the old offsets?",
      options: ["Option A", "Option B"],
      recommendation: "Option B",
      detail: "The offsets from the spring survey drift by 4 mm.\nOption B resets them.",
      urgency: "now",
    });
    asks.third = await ask(sessions.main, { question: "Log the readings hourly or daily?" });
    asks.elsewhere = await ask(sessions.other, { question: "Replace the lamp this week?", options: ["Yes", "Next week"] });
  });

  test.afterAll(async () => {
    await relay?.stop();
    relay = null;
  });

  test("desktop: the red count, the list, an answer that moves the card, Escape and back", async ({ page }) => {
    await openApp(page, DESKTOP);
    // The Inbox badge: one urgent of four, in red.
    const inboxCount = page.locator("#inbox-count");
    await expect(inboxCount).toHaveText("1");
    await expect(inboxCount).toHaveClass(/is-urgent/);
    await expect(page.locator("#inbox-btn")).toHaveAttribute("aria-label", "Inbox, 1 urgent of 4 waiting");

    await openSession(page, sessions.main);
    const button = page.locator("#questions-btn");
    await expect(button).toBeVisible();
    await expect(button.locator(".header-icon-count")).toHaveText("1");
    await expect(button.locator(".header-icon-count")).toHaveClass(/is-urgent/);
    await expect(button).toHaveAttribute("title", "Questions (1 urgent of 3 open)");
    // First of the header's icons.
    expect(await page.locator("#chat-header-actions > button:not([hidden])").first().getAttribute("id")).toBe("questions-btn");
    await shoot(page, "header-desktop");

    await button.click();
    const panel = page.locator("#questions-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".questions-panel-title")).toHaveText("📓 Questions · 1 urgent · 3 open");
    const cards = panel.locator(".inbox-item");
    await expect(cards).toHaveCount(3);
    await expect(cards.first()).toHaveAttribute("data-item-id", asks.urgent);
    await expect(cards.first().locator("details.inbox-item-detail")).toHaveJSProperty("open", true);
    // The list hangs under 📓.
    const [buttonBox, panelBox] = [await button.boundingBox(), await panel.boundingBox()];
    expect(panelBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height);
    await shoot(page, "panel-desktop");

    // A typed draft survives the re-render an answer elsewhere brings.
    // Pending newest first after the urgent one.
    await expect(cards.nth(1)).toHaveAttribute("data-item-id", asks.third);
    await expect(cards.nth(2)).toHaveAttribute("data-item-id", asks.first);
    await panel.locator(`.inbox-item[data-item-id="${asks.third}"] .inbox-answer-text`).fill("Hourly, for a week");
    await cards.first().locator(".inbox-choice", { hasText: "Option B" }).click();
    await expect(panel).toBeVisible();
    await expect(panel.locator(".inbox-divider")).toHaveText("Answered in the last day");
    const answered = panel.locator(`.inbox-item[data-item-id="${asks.urgent}"]`);
    await expect(answered.locator(".inbox-item-outcome")).toHaveText("Answered: Option B");
    await expect(panel.locator(`.inbox-item[data-item-id="${asks.third}"] .inbox-answer-text`)).toHaveValue("Hourly, for a week");
    await expect(button.locator(".header-icon-count")).toHaveText("2");
    await expect(button.locator(".header-icon-count")).not.toHaveClass(/is-urgent/);
    await expect(inboxCount).toHaveText("3");
    await expect(inboxCount).not.toHaveClass(/is-urgent/);

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();

    // Back closes it, and the session stays.
    await button.click();
    await expect(panel).toBeVisible();
    // The history watches the open list (an entry of its own) before back.
    await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.oarOverlay))).toBe(true);
    await page.goBack();
    await expect(panel).toBeHidden();
    await expect(page.locator("#chat-title")).toContainText("Tide gauge calibration");

    // A click outside closes it; ✕ does too.
    await button.click();
    await page.locator("#messages").click({ position: { x: 20, y: 20 } });
    await expect(panel).toBeHidden();
    await button.click();
    await panel.locator(".questions-panel-close").click();
    await expect(panel).toBeHidden();
  });

  test("narrow desktop: 📓 in ︙ carries its count, and the list hangs from ︙", async ({ page }) => {
    // 📓 is the header's first priority: it goes into ︙ only when nothing
    // fits, as on a narrow window at the largest text scale.
    await openApp(page, NARROW);
    await page.evaluate(() => window.updateFontScaleFromSelect("1.5"));
    await openSession(page, sessions.other);
    const twin = page.locator("#chat-menu-questions");
    await expect(page.locator("#questions-btn")).toBeHidden();
    await page.locator("#chat-actions-menu-btn").click();
    await expect(twin).toBeVisible();
    await expect(twin).toHaveText("📓 Questions (1 open)");
    await twin.click();
    const panel = page.locator("#questions-panel");
    await expect(panel).toBeVisible();
    // Under ︙, right edges lined up: the list follows ︙ when the header
    // re-fits after it opened, so this is read once the layout has settled.
    const placement = () => page.evaluate(() => {
      const menu = document.getElementById("chat-actions-menu-btn").getBoundingClientRect();
      const list = document.getElementById("questions-panel").getBoundingClientRect();
      return { below: list.top >= menu.bottom, rightEdgesLinedUp: Math.abs(list.right - menu.right) < 12 };
    });
    await expect.poll(placement).toEqual({ below: true, rightEdgesLinedUp: true });
    await shoot(page, "panel-from-menu-narrow");
    await page.evaluate(() => window.updateFontScaleFromSelect("1"));
  });

  test("phone: a sheet under the header, half-width buttons, a dim backdrop that closes it", async ({ page }) => {
    // One more urgent ask, so the phone shows the red count too.
    asks.phoneUrgent = await ask(sessions.main, { question: "Stop the pump during the reading?", options: ["Stop it", "Leave it running"], urgency: "now" });
    await openApp(page, PHONE);
    await openSession(page, sessions.main);
    const button = page.locator("#questions-btn");
    const twin = page.locator("#chat-menu-questions");
    // The count is in, and the header fit (one frame later) has placed 📓.
    await expect(button).toHaveAttribute("data-count", "3");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (await button.isVisible()) {
      await expect(button.locator(".header-icon-count")).toHaveText("1");
      await expect(button.locator(".header-icon-count")).toHaveClass(/is-urgent/);
      await shoot(page, "header-phone");
      await button.click();
    } else {
      await page.locator("#chat-actions-menu-btn").click();
      await expect(twin).toHaveText("📓 Questions (1 urgent)");
      await shoot(page, "header-phone-menu");
      await twin.click();
    }
    const panel = page.locator("#questions-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/is-sheet/);
    await expect(page.locator("#questions-panel-backdrop")).toBeVisible();
    const box = await panel.boundingBox();
    expect(box.x).toBeLessThan(16);
    expect(box.x + box.width).toBeGreaterThan(PHONE.width - 16);
    // Every button of a card: half the card's width, left aligned, at least 28 px high.
    const card = panel.locator(".inbox-item").first();
    const cardBox = await card.boundingBox();
    for (const node of await card.locator(".inbox-choice, .inbox-answer, .inbox-dismiss").all()) {
      const b = await node.boundingBox();
      expect(b.width).toBeLessThan(cardBox.width * 0.62);
      expect(b.x - cardBox.x).toBeLessThan(16);
      expect(b.height).toBeGreaterThanOrEqual(28);
    }
    await shoot(page, "panel-phone");
    // A tap beside the sheet, on the dimmed header strip above it.
    await page.locator("#questions-panel-backdrop").click({ position: { x: PHONE.width / 2, y: 4 } });
    await expect(panel).toBeHidden();
    await expect(page.locator("#questions-panel-backdrop")).toBeHidden();

    // The Inbox badge in red, in the drawer.
    await page.locator("#sidebar-toggle").click();
    await expect(page.locator("#inbox-count")).toHaveClass(/is-urgent/);
    await shoot(page, "inbox-badge-phone");
  });

  test("the Inbox's open: the session opens with 📓 open at that ask", async ({ page }) => {
    await openApp(page, DESKTOP);
    await page.locator("#inbox-btn").click();
    const row = page.locator(`.inbox-view .inbox-item[data-item-id="${asks.elsewhere}"]`);
    await expect(row).toBeVisible();
    await shoot(page, "inbox-badge-desktop");
    await row.locator(".inbox-open-session").click();
    const panel = page.locator("#questions-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".questions-card-focus")).toHaveAttribute("data-item-id", asks.elsewhere);
    await expect(page.locator("#chat-title")).toContainText("Lighthouse lamp log");
  });
});

/**
 * 📓 stubs: the one line an ask leaves in the bubble of the turn that asked
 * it (live while the turn runs, then in its reply, after a reload too), the
 * answer it then shows, the standalone line of an ask on behalf of another
 * session, and the ask a compaction carries into the new conversation.
 */
test.describe.serial("📓 stubs", () => {
  test.describe.configure({ timeout: 180_000 });

  let relay = null;
  const suffix = Date.now();
  const turn = {};
  const ids = {};

  async function api(route, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  }

  async function conversation(text) {
    const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    return queued.payload;
  }

  // A turn a worker took: its queue row is the live one while it runs.
  async function runningTurn(text) {
    const { conversationId, messageId, ownerSessionId } = await conversation(text);
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

  async function ask(conversationId, args) {
    const result = await api("/api/remote-relays/tool", { method: "POST", body: { conversationId, action: "ask", args } });
    expect(result.status, JSON.stringify(result.payload)).toBe(200);
    return result.payload.question_id;
  }

  async function openApp(page, viewport, conversationId) {
    await page.setViewportSize(viewport);
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function");
  }

  async function shoot(page, name) {
    if (!SHOT_DIR) return;
    for (const theme of ["dark", "light"]) {
      await page.evaluate((wanted) => window.updateTheme(wanted), theme);
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${SHOT_DIR}/${name}-${theme}.png` });
    }
    await page.evaluate(() => window.updateTheme("dark"));
  }

  const stub = (page, id) => page.locator(`#messages .msg-ask-stub[data-ask-id="${id}"]`);

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
    // An agent asks on behalf of another session only with agent sessions on.
    expect((await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).status).toBe(200);
    Object.assign(turn, await runningTurn(`Salt marsh transect ${suffix}`));
    ids.live = await ask(turn.conversationId, { question: "Walk the transect at low tide?", options: ["Option A", "Option B"], urgency: "now" });
    ids.lead = (await conversation(`Estuary lead ${suffix}`)).conversationId;
    ids.target = (await conversation(`Mudflat counts ${suffix}`)).conversationId;
    ids.behalf = await ask(ids.lead, { session: ids.target, question: "Count the waders twice?", options: ["Yes", "No"] });
  });

  test.afterAll(async () => {
    await relay?.stop();
    relay = null;
  });

  for (const [layout, viewport] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    test(`${layout}: the stub sits in the asking turn's bubble, live and in its reply, after a reload too`, async ({ page }) => {
      await openApp(page, viewport, turn.conversationId);
      if (layout === "desktop") {
        // Live: the turn still runs.
        const live = page.locator(`#thinking-indicator .msg-ask-stub[data-ask-id="${ids.live}"]`);
        await expect(live).toHaveText("📓 Question for you · urgent");
        await expect(live.locator(".msg-ask-stub-urgent")).toHaveText("urgent");
        await shoot(page, `stub-live-${layout}`);
        const answered = await api("/api/response", { method: "POST", body: { messageId: turn.messageId, conversationId: turn.conversationId, text: "The transect plan is ready; one question is in 📓.", model: "gpt-5.4-mini" } });
        expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
      }
      const inReply = page.locator(`.msg.assistant[data-source-message-id="${turn.messageId}"] .msg-ask-stub[data-ask-id="${ids.live}"]`);
      await expect(inReply).toBeVisible();
      await expect(stub(page, ids.live)).toHaveCount(1);
      await expect(page.locator(".relay-ask-container")).toHaveCount(0);
      await shoot(page, `stub-bubble-${layout}`);
      await page.reload();
      await page.waitForFunction(() => typeof window.openConversation === "function");
      await expect(inReply).toBeVisible();
      await expect(stub(page, ids.live)).toHaveCount(1);
    });
  }

  test("a tap on the stub opens 📓 at it; answered, the stub says so", async ({ page }) => {
    await openApp(page, DESKTOP, turn.conversationId);
    await stub(page, ids.live).click();
    const panel = page.locator("#questions-panel");
    await expect(panel.locator(".questions-card-focus")).toHaveAttribute("data-item-id", ids.live);
    await panel.locator(`.inbox-item[data-item-id="${ids.live}"] .inbox-choice`, { hasText: "Option B" }).click();
    await expect(stub(page, ids.live)).toHaveText("📓 Answered: Option B");
    await page.keyboard.press("Escape");
    await shoot(page, "stub-answered-desktop");
  });

  test("an ask on behalf of another session: one standalone line there", async ({ page }) => {
    await openApp(page, PHONE, ids.target);
    const line = page.locator(`.relay-ask-stub-container .msg-ask-stub[data-ask-id="${ids.behalf}"]`);
    await expect(line).toHaveText("📓 Question for you");
    await expect(page.locator(".relay-ask-stub-container")).toHaveCount(1);
    await shoot(page, "stub-standalone-phone");
  });

  test("a compaction carries the pending ask over: both counters change without a reload", async ({ page }) => {
    ids.carried = await ask(ids.target, { question: "Keep the old count sheets?", options: ["Keep", "Bin"] });
    await openApp(page, DESKTOP, ids.target);
    const button = page.locator("#questions-btn");
    await expect(button).toHaveAttribute("data-count", "2");
    const compacted = await api(`/api/conversation/${encodeURIComponent(ids.target)}/compact`, { method: "POST", body: {} });
    expect(compacted.status, JSON.stringify(compacted.payload)).toBe(200);
    const next = String(compacted.payload?.conversationId || compacted.payload?.conversation?.id || compacted.payload?.targetConversationId || "");
    expect(next, JSON.stringify(compacted.payload)).toBeTruthy();
    // The old conversation's 📓 empties by the socket alone.
    await expect(button).toBeHidden();
    await expect(page.locator(".relay-ask-stub-container")).toHaveCount(0);
    await page.evaluate((id) => window.openConversation(id), next);
    await expect(button).toHaveAttribute("data-count", "2");
    // Its turns are in the old conversation: standalone lines here.
    for (const id of [ids.behalf, ids.carried]) {
      await expect(page.locator(`.relay-ask-stub-container .msg-ask-stub[data-ask-id="${id}"]`)).toHaveCount(1);
    }
    await shoot(page, "stub-compacted-desktop");
  });
});
