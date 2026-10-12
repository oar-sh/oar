import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { startRelayServer } from "./relay-server-harness.mjs";

/**
 * Settings with no conversation open, on a fresh install.
 *
 * This spec boots its own relay on an empty database with no provider turned
 * on, the state a first start lands in: the ⋯ menu must work there, Settings
 * must be reachable from it, from the empty transcript and from New Chat, and
 * nothing may create a Copilot chat as if Copilot were set up. The shared
 * read-only view keeps Day/Night only. Half way through, the relay is marked
 * "Copilot ready" the way a real discovery would, and the screen, the
 * composer and New Chat must follow without a reload. Everything runs on a
 * desktop and on a phone viewport, where the sidebar is an off-canvas drawer.
 *
 * The shared e2e relay is not used: its catalog is marked "Copilot ready" by
 * the runner, which is exactly the state the first half must not see.
 */

const RELAY_WIDE_ENTRIES = [
  "chat-menu-pwa-version",
  "chat-menu-queue-status",
  "chat-menu-usage",
  "chat-menu-select-models",
  "chat-menu-settings",
  "chat-menu-restart-relay",
  // Shown by default; Settings → General can hide it.
  "chat-menu-suspend-host",
];

const PER_CONVERSATION_ENTRIES = [
  "chat-menu-edit-title",
  "chat-menu-share-conversation",
  "chat-menu-archive",
  "chat-menu-inspect-tmux",
  "chat-menu-change-cwd",
  "chat-menu-git-changes",
  "chat-menu-kill-session",
];

const SETUP_PLACEHOLDER = "Set up a provider to start chatting";

