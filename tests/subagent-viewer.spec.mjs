import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { relayDbPath, relayToken } from "./e2e-env.mjs";

// The sub-agent viewer, against the shared e2e relay. Everything is published
// through the routes a session worker posts to (the queued turn never runs:
// CLI spawn is disabled on the test server).
//
// A worker-written record: the panel row's title opens the viewer, thoughts
// and tool output are folded, live entries append and the view follows, a
// child agent opens in place and "‹" goes back, the system back closes the
// viewer, and after the turn the reply bubble lists the agent as a row that
// opens the same record. A Copilot-style run (lane frames only) shows its
// mirrored record the same way, live too. Record entries reach only the page
// whose viewer shows the run: a second page of the same conversation gets
// none. A record past its retention shows what the sweep removed.

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

// Socket.io events a page receives, by name, read off its websocket frames.
function countSocketEvents(page) {
  const counts = new Map();
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const match = /^42(?:\/[^,]*,)?\d*\["([^"]+)"/.exec(typeof payload === "string" ? payload : payload.toString());
      if (match) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
    });
  });
  return (name) => counts.get(name) || 0;
}

async function openConversationPage(page, token, conversationId) {
  await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
  await expect(page.locator("#cli-dot")).toHaveClass("online");
}

function workerEntries(prefix, from, count) {
  const entries = [];
  for (let index = from; index < from + count; index += 1) {
    const kind = ["thought", "tool_call", "tool_result", "text"][index % 4];
    entries.push({
      key: `${prefix}:${index}`,
      kind,
      text: kind === "tool_call"
        ? JSON.stringify({ command: `grep -rn widget src/part-${index}`, description: `Search part ${index}` })
        : kind === "tool_result" ? `src/part-${index}/widget.js:12: export function widget${index}() {}`
          : kind === "thought" ? `Step ${index}: the widget parser needs a look at part ${index}.`
            : `Part ${index} checked.`,
      ...(kind === "tool_call" ? { toolName: "Bash", toolUseId: `toolu_bash_${index}` } : {}),
      ...(kind === "tool_result" ? { toolUseId: `toolu_bash_${index - 1}` } : {}),
    });
  }
  return entries;
}

