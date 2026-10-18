import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

/**
 * A ready session's title shows whether it works, in the sidebar and in the
 * chat header, on both themes: bright green while it works (here: a running
 * background task), a darker green (dark theme) or a muted one (light theme)
 * while idle. No dots follow the title. The test relay runs no workers, so
 * its /api/status answer gains one ready worker for the chat's session id,
 * as in conversation-archive-confirm.spec.mjs.
 */

const COLOURS = {
  dark: { working: "rgb(63, 185, 80)", idle: "rgb(35, 134, 54)" },
  light: { working: "rgb(26, 127, 55)", idle: "rgb(76, 139, 92)" },
};

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

const colourOf = (locator) => locator.evaluate((node) => getComputedStyle(node).color);

for (const theme of ["dark", "light"]) {
  test(`${theme} theme: a working session's title is bright green, an idle one darker, with no dots`, async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const sdkSessionId = `playwright-activity-colour-${theme}-${stamp}`;
    const conversationId = await seed(request, headers, `activity-colour-${theme}-${stamp}`);
    const synced = await request.post("/api/session-sync", {
      headers,
      data: { sdk_session_id: sdkSessionId, conversation_id: conversationId },
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
    await page.addInitScript((value) => { window.localStorage.setItem("copilot_theme", value); }, theme);
    const publish = (tasks) => request.post("/api/background-tasks", { headers, data: { conversationId, tasks } });

    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/?token=${encodeURIComponent(token)}`);
      await page.waitForLoadState("networkidle");
      await page.waitForFunction(() => typeof window.openConversation === "function");
      await page.evaluate((id) => window.openConversation(id), conversationId);
      const row = page.locator(`#conv-list .conv-item[data-conversation-id="${conversationId}"]`);
      const rowTitle = row.locator(".conv-title");
      const header = page.locator("#chat-title");
      await expect(row).toHaveClass(/worker-ui-ready/);
      await expect(header).toHaveAttribute("data-ui-state", "ready");

      // Idle: the darker green, in the row and the header.
      await expect(row).not.toHaveClass(/conv-working/);
      await expect.poll(() => colourOf(rowTitle)).toBe(COLOURS[theme].idle);
      await expect.poll(() => colourOf(header)).toBe(COLOURS[theme].idle);

      // A background task starts: the live event alone turns both bright.
      expect((await publish([{ taskId: `task-${stamp}`, taskType: "shell", description: "npm run build", startedAt: Date.now() }])).ok()).toBeTruthy();
      await expect(row).toHaveClass(/conv-working/, { timeout: 10_000 });
      await expect.poll(() => colourOf(rowTitle)).toBe(COLOURS[theme].working);
      await expect.poll(() => colourOf(header)).toBe(COLOURS[theme].working);
      await expect(page.locator("#conv-list .conv-processing-dots")).toHaveCount(0);

      // It ends: back to the darker green.
      expect((await publish([])).ok()).toBeTruthy();
      await expect(row).not.toHaveClass(/conv-working/, { timeout: 10_000 });
      await expect.poll(() => colourOf(rowTitle)).toBe(COLOURS[theme].idle);
      await expect.poll(() => colourOf(header)).toBe(COLOURS[theme].idle);
    } finally {
      await publish([]).catch(() => {});
    }
  });
}
