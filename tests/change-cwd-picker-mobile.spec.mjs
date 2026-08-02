import { devices, expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// Mobile regression suite for the Change CWD picker.
//
// The original defect: the known-CWD panel was an in-flow block, and selecting an
// entry ran on `pointerup` and collapsed the panel synchronously. That removed up
// to 220px of layout, sliding an action button up under the finger, and the
// delayed compatibility `click` then pressed it.
//
// Which test actually guards this: "the action row never moves" is the reliable
// one — on the old code it fails with a ~228px jump, which is the mechanism. The
// "does not ghost-click" test is a belt-and-braces check; whether the stray click
// lands depends on engine timing and it does not reproduce deterministically in
// headless Chromium, so do not treat it passing as proof on its own.
//
// These tests must use tap() (real touch events), not click().

test.use({ ...devices["iPhone 12"], browserName: "chromium" });

const RECENT_ROOTS = Array.from(
  { length: 20 },
  (_, index) => `C:\\workspaces\\recent-${String(index + 1).padStart(2, "0")}`,
);

/**
 * Seeds one conversation and reuses it for every case in this file, so the suite
 * stays inside the shared prompt budget documented in tests/AGENTS.md.
 */
test.describe.serial("Change CWD picker on mobile", () => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  let conversationId = "";
  let messageId = "";
  /** Set by the route stubs whenever the UI actually submits. */
  let posted = null;

  test.beforeAll(async ({ request }) => {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `mobile cwd picker ${Date.now()}`, relayMode: "ask", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    const body = await queued.json();
    conversationId = String(body?.conversationId || "");
    messageId = String(body?.messageId || "");
    expect(conversationId).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (!messageId || !conversationId) return;
    await request.post("/api/response", {
      headers,
      data: { messageId, conversationId, text: "done", status: "completed" },
    }).catch(() => {});
  });

  test.beforeEach(async ({ page }) => {
    posted = null;

    await page.route("**/api/status", async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      let body = null;
      try {
        body = await response.json();
      } catch {
        return route.fulfill({ response });
      }
      body.recentWorkspaceRoots = RECENT_ROOTS;
      return route.fulfill({ response, contentType: "application/json", body: JSON.stringify(body) });
    });

    const captureSubmit = async (route) => {
      const payload = route.request().postDataJSON();
      posted = { url: route.request().url(), rootPath: String(payload?.rootPath || "").trim() };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          conversationId,
          configuredWorkspaceRootPath: posted.rootPath,
          workspaceRootApplied: true,
          relaunched: true,
          recentWorkspaceRoots: RECENT_ROOTS,
        }),
      });
    };
    await page.route("**/api/conversation/*/workspace-root", captureSubmit);
    await page.route("**/api/conversation/*/relaunch-with-workspace-root", captureSubmit);

    await page.addInitScript((id) => {
      localStorage.setItem("copilot_last_conv", id);
    }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
  });

  async function openChangeCwdModal(page) {
    await page.locator("#chat-actions-menu-btn").tap();
    await page.locator("#chat-menu-change-cwd").tap();
    await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
  }

  test("selecting a CWD does not ghost-click an action button", async ({ page }) => {
    await openChangeCwdModal(page);

    const trigger = page.locator("#change-cwd-menu-trigger");
    const menu = page.locator("#change-cwd-menu");
    await trigger.tap();
    await expect(menu).toBeVisible();

    const options = page.locator("#change-cwd-menu .change-cwd-menu-item[data-path]");
    await expect.poll(() => options.count()).toBeGreaterThanOrEqual(10);

    // Pick a late entry: on the old layout it sat directly above the action row,
    // which is what the collapse then slid under the finger.
    const picked = options.nth(await options.count() - 1);
    const pickedPath = String(await picked.getAttribute("data-path") || "").trim();
    expect(pickedPath).toBeTruthy();
    await picked.tap();

    await expect(menu).toBeHidden();
    await expect(page.locator("#change-cwd-selected-path")).toHaveValue(pickedPath);
    // The modal must still be open and nothing may have been submitted.
    await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
    expect(posted).toBeNull();

    // Outlast any delayed synthetic click.
    await page.waitForTimeout(600);
    await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
    expect(posted).toBeNull();
  });

  test("the action row never moves when the menu opens or closes", async ({ page }) => {
    await openChangeCwdModal(page);
    const saveButton = page.locator("#change-cwd-actions button", { hasText: "Save next-launch CWD" });
    const trigger = page.locator("#change-cwd-menu-trigger");
    const options = page.locator("#change-cwd-menu .change-cwd-menu-item[data-path]");

    const before = await saveButton.boundingBox();
    await trigger.tap();
    await expect(page.locator("#change-cwd-menu")).toBeVisible();
    const during = await saveButton.boundingBox();
    await options.nth(1).tap();
    await expect(page.locator("#change-cwd-menu")).toBeHidden();
    const after = await saveButton.boundingBox();

    expect(during.y).toBeCloseTo(before.y, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });

  test("the panel is not clipped by the dialog", async ({ page }) => {
    await openChangeCwdModal(page);
    await page.locator("#change-cwd-menu-trigger").tap();
    const menu = page.locator("#change-cwd-menu");
    await expect(menu).toBeVisible();

    const box = await menu.boundingBox();
    const viewport = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

    // The first and last *visible* options must actually be hittable.
    const hits = await menu.evaluate((panel) => {
      const items = Array.from(panel.querySelectorAll(".change-cwd-menu-item[data-path]"));
      const panelRect = panel.getBoundingClientRect();
      const visible = items.filter((item) => {
        const rect = item.getBoundingClientRect();
        return rect.top >= panelRect.top && rect.bottom <= panelRect.bottom;
      });
      const probe = (item) => {
        const rect = item.getBoundingClientRect();
        const hit = document.elementFromPoint(
          Math.floor(rect.left + rect.width / 2),
          Math.floor(rect.top + rect.height / 2),
        );
        return !!hit && !!hit.closest("#change-cwd-menu");
      };
      return { count: visible.length, first: probe(visible[0]), last: probe(visible[visible.length - 1]) };
    });
    expect(hits.count).toBeGreaterThan(0);
    expect(hits.first).toBe(true);
    expect(hits.last).toBe(true);
  });

  test("the tap that opens the modal does not ghost-click inside it", async ({ page }) => {
    await openChangeCwdModal(page);
    await page.waitForTimeout(600);
    await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
    expect(posted).toBeNull();
  });

  test("dragging the list scrolls instead of selecting", async ({ page }) => {
    await openChangeCwdModal(page);
    await page.locator("#change-cwd-menu-trigger").tap();
    const menu = page.locator("#change-cwd-menu");
    await expect(menu).toBeVisible();

    const selectedBefore = await page.locator("#change-cwd-selected-path").inputValue();
    const box = await menu.boundingBox();
    const x = Math.floor(box.x + box.width / 2);
    const startY = Math.floor(box.y + box.height - 20);
    const endY = startY - 80;

    await page.evaluate(({ x: px, startY: sy, endY: ey }) => {
      const target = document.elementFromPoint(px, sy);
      if (!target) return;
      const touch = (type, clientY) => {
        // TouchEventInit requires real Touch instances, not plain objects.
        const points = [new Touch({ identifier: 1, target, clientX: px, clientY })];
        target.dispatchEvent(new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          touches: type === "touchend" ? [] : points,
          targetTouches: type === "touchend" ? [] : points,
          changedTouches: points,
        }));
      };
      touch("touchstart", sy);
      for (let step = 1; step <= 8; step += 1) touch("touchmove", sy - (step * ((sy - ey) / 8)));
      touch("touchend", ey);
    }, { x, startY, endY });

    await page.waitForTimeout(400);
    await expect(page.locator("#change-cwd-selected-path")).toHaveValue(selectedBefore);
    await expect(menu).toBeVisible();
    expect(posted).toBeNull();
  });

  test("an honest server response is reported honestly", async ({ page }) => {
    await page.unroute("**/api/conversation/*/relaunch-with-workspace-root");
    await page.route("**/api/conversation/*/relaunch-with-workspace-root", async (route) => {
      const payload = route.request().postDataJSON();
      posted = { rootPath: String(payload?.rootPath || "").trim(), idempotencyKey: payload?.idempotencyKey };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          conversationId,
          configuredWorkspaceRootPath: posted.rootPath,
          workspaceRootApplied: false,
          relaunched: false,
          reusedExistingProcess: true,
          warning: "cwd-not-applied",
        }),
      });
    });

    await openChangeCwdModal(page);
    const relaunchButton = page.locator("#change-cwd-actions button", { hasText: "Set new CWD and (re)launch" });
    if (await relaunchButton.isDisabled()) {
      test.skip(true, "no launchable session bound to this conversation");
      return;
    }
    await page.locator("#change-cwd-manual-path").fill("C:\\workspaces\\recent-01");
    await relaunchButton.tap();

    await expect(page.locator("#model-banner")).toContainText("kept its current directory");
    expect(posted.idempotencyKey).toBeTruthy();
  });
});

