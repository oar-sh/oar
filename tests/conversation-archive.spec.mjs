import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";
import { relayDataDir, relayToken } from "./e2e-env.mjs";
import { readRelaySecretsFile, relaySecretsPath } from "../server/services/owner-secret-store.mjs";
import { mintAgentTokenWithKey } from "../shared/relay-credentials.mjs";
import { completeTurn, createFakeWorker, fakeWorkerFor, settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

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

// A message an agent sends into an archived chat brings the chat back to the
// list and runs, as one the user sends does. The agent is another session,
// with the agent token its worker holds (made from the relay's agent key).
test("an agent's message into an archived chat brings it back to the list and runs", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const target = await seed(`archive-agent-target-${stamp}`);
  const sender = await seed(`archive-agent-sender-${stamp}`);
  try {
    expect((await request.post(`/api/conversation/${target}/archive`, { headers })).status()).toBe(200);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openConversation === "function");
    const row = (id) => page.locator(`#conv-list .conv-item[data-conversation-id="${id}"]`);
    await expect(row(sender)).toBeVisible();
    await expect(row(target)).toHaveCount(0);

    const { secrets } = readRelaySecretsFile(relaySecretsPath(relayDataDir()));
    expect(Boolean(secrets?.agentKey), "the e2e relay has an agent key").toBe(true);
    const agentToken = mintAgentTokenWithKey(secrets.agentKey, { kind: "session", subject: sender });
    const sent = await request.post("/api/message", {
      headers: { Authorization: `Bearer ${agentToken}` },
      data: { conversationId: target, text: `archive-agent-send-${stamp}`, model: "gpt-5.4-mini", relayMode: "agent" },
    });
    expect(sent.status(), await sent.text()).toBe(200);
    const queued = await sent.json();

    // Stored as live, and back in the open page's live list without a reload,
    // though the page never loaded the chat.
    await expect.poll(() => archivedFlag(request, headers, target)).toBe(false);
    await expect(row(target)).toBeVisible();
    // And it runs: the chat's worker is handed the message.
    const worker = fakeWorkerFor(queued);
    const taken = await worker.take(queued.messageId);
    expect(taken.id).toBe(queued.messageId);
    const responded = await worker.respond(queued.messageId, { text: "picked up", model: "gpt-5.4-mini", mode: "agent" });
    expect(responded.ok).toBeTruthy();
  } finally {
    for (const id of [target, sender]) {
      await request.delete(`/api/conversation/${id}`, { headers }).catch(() => {});
    }
  }
});

// A chat archived before this tab opened, unarchived in another tab: it comes
// back to this tab's live list without a reload.
test("a chat unarchived in another tab comes back to this tab's list without a reload", async ({ page, context, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const target = await seed(`archive-tab-target-${stamp}`);
  const other = await seed(`archive-tab-other-${stamp}`);
  const second = await context.newPage();
  try {
    expect((await request.post(`/api/conversation/${target}/archive`, { headers })).status()).toBe(200);
    const row = (tab, id) => tab.locator(`#conv-list .conv-item[data-conversation-id="${id}"]`);
    for (const tab of [page, second]) {
      await tab.goto(`/?token=${encodeURIComponent(token)}`);
      await tab.waitForLoadState("networkidle");
      await tab.waitForFunction(() => typeof window.openConversation === "function");
      await expect(row(tab, other)).toBeVisible();
      await expect(row(tab, target)).toHaveCount(0);
    }

    // The other tab unarchives it from its Archived view.
    await second.locator("#conv-archived-toggle").click();
    await expect(row(second, target)).toBeVisible();
    await row(second, target).hover();
    await row(second, target).locator(".conv-archive").click();
    await expect(row(second, target)).toHaveCount(0);
    await expect.poll(() => archivedFlag(request, headers, target)).toBe(false);

    // This tab never loaded it, and lists it now.
    await expect(row(page, target)).toBeVisible();
  } finally {
    await second.close().catch(() => {});
    for (const id of [target, other]) {
      await request.delete(`/api/conversation/${id}`, { headers }).catch(() => {});
    }
  }
});

// A turn whose worker died: the worker that took it names a process of its
// own, which ends before the archive. The archive ends the turn as failed
// instead of leaving it for the dead-worker sweep to requeue, and nothing
// takes it up again after a sweep has run.
test("archiving a chat whose worker died mid-reply ends the reply as failed", async ({ request }) => {
  test.setTimeout(120_000);
  const headers = { Authorization: `Bearer ${relayToken()}` };
  const started = await startConversation({ text: `archive-dead-worker-${Date.now()}` });
  const sessionId = String(started.ownerSessionId || "").trim() || started.conversationId;
  started.worker.stop();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const worker = createFakeWorker({ sessionId, conversationId: started.conversationId, pid: child.pid });
    await worker.take(started.messageId);
    worker.stop();
    child.kill("SIGKILL");
    await exited;

    const archived = await request.post(`/api/conversation/${started.conversationId}/archive`, { headers });
    expect(archived.status()).toBe(200);
    expect((await archived.json()).failedMessageIds).toEqual([started.messageId]);
    const conversation = await (await request.get(`/api/conversation/${started.conversationId}`, { headers })).json();
    const replies = conversation.messages.filter((message) => message.role === "assistant").map((message) => message.text);
    expect(replies.filter((text) => text.includes("Error code: relay.conversation-archived.")).length).toBe(1);
    expect(replies.at(-1)).toBe("[System Message] Archived: ended 1 unfinished reply.");

    // Past one sweep (every 30 s): the session's worker is handed nothing.
    await new Promise((resolve) => setTimeout(resolve, 32_000));
    const live = createFakeWorker({ sessionId, conversationId: started.conversationId });
    const polled = await live.poll();
    live.stop();
    expect(polled.payload?.message?.id || null).toBeNull();
    const after = await (await request.get(`/api/conversation/${started.conversationId}`, { headers })).json();
    expect(after.messages.filter((message) => message.role === "assistant").length).toBe(replies.length);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await request.delete(`/api/conversation/${started.conversationId}`, { headers }).catch(() => {});
  }
});
