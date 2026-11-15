import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";
import { completeTurn, settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

/**
 * Archiving conversations from the sidebar, the Archived view, and the row
 * context menu, against the shared e2e relay.
 *
 * Two conversations are seeded through the API. One is archived from its
 * row: it leaves the list, the relay stores it as archived, and the 🗄 toggle
 * shows it with Unarchive. The other is archived from the context menu a
 * right-click opens; on the phone profile the same menu opens on a long
 * press (pointer events with pointerType "touch", since Playwright has no
 * long-press gesture). Unarchive brings a chat back to the live list.
 */

// Made as the web client makes a chat: bound to its session from the start.
async function seed(text) {
  const started = await startConversation({ text });
  const conversationId = String(started.conversationId || "").trim();
  expect(conversationId).toBeTruthy();
  const responded = await completeTurn(started, { text: `${text} reply`, model: "gpt-5.4-mini", mode: "agent" });
  expect(responded.ok).toBeTruthy();
  return conversationId;
}

async function archivedFlag(request, headers, conversationId) {
  const response = await request.get(`/api/conversations?archived=true`, { headers });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.conversations.find((row) => row.id === conversationId)?.archived ?? null;
}

for (const profile of [
  { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, touch: false },
  { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, touch: true },
]) {
  test.describe(`conversation archive on a ${profile.name} viewport`, () => {
    test.use(profile.use);

    test("archive from the row, the Archived view, the context menu, and unarchive", async ({ page, request }) => {
      const token = relayToken();
      const headers = { Authorization: `Bearer ${token}` };
      const stamp = Date.now();
      const first = await seed(`archive-row-${profile.name}-${stamp}`);
      const second = await seed(`archive-menu-${profile.name}-${stamp}`);
      page.on("dialog", (dialog) => { dialog.accept().catch(() => {}); });

      try {
        await page.goto(`/?token=${encodeURIComponent(token)}`);
        await page.waitForLoadState("networkidle");
        await page.waitForFunction(() => typeof window.openConversation === "function");
        if (profile.touch) {
          await page.evaluate(() => window.toggleSidebar?.(true));
        }
        const row = (id) => page.locator(`#conv-list .conv-item[data-conversation-id="${id}"]`);
        await expect(row(first)).toBeVisible();
        await expect(row(second)).toBeVisible();

        // From the row: the chat leaves the live list and is stored as archived.
        await row(first).hover();
        await row(first).locator(".conv-archive").click();
        await expect(row(first)).toHaveCount(0);
        await expect.poll(() => archivedFlag(request, headers, first)).toBe(true);
        await expect(row(second)).toBeVisible();

        // From the context menu: right-click, or a long press on touch.
        if (profile.touch) {
          await row(second).evaluate(async (node) => {
            const box = node.getBoundingClientRect();
            const init = { bubbles: true, pointerType: "touch", clientX: box.x + 20, clientY: box.y + 10, pointerId: 7 };
            node.dispatchEvent(new PointerEvent("pointerdown", init));
            // A long press opens the menu when the finger lifts.
            await new Promise((resolve) => setTimeout(resolve, 650));
            node.dispatchEvent(new PointerEvent("pointerup", init));
          });
        } else {
          await row(second).click({ button: "right" });
        }
        const menu = page.locator(".context-menu");
        await expect(menu).toBeVisible({ timeout: 5000 });
        await expect(menu.locator('[data-menu-item="archive"]')).toBeVisible();
        await expect(menu.locator('[data-menu-item="delete"]')).toHaveClass(/context-menu-item-danger/);
        const menuBox = await menu.boundingBox();
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
        await menu.locator('[data-menu-item="archive"]').click();
        await expect(menu).toHaveCount(0);
        await expect(row(second)).toHaveCount(0);
        await expect.poll(() => archivedFlag(request, headers, second)).toBe(true);

        // The Archived view lists both; Unarchive brings one back.
        await page.locator("#conv-archived-toggle").click();
        await expect(page.locator("#conv-archived-banner")).toBeVisible();
        await expect(row(first)).toBeVisible();
        await expect(row(second)).toBeVisible();
        await expect(row(first)).toHaveClass(/archived/);
        await row(first).hover();
        await row(first).locator(".conv-archive").click();
        await expect(row(first)).toHaveCount(0);
        await expect.poll(() => archivedFlag(request, headers, first)).toBe(false);
        await page.locator("#conv-archived-banner .conv-archived-back").click();
        await expect(page.locator("#conv-archived-banner")).toBeHidden();
        await expect(row(first)).toBeVisible();
        await expect(row(second)).toHaveCount(0);

        // An archived chat that is opened cannot be sent to.
        await page.evaluate(async (id) => { await window.openConversation(id); }, second);
        await expect(page.locator("#send-btn")).toBeDisabled();
        await expect(page.locator("#send-btn")).toHaveAttribute("title", /archived/);
        await expect(page.locator("#chat-menu-archive")).toHaveText(/Unarchive conversation/);
      } finally {
        for (const id of [first, second]) {
          await request.delete(`/api/conversation/${id}`, { headers }).catch(() => {});
        }
      }
    });
  });
}