test.describe("sub-agent viewer", () => {
  test("a worker-written record opens from the panel and the reply bubble, live", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const runId = `toolu_viewer_${stamp}`;
    const childId = `toolu_viewer_child_${stamp}`;
    const { conversationId, messageId } = await startTurn(request, headers, `Survey the widget parser ${stamp}`);

    try {
      expect((await request.post("/api/subagent-run", {
        headers,
        data: { messageId, conversationId, subagentRunId: runId, displayName: "Survey the widget parser", status: "running", subagentType: "general-purpose", timelineOwner: "worker", background: true },
      })).ok()).toBeTruthy();
      const timeline = (entries, header) => request.post("/api/subagent-timeline", {
        headers,
        data: { conversationId, subagentRunId: runId, entries, ...(header ? { header } : {}) },
      });
      expect((await timeline(workerEntries("w", 0, 28), { model: "claude-opus-5-5", totalTokens: 41000 })).ok()).toBeTruthy();
      expect((await timeline([{ key: "w:child", kind: "child", toolUseId: childId, text: "Check the fixtures" }])).ok()).toBeTruthy();
      expect((await request.post("/api/subagent-timeline", {
        headers,
        data: {
          conversationId,
          subagentRunId: childId,
          header: { parentSubagentId: runId, displayName: "Check the fixtures", subagentType: "Explore", timelineOwner: "worker" },
          entries: [{ key: "c:1", kind: "text", text: "The fixtures cover every widget." }],
        },
      })).ok()).toBeTruthy();
      expect((await request.post("/api/background-tasks", {
        headers,
        data: { conversationId, tasks: [{ taskId: `task-${stamp}`, taskType: "local_agent", description: "Survey the widget parser", toolUseId: runId, startedAt: Date.now() - 60_000, model: "claude-opus-5-5", subagentType: "general-purpose", totalTokens: 41000 }] },
      })).ok()).toBeTruthy();

      const viewerEvents = countSocketEvents(page);
      await openConversationPage(page, token, conversationId);
      // A second page on the same conversation, without the viewer.
      const otherPage = await page.context().newPage();
      const otherEvents = countSocketEvents(otherPage);
      await openConversationPage(otherPage, token, conversationId);

      // The panel row's title opens the viewer.
      const panel = page.locator("#background-tasks-panel");
      await expect(panel).toBeVisible();
      if ((await panel.getAttribute("open")) === null) await page.locator("#background-tasks-summary").click();
      await panel.locator(`[data-subagent-open="${runId}"]`).click();

      const modal = page.locator("#subagent-viewer-modal");
      await expect(modal).toHaveClass(/visible/);
      await expect(page.locator("#subagent-viewer-title")).toHaveText("Survey the widget parser");
      await expect(page.locator("#subagent-viewer-meta")).toContainText("Opus 5.5");
      await expect(page.locator("#subagent-viewer-meta")).toContainText("general-purpose");
      await expect(page.locator("#subagent-viewer-stop")).toBeVisible();
      const entries = modal.locator(".sav-entry");
      await expect(entries).toHaveCount(29);
      // Thoughts and tool output are folded; reply text is shown.
      await expect(modal.locator(".sav-entry-thought details[open]")).toHaveCount(0);
      await expect(modal.locator(".sav-entry-tool_result details[open]")).toHaveCount(0);
      await expect(modal.locator(".sav-entry-text").first()).toContainText("Part 3 checked.");
      await expect(modal.locator(".sav-entry-tool_call").first()).toContainText("grep -rn widget src/part-1");

      // A running agent's record follows its end: new entries append in view.
      const body = page.locator("#subagent-viewer-body");
      await body.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      // A header change sends the run's status in the same tick as the batch.
      expect((await timeline(workerEntries("w", 28, 3), { totalTokens: 45000 })).ok()).toBeTruthy();
      await expect(entries).toHaveCount(32);
      await expect(modal.locator(".sav-entry").last()).toBeInViewport();
      // An open text grows in place.
      expect((await timeline([{ key: "w:live", kind: "text", text: "Writing the sum", done: false }])).ok()).toBeTruthy();
      await expect(modal.locator(".sav-entry-text.is-open")).toContainText("Writing the sum");
      expect((await timeline([{ key: "w:live", kind: "text", text: "Writing the summary now.", done: true }])).ok()).toBeTruthy();
      await expect(modal.locator(".sav-entry-text").last()).toContainText("Writing the summary now.");
      await expect(entries).toHaveCount(33);
      // Those came live, to this page only.
      expect(viewerEvents("subagent_timeline")).toBeGreaterThanOrEqual(3);
      expect(otherEvents("subagent_timeline")).toBe(0);

      // A child agent opens in place; "‹" goes back to its parent.
      await modal.locator(`[data-subagent-open="${childId}"]`).click();
      await expect(page.locator("#subagent-viewer-title")).toHaveText("Check the fixtures");
      await expect(modal.locator(".sav-entry-text")).toContainText("The fixtures cover every widget.");
      await page.locator("#subagent-viewer-parent").click();
      await expect(page.locator("#subagent-viewer-title")).toHaveText("Survey the widget parser");

      // The system back closes the viewer and leaves the page where it was.
      await page.goBack();
      await expect(modal).not.toHaveClass(/visible/);
      expect(new URL(page.url()).pathname).toBe("/");
      await expect(page.locator("#background-tasks-panel")).toBeVisible();

      // The agent ends; the turn ends; the reply bubble lists it as a row.
      expect((await timeline([], { status: "completed", totalTokens: 52000 })).ok()).toBeTruthy();
      expect((await request.post("/api/response", { headers, data: { messageId, conversationId, text: "The parser survey is done.", model: "gpt-5.4-mini", mode: "agent" } })).ok()).toBeTruthy();
      const row = page.locator(`.msg .subagent-row[data-subagent-row="${runId}"]`);
      await expect(row).toBeVisible();
      await expect(row).toContainText("Completed");
      await expect(row).toContainText("52.0k tok");
      // The other page hears the run's status like any page, never its record.
      await expect.poll(() => otherEvents("subagent_status")).toBeGreaterThan(0);
      expect(otherEvents("subagent_timeline")).toBe(0);
      await otherPage.close();
      await expect(page.locator(`.msg .subagent-row[data-subagent-row="${childId}"]`)).toHaveCount(0);
      await row.locator("[data-subagent-open]").click();
      await expect(modal).toHaveClass(/visible/);
      await expect(entries).toHaveCount(33);
      await expect(page.locator("#subagent-viewer-stop")).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(modal).not.toHaveClass(/visible/);
    } finally {
      await request.post("/api/background-tasks", { headers, data: { conversationId, tasks: [] } }).catch(() => {});
      await request.post("/api/response", { headers, data: { messageId, conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" } }).catch(() => {});
    }
  });

  test("a run published on the lanes alone shows its mirrored record, live", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const runId = `agent-lane-${stamp}`;
    const { conversationId, messageId } = await startTurn(request, headers, `Count the widgets ${stamp}`);
    const publish = (route, data) => request.post(route, { headers, data: { messageId, conversationId, mode: "agent", ...data } });

    try {
      expect((await publish("/api/subagent-run", { subagentRunId: runId, displayName: "Count the widgets", status: "running" })).ok()).toBeTruthy();
      expect((await publish("/api/thought", { subagentRunId: runId, reasoningId: `r-${stamp}`, text: "Counting the widget files first.", done: true })).ok()).toBeTruthy();
      expect((await request.post("/api/background-tasks", {
        headers,
        data: { conversationId, tasks: [{ taskId: `task-lane-${stamp}`, taskType: "local_agent", description: "Count the widgets", toolUseId: runId, startedAt: Date.now() - 5_000 }] },
      })).ok()).toBeTruthy();

      await openConversationPage(page, token, conversationId);
      const panel = page.locator("#background-tasks-panel");
      await expect(panel).toBeVisible();
      if ((await panel.getAttribute("open")) === null) await page.locator("#background-tasks-summary").click();
      await panel.locator(`[data-subagent-open="${runId}"]`).click();
      const modal = page.locator("#subagent-viewer-modal");
      await expect(modal).toHaveClass(/visible/);
      await expect(modal.locator(".sav-entry")).toHaveCount(1);

      // Each lane frame is mirrored into the record and reaches the open
      // viewer, though the lane event goes out in the same tick.
      expect((await publish("/api/activity", { subagentRunId: runId, text: "Tool (glob): src/**/widget*.js" })).ok()).toBeTruthy();
      await expect(modal.locator(".sav-entry-tool_call")).toContainText("glob");
      expect((await publish("/api/stream", { subagentRunId: runId, text: "There are twelve widgets.", done: true })).ok()).toBeTruthy();
      await expect(modal.locator(".sav-entry-text")).toContainText("There are twelve widgets.");
      await expect(modal.locator(".sav-entry")).toHaveCount(3);
      await page.locator("#subagent-viewer-modal .subagent-viewer-close").click();
      await expect(modal).not.toHaveClass(/visible/);

      expect((await request.post("/api/background-tasks", { headers, data: { conversationId, tasks: [] } })).ok()).toBeTruthy();
      expect((await publish("/api/subagent-run", { subagentRunId: runId, displayName: "Count the widgets", status: "completed" })).ok()).toBeTruthy();
      expect((await publish("/api/response", { text: "Twelve widgets." })).ok()).toBeTruthy();

      const row = page.locator(`.msg .subagent-row[data-subagent-row="${runId}"]`);
      await expect(row).toBeVisible();
      await row.locator("[data-subagent-open]").click();
      await expect(modal).toHaveClass(/visible/);
      await expect(modal.locator(".sav-entry")).toHaveCount(3);
      await expect(modal.locator(".sav-entry-thought")).toContainText("Counting the widget files first.");
      // No model or tokens for a provider that does not report them: blanks.
      await expect(row.locator(".bg-task-model")).toHaveCount(0);
      await page.locator("#subagent-viewer-modal .subagent-viewer-close").click();
      await expect(modal).not.toHaveClass(/visible/);
    } finally {
      await request.post("/api/background-tasks", { headers, data: { conversationId, tasks: [] } }).catch(() => {});
      await publish("/api/response", { text: "cleanup" }).catch(() => {});
    }
  });

  test("a record past its retention shows what the sweep removed", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const runId = `toolu_retention_${stamp}`;
    const { conversationId, messageId } = await startTurn(request, headers, `Old widget survey ${stamp}`);
    expect((await request.post("/api/subagent-run", {
      headers,
      data: { messageId, conversationId, subagentRunId: runId, displayName: "Survey the old widgets", status: "completed", timelineOwner: "worker" },
    })).ok()).toBeTruthy();
    expect((await request.post("/api/subagent-timeline", {
      headers,
      data: { conversationId, subagentRunId: runId, entries: workerEntries("old", 0, 4) },
    })).ok()).toBeTruthy();
    expect((await request.post("/api/response", { headers, data: { messageId, conversationId, text: "Survey done.", model: "gpt-5.4-mini", mode: "agent" } })).ok()).toBeTruthy();

    // The record is 100 days old; saving the (default) setting runs a sweep.
    const db = new Database(relayDbPath());
    try {
      db.prepare("UPDATE subagent_timeline SET updated_at = ? WHERE run_id = ?").run(new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(), runId);
      const saved = await request.post("/api/settings/subagent-record-retention", { headers, data: { retentionDays: 90 } });
      expect(saved.ok()).toBeTruthy();
      expect((await saved.json()).retentionDays).toBe(90);
      await expect.poll(
        () => db.prepare("SELECT COUNT(*) AS n FROM subagent_timeline WHERE run_id = ? AND pruned_at IS NOT NULL").get(runId).n,
        { timeout: 20_000 },
      ).toBe(2);
    } finally {
      db.close();
    }

    await openConversationPage(page, token, conversationId);
    const row = page.locator(`.msg .subagent-row[data-subagent-row="${runId}"]`);
    await row.locator("[data-subagent-open]").click();
    const modal = page.locator("#subagent-viewer-modal");
    await expect(modal).toHaveClass(/visible/);
    await expect(modal.locator(".sav-entry")).toHaveCount(4);
    await expect(modal.locator(".sav-entry-thought")).toContainText("Step 0: the widget parser needs a look at part 0.");
    const call = modal.locator(".sav-entry-tool_call");
    await expect(call).toContainText("grep -rn widget src/part-1");
    await expect(call).toContainText("Input removed after 90 days");
    await expect(call.locator("details")).toHaveCount(0);
    await expect(modal.locator(".sav-entry-tool_result")).toContainText("output removed after 90 days");
    await expect(modal.locator(".sav-entry-text")).toContainText("Part 3 checked.");
    await page.keyboard.press("Escape");
    await expect(modal).not.toHaveClass(/visible/);
  });
});

