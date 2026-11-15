import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "@playwright/test";

import { resolveDatabaseFile } from "../server/services/database-file.mjs";
import { sleep, startRelayServer } from "./relay-server-harness.mjs";
import { attemptOf, completeTurn, respondAsWorker, settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

/**
 * The sidebar's 🔥 toggle (active sessions only), against a relay of its own:
 *
 *  - off, every session shows; on (by keyboard), only the working one, the
 *    recently finished one and the one with a plan card waiting;
 *  - it combines with the title filter, and an empty result offers to turn
 *    it off;
 *  - a background task starting brings an old session in, live, and its end
 *    takes it out again;
 *  - the setting survives a reload, and a session ages out of the
 *    five-minute window by itself;
 *  - on a phone the toggle and the field share the row.
 *
 * No model runs: the spec plays the worker (it dequeues a turn, posts a plan
 * card and replies). The test relay runs no workers, so its /api/status
 * answer gains a ready worker for the sessions that run background work, as
 * in conversation-list-activity-colour.spec.mjs. Titles are invented.
 */

const MINUTE = 60 * 1000;

function createApi(getRelay) {
  return async function api(route, { method = "GET", body, headers = {} } = {}) {
    const relay = getRelay();
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  };
}

test.describe.serial("the 🔥 active filter in the sidebar", () => {
  test.describe.configure({ timeout: 120_000 });

  let relay = null;
  const onRelay = { baseUrl: () => relay.baseUrl, token: () => relay.token };
  const api = createApi(() => relay);
  const seeded = { plan: "", old: "", working: "", recent: "" };
  const sessions = { working: "", old: "" };

  /** Sets a conversation's list time in the relay's own (throwaway) database. */
  function setUpdatedAt(conversationId, msAgo) {
    const db = new DatabaseSync(resolveDatabaseFile(relay.dataDir).path);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - msAgo).toISOString(), conversationId);
    } finally {
      db.close();
    }
  }

  // A chat made as the web client makes one: bound to its session (its own
  // id) from the start.
  const chat = (title) => startConversation({ text: title }, onRelay);

  // A whole turn by a worker that ends.
  async function reply(turn) {
    const replied = await completeTurn(turn, { text: "done", model: "gpt-5.4-mini", mode: "agent" }, onRelay);
    expect(replied.status).toBe(200);
  }

  const publishTasks = (conversationId, tasks) => api("/api/background-tasks", { method: "POST", body: { conversationId, tasks } });

  const row = (page, id) => page.locator(`#conv-list .conv-item[data-conversation-id="${id}"]`);
  const toggle = (page) => page.locator("#conv-active-toggle");

  async function openApp(page) {
    await page.route("**/api/status", async (route) => {
      const response = await route.fetch();
      const body = await response.json().catch(() => null);
      if (!response.ok() || !body) return route.fulfill({ response });
      const sessionWorker = body.sessionWorker && typeof body.sessionWorker === "object" ? body.sessionWorker : {};
      const workers = Array.isArray(sessionWorker.workers) ? sessionWorker.workers : [];
      body.sessionWorker = {
        ...sessionWorker,
        workers: [
          ...workers,
          ...Object.values(sessions).map((sdkSessionId) => ({ sdkSessionId, status: "ready", uiState: "ready", workerId: `worker-${sdkSessionId}` })),
        ],
      };
      return route.fulfill({ response, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openConversation === "function");
  }

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });

    // A plan card waits in this one: its turn ran, posted the card, and ended.
    const plan = await chat("Plan the storage migration");
    seeded.plan = plan.conversationId;
    await plan.worker.take(plan.messageId);
    const board = await api("/api/relay-board", {
      method: "POST",
      body: {
        ...attemptOf(plan.messageId),
        queueId: plan.messageId,
        messageId: plan.messageId,
        conversationId: plan.conversationId,
        mode: "plan",
        boardType: "plan_ready",
        title: "Plan ready for review",
        body: "1. Copy the tables\n2. Switch the reads",
        actions: [{ id: "autopilot", label: "Implement in autopilot", mode: "autopilot" }],
        recommendedAction: "autopilot",
      },
    });
    expect(board.status, JSON.stringify(board.payload)).toBe(200);
    expect((await respondAsWorker(plan.messageId, { text: "done", model: "gpt-5.4-mini", mode: "agent" })).status).toBe(200);

    const old = await chat("Old notes on the backlog");
    seeded.old = old.conversationId;
    // The session the /api/status answer gains a worker for: the conversation's own.
    sessions.old = old.conversationId;
    await reply(old);
    const working = await chat("Build the release bundle");
    seeded.working = working.conversationId;
    sessions.working = working.conversationId;
    await reply(working);
    const recent = await chat("Recently finished review");
    seeded.recent = recent.conversationId;
    await reply(recent);

    // Everything but the recent one is hours old.
    for (const key of ["plan", "old", "working"]) setUpdatedAt(seeded[key], 3 * 60 * MINUTE);
    expect((await publishTasks(seeded.working, [{ taskId: "task-build", taskType: "shell", description: "npm run build", startedAt: Date.now() }])).status).toBe(200);
  });

  test.afterAll(async () => {
    await relay?.stop();
  });

  test("on, by keyboard: working, recent and waiting sessions show, with the count; AND with the title filter", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page);
    for (const id of Object.values(seeded)) await expect(row(page, id)).toHaveCount(1);
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(toggle(page)).toHaveAccessibleName("Show active sessions only");

    await toggle(page).focus();
    await page.keyboard.press("Space");
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(row(page, seeded.old)).toHaveCount(0);
    for (const key of ["recent", "working", "plan"]) await expect(row(page, seeded[key])).toHaveCount(1);
    await expect(toggle(page).locator(".conv-active-count")).toHaveText("3");
    await expect(page.locator("#conv-filter-status")).toHaveText("3 active sessions");

    await page.locator("#conv-filter-input").fill("storage");
    await expect(page.locator("#conv-list .conv-item")).toHaveCount(1);
    await expect(row(page, seeded.plan)).toHaveCount(1);
    await expect(toggle(page).locator(".conv-active-count")).toHaveText("1");

    await page.locator("#conv-filter-input").fill("backlog");
    await expect(page.locator("#conv-list .conv-active-empty")).toContainText("No active sessions match your filter");
    await page.locator("#conv-list [data-active-filter-off]").click();
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(row(page, seeded.old)).toHaveCount(1);
    await page.locator("#conv-filter-clear").click();
  });

  test("live: a background task brings an old session in and its end takes it out; the setting survives a reload", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => { window.localStorage.setItem("copilot_conv_active_filter", "1"); });
    await openApp(page);
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(row(page, seeded.old)).toHaveCount(0);

    expect((await publishTasks(seeded.old, [{ taskId: "task-sync", taskType: "shell", description: "sync the mirror", startedAt: Date.now() }])).status).toBe(200);
    await expect(row(page, seeded.old)).toHaveCount(1, { timeout: 10_000 });
    expect((await publishTasks(seeded.old, [])).status).toBe(200);
    await expect(row(page, seeded.old)).toHaveCount(0, { timeout: 10_000 });

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(row(page, seeded.recent)).toHaveCount(1);
    await expect(row(page, seeded.old)).toHaveCount(0);
  });

  test("with 🔥 stored on, the list does not say \"Nothing active\" before its first page arrives", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => { window.localStorage.setItem("copilot_conv_active_filter", "1"); });
    let held = true;
    await page.route("**/api/conversations?*", async (route) => {
      if (held) await sleep(2500);
      held = false;
      return route.continue();
    });
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`, { waitUntil: "domcontentloaded" });
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    const list = page.locator("#conv-list");
    for (let i = 0; i < 8; i += 1) {
      await expect(list).not.toContainText("Nothing active");
      await expect(list.locator("[data-active-filter-off]")).toHaveCount(0);
      await sleep(150);
    }
    await expect(row(page, seeded.plan)).toHaveCount(1, { timeout: 15_000 });
  });

  test("a session ages out of the five-minute window by itself", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => { window.localStorage.setItem("copilot_conv_active_filter", "1"); });
    // Finished four minutes and 56 seconds ago: four seconds left in the window.
    setUpdatedAt(seeded.recent, 5 * MINUTE - 4000);
    await openApp(page);
    await expect(row(page, seeded.recent)).toHaveCount(1);
    await expect(row(page, seeded.recent)).toHaveCount(0, { timeout: 12_000 });
    await expect(row(page, seeded.plan)).toHaveCount(1);
  });

  test("on a phone the toggle and the field share the row", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      await openApp(page);
      await page.locator("#sidebar-toggle").click();
      await expect(toggle(page)).toBeVisible();
      // The sidebar slides in: measured once it is in place.
      await expect.poll(async () => (await toggle(page).boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
      const boxes = await page.evaluate(() => {
        const rect = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; };
        return { toggle: rect("conv-active-toggle"), input: rect("conv-filter-input"), viewport: window.innerWidth };
      });
      expect(boxes.toggle.left).toBeGreaterThanOrEqual(0);
      expect(boxes.toggle.right).toBeLessThanOrEqual(boxes.input.left);
      expect(boxes.input.right).toBeLessThanOrEqual(boxes.viewport);
      expect(boxes.input.width).toBeGreaterThan(150);
      expect(Math.abs((boxes.toggle.top + boxes.toggle.bottom) / 2 - (boxes.input.top + boxes.input.bottom) / 2)).toBeLessThan(3);
    } finally {
      await context.close();
    }
  });
});
