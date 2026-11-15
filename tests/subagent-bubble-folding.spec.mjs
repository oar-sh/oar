import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";
import { attemptOf, respondAsWorker, settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

// The live bubble of a running turn nests one bubble per subagent. Each is
// folded to its header until the user opens it, so the turn stays scrollable
// on a phone; the header says what the run is doing in one line. What the
// user chose by hand is not undone by a later event.
//
// Everything is injected through the routes a session worker publishes on
// (the queued turn never runs: CLI spawn is disabled on the test server).

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

    const publish = (route, data) => request.post(route, { headers, data: { ...attemptOf(messageId), messageId, conversationId, ...data } });

    try {
      // Made as the web client makes a chat: bound to its session from the start.
      const started = await startConversation({ text: `Fold the finished subagents ${stamp}` });
      conversationId = String(started.conversationId || "");
      messageId = String(started.messageId || "");
      await started.worker.take(messageId);

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
        await respondAsWorker(messageId, { conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" }).catch(() => {});
        await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
      }
    }
  });
});