test.describe("sub-agent viewer on a phone", () => {
  test.use({ viewport: { width: 412, height: 915 } });

  test("the viewer fills the screen", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const runId = `toolu_phone_${stamp}`;
    const { conversationId, messageId } = await startTurn(request, headers, `Phone viewer ${stamp}`);
    expect((await request.post("/api/subagent-run", {
      headers,
      data: { messageId, conversationId, subagentRunId: runId, displayName: "Read the phone layout", status: "completed", timelineOwner: "worker" },
    })).ok()).toBeTruthy();
    expect((await request.post("/api/subagent-timeline", {
      headers,
      data: { conversationId, subagentRunId: runId, entries: workerEntries("p", 0, 6) },
    })).ok()).toBeTruthy();
    expect((await request.post("/api/response", { headers, data: { messageId, conversationId, text: "Layout read.", model: "gpt-5.4-mini", mode: "agent" } })).ok()).toBeTruthy();

    await openConversationPage(page, token, conversationId);
    const row = page.locator(`.msg .subagent-row[data-subagent-row="${runId}"]`);
    await row.locator("[data-subagent-open]").click();
    const dialog = page.locator("#subagent-viewer-modal .subagent-viewer-dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(Math.round(box.width)).toBe(412);
    expect(Math.round(box.height)).toBe(915);
    // Nothing in a row runs out of the screen.
    const entryBoxes = await page.locator("#subagent-viewer-modal .sav-entry").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
    for (const right of entryBoxes) expect(right).toBeLessThanOrEqual(412);
    await page.goBack();
    await expect(page.locator("#subagent-viewer-modal")).not.toHaveClass(/visible/);
  });
});
