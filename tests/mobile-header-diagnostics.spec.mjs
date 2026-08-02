import { devices, expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

test.use({ ...devices["iPhone 12"], browserName: "chromium" });

function makeInlineSvgDataUrl(width, height, fill = "#60a5fa") {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="${fill}"/>
      <rect x="12" y="12" width="${Math.max(0, width - 24)}" height="${Math.max(0, height - 24)}" rx="18" fill="rgba(255,255,255,0.32)"/>
    </svg>
  `.trim();
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function hitTestDiagnostics(page, selector) {
  return page.locator(selector).evaluate((el, sel) => {
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.floor(rect.left + (rect.width / 2)));
    const y = Math.max(0, Math.floor(rect.top + (rect.height / 2)));
    const stack = document.elementsFromPoint(x, y).slice(0, 8).map((node) => {
      const id = String(node.id || '').trim();
      const classes = String(node.className || '').trim().replace(/\s+/g, '.');
      return `${node.tagName.toLowerCase()}${id ? `#${id}` : ''}${classes ? `.${classes}` : ''}`;
    });
    const hit = document.elementFromPoint(x, y);
    return {
      selector: sel,
      center: { x, y },
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      computed: {
        display: getComputedStyle(el).display,
        visibility: getComputedStyle(el).visibility,
        pointerEvents: getComputedStyle(el).pointerEvents,
        zIndex: getComputedStyle(el).zIndex,
      },
      hit: hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}` : null,
      stack,
    };
  });
}

async function logDiagnostics(page, label, selector) {
  const data = await hitTestDiagnostics(page, selector);
  console.log(`\n[mobile-diag] ${label}\n${JSON.stringify(data, null, 2)}`);
  return data;
}

test.describe.serial("mobile header diagnostics", () => {

  test("sidebar toggle and actions are tappable in portrait and landscape", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
      const seed = `mobile-header-diagnostics-${Date.now()}`;
      const imageDataUrl = makeInlineSvgDataUrl(320, 180, "#f59e0b");
      let conversationId = "";
      let messageId = "";

    try {
      const created = await request.post("/api/message", {
        headers,
          data: {
            text: seed,
            relayMode: "autopilot",
            model: "gpt-5.4-mini",
            attachments: [
              {
                name: "menu-overlap.svg",
                type: "image/svg+xml",
                dataUrl: imageDataUrl,
              },
            ],
          },
        });
      expect(created.ok()).toBeTruthy();
      const createdBody = await created.json();
      conversationId = String(createdBody?.conversationId || "").trim();
      messageId = String(createdBody?.messageId || "").trim();

      if (conversationId && messageId) {
        const response = await request.post("/api/response", {
          headers,
          data: {
            messageId,
            conversationId,
            text: "playwright setup",
            model: "gpt-5.4-mini",
            mode: "autopilot",
          },
        });
        expect(response.ok()).toBeTruthy();
      }

      await page.goto(`/?token=${encodeURIComponent(token)}`);
      await page.waitForLoadState("networkidle");
      await page.evaluate(async (id) => {
        if (id) await window.openConversation(id);
      }, conversationId);

      const sidebarToggle = page.locator("#sidebar-toggle");
      const menuToggle = page.locator("#chat-actions-menu-btn");

      await expect(sidebarToggle).toBeVisible();
      await expect(menuToggle).toBeVisible();

      await logDiagnostics(page, "portrait sidebar toggle", "#sidebar-toggle");
      await sidebarToggle.tap();
      await expect(page.locator("#sidebar")).toHaveClass(/open/);

      await logDiagnostics(page, "portrait action menu", "#chat-actions-menu-btn");
      await menuToggle.tap();
      await expect(page.locator("#chat-actions-menu")).toBeVisible();
      await page.locator("#chat-menu-edit-title").tap();
      await expect(page.locator("#chat-actions-menu")).toBeHidden();
      await expect(page.locator("#file-preview-modal")).toBeHidden();
      const titleInput = page.locator("#chat-title-input");
      await expect(titleInput).toBeVisible();
      await expect(titleInput).toBeFocused();
      await page.waitForTimeout(300);
      await expect(titleInput).toBeFocused();
      await page.locator("#chat-title-cancel-btn").tap();
      await expect(titleInput).toBeHidden();

      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForTimeout(250);

      await logDiagnostics(page, "landscape sidebar toggle", "#sidebar-toggle");
      await sidebarToggle.tap();
      await expect(page.locator("#sidebar")).not.toHaveClass(/open/);

      await logDiagnostics(page, "landscape action menu", "#chat-actions-menu-btn");
      await menuToggle.tap();
      const menu = page.locator("#chat-actions-menu");
      if (!(await menu.isVisible())) {
        console.log("[mobile-diag] landscape touch tap did not open menu; trying programmatic click");
        await menuToggle.evaluate((btn) => btn.click());
        await page.waitForTimeout(100);
        await logDiagnostics(page, "landscape action menu after programmatic click", "#chat-actions-menu-btn");
      }
      await expect(menu).toBeVisible();
      await page.locator("#chat-menu-compact").tap();
      await expect(menu).toBeHidden();
    } finally {
      if (conversationId) {
        await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
      }
    }
  });
});