for (const profile of [
  { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, touch: false },
  { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, touch: true },
]) {
  test.describe(`settings without a session on a ${profile.name} viewport`, () => {
    test.use(profile.use);
    // One relay for the describe; the readiness flip half way through is a
    // state the later tests build on, so the order matters.
    test.describe.configure({ mode: "serial" });

    let relay = null;
    let headers = null;

    test.beforeAll(async () => {
      relay = await startRelayServer({ token: randomUUID() });
      headers = { Authorization: `Bearer ${relay.token}` };
    });

    test.afterAll(async () => {
      if (relay) await relay.stop();
      relay = null;
    });

    const api = (path) => `${relay.baseUrl}${path}`;
    const press = async (locator) => (profile.touch ? locator.tap() : locator.click());
    const emptyState = (page) => page.locator("#messages .empty-state");

    async function loadApp(page) {
      await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
      await page.waitForLoadState("networkidle");
      await page.waitForFunction(() => typeof window.openConversation === "function");
    }

    async function conversationCount(request) {
      const response = await request.get(api("/api/conversations"), { headers });
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      return (body.conversations || []).length;
    }

    // A conversation row exists after a bootstrap even when its worker cannot
    // start (CLI spawn is disabled on the test relay), which answers 409 with
    // the id of the committed conversation.
    async function seedConversation(request, title) {
      const response = await request.post(api("/api/conversation/bootstrap"), {
        headers,
        data: { title, model: "gpt-5.4-mini" },
      });
      const body = await response.json();
      expect([200, 409]).toContain(response.status());
      const conversationId = String(body?.conversationId || "").trim();
      expect(conversationId).toBeTruthy();
      return conversationId;
    }

    // Opens a conversation seeded through the API in a page that is already
    // loaded: the list is read again first, so the header shows the title.
    async function openSeeded(page, conversationId, title) {
      await page.evaluate(async (id) => {
        await window.refreshConversations?.();
        await window.openConversation(id);
      }, conversationId);
      await expect(page.locator("#chat-title")).toHaveText(title);
    }

    async function visibleMenuEntryIds(page) {
      return page.locator("#chat-actions-menu").evaluate((menu) => (
        Array.from(menu.children)
          .filter((child) => !child.hidden && getComputedStyle(child).display !== "none")
          .map((child) => child.id)
      ));
    }

    async function openMenu(page) {
      const trigger = page.locator("#chat-actions-menu-btn");
      await expect(trigger).toBeVisible();
      await expect(trigger).toBeEnabled();
      await press(trigger);
      const menu = page.locator("#chat-actions-menu");
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      const viewport = page.viewportSize();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      return menu;
    }

    async function closeMenu(page) {
      await page.keyboard.press("Escape");
      await expect(page.locator("#chat-actions-menu")).toBeHidden();
    }

    async function expectRelayWideMenu(page) {
      await openMenu(page);
      expect(await visibleMenuEntryIds(page)).toEqual(RELAY_WIDE_ENTRIES);
      for (const id of PER_CONVERSATION_ENTRIES) {
        await expect(page.locator(`#${id}`)).toBeHidden();
      }
    }

    async function openSettingsFromMenu(page) {
      await press(page.locator("#chat-menu-settings"));
      await expect(page.locator("#chat-actions-menu")).toBeHidden();
      await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
    }

    async function expectSettingsOnProviders(page) {
      await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
      await expect(page.locator("#settings-tab-providers")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#settings-panel-providers")).toBeVisible();
    }

    async function closeSettings(page) {
      await press(page.locator("#settings-modal .summary-close"));
      await expect(page.locator("#settings-modal")).not.toHaveClass(/visible/);
    }

    async function expectEmptyState(page, variant) {
      await expect(emptyState(page)).toHaveAttribute("data-variant", variant);
      await expect(emptyState(page)).toBeVisible();
      const box = await emptyState(page).boundingBox();
      const viewport = page.viewportSize();
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }

    async function openNewChat(page) {
      if (profile.touch) await page.evaluate(() => window.toggleSidebar?.(true));
      await press(page.locator("#new-conv-btn"));
      await expect(page.locator("#new-conversation-model-modal")).toHaveClass(/visible/);
    }

    async function cancelNewChat(page) {
      await press(page.locator("#new-conversation-model-modal .summary-close"));
      await expect(page.locator("#new-conversation-model-modal")).not.toHaveClass(/visible/);
      if (profile.touch) await page.evaluate(() => window.toggleSidebar?.(false));
    }

    test("fresh install: the menu works and reaches Settings → Providers", async ({ page }) => {
      await loadApp(page);
      await expect(page.locator("#chat-title")).toHaveText("Select or start a conversation");
      await expectRelayWideMenu(page);
      await openSettingsFromMenu(page);
      await press(page.locator("#settings-tab-providers"));
      await expectSettingsOnProviders(page);
      await press(page.locator("#settings-provider-tab-claude"));
      await expect(page.locator("#settings-provider-panel-claude")).toBeVisible();
      await closeSettings(page);
      // Closing Settings leaves the menu usable.
      await openMenu(page);
    });

    test("fresh install: the empty screen points to Settings → Providers", async ({ page }) => {
      await loadApp(page);
      await expectEmptyState(page, "setup");
      await expect(emptyState(page).locator("h3")).toHaveText("Set up a provider");
      await expect(emptyState(page).locator("p")).toContainText("Settings → Providers");
      await expect(emptyState(page).locator("p")).toContainText("Copilot CLI on the relay host");
      await expect(page.locator("#empty-state-open-settings")).toBeVisible();
      await expect(page.locator("#empty-state-new-chat")).toBeVisible();
      await expect(page.locator("#empty-state-show-conversations")).toHaveCount(0);
      await press(page.locator("#empty-state-open-settings"));
      await expectSettingsOnProviders(page);
      await closeSettings(page);
      // The second action opens New Chat, which is in its own setup state.
      await press(page.locator("#empty-state-new-chat"));
      await expect(page.locator("#new-conversation-model-modal")).toHaveClass(/visible/);
      await expect(page.locator("#new-conversation-setup-note")).toBeVisible();
      await press(page.locator("#new-conversation-model-modal .summary-close"));
      await expect(page.locator("#new-conversation-model-modal")).not.toHaveClass(/visible/);
    });

    test("fresh install: the composer does not create a chat", async ({ page, request }) => {
      await loadApp(page);
      const input = page.locator("#msg-input");
      await expect(input).toBeDisabled();
      await expect(input).toHaveAttribute("placeholder", SETUP_PLACEHOLDER);
      await expect(page.locator("#send-btn")).toBeDisabled();
      await expect(page.locator("#send-btn")).toHaveAttribute("title", SETUP_PLACEHOLDER);
      // Even a send forced from script creates nothing.
      await page.evaluate(async () => {
        const field = document.getElementById("msg-input");
        field.value = "hello from a fresh install";
        await window.sendMessage?.();
      });
      await page.waitForTimeout(500);
      expect(await conversationCount(request)).toBe(0);
      await expectEmptyState(page, "setup");
    });

    test("fresh install: New Chat does not pretend Copilot is ready", async ({ page, request }) => {
      await loadApp(page);
      await openNewChat(page);
      const note = page.locator("#new-conversation-setup-note");
      const openSettings = page.locator("#new-conversation-open-settings");
      const confirm = page.locator("#new-conversation-model-confirm");
      await expect(note).toBeVisible();
      await expect(note).toContainText("Settings → Providers");
      await expect(openSettings).toBeVisible();
      await expect(openSettings).toHaveClass(/summary-btn-accent/);
      await expect(confirm).toHaveText("Start a Copilot chat anyway");
      await expect(confirm).toBeEnabled();
      await expect(page.locator("#new-conversation-provider-row")).toBeHidden();

      // Settings first: the modal closes, Settings opens on Providers, no chat exists.
      await press(openSettings);
      await expect(page.locator("#new-conversation-model-modal")).not.toHaveClass(/visible/);
      await expectSettingsOnProviders(page);
      await closeSettings(page);
      expect(await conversationCount(request)).toBe(0);

      // "Anyway" still works: exactly one conversation, opened on screen.
      if (profile.touch) await page.evaluate(() => window.toggleSidebar?.(false));
      await openNewChat(page);
      await press(confirm);
      await expect(page.locator("#new-conversation-model-modal")).not.toHaveClass(/visible/, { timeout: 30_000 });
      await expect.poll(() => conversationCount(request), { timeout: 30_000 }).toBe(1);
      await expect(page.locator("#chat-title")).toHaveText("New Conversation");
      await expect(page.locator("#msg-input")).toBeEnabled();

      // Deleted again from another device: back to the setup screen.
      const list = await (await request.get(api("/api/conversations"), { headers })).json();
      const created = String(list.conversations[0].id);
      const deleted = await request.delete(api(`/api/conversation/${created}`), { headers });
      expect(deleted.ok()).toBeTruthy();
      await expect(page.locator("#chat-title")).toHaveText("Select or start a conversation");
      await expectEmptyState(page, "setup");
      await expect(page.locator("#msg-input")).toBeDisabled();
      expect(await conversationCount(request)).toBe(0);
    });

    test("the shared view has no Settings, even for an unknown share", async ({ request, browser }) => {
      const conversationId = await seedConversation(request, "Sample chat to share");
      try {
        const share = await request.post(api(`/api/conversation/${conversationId}/share`), { headers });
        expect(share.ok()).toBeTruthy();
        const sharePath = String((await share.json()).path || "").trim();
        expect(sharePath).toMatch(/^\/shared\//);

        for (const path of [sharePath, "/shared/no-such-share-fixture"]) {
          const context = await browser.newContext(profile.use);
          try {
            const sharedPage = await context.newPage();
            await sharedPage.goto(`${relay.baseUrl}${path}`);
            await sharedPage.waitForLoadState("networkidle");
            const trigger = sharedPage.locator("#chat-actions-menu-btn");
            await expect(trigger).toBeVisible();
            await expect(trigger).toBeEnabled();
            await (profile.touch ? trigger.tap() : trigger.click());
            await expect(sharedPage.locator("#chat-actions-menu")).toBeVisible();
            expect(await visibleMenuEntryIds(sharedPage)).toEqual(["chat-menu-shared-theme-toggle"]);
            await expect(sharedPage.locator("#chat-menu-settings")).toBeHidden();
            await expect(sharedPage.locator("#settings-modal")).not.toHaveClass(/visible/);
            // None of the empty-screen actions exist in the shared view.
            await expect(sharedPage.locator("#empty-state-open-settings")).toHaveCount(0);
            await expect(sharedPage.locator("#msg-input")).toBeDisabled();
          } finally {
            await context.close();
          }
        }
      } finally {
        await request.delete(api(`/api/conversation/${conversationId}`), { headers }).catch(() => {});
      }
    });

    test("readiness flips without a reload once a real Copilot catalog arrives", async ({ page, request }) => {
      await loadApp(page);
      await expectEmptyState(page, "setup");
      await expect(page.locator("#msg-input")).toBeDisabled();

      // What a discovery or a worker snapshot does: the catalog's source is no
      // longer the seed. Non-authoritative and naming a curated model, so the
      // model list itself does not change.
      const posted = await request.post(api("/api/models/snapshot"), {
        headers,
        data: { source: "e2e-harness:copilot-ready", models: ["gpt-5.4-mini"] },
      });
      expect(posted.ok()).toBeTruthy();

      await expectEmptyState(page, "first-chat");
      await expect(emptyState(page).locator("h3")).toHaveText("Start your first chat");
      await expect(page.locator("#empty-state-new-chat")).toBeVisible();
      await expect(page.locator("#empty-state-open-settings")).toBeVisible();
      await expect(page.locator("#msg-input")).toBeEnabled();
      await expect(page.locator("#msg-input")).not.toHaveAttribute("placeholder", SETUP_PLACEHOLDER);
      await expect(page.locator("#send-btn")).toHaveAttribute("title", "Send message");

      // New Chat is back to its usual layout.
      await openNewChat(page);
      await expect(page.locator("#new-conversation-setup-note")).toBeHidden();
      await expect(page.locator("#new-conversation-open-settings")).toBeHidden();
      await expect(page.locator("#new-conversation-model-confirm")).toHaveText("Start chat");
      await cancelNewChat(page);
      expect(await conversationCount(request)).toBe(0);
    });

    test("the menu and the screen stay right after the last conversation is deleted, here or from another device", async ({ page, request }) => {
      page.on("dialog", (dialog) => { dialog.accept().catch(() => {}); });
      await loadApp(page);

      // Deleted from this client's row menu.
      const first = await seedConversation(request, "Sample chat to delete here");
      await openSeeded(page, first, "Sample chat to delete here");
      await openMenu(page);
      await expect(page.locator("#chat-menu-edit-title")).toBeVisible();
      await closeMenu(page);
      if (profile.touch) await page.evaluate(() => window.toggleSidebar?.(true));
      const row = page.locator(`#conv-list .conv-item[data-conversation-id="${first}"]`);
      await expect(row).toBeVisible();
      if (profile.touch) {
        await row.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const init = { bubbles: true, pointerType: "touch", clientX: box.x + 20, clientY: box.y + 10, pointerId: 7 };
          node.dispatchEvent(new PointerEvent("pointerdown", init));
        });
      } else {
        await row.click({ button: "right" });
      }
      const contextMenu = page.locator(".context-menu");
      await expect(contextMenu).toBeVisible();
      await contextMenu.locator('[data-menu-item="delete"]').click();
      await expect(row).toHaveCount(0);
      if (profile.touch) await page.evaluate(() => window.toggleSidebar?.(false));
      await expect(page.locator("#chat-title")).toHaveText("Select or start a conversation");
      await expectEmptyState(page, "first-chat");
      await expectRelayWideMenu(page);
      await closeMenu(page);

      // Deleted through the API, as another device would: the socket path.
      const second = await seedConversation(request, "Sample chat to delete elsewhere");
      await openSeeded(page, second, "Sample chat to delete elsewhere");
      const deleted = await request.delete(api(`/api/conversation/${second}`), { headers });
      expect(deleted.ok()).toBeTruthy();
      await expect(page.locator("#chat-title")).toHaveText("Select or start a conversation");
      await expectEmptyState(page, "first-chat");
      await expectRelayWideMenu(page);
      await openSettingsFromMenu(page);
      await closeSettings(page);
      expect(await conversationCount(request)).toBe(0);
    });

    test("a fresh client on a relay with conversations gets the menu and the list before anything is opened", async ({ page, request }) => {
      const conversationId = await seedConversation(request, "Sample chat left over");
      try {
        await loadApp(page);
        await expect(page.locator(`#conv-list .conv-item[data-conversation-id="${conversationId}"]`)).toHaveCount(1);
        await expect(page.locator("#chat-title")).toHaveText("Select or start a conversation");
        await expectEmptyState(page, "pick");
        await expect(emptyState(page).locator("h3")).toHaveText("No conversation open");
        await expect(page.locator("#empty-state-new-chat")).toBeVisible();
        if (profile.touch) {
          await expect(page.locator("#sidebar")).not.toHaveClass(/open/);
          await press(page.locator("#empty-state-show-conversations"));
          await expect(page.locator("#sidebar")).toHaveClass(/open/);
          await page.evaluate(() => window.toggleSidebar?.(false));
        } else {
          await expect(page.locator("#empty-state-show-conversations")).toHaveCount(0);
        }
        await expectRelayWideMenu(page);
        await openSettingsFromMenu(page);
        await closeSettings(page);
      } finally {
        await request.delete(api(`/api/conversation/${conversationId}`), { headers }).catch(() => {});
      }
    });
  });
}