test.describe("Change CWD picker keyboard access", () => {
  // Desktop-sized viewport: the picker must be fully operable without a pointer.
  // Only the viewport traits are overridden here — spreading a whole device
  // descriptor inside a describe would force a new worker and Playwright rejects it.
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test("arrow keys, Enter and Escape drive the listbox", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `cwd keyboard ${Date.now()}`, relayMode: "ask", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    const body = await queued.json();
    const conversationId = String(body?.conversationId || "");
    const messageId = String(body?.messageId || "");

    try {
      await page.route("**/api/status", async (route) => {
        const response = await route.fetch();
        if (!response.ok()) return route.fulfill({ response });
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          return route.fulfill({ response });
        }
        payload.recentWorkspaceRoots = RECENT_ROOTS;
        return route.fulfill({ response, contentType: "application/json", body: JSON.stringify(payload) });
      });
      await page.route("**/api/conversation/*/workspace-root", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, conversationId }),
      }));
      await page.addInitScript((id) => localStorage.setItem("copilot_last_conv", id), conversationId);
      await page.goto(`/?token=${encodeURIComponent(token)}`);
      await page.waitForLoadState("networkidle");

      await page.click("#chat-actions-menu-btn");
      await page.click("#chat-menu-change-cwd");
      await expect(page.locator("#summary-modal")).toHaveClass(/visible/);

      const trigger = page.locator("#change-cwd-menu-trigger");
      const menu = page.locator("#change-cwd-menu");
      await trigger.focus();

      await page.keyboard.press("ArrowDown");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(menu).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-activedescendant", /^change-cwd-option-\d+$/);

      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      const activeId = await trigger.getAttribute("aria-activedescendant");
      const expectedPath = await page.locator(`#${activeId}`).getAttribute("data-path");

      await page.keyboard.press("Enter");
      await expect(menu).toBeHidden();
      await expect(page.locator("#change-cwd-selected-path")).toHaveValue(expectedPath);
      await expect(trigger).toBeFocused();

      // Escape closes without committing.
      await page.keyboard.press("ArrowDown");
      await expect(menu).toBeVisible();
      await page.keyboard.press("End");
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(page.locator("#change-cwd-selected-path")).toHaveValue(expectedPath);
    } finally {
      if (messageId && conversationId) {
        await request.post("/api/response", {
          headers,
          data: { messageId, conversationId, text: "done", status: "completed" },
        }).catch(() => {});
      }
    }
  });
});
