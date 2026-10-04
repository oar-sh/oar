import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// A compaction shows as a break line above the turn while it runs
// ("Compacting context…", with the live bubble saying so too), and the same
// line turns into the final "Context compacted · …" label when it ends.
// The compaction steps are injected through the activity route a session
// worker publishes on (the queued turn never runs: CLI spawn is disabled on
// the test server), in the shapes the Claude worker sends.
//
// The 🧠 modal's compaction window slider is a draft while the modal is
// open: it is saved when the modal closes, and only when it differs from the
// stored value. The modal payload is served by the page route below (a
// Claude session with a running CLI), so no worker is needed for it either.

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

test("a running compaction is one line that turns into the final one; the window slider saves on close", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  let conversationId = "";
  let messageId = "";
  let finished = false;

  const publish = (data) => request.post("/api/activity", { headers, data: { messageId, conversationId, mode: "agent", ...data } });

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `Compact the context ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    await dequeue(request, headers, messageId, String(queuedBody?.ownerSessionId || ""));
    expect((await publish({ text: "Tool (view): notes.md" })).ok()).toBeTruthy();

    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");

    const bubble = page.locator("#thinking-indicator");
    await expect(bubble).toBeVisible();
    const lines = page.locator("#messages > .transcript-separator.is-compact");
    await expect(lines).toHaveCount(0);

    // The compaction starts: a pending line right above the live bubble.
    expect((await publish({ text: "Compacting context…", metadata: { kind: "compact_boundary", state: "pending" } })).ok()).toBeTruthy();
    await expect(lines).toHaveCount(1);
    const line = lines.first();
    await expect(line).toHaveText("Compacting context…");
    await expect(line).toHaveClass(/is-pending/);
    await expect(line).toHaveAttribute("data-separator-key", `compact:${messageId}`);
    await expect(line.locator(".dots span")).toHaveCount(3);
    await expect(page.locator("#messages > .transcript-separator.is-compact + #thinking-indicator")).toHaveCount(1);
    await expect(bubble.locator(".thinking-compacting-note")).toHaveText("Compacting the conversation…");
    await expect(bubble.locator(".thinking-activity-item", { hasText: "Compacting" })).toHaveCount(0);
    // Marks the node: the end of the compaction relabels it rather than drawing a second one.
    await line.evaluate((node) => { node.dataset.e2eMark = "kept"; });

    // It ends: the same line, final label; the bubble's note goes.
    expect((await publish({
      text: "Context compacted",
      metadata: { kind: "compact_boundary", trigger: "auto", preTokens: 120000, postTokens: 40000 },
    })).ok()).toBeTruthy();
    await expect(line).toHaveText("Context compacted · 120k → 40k tokens");
    await expect(line).not.toHaveClass(/is-pending/);
    await expect(line).toHaveAttribute("data-e2e-mark", "kept");
    await expect(lines).toHaveCount(1);
    await expect(bubble.locator(".thinking-compacting-note")).toBeHidden();

    // The reply carries the line from here on (the end of a turn reloads the
    // transcript, so the node itself is rebuilt).
    expect((await request.post("/api/response", {
      headers,
      data: { messageId, conversationId, text: `Compacted ${stamp}`, model: "gpt-5.4-mini", mode: "agent" },
    })).ok()).toBeTruthy();
    finished = true;
    await expect(bubble).toHaveCount(0);
    await expect(page.locator(".msg.assistant", { hasText: `Compacted ${stamp}` })).toBeVisible();
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toHaveText("Context compacted · 120k → 40k tokens");
    await expect(page.locator(".msg.assistant .msg-activity-item", { hasText: "Compact" })).toHaveCount(0);

    // ── The compaction window slider ──
    const patches = [];
    await page.route("**/api/context/**", async (route) => {
      await route.fulfill({
        json: {
          conversationId,
          resolvedConversationId: conversationId,
          providerType: "claude",
          autoCompactWindow: null,
          activeAutoCompactWindow: null,
          modelContextLimit: 1000000,
          autoCompactWindowDeferred: null,
          thinkingEnabled: true,
          thinkingDisplay: "summarized",
          contextUsage: {
            model: "claude-sonnet-5",
            totalTokens: 160000,
            maxTokens: 200000,
            percentage: 80,
            categories: [{ name: "Messages", tokens: 160000, percent: 80, color: "orange" }],
            autoCompactThreshold: 187000,
            autocompactSource: "auto",
            isAutoCompactEnabled: true,
          },
          text: "",
        },
      });
    });
    await page.route(`**/api/conversation/${conversationId}/preferences`, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      const body = route.request().postDataJSON();
      patches.push(body.autoCompactWindow);
      await route.fulfill({ json: { ok: true, autoCompactWindow: body.autoCompactWindow ?? null } });
    });

    await page.click("#context-btn");
    const modal = page.locator("#summary-modal");
    const slider = page.locator("#ctx-autocompact-slider");
    await expect(slider).toBeVisible();
    await expect(page.locator(".ctx-usage-headline")).toHaveText("160.0k used · compaction window 200.0k · model limit 1M");
    await expect(page.locator("#ctx-autocompact-value")).toHaveText("Auto");
    await expect(page.locator("[data-autocompact-note]")).toHaveCount(0);

    // A draft below the tokens in use: label and notes move, nothing is sent.
    await slider.fill("1");
    await expect(page.locator("#ctx-autocompact-value")).toHaveText("100k");
    await expect(page.locator('[data-autocompact-note="compact-next"]')).toHaveText("The conversation will be compacted on the next message.");
    await expect(page.locator('[data-autocompact-note="pending"]')).toHaveText("Applies on the next message (the session restarts once).");
    // Set back to the stored value: no notes, and closing sends nothing.
    await slider.fill("0");
    await expect(page.locator("[data-autocompact-note]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(modal).not.toHaveClass(/visible/);
    await sleep(300);
    expect(patches).toEqual([]);

    // A real change is saved once, when the modal is closed (the × button).
    await page.click("#context-btn");
    await expect(slider).toBeVisible();
    await slider.fill("3");
    await expect(page.locator("#ctx-autocompact-value")).toHaveText("200k");
    await expect(page.locator('[data-autocompact-note="compact-next"]')).toHaveCount(0);
    await sleep(300);
    expect(patches).toEqual([]);
    await page.locator("#summary-modal .summary-close").click();
    await expect.poll(() => patches).toEqual([200000]);

    // The backdrop is a way out too.
    await page.click("#context-btn");
    await expect(slider).toBeVisible();
    await slider.fill("2");
    await page.mouse.click(5, 5);
    await expect(modal).not.toHaveClass(/visible/);
    await expect.poll(() => patches).toEqual([200000, 150000]);

    // So is closing the page with the modal still open (a reload here).
    await page.click("#context-btn");
    await expect(slider).toBeVisible();
    await slider.fill("4");
    // The request leaves while the page unloads, where the page-level route
    // above no longer sees it: let it reach the relay and read what it stored.
    await page.unroute(`**/api/conversation/${conversationId}/preferences`);
    await page.reload();
    await expect.poll(async () => {
      const stored = await request.get(`/api/context/${conversationId}`, { headers });
      return (await stored.json()).autoCompactWindow;
    }).toBe(300000);
  } finally {
    if (messageId && conversationId) {
      if (!finished) {
        await request.post("/api/response", {
          headers,
          data: { messageId, conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" },
        }).catch(() => {});
      }
      await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
    }
  }
});
