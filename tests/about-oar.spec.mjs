import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { startRelayServer } from "./relay-server-harness.mjs";

/**
 * ⋯ → About OAR, on a desktop and a phone viewport: the entry carries the
 * running version, the modal shows its sections and the two links, the update
 * line follows the opt-in check (a local stub manifest, never oar.sh), and a
 * shared viewer has no such entry. Day/Night sits in the same menu and works
 * outside the shared view too.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;

for (const profile of [
  { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, touch: false },
  { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, touch: true },
]) {
  test.describe(`About OAR on a ${profile.name} viewport`, () => {
    test.use(profile.use);
    test.describe.configure({ mode: "serial", timeout: 120_000 });

    let relay = null;
    let headers = null;
    let manifestServer = null;

    test.beforeAll(async () => {
      manifestServer = http.createServer((_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          schemaVersion: 1,
          channels: {
            stable: { version: "99.0.0", publishedAt: "2026-09-05T00:00:00Z", notesUrl: "https://github.com/oar-sh/oar/releases/tag/v99.0.0", critical: false },
          },
        }));
      });
      await new Promise((resolve) => manifestServer.listen(0, "127.0.0.1", resolve));
      relay = await startRelayServer({
        token: randomUUID(),
        overrides: {
          OAR_NO_UPDATE_CHECK: "",
          OAR_UPDATE_MANIFEST_URL: `http://127.0.0.1:${manifestServer.address().port}/latest.json`,
        },
      });
      headers = { Authorization: `Bearer ${relay.token}` };
    });

    test.afterAll(async () => {
      if (relay) await relay.stop();
      relay = null;
      if (manifestServer) {
        manifestServer.closeAllConnections?.();
        await new Promise((resolve) => manifestServer.close(resolve));
      }
      manifestServer = null;
    });

    const api = (urlPath) => `${relay.baseUrl}${urlPath}`;
    const press = async (locator) => (profile.touch ? locator.tap() : locator.click());

    async function loadApp(page) {
      await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
      await page.waitForLoadState("networkidle");
      await page.waitForFunction(() => typeof window.openConversation === "function");
    }

    async function openMenu(page) {
      const trigger = page.locator("#chat-actions-menu-btn");
      await expect(trigger).toBeVisible();
      await press(trigger);
      await expect(page.locator("#chat-actions-menu")).toBeVisible();
    }

    async function openAbout(page) {
      await openMenu(page);
      const entry = page.locator("#chat-menu-about");
      await expect(entry).toBeVisible();
      await expect(entry).toHaveText(`ℹ️ About OAR · ${VERSION}`);
      await press(entry);
      const modal = page.locator("#summary-modal");
      await expect(modal).toHaveClass(/visible/);
      await expect(modal).toHaveAttribute("data-kind", "about");
      await expect(page.locator("#summary-modal-title")).toHaveText("About OAR");
      await expect(page.locator('[data-about-section="build"]')).toBeVisible();
      return modal;
    }

    test("the API answers only with the token", async ({ request }) => {
      const refused = await request.get(api("/api/about"));
      expect(refused.status()).toBe(401);
      const answered = await request.get(api("/api/about"), { headers });
      expect(answered.ok()).toBeTruthy();
      const about = await answered.json();
      expect(about.version).toBe(VERSION);
      expect(about.stats).toEqual(expect.objectContaining({ conversations: expect.any(Number), turns: expect.any(Number) }));
      expect(about.relay.dbBytes).toBeGreaterThan(0);
      expect(about.update.checkEnabled).toBe(false);
    });

    test("Day/Night is in the menu and switches the theme", async ({ page }) => {
      await loadApp(page);
      const before = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      await openMenu(page);
      const toggle = page.locator("#chat-menu-theme-toggle");
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveText(before === "light" ? "🌙 Night mode" : "☀️ Day mode");
      await press(toggle);
      await expect(page.locator("#chat-actions-menu")).toBeHidden();
      await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme")))
        .toBe(before === "light" ? "dark" : "light");
      // Back as it was, for the screenshots.
      await openMenu(page);
      await press(page.locator("#chat-menu-theme-toggle"));
    });

    test("the modal shows its sections and links, and how to turn update checks on", async ({ page }, testInfo) => {
      await loadApp(page);
      const modal = await openAbout(page);
      for (const id of ["build", "providers", "activity", "usage", "relay", "update", "links"]) {
        await expect(page.locator(`[data-about-section="${id}"]`)).toHaveCount(1);
      }
      await expect(page.locator('[data-about-section="build"]')).toContainText(VERSION);
      // This checkout's commit, read from its .git (a linked worktree too).
      const head = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      await expect(page.locator('[data-about-section="build"] code')).toHaveText(head);
      await expect(page.locator('[data-about-section="relay"]')).toContainText("Database");
      for (const [href, text] of [["https://github.com/oar-sh/oar", "github.com/oar-sh/oar"], ["https://oar.sh", "oar.sh"]]) {
        const link = page.locator(`[data-about-section="links"] a[href="${href}"]`);
        await expect(link).toHaveText(text);
        await expect(link).toHaveAttribute("target", "_blank");
        await expect(link).toHaveAttribute("rel", /\bnoopener\b/);
      }
      const update = page.locator('[data-about-section="update"]');
      await expect(update).toContainText("Update checks are off");
      await expect(update).not.toContainText("99.0.0");

      // Phone friendly: the dialog fits the viewport and only its body scrolls.
      await expect(page.locator("#summary-modal-title")).toBeInViewport();
      const box = await page.locator("#summary-modal .summary-dialog").boundingBox();
      const viewport = page.viewportSize();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      const overflow = await page.locator("#summary-modal-body").evaluate((body) => body.scrollWidth - body.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath(`about-${profile.name}.png`) });
      await page.locator('[data-about-section="links"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`about-${profile.name}-bottom.png`) });

      // The hint opens Settings › General at the toggle.
      await press(update.locator("[data-about-open-settings]"));
      await expect(modal).not.toHaveClass(/visible/);
      await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
      await expect(page.locator("#settings-tab-general")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#update-auto-check-toggle")).toBeVisible();
    });

    test("with the check on, the modal names the latest version", async ({ page, request }, testInfo) => {
      expect((await request.post(api("/api/update/auto-check"), { headers, data: { enabled: true } })).ok()).toBeTruthy();
      expect((await request.post(api("/api/update/check"), { headers })).ok()).toBeTruthy();
      try {
        await loadApp(page);
        await openAbout(page);
        const update = page.locator('[data-about-section="update"]');
        await expect(update).toContainText("Latest: 99.0.0");
        const notes = update.locator('a[href="https://github.com/oar-sh/oar/releases/tag/v99.0.0"]');
        await expect(notes).toHaveAttribute("target", "_blank");
        await expect(notes).toHaveAttribute("rel", /\bnoopener\b/);
        await update.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`about-update-${profile.name}.png`) });
      } finally {
        await request.post(api("/api/update/auto-check"), { headers, data: { enabled: false } });
      }
    });

    test("a shared viewer has no About entry", async ({ request, browser }) => {
      const bootstrap = await request.post(api("/api/conversation/bootstrap"), { headers, data: { title: "Sample chat to share", model: "gpt-5.4-mini" } });
      expect([200, 409]).toContain(bootstrap.status());
      const conversationId = String((await bootstrap.json())?.conversationId || "").trim();
      expect(conversationId).toBeTruthy();
      try {
        const share = await request.post(api(`/api/conversation/${conversationId}/share`), { headers });
        expect(share.ok()).toBeTruthy();
        const sharePath = String((await share.json()).path || "").trim();
        const context = await browser.newContext(profile.use);
        try {
          const sharedPage = await context.newPage();
          await sharedPage.goto(`${relay.baseUrl}${sharePath}`);
          await sharedPage.waitForLoadState("networkidle");
          await openMenu(sharedPage);
          await expect(sharedPage.locator("#chat-menu-theme-toggle")).toBeVisible();
          await expect(sharedPage.locator("#chat-menu-about")).toBeHidden();
          const refused = await context.request.get(api("/api/about"));
          expect(refused.status()).toBe(401);
        } finally {
          await context.close();
        }
      } finally {
        await request.delete(api(`/api/conversation/${conversationId}`), { headers }).catch(() => {});
      }
    });
  });
}
