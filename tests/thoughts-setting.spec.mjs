import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// "Expand thoughts while an agent works" (Settings › General › Appearance,
// mirrored in the 🧠 modal), against the shared e2e relay. A turn is queued
// and taken off the queue; its thoughts are posted through the routes a
// session worker uses (no CLI runs on the test server).
//
// On (the default): live thoughts open; one folded by hand stays folded as
// more text streams in. Off: they start folded; one opened by hand stays
// open. The 🧠 row and the Settings toggle show the same value. The viewer of
// a finished sub-agent opens its done thoughts while the setting is on, and
// folds them while it is off (one opened by hand stays open).
// With OAR_E2E_SCREENSHOT_DIR set, each view is shot dark and light.

const SHOT_DIR = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim();
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dequeue(request, headers, messageId, ownerSessionId) {
  const dequeueHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const dequeued = await request.get("/api/pending", { headers: dequeueHeaders });
    expect(dequeued.ok()).toBeTruthy();
    const message = (await dequeued.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

async function startTurn(request, headers, text) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "");
  const messageId = String(body?.messageId || "");
  await dequeue(request, headers, messageId, String(body?.ownerSessionId || ""));
  return { conversationId, messageId };
}

// The worker's heartbeat while the turn runs: without it the CLI reads as
// offline after a while and the live bubble goes with it.
function keepWorkerAlive(request, headers, messageId) {
  const beat = () => request.post("/api/heartbeat", { headers, data: { activeQueueMessageId: messageId } }).catch(() => {});
  void beat();
  const timer = setInterval(beat, 2_000);
  return () => clearInterval(timer);
}

async function openConversationPage(page, token, conversationId, { expanded = null } = {}) {
  await page.addInitScript(({ id, expanded: value }) => {
    window.localStorage.setItem("copilot_last_conv", id);
    if (value === null) window.localStorage.removeItem("copilot_thoughts_expanded");
    else window.localStorage.setItem("copilot_thoughts_expanded", value ? "1" : "0");
  }, { id: conversationId, expanded });
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
  await expect(page.locator("#cli-dot")).toHaveClass("online");
}

async function shoot(page, name, locator = null) {
  if (!SHOT_DIR) return;
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => window.updateTheme(value), theme);
    if (locator) await locator.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${theme}.png` });
  }
  await page.evaluate(() => window.updateTheme("dark"));
}

const liveRow = (page, reasoningId) => page.locator(`#thinking-thoughts .thinking-thought[data-reasoning-id="${reasoningId}"]`);
const isOpen = (locator) => locator.evaluate((node) => node.open);

