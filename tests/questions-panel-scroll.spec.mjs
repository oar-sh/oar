import { expect, test } from "@playwright/test";

import { relayBaseUrl, relayToken } from "./e2e-env.mjs";
import { settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

/**
 * 📓 holds still while it is read: the list is drawn anew on every change of
 * an ask, and an ask added above the reader, or one answered there, must not
 * move the card they read. The pointer stays in the list meanwhile, as a
 * reader's does, so the header's re-fit (📓's count changes) does not move
 * the list either.
 *
 * No worker runs: the session is a conversation its first message made; the
 * asks come through the relay tool route as an agent's would.
 */

const VIEWPORT = { width: 1280, height: 640 };

async function api(route, { method = "GET", body } = {}) {
  const response = await fetch(`${relayBaseUrl()}${route}`, {
    method,
    headers: { Authorization: `Bearer ${relayToken()}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

async function ask(conversationId, args) {
  const result = await api("/api/remote-relays/tool", { method: "POST", body: { conversationId, action: "ask", args: { relay: "this", ...args } } });
  expect(result.status, JSON.stringify(result.payload)).toBe(200);
  const id = result.payload?.question_id || result.payload?.result?.question_id;
  expect(id, JSON.stringify(result.payload)).toBeTruthy();
  return id;
}

test("📓: an ask added above the reader, or one answered there, does not move what they read", async ({ page }) => {
  const { conversationId } = await startConversation({ text: `Reed bed count ${Date.now()}` });
  const ids = [];
  for (let n = 1; n <= 8; n += 1) {
    ids.push(await ask(conversationId, { question: `Plot ${n}: count it again this week?`, options: ["Again", "Skip"], detail: `Plot ${n} (made up).` }));
  }

  await page.setViewportSize(VIEWPORT);
  await page.goto(`${relayBaseUrl()}/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
  await page.evaluate((id) => window.openConversation(id), conversationId);
  const button = page.locator("#questions-btn");
  await expect(button).toHaveAttribute("data-count", "8");
  await button.click();
  const panel = page.locator("#questions-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".inbox-item")).toHaveCount(8);
  // The list is taller than its room: it scrolls.
  expect(await panel.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);

  // Newest first: the reader is at plot 4, under plot 5, with 10 px of it
  // scrolled past, and the pointer in the list.
  const reader = ids[3];
  const above = ids[4];
  await panel.evaluate((node, id) => {
    const card = node.querySelector(`.inbox-item[data-item-id="${id}"]`);
    node.scrollTop += card.getBoundingClientRect().top - node.getBoundingClientRect().top + 10;
  }, reader);
  const box = await panel.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const topOf = (id) => panel.locator(`.inbox-item[data-item-id="${id}"]`).evaluate((node) => node.getBoundingClientRect().top);
  const firstVisible = () => panel.evaluate((node) => {
    const view = node.getBoundingClientRect();
    return [...node.querySelectorAll(".inbox-item")].find((card) => card.getBoundingClientRect().bottom > view.top + 1)?.dataset.itemId || "";
  });
  expect(await firstVisible()).toBe(reader);
  const before = await topOf(reader);

  // A new ask: listed first, above the reader; 📓's count changes.
  const added = await ask(conversationId, { question: "Plot 9: count it again this week?", options: ["Again", "Skip"] });
  await expect(panel.locator(`.inbox-item[data-item-id="${added}"]`)).toBeAttached();
  await expect(button).toHaveAttribute("data-count", "9");
  // The header's re-fit runs two frames after its notice.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  expect(Math.abs((await topOf(reader)) - before)).toBeLessThanOrEqual(2);

  // The card above the reader is answered (from the Inbox, say): it moves
  // under the divider, and the reader's card stays where it is.
  const answered = await api(`/api/relay-question/${encodeURIComponent(above)}/answer`, { method: "POST", body: { choice: "Again", answer: "Again" } });
  expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
  await expect(panel.locator(`.inbox-item[data-item-id="${above}"]`)).toHaveAttribute("data-status", "answered");
  await expect(panel.locator(".inbox-divider")).toBeAttached();
  expect(Math.abs((await topOf(reader)) - before)).toBeLessThanOrEqual(2);
  expect(await firstVisible()).toBe(reader);
});
