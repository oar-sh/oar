import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// The live bubble of a running turn nests one bubble per subagent. Each is
// folded to its header until the user opens it, so the turn stays scrollable
// on a phone; the header says what the run is doing in one line. What the
// user chose by hand is not undone by a later event.
//
// Everything is injected through the routes a session worker publishes on
// (the queued turn never runs: CLI spawn is disabled on the test server).

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

test.describe("live subagent bubbles", () => {
  test.use({ viewport: { width: 412, height: 915 } });

  test("a subagent is folded to a header that says what it is doing, and a tap unfolds it", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const finishedRun = `run-finished-${stamp}`;
    const runningRun = `run-running-${stamp}`;
    let conversationId = "";
    let messageId = "";

    const publish = (route, data) => request.post(route, { headers, data: { messageId, conversationId, ...data } });

    try {
      const queued = await request.post("/api/message", {
        headers,
        data: { text: `Fold the finished subagents ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
      });
      expect(queued.ok()).toBeTruthy();
      const queuedBody = await queued.json();
      conversationId = String(queuedBody?.conversationId || "");
      messageId = String(queuedBody?.messageId || "");
      await dequeue(request, headers, messageId, String(queuedBody?.ownerSessionId || ""));

      for (const [subagentRunId, displayName] of [[finishedRun, "Check the imports"], [runningRun, "Check the tests"]]) {
        expect((await publish("/api/subagent-run", { subagentRunId, displayName, status: "running" })).ok()).toBeTruthy();
        expect((await publish("/api/activity", { subagentRunId, text: `Tool (view): ${displayName}.md`, mode: "agent" })).ok()).toBeTruthy();
      }

      // A phone shows the conversation list behind the burger, so the page
      // is pointed at the conversation the way a reload finds it again.
      await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
      await page.goto(`/?token=${encodeURIComponent(token)}`);
      await page.waitForLoadState("networkidle");

      const finished = page.locator(`.subagent-bubble[data-subagent-run-id="${finishedRun}"]`);
      const running = page.locator(`.subagent-bubble[data-subagent-run-id="${runningRun}"]`);
      await expect(finished).toBeVisible();
      await expect(running).toBeVisible();

      // Both are running and folded: the header alone, with its one line
      // about the run and a Stop.
      for (const bubble of [finished, running]) {
        await expect(bubble).toHaveClass(/folded/);
        await expect(bubble.locator(".subagent-activity-item")).toBeHidden();
        await expect(bubble.locator(".subagent-bubble-header")).toHaveAttribute("aria-expanded", "false");
        await expect(bubble.locator(".subagent-stop-btn")).toBeVisible();
      }
      await expect(running.locator(".subagent-bubble-summary")).toContainText("1 step");
      await expect(running.locator(".subagent-bubble-summary")).toContainText("Check the tests.md");

      // The line follows the run while the bubble stays folded.
      expect((await publish("/api/activity", { subagentRunId: runningRun, text: "Tool (view): more.md", mode: "agent" })).ok()).toBeTruthy();
      await expect(running.locator(".subagent-bubble-summary")).toContainText("2 steps");
      await expect(running.locator(".subagent-bubble-summary")).toContainText("more.md");
      await expect(running).toHaveClass(/folded/);

      // The header is one row and nothing in it runs out of the bubble.
      const bubbleBox = await running.boundingBox();
      const headerBox = await running.locator(".subagent-bubble-header").boundingBox();
      const stopBox = await running.locator(".subagent-stop-btn").boundingBox();
      expect(headerBox.height).toBeLessThan(48);
      expect(stopBox.x + stopBox.width).toBeLessThanOrEqual(bubbleBox.x + bubbleBox.width);

      // A finished one loses its Stop and keeps its name and status.
      expect((await publish("/api/subagent-run", { subagentRunId: finishedRun, displayName: "Check the imports", status: "completed" })).ok()).toBeTruthy();
      await expect(finished.locator(".subagent-bubble-status")).toHaveText("Completed");
      await expect(finished.locator(".subagent-stop-btn")).toBeHidden();
      await expect(finished).toHaveClass(/folded/);

      // A tap on the header unfolds it, and a later event leaves that alone.
      await running.locator(".subagent-bubble-header").click();
      await expect(running).not.toHaveClass(/folded/);
      await expect(running.locator(".subagent-activity-item")).toHaveCount(2);
      await expect(running.locator(".subagent-bubble-summary")).toBeHidden();
      expect((await publish("/api/activity", { subagentRunId: runningRun, text: "Tool (view): last.md", mode: "agent" })).ok()).toBeTruthy();
      await expect(running.locator(".subagent-activity-item")).toHaveCount(3);
      await expect(running).not.toHaveClass(/folded/);
      // Its status is still the run's own.
      await expect(running.locator(".subagent-bubble-status")).toHaveText("● Running");

      // A second tap folds it again.
      await running.locator(".subagent-bubble-header").click();
      await expect(running).toHaveClass(/folded/);
      await expect(running.locator(".subagent-bubble-summary")).toContainText("3 steps");
    } finally {
      if (messageId && conversationId) {
        await request.post("/api/response", {
          headers,
          data: { messageId, conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" },
        }).catch(() => {});
        await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
      }
    }
  });
});