test.describe("thoughts setting", () => {
  test.use({ viewport: PHONE });

  test("on by default: live thoughts open, and a hand fold sticks across chunks", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const { conversationId, messageId } = await startTurn(request, headers, `Plan the widget cache ${stamp}`);
    const thought = (reasoningId, text, done = false) => request.post("/api/thought", {
      headers,
      data: { messageId, conversationId, mode: "agent", reasoningId, text, done },
    });
    const stopBeating = keepWorkerAlive(request, headers, messageId);

    try {
      expect((await thought(`r1-${stamp}`, "The widget cache needs a size cap first.", true)).ok()).toBeTruthy();
      expect((await thought(`r2-${stamp}`, "Reading the eviction code")).ok()).toBeTruthy();
      await openConversationPage(page, token, conversationId);

      const first = liveRow(page, `r1-${stamp}`);
      const second = liveRow(page, `r2-${stamp}`);
      await expect(second).toBeVisible();
      expect(await isOpen(first)).toBe(true);
      expect(await isOpen(second)).toBe(true);
      await shoot(page, "live-open-phone", second);

      // Fold the streaming one by hand; the next chunks keep it folded.
      await second.locator("summary").click();
      await expect.poll(() => isOpen(second)).toBe(false);
      expect((await thought(`r2-${stamp}`, "Reading the eviction code: it drops the oldest widget")).ok()).toBeTruthy();
      await expect(second.locator("summary")).toContainText("it drops the oldest widget");
      expect(await isOpen(second)).toBe(false);
      expect((await thought(`r2-${stamp}`, "Reading the eviction code: it drops the oldest widget first.", true)).ok()).toBeTruthy();
      await expect(second).toHaveAttribute("data-done", "1");
      expect(await isOpen(second)).toBe(false);
      // A new thought still opens.
      expect((await thought(`r3-${stamp}`, "Next: the hit counter")).ok()).toBeTruthy();
      await expect(liveRow(page, `r3-${stamp}`)).toBeVisible();
      expect(await isOpen(liveRow(page, `r3-${stamp}`))).toBe(true);
    } finally {
      stopBeating();
      await request.post("/api/response", { headers, data: { messageId, conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" } }).catch(() => {});
    }
  });

  test("off: live thoughts start folded, one opened by hand stays open; 🧠 and Settings agree", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const { conversationId, messageId } = await startTurn(request, headers, `Size the widget pool ${stamp}`);
    const thought = (reasoningId, text, done = false) => request.post("/api/thought", {
      headers,
      data: { messageId, conversationId, mode: "agent", reasoningId, text, done },
    });
    const stopBeating = keepWorkerAlive(request, headers, messageId);

    try {
      expect((await thought(`q1-${stamp}`, "The pool holds sixteen widgets today.", true)).ok()).toBeTruthy();
      expect((await thought(`q2-${stamp}`, "Measuring the pool")).ok()).toBeTruthy();
      await openConversationPage(page, token, conversationId, { expanded: false });

      const first = liveRow(page, `q1-${stamp}`);
      const second = liveRow(page, `q2-${stamp}`);
      await expect(page.locator("#thinking-thoughts")).toBeVisible();
      await expect(second).toHaveCount(1);
      expect(await isOpen(first)).toBe(false);
      expect(await isOpen(second)).toBe(false);
      await shoot(page, "live-closed-phone", page.locator("#thinking-thoughts"));

      await second.locator("summary").click();
      await expect.poll(() => isOpen(second)).toBe(true);
      expect((await thought(`q2-${stamp}`, "Measuring the pool: twelve are busy at peak.")).ok()).toBeTruthy();
      await expect(second.locator(".thinking-thought-body")).toContainText("twelve are busy at peak");
      expect(await isOpen(second)).toBe(true);
      expect(await isOpen(first)).toBe(false);

      // The 🧠 row shows Collapsed; Expanded there ticks the Settings toggle.
      await page.evaluate(() => window.showContext());
      const row = page.locator("#summary-modal .ctx-thoughts");
      await expect(row).toBeVisible();
      await expect(row.locator('[data-thoughts-expanded="off"]')).toHaveAttribute("aria-pressed", "true");
      await row.locator('[data-thoughts-expanded="on"]').click();
      await expect(row.locator('[data-thoughts-expanded="on"]')).toHaveAttribute("aria-pressed", "true");
      expect(await page.evaluate(() => window.localStorage.getItem("copilot_thoughts_expanded"))).toBe("1");
      await page.setViewportSize(DESKTOP);
      await shoot(page, "context-row-desktop", row);
      await page.setViewportSize(PHONE);
      await page.keyboard.press("Escape");

      await page.evaluate(() => window.openSettingsModal("general"));
      const toggle = page.locator("#thoughts-expanded-toggle");
      await expect(toggle).toBeChecked();
      await toggle.uncheck();
      expect(await page.evaluate(() => window.localStorage.getItem("copilot_thoughts_expanded"))).toBe("0");
      for (const viewport of [["phone", PHONE], ["desktop", DESKTOP]]) {
        await page.setViewportSize(viewport[1]);
        await shoot(page, `settings-appearance-${viewport[0]}`, page.locator("#settings-section-appearance-title"));
      }
    } finally {
      stopBeating();
      await request.post("/api/response", { headers, data: { messageId, conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" } }).catch(() => {});
    }
  });

  test("the viewer of a finished sub-agent opens its done thoughts", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const runId = `toolu_thoughts_${stamp}`;
    const { conversationId, messageId } = await startTurn(request, headers, `Explore the widget store ${stamp}`);
    expect((await request.post("/api/subagent-run", {
      headers,
      data: { messageId, conversationId, subagentRunId: runId, displayName: "Explore the widget store", status: "completed", subagentType: "Explore", timelineOwner: "worker" },
    })).ok()).toBeTruthy();
    expect((await request.post("/api/subagent-timeline", {
      headers,
      data: {
        conversationId,
        subagentRunId: runId,
        entries: [
          { key: "t:1", kind: "thought", text: "The widget store keeps one file per widget." },
          { key: "t:2", kind: "tool_call", toolName: "Glob", toolUseId: `toolu_glob_${stamp}`, text: JSON.stringify({ pattern: "store/**/*.widget" }) },
          { key: "t:3", kind: "tool_result", toolUseId: `toolu_glob_${stamp}`, text: "store/a.widget\nstore/b.widget" },
          { key: "t:4", kind: "thought", text: "Two widgets, both small: no index needed." },
          { key: "t:5", kind: "text", text: "The store holds two widgets." },
        ],
      },
    })).ok()).toBeTruthy();
    expect((await request.post("/api/response", { headers, data: { messageId, conversationId, text: "Store explored.", model: "gpt-5.4-mini", mode: "agent" } })).ok()).toBeTruthy();

    for (const [name, viewport] of [["phone", PHONE], ["desktop", DESKTOP]]) {
      await page.setViewportSize(viewport);
      await openConversationPage(page, token, conversationId);
      const row = page.locator(`.msg .subagent-row[data-subagent-row="${runId}"]`);
      await row.locator("[data-subagent-open]").click();
      const modal = page.locator("#subagent-viewer-modal");
      await expect(modal).toHaveClass(/visible/);
      await expect(modal.locator(".sav-entry")).toHaveCount(5);
      await expect(modal.locator(".sav-entry-thought details[open]")).toHaveCount(2);
      await expect(modal.locator(".sav-entry-tool_result details[open]")).toHaveCount(0);
      // A hand fold sticks while the viewer stays open.
      if (name === "phone") {
        await modal.locator(".sav-entry-thought summary").first().click();
        await expect(modal.locator(".sav-entry-thought details[open]")).toHaveCount(1);
        await modal.locator(".sav-entry-thought summary").first().click();
        await expect(modal.locator(".sav-entry-thought details[open]")).toHaveCount(2);
      }
      await shoot(page, `viewer-${name}`);
      await page.keyboard.press("Escape");
      await expect(modal).not.toHaveClass(/visible/);
    }

    // Off: the same record opens with its thoughts folded; one opened by hand
    // stays open.
    await page.setViewportSize(PHONE);
    await openConversationPage(page, token, conversationId, { expanded: false });
    await page.locator(`.msg .subagent-row[data-subagent-row="${runId}"] [data-subagent-open]`).click();
    const modal = page.locator("#subagent-viewer-modal");
    await expect(modal.locator(".sav-entry")).toHaveCount(5);
    await expect(modal.locator(".sav-entry-thought details[open]")).toHaveCount(0);
    await modal.locator(".sav-entry-thought summary").last().click();
    await expect(modal.locator(".sav-entry-thought details[open]")).toHaveCount(1);
    await shoot(page, "viewer-off-hand-opened-phone");
    await expect(modal.locator(".sav-entry-thought details[open]")).toHaveCount(1);
  });

  // The viewer re-renders a thought that is still streaming on every chunk;
  // the reader's fold is kept across it, either way.
  for (const expanded of [true, false]) {
    test(`the viewer keeps a hand fold of a streaming thought across chunks (setting ${expanded ? "on" : "off"})`, async ({ page, request }) => {
      const token = relayToken();
      const headers = { Authorization: `Bearer ${token}` };
      const stamp = Date.now();
      const runId = `toolu_thoughts_live_${stamp}`;
      const { conversationId, messageId } = await startTurn(request, headers, `Watch the widget audit ${stamp}`);
      const stopBeating = keepWorkerAlive(request, headers, messageId);
      const timeline = (entries, header) => request.post("/api/subagent-timeline", {
        headers,
        data: { conversationId, subagentRunId: runId, entries, ...(header ? { header } : {}) },
      });
      try {
        expect((await request.post("/api/subagent-run", {
          headers,
          data: { messageId, conversationId, subagentRunId: runId, displayName: "Audit the widget store", status: "running", subagentType: "Explore", timelineOwner: "worker", background: true },
        })).ok()).toBeTruthy();
        expect((await timeline([
          { key: "a:1", kind: "thought", text: "Auditing the widget store.", done: true },
          { key: "a:2", kind: "thought", text: "Checking the first widget", done: false },
        ])).ok()).toBeTruthy();
        expect((await request.post("/api/background-tasks", {
          headers,
          data: { conversationId, tasks: [{ taskId: `task-audit-${stamp}`, taskType: "local_agent", description: "Audit the widget store", toolUseId: runId, startedAt: Date.now() - 5_000 }] },
        })).ok()).toBeTruthy();

        await openConversationPage(page, token, conversationId, { expanded });
        const panel = page.locator("#background-tasks-panel");
        await expect(panel).toBeVisible();
        if ((await panel.getAttribute("open")) === null) await page.locator("#background-tasks-summary").click();
        await panel.locator(`[data-subagent-open="${runId}"]`).click();
        const modal = page.locator("#subagent-viewer-modal");
        await expect(modal).toHaveClass(/visible/);
        const streaming = modal.locator(".sav-entry-thought.is-open details");
        await expect(streaming).toHaveCount(1);
        const isOpen = () => streaming.evaluate((node) => node.open);
        expect(await isOpen()).toBe(expanded);
        expect(await modal.locator(".sav-entry-thought").first().locator("details").evaluate((node) => node.open)).toBe(expanded);

        // Fold (on) or open (off) the streaming thought by hand; more chunks
        // re-render it and the fold stays.
        await streaming.locator("summary").click();
        await expect.poll(isOpen).toBe(!expanded);
        for (const text of ["Checking the first widget: its size", "Checking the first widget: its size is fine"]) {
          expect((await timeline([{ key: "a:2", kind: "thought", text, done: false }])).ok()).toBeTruthy();
          await expect(streaming.locator(".sav-thought-body")).toContainText(text);
          expect(await isOpen()).toBe(!expanded);
        }
        // It ends: still the reader's fold.
        expect((await timeline([{ key: "a:2", kind: "thought", text: "Checking the first widget: done.", done: true }])).ok()).toBeTruthy();
        const ended = modal.locator(".sav-entry-thought").nth(1).locator("details");
        await expect(ended.locator(".sav-thought-body")).toContainText("done.");
        expect(await ended.evaluate((node) => node.open)).toBe(!expanded);
        await page.keyboard.press("Escape");
      } finally {
        stopBeating();
        await request.post("/api/background-tasks", { headers, data: { conversationId, tasks: [] } }).catch(() => {});
        await request.post("/api/response", { headers, data: { messageId, conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" } }).catch(() => {});
      }
    });
  }
});
