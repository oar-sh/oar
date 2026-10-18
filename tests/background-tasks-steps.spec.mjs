import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// Sub-agent rows in the composer's background-task panel show how many steps
// (tool calls) the agent has taken, from the `steps` the worker publishes.

test("a sub-agent row shows its step count", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  let conversationId = "";
  try {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `Survey the harbour charts ${stamp}`, relayMode: "autopilot", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    conversationId = String((await queued.json())?.conversationId || "");
    const published = await request.post("/api/background-tasks", {
      headers,
      data: {
        conversationId,
        tasks: [
          { taskId: `charts-${stamp}`, taskType: "local_agent", subagentType: "Explore", description: "Survey the harbour charts", startedAt: stamp - 120_000, steps: 22 },
          { taskId: `tides-${stamp}`, taskType: "local_agent", subagentType: "general-purpose", description: "Read the tide tables", startedAt: stamp - 5_000, steps: 1 },
        ],
      },
    });
    expect(published.ok()).toBeTruthy();

    await page.addInitScript((id) => localStorage.setItem("copilot_last_conv", id), conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    const panel = page.locator("#background-tasks-panel");
    await expect(panel).toBeVisible();
    if ((await panel.getAttribute("open")) === null) await page.locator("#background-tasks-summary").click();

    await expect(page.locator(`.bg-task-row[data-task-id="charts-${stamp}"] .bg-task-steps`)).toHaveText("22 steps");
    await expect(page.locator(`.bg-task-row[data-task-id="tides-${stamp}"] .bg-task-steps`)).toHaveText("1 step");

    // The count moves with the next set.
    const next = await request.post("/api/background-tasks", {
      headers,
      data: { conversationId, tasks: [{ taskId: `charts-${stamp}`, taskType: "local_agent", subagentType: "Explore", description: "Survey the harbour charts", startedAt: stamp - 120_000, steps: 23 }] },
    });
    expect(next.ok()).toBeTruthy();
    await expect(page.locator(`.bg-task-row[data-task-id="charts-${stamp}"] .bg-task-steps`)).toHaveText("23 steps");
    await expect(page.locator("#background-tasks-summary")).toHaveText("1 background task running");
  } finally {
    if (conversationId) {
      await request.post("/api/background-tasks", { headers, data: { conversationId, tasks: [] } }).catch(() => {});
      await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers }).catch(() => {});
    }
  }
});
