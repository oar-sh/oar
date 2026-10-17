import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

/**
 * Archiving a chat whose process is live asks first, on a desktop and a phone
 * viewport, against the shared e2e relay.
 *
 * - A green chat (a live, idle worker): the row's 🗄 opens a confirmation;
 *   Cancel and Escape keep the chat, and confirming from the row's menu
 *   archives it. The test relay runs no workers, so its /api/status answer
 *   gains one ready worker for the chat's session id, the same field the
 *   sidebar turns green from.
 * - An offline chat archives at once, with no dialog.
 * - A chat with a running turn (a claimed queue row) asks too, and after the
 *   confirmation the relay still refuses it until the turn is done.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seed(request, headers, text) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "").trim();
  const messageId = String(body?.messageId || "").trim();
  expect(conversationId).toBeTruthy();
  const responded = await request.post("/api/response", {
    headers,
    data: { messageId, conversationId, text: `${text} reply`, model: "gpt-5.4-mini", mode: "agent" },
  });
  expect(responded.ok()).toBeTruthy();
  return conversationId;
}

// Claims one queued message as the relay's runner would, so its turn runs.
async function claim(request, headers, messageId, ownerSessionId = "") {
  const claimHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const pending = await request.get("/api/pending", { headers: claimHeaders });
    expect(pending.ok()).toBeTruthy();
    const message = (await pending.json())?.message || null;
    if (!message) {
      await sleep(250);
      continue;
    }
    if (String(message.id || "") === messageId) return;
    await request.post("/api/requeue", { headers, data: { messageId: String(message.id || "") } }).catch(() => {});
    await sleep(120);
  }
  throw new Error("Timed out claiming the seeded message");
}

async function archivedFlag(request, headers, conversationId) {
  const response = await request.get(`/api/conversations?archived=true`, { headers });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.conversations.find((row) => row.id === conversationId)?.archived ?? null;
}

async function openSidebar(page, token, touch) {
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.openConversation === "function");
  if (touch) await page.evaluate(() => window.toggleSidebar?.(true));
}

async function expectInViewport(page, locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).toBeTruthy();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

for (const profile of [
  { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, touch: false },
  { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, touch: true },
]) {
  test.describe(`archive confirmation on a ${profile.name} viewport`, () => {
    test.use(profile.use);

    test("a chat with a live idle process asks first; Cancel and Escape keep it", async ({ page, request }) => {
      const token = relayToken();
      const headers = { Authorization: `Bearer ${token}` };
      const stamp = Date.now();
      const sdkSessionId = `playwright-archive-confirm-${profile.name}-${stamp}`;
      const green = await seed(request, headers, `archive-confirm-green-${profile.name}-${stamp}`);
      const synced = await request.post("/api/session-sync", {
        headers,
        data: { sdk_session_id: sdkSessionId, conversation_id: green },
      });
      expect(synced.ok()).toBeTruthy();
      await page.route("**/api/status", async (route) => {
        const response = await route.fetch();
        if (!response.ok()) return route.fulfill({ response });
        const body = await response.json().catch(() => null);
        if (!body) return route.fulfill({ response });
        const sessionWorker = body.sessionWorker && typeof body.sessionWorker === "object" ? body.sessionWorker : {};
        const workers = Array.isArray(sessionWorker.workers) ? sessionWorker.workers : [];
        body.sessionWorker = {
          ...sessionWorker,
          workers: [...workers, { sdkSessionId, status: "ready", uiState: "ready", workerId: `worker-${stamp}` }],
        };
        return route.fulfill({ response, contentType: "application/json", body: JSON.stringify(body) });
      });

      try {
        await openSidebar(page, token, profile.touch);
        const row = page.locator(`#conv-list .conv-item[data-conversation-id="${green}"]`);
        await expect(row).toBeVisible();
        await expect(row).toHaveClass(/worker-ui-ready/);

        const modal = page.locator("#summary-modal");
        const cancel = modal.locator("[data-archive-cancel]");
        const confirm = modal.locator("[data-archive-confirm]");

        // The row's 🗄: the confirmation, reachable on the screen; Cancel keeps it.
        await row.hover();
        await row.locator(".conv-archive").click();
        await expect(modal).toHaveClass(/visible/);
        await expect(modal).toHaveAttribute("data-kind", "archive-confirm");
        await expect(modal.locator("#summary-modal-body")).toContainText("Archive this session? Its process is still active.");
        await expectInViewport(page, confirm);
        await expectInViewport(page, cancel);
        await expect(cancel).toBeFocused();
        await cancel.click();
        await expect(modal).not.toHaveClass(/visible/);
        await expect(row).toBeVisible();
        expect(await archivedFlag(request, headers, green)).toBe(false);

        // Escape keeps it too.
        await row.hover();
        await row.locator(".conv-archive").click();
        await expect(modal).toHaveClass(/visible/);
        await page.keyboard.press("Escape");
        await expect(modal).not.toHaveClass(/visible/);
        await expect(row).toBeVisible();
        expect(await archivedFlag(request, headers, green)).toBe(false);

        // The row's menu asks the same; confirming archives the chat.
        if (profile.touch) {
          await row.evaluate(async (node) => {
            const box = node.getBoundingClientRect();
            const init = { bubbles: true, pointerType: "touch", clientX: box.x + 20, clientY: box.y + 10, pointerId: 7 };
            node.dispatchEvent(new PointerEvent("pointerdown", init));
            // A long press opens the menu when the finger lifts.
            await new Promise((resolve) => setTimeout(resolve, 650));
            node.dispatchEvent(new PointerEvent("pointerup", init));
          });
        } else {
          await row.click({ button: "right" });
        }
        const menu = page.locator(".context-menu");
        await expect(menu).toBeVisible({ timeout: 5000 });
        await menu.locator('[data-menu-item="archive"]').click();
        await expect(modal).toHaveClass(/visible/);
        await expect(row).toBeVisible();
        await confirm.click();
        await expect(modal).not.toHaveClass(/visible/);
        await expect(row).toHaveCount(0);
        await expect.poll(() => archivedFlag(request, headers, green)).toBe(true);
      } finally {
        await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
        await request.delete(`/api/conversation/${green}`, { headers }).catch(() => {});
        await request.post("/api/sdk-session-delete/result", {
          headers,
          data: { sdk_session_id: sdkSessionId, ok: true },
        }).catch(() => {});
      }
    });

    test("an offline chat archives at once, with no dialog", async ({ page, request }) => {
      const token = relayToken();
      const headers = { Authorization: `Bearer ${token}` };
      const offline = await seed(request, headers, `archive-confirm-offline-${profile.name}-${Date.now()}`);

      try {
        await openSidebar(page, token, profile.touch);
        const row = page.locator(`#conv-list .conv-item[data-conversation-id="${offline}"]`);
        await expect(row).toBeVisible();
        await expect(row).toHaveClass(/worker-ui-offline/);
        await row.hover();
        await row.locator(".conv-archive").click();
        await expect(row).toHaveCount(0);
        await expect(page.locator("#summary-modal")).not.toHaveClass(/visible/);
        await expect.poll(() => archivedFlag(request, headers, offline)).toBe(true);
      } finally {
        await request.delete(`/api/conversation/${offline}`, { headers }).catch(() => {});
      }
    });

    test("a chat with a running turn asks, and the relay still refuses it", async ({ page, request }) => {
      const token = relayToken();
      const headers = { Authorization: `Bearer ${token}` };
      const stamp = Date.now();
      let conversationId = "";
      let messageId = "";
      let answered = false;

      try {
        const queued = await request.post("/api/message", {
          headers,
          data: { text: `archive-confirm-running-${profile.name}-${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
        });
        expect(queued.ok()).toBeTruthy();
        const queuedBody = await queued.json();
        conversationId = String(queuedBody?.conversationId || "");
        messageId = String(queuedBody?.messageId || "");
        await claim(request, headers, messageId, String(queuedBody?.ownerSessionId || ""));

        await openSidebar(page, token, profile.touch);
        const row = page.locator(`#conv-list .conv-item[data-conversation-id="${conversationId}"]`);
        await expect(row).toBeVisible();
        const modal = page.locator("#summary-modal");

        // Cancel keeps it.
        await row.hover();
        await row.locator(".conv-archive").click();
        await expect(modal).toHaveClass(/visible/);
        await expect(modal.locator("#summary-modal-body")).toContainText("Archive this session? It is still working on a reply.");
        await modal.locator("[data-archive-cancel]").click();
        await expect(modal).not.toHaveClass(/visible/);
        await expect(row).toBeVisible();

        // Confirmed, the relay's own guard answers: stop it first.
        await row.hover();
        await row.locator(".conv-archive").click();
        await modal.locator("[data-archive-confirm]").click();
        await expect(page.getByText("This conversation is still working on a reply")).toBeVisible();
        await expect(row).toBeVisible();
        expect(await archivedFlag(request, headers, conversationId)).toBe(false);

        const responded = await request.post("/api/response", {
          headers,
          data: { messageId, conversationId, text: "done", model: "gpt-5.4-mini", mode: "agent" },
        });
        expect(responded.ok()).toBeTruthy();
        answered = true;
      } finally {
        if (messageId && !answered) {
          await request.post("/api/response", {
            headers,
            data: { messageId, conversationId, text: "done", model: "gpt-5.4-mini", mode: "agent" },
          }).catch(() => {});
        }
        if (conversationId) await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
      }
    });
  });
}
