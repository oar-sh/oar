import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * The "watching N sessions" chip opens its list as a popover that is fully
 * on screen, on a desktop and on a phone. The header's title slot clips its
 * overflow (for the title's ellipsis), so the list must not live inside it:
 * a hit test at the list's centre has to land on the list. Escape and a
 * click elsewhere close it; Unsubscribe in it ends the subscription.
 *
 * No worker runs: a "turn" is a message the spec took off the queue
 * (GET /api/pending), which is what a subscribe call sits on.
 */

const APPROVAL_TIMEOUT = 20_000;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 412, height: 915 };

test.describe.serial("the watching list opens unclipped", () => {
  test.describe.configure({ timeout: 120_000 });

  let relay = null;
  const suffix = Date.now();
  // Long on purpose: the list's row must still keep its button on a phone.
  const watchedTitle = `terrain shader rewrite with a much longer working title ${suffix}`;
  const watcherTitle = `release helper ${suffix}`;
  let watched = { conversationId: "", messageId: "" };
  let watcher = { conversationId: "", messageId: "" };

  async function api(route, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  }

  const tool = (conversationId, action, args = {}) => api("/api/remote-relays/tool", {
    method: "POST",
    body: { conversationId, action, args },
  });

  async function conversationWithRunningTurn(text) {
    const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    const { conversationId, messageId, ownerSessionId } = queued.payload;
    const synced = await api("/api/session-sync", {
      method: "POST",
      body: { sdk_session_id: conversationId, conversation_id: conversationId },
    });
    expect(synced.status, JSON.stringify(synced.payload)).toBe(200);
    const headers = ownerSessionId ? { "x-relay-session-id": String(ownerSessionId) } : {};
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const dequeued = await api("/api/pending", { headers });
      if (String(dequeued.payload?.message?.id || "") === messageId) return { conversationId, messageId };
      await sleep(250);
    }
    throw new Error("The message was never handed out");
  }

  async function approveNextCard(conversationId) {
    const deadline = Date.now() + APPROVAL_TIMEOUT;
    while (Date.now() < deadline) {
      const { payload } = await api(`/api/relay-questions?status=pending&conversationId=${encodeURIComponent(conversationId)}`);
      const card = (payload?.questions || []).find((question) => question?.context?.source === "remote_relay");
      if (card) {
        const answered = await api(`/api/relay-question/${encodeURIComponent(card.id)}/answer`, {
          method: "POST",
          body: { answer: "Allow", ...(card.sdkSessionId ? { sdk_session_id: card.sdkSessionId } : {}) },
        });
        expect(answered.status).toBe(200);
        return;
      }
      await sleep(150);
    }
    throw new Error("No approval card appeared");
  }

  async function subscribe() {
    const subscribed = await tool(watcher.conversationId, "subscribe", { sessions: [watched.conversationId] });
    expect(subscribed.status, JSON.stringify(subscribed.payload)).toBe(200);
  }

  async function openWatcher(page, viewport) {
    await page.setViewportSize(viewport);
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, watcher.conversationId);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function");
    const chip = page.locator("#chat-title-relay-events .relay-watch-chip");
    await expect(chip).toHaveText("👁 watching 1 session");
    return chip;
  }

  // On screen, not cut off, and the topmost element at its centre.
  async function expectUnclipped(page, locator, viewport) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    const hit = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(top && (top === element || element.contains(top)));
    });
    expect(hit).toBe(true);
  }

  async function checkPanel(page, viewport) {
    const chip = await openWatcher(page, viewport);
    // The schedules list shares the popover's class: the watching list by its id.
    const panel = page.locator("#relay-watch-panel");

    await chip.click();
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expectUnclipped(page, panel, viewport);
    // Under the chip, not over it.
    const chipBox = await chip.boundingBox();
    expect((await panel.boundingBox()).y).toBeGreaterThanOrEqual(chipBox.y + chipBox.height);
    await expect(panel.locator(".relay-watch-what")).toHaveText(watchedTitle);

    // Escape closes it; so does a click elsewhere; the chip toggles it.
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await chip.click();
    await expect(panel).toBeVisible();
    const below = await panel.boundingBox();
    await page.mouse.click(viewport.width / 2, Math.min(viewport.height - 10, below.y + below.height + 40));
    await expect(panel).toBeHidden();
    await chip.click();
    await expect(panel).toBeVisible();
    await chip.click();
    await expect(panel).toBeHidden();

    // Unsubscribe from the list.
    await chip.click();
    const button = panel.locator(".relay-watch-unsubscribe");
    await expect(button).toHaveCount(1);
    await expectUnclipped(page, button, viewport);
    await button.click();
    await expect(panel).toBeHidden();
    await expect(page.locator("#chat-title-relay-events")).toBeHidden();
    const left = await api("/api/relay-events/subscriptions");
    expect(left.payload.subscriptions).toEqual([]);
  }

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
    expect((await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).status).toBe(200);
    watched = await conversationWithRunningTurn(watchedTitle);
    watcher = await conversationWithRunningTurn(watcherTitle);
    // The first subscribe of a conversation asks the user; later ones do not.
    const first = tool(watcher.conversationId, "subscribe", { sessions: [watched.conversationId] });
    await approveNextCard(watcher.conversationId);
    expect((await first).status).toBe(200);
    const listed = await api("/api/relay-events/subscriptions");
    for (const sub of listed.payload.subscriptions) {
      expect((await api(`/api/relay-events/subscriptions/${encodeURIComponent(sub.id)}`, { method: "DELETE" })).status).toBe(200);
    }
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  test("desktop: the list shows in full, closes, and unsubscribes", async ({ page }) => {
    await subscribe();
    await checkPanel(page, DESKTOP);
  });

  test("phone: the same at phone width", async ({ page }) => {
    await subscribe();
    await checkPanel(page, PHONE);
  });
});
