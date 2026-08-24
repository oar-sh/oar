import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// E2E cover for the workflow progress tree
// (docs/plans/workflow-progress-tree.md): a Claude session worker publishes a
// `workflowProgress` digest on its background-task rows via
// POST /api/background-tasks, and the composer panel renders it as a fold-out
// tree (logs, phase headers, agent rows with state icons, "+N more agents").
//
// Everything is injected into the isolated test server per the e2e isolation
// contract: the conversation is created through POST /api/message (which
// commits the row even though the queued turn never runs — CLI spawn is
// disabled), and the task set is published through the same authenticated
// endpoint the worker uses (standard bearer auth, REPLACE semantics). No live
// CLI, no host state.

const WORKFLOW_MODEL = "claude-sonnet-5";

// Digest modeled on the reference run in the plan doc: 2 phases, 4 agents
// across queued/running/done, narrator logs, and 2 agents omitted by the
// worker's own cap. `runningTokens`/`totalTokens` are parameterized so a
// re-publish visibly changes the rendered row (proving a re-render happened).
function buildWorkflowDigest({ totalTokens, runningTokens }) {
  const now = Date.now();
  return {
    runId: "wf_e2e_progress1",
    workflowName: "review",
    status: "running",
    agentCount: 6,
    totalTokens,
    phases: [
      { index: 0, title: "Review" },
      { index: 1, title: "Verify" },
    ],
    logs: [
      "Spawning 3 reviewers across the diff...",
      "4 raw findings from 3 reviewers, verifying each...",
    ],
    agents: [
      {
        index: 0,
        label: "review:edge-cases-data",
        phaseIndex: 0,
        phaseTitle: "Review",
        model: WORKFLOW_MODEL,
        state: "done",
        attempt: 1,
        tokens: 62_200,
        toolCalls: 27,
        durationMs: 260_000,
        startedAt: now - 320_000,
      },
      {
        index: 1,
        label: "review:tests-coverage",
        phaseIndex: 0,
        phaseTitle: "Review",
        model: WORKFLOW_MODEL,
        state: "done",
        attempt: 1,
        tokens: 48_100,
        toolCalls: 19,
        durationMs: 245_000,
        startedAt: now - 318_000,
      },
      {
        index: 2,
        label: "verify:finding-1",
        phaseIndex: 1,
        phaseTitle: "Verify",
        model: WORKFLOW_MODEL,
        state: "running",
        attempt: 1,
        lastToolName: "Grep",
        tokens: runningTokens,
        toolCalls: 6,
        startedAt: now - 45_000,
      },
      {
        index: 3,
        label: "verify:finding-2",
        phaseIndex: 1,
        phaseTitle: "Verify",
        model: WORKFLOW_MODEL,
        state: "queued",
        attempt: 1,
      },
    ],
    agentsOmitted: 2,
  };
}

// The task set a worker would publish mid-run: the workflow row carrying the
// digest plus a plain backgrounded-Bash row that must stay flat.
function buildTaskRows(ids, { totalTokens = 82_400, runningTokens = 12_800 } = {}) {
  return [
    {
      taskId: ids.workflowTaskId,
      taskType: "local_workflow",
      description: "Ultracode review workflow",
      startedAt: Date.now() - 320_000,
      lastToolName: "verify:finding-1",
      totalTokens,
      model: WORKFLOW_MODEL,
      workflowProgress: buildWorkflowDigest({ totalTokens, runningTokens }),
    },
    {
      taskId: ids.bashTaskId,
      taskType: "local_bash",
      description: "npm run build --watch",
      startedAt: Date.now() - 60_000,
      lastToolName: "Bash",
    },
  ];
}

// Phase 4: a settled workflow's final digest persists with the assistant
// message that reports the completion (`workflowRuns` on POST /api/response —
// the same authenticated seam the session worker uses) and the transcript
// renders one collapsed "Finished background task" card per run, unfolding
// into the same tree the live panel shows.
test.describe("finished background task cards in the transcript", () => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };

  function finishedDigest() {
    return {
      runId: "wf_e2e_card1",
      workflowName: "review",
      status: "completed",
      agentCount: 6,
      totalTokens: 1_160_000,
      durationMs: 28 * 60_000,
      phases: [
        { index: 0, title: "Review" },
        { index: 1, title: "Verify" },
      ],
      logs: ["4 raw findings from 3 reviewers, verifying each..."],
      agents: [
        { index: 0, label: "review:edge-cases-data", phaseIndex: 0, phaseTitle: "Review", model: WORKFLOW_MODEL, state: "done", tokens: 62_200, toolCalls: 27, durationMs: 260_000 },
        { index: 1, label: "review:tests-coverage", phaseIndex: 0, phaseTitle: "Review", model: WORKFLOW_MODEL, state: "done", tokens: 48_100, toolCalls: 19, durationMs: 245_000 },
        { index: 2, label: "verify:finding-1", phaseIndex: 1, phaseTitle: "Verify", model: WORKFLOW_MODEL, state: "done", tokens: 21_400, toolCalls: 6, durationMs: 120_000 },
      ],
      agentsOmitted: 3,
    };
  }

  function stoppedDigest() {
    return {
      runId: "wf_e2e_card2",
      workflowName: "flaky-run",
      status: "failed",
      agentCount: 1,
      totalTokens: 9_400,
      durationMs: null,
      phases: [],
      logs: [],
      agents: [
        { index: 0, label: "review:only-agent", phaseIndex: null, phaseTitle: null, model: WORKFLOW_MODEL, state: "failed", tokens: 9_400, toolCalls: 3 },
      ],
      agentsOmitted: 0,
    };
  }

  test("a persisted workflowRuns response renders collapsed cards that unfold into the tree", async ({ page, request }) => {
    const seedText = `workflow-card-render-${Date.now()}`;
    let conversationId = "";
    try {
      // Seed the conversation + queued turn (the isolated server never spawns
      // a CLI, so the queue row just waits for its response)...
      const queued = await request.post("/api/message", {
        headers,
        data: { text: seedText, relayMode: "autopilot", model: "gpt-5.4-mini" },
      });
      expect(queued.ok()).toBeTruthy();
      const queuedBody = await queued.json();
      conversationId = String(queuedBody?.conversationId || "");
      const messageId = String(queuedBody?.messageId || "");
      expect(conversationId).toBeTruthy();
      expect(messageId).toBeTruthy();

      // ...then finalize it exactly like a session worker whose workflows
      // settled during the turn: two runs, one completed, one failed.
      const responded = await request.post("/api/response", {
        headers,
        data: {
          messageId,
          conversationId,
          text: "Both workflows finished; details in the cards below.",
          model: WORKFLOW_MODEL,
          mode: "autopilot",
          workflowRuns: [finishedDigest(), stoppedDigest()],
        },
      });
      expect(responded.ok()).toBeTruthy();
      expect((await responded.json())?.ok).toBe(true);

      await page.goto(`/?token=${encodeURIComponent(token)}`);
      await page.waitForLoadState("networkidle");
      await page.locator(".conv-item", { hasText: seedText }).first().click();

      // One card per run, collapsed by default.
      const cards = page.locator(".msg-workflow-run");
      await expect(cards).toHaveCount(2);
      const completedCard = cards.nth(0);
      await expect(completedCard.locator("summary")).toHaveText(
        "🧩 Finished background task — review · 6 agents · 1.2M tok · 28m",
      );
      const completedTree = completedCard.locator(".bg-task-tree");
      await expect(completedTree).toBeHidden();

      // A non-completed run says so in its header.
      const failedCard = cards.nth(1);
      await expect(failedCard.locator("summary")).toHaveText(
        "🧩 Finished background task (failed) — flaky-run · 1 agent · 9.4k tok",
      );

      // Clicking the header unfolds the SAME tree the live panel renders:
      // narrator log, phase headers, agent rows with state icons, overflow.
      await completedCard.locator("summary").click();
      await expect(completedTree).toBeVisible();
      await expect(completedTree.locator(".bg-task-tree-log")).toHaveText([
        "4 raw findings from 3 reviewers, verifying each...",
      ]);
      await expect(completedTree.locator(".bg-task-tree-phase")).toHaveText(["Review", "Verify"]);
      await expect(completedTree.locator(".bg-task-tree-agent")).toHaveCount(3);
      await expect(completedTree.locator(".bg-task-agent-state")).toHaveText(["✓", "✓", "✓"]);
      await expect(completedTree.locator(".bg-task-agent-label")).toContainText([
        "review:edge-cases-data",
        "review:tests-coverage",
        "verify:finding-1",
      ]);
      await expect(completedTree.locator(".bg-task-agent-meta").first()).toHaveText(
        "sonnet-5 · 62.2k tok · 27 tools · 4m20s",
      );
      await expect(completedTree.locator(".bg-task-tree-omitted")).toHaveText("+3 more agents");

      // Folding back hides the tree again.
      await completedCard.locator("summary").click();
      await expect(completedTree).toBeHidden();

      // The cards come from the DB, not the live socket: a full reload keeps them.
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.locator(".conv-item", { hasText: seedText }).first().click();
      await expect(page.locator(".msg-workflow-run")).toHaveCount(2);
      await expect(page.locator(".msg-workflow-run").first().locator(".bg-task-tree")).toBeHidden();
    } finally {
      if (conversationId) {
        await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers }).catch(() => {});
      }
    }
  });
});

test.describe("workflow progress tree in the background-tasks panel", () => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };

  // POST /api/message commits the conversation row (the queued message just
  // sits there — the isolated server cannot spawn a CLI, and nothing here
  // dequeues it), which is all the panel needs: a sidebar entry to open and a
  // conversation id for the task store.
  async function seedConversation(request, seedText) {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: seedText, relayMode: "autopilot", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    const conversationId = String((await queued.json())?.conversationId || "");
    expect(conversationId).toBeTruthy();
    return conversationId;
  }

  async function publishTasks(request, conversationId, tasks) {
    const response = await request.post("/api/background-tasks", {
      headers,
      data: { conversationId, tasks },
    });
    expect(response.ok()).toBeTruthy();
    expect((await response.json())?.count).toBe(tasks.length);
  }

  async function cleanupConversation(request, conversationId) {
    if (!conversationId) return;
    // REPLACE with an empty set clears the store entry so later specs in the
    // same server never see this conversation's tasks.
    await request.post("/api/background-tasks", {
      headers,
      data: { conversationId, tasks: [] },
    }).catch(() => {});
    await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers }).catch(() => {});
  }

  // Opens the app, clicks the seeded conversation, and unfolds the
  // background-tasks <details> (closed by default) so its rows are visible.
  async function openConversationTasksPanel(page, seedText) {
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.locator(".conv-item", { hasText: seedText }).first().click();
    const panel = page.locator("#background-tasks-panel");
    await expect(panel).toBeVisible();
    if ((await panel.getAttribute("open")) === null) {
      await page.locator("#background-tasks-summary").click();
    }
    await expect(panel).toHaveAttribute("open", "");
    return panel;
  }

  function testIds() {
    const stamp = Date.now();
    return { workflowTaskId: `wf-task-${stamp}`, bashTaskId: `bash-task-${stamp}` };
  }

  test("a running workflow renders the expanded progress tree", async ({ page, request }) => {
    const ids = testIds();
    const seedText = `workflow-tree-render-${ids.workflowTaskId}`;
    let conversationId = "";
    try {
      conversationId = await seedConversation(request, seedText);
      await publishTasks(request, conversationId, buildTaskRows(ids));
      await openConversationTasksPanel(page, seedText);

      // The workflow row: 🧩 badge and a chevron reporting "expanded" —
      // status "running" makes the tree open by default.
      const row = page.locator(`.bg-task-row[data-task-id="${ids.workflowTaskId}"]`);
      await expect(row).toBeVisible();
      await expect(row.locator(".bg-task-badge")).toHaveText("Workflow");
      const fold = row.locator(".bg-task-fold");
      await expect(fold).toHaveAttribute("aria-expanded", "true");
      await expect(fold).toHaveText("▾");

      const tree = page.locator(`.bg-task-tree[data-task-id="${ids.workflowTaskId}"]`);
      await expect(tree).toBeVisible();

      // Narrator log lines above the tree, in publish order.
      await expect(tree.locator(".bg-task-tree-log")).toHaveText([
        "Spawning 3 reviewers across the diff...",
        "4 raw findings from 3 reviewers, verifying each...",
      ]);

      // Phase headers group the agents beneath them.
      await expect(tree.locator(".bg-task-tree-phase")).toHaveText(["Review", "Verify"]);

      // Agent rows in phase order with their state icons: done ✓, running ◐
      // (spinner class), queued ○.
      await expect(tree.locator(".bg-task-agent-state")).toHaveText(["✓", "✓", "◐", "○"]);
      await expect(tree.locator(".bg-task-agent-state-running")).toHaveCount(1);
      // Two-line agent rows: the clamped label line, then the muted metrics
      // line, which also carries the running agent's activity as its last
      // segment — outside the label clamp, so a long label cannot hide it.
      await expect(tree.locator(".bg-task-agent-label")).toContainText([
        "review:edge-cases-data",
        "review:tests-coverage",
        "verify:finding-1",
        "verify:finding-2",
      ]);
      await expect(tree.locator(".bg-task-agent-meta")).toHaveText([
        "sonnet-5 · 62.2k tok · 27 tools · 4m20s",
        "sonnet-5 · 48.1k tok · 19 tools · 4m5s",
        "sonnet-5 · 12.8k tok · 6 tools — using Grep",
        "sonnet-5",
      ]);

      // Only the running agent shows a live-activity segment.
      const activity = tree.locator(".bg-task-agent-activity");
      await expect(activity).toHaveCount(1);
      await expect(activity).toHaveText("— using Grep");
      await expect(
        tree.locator(".bg-task-tree-agent", { hasText: "verify:finding-1" }).locator(".bg-task-agent-activity"),
      ).toHaveText("— using Grep");

      // The worker capped its digest at 4 agents and reported 2 omitted.
      await expect(tree.locator(".bg-task-tree-omitted")).toHaveText("+2 more agents");

      // The flat row's token count is its own element beside the elapsed
      // clock; the detail line keeps only progress + model.
      await expect(row.locator(".bg-task-tokens")).toHaveText("82.4k tok");
      await expect(row.locator(".bg-task-detail")).not.toContainText("tok");
    } finally {
      await cleanupConversation(request, conversationId);
    }
  });

  test("a manual fold survives a live background_tasks re-render", async ({ page, request }) => {
    const ids = testIds();
    const seedText = `workflow-tree-fold-${ids.workflowTaskId}`;
    let conversationId = "";
    try {
      conversationId = await seedConversation(request, seedText);
      await publishTasks(request, conversationId, buildTaskRows(ids, { totalTokens: 82_400 }));
      await openConversationTasksPanel(page, seedText);

      const row = page.locator(`.bg-task-row[data-task-id="${ids.workflowTaskId}"]`);
      const fold = row.locator(".bg-task-fold");
      const tree = page.locator(`.bg-task-tree[data-task-id="${ids.workflowTaskId}"]`);
      await expect(tree).toBeVisible();
      await expect(row.locator(".bg-task-tokens")).toHaveText("82.4k tok");

      // Collapse: the chevron flips and the tree holder hides.
      await fold.click();
      await expect(fold).toHaveAttribute("aria-expanded", "false");
      await expect(fold).toHaveText("▸");
      await expect(tree).toBeHidden();

      // A worker re-publish (changed token totals) rides the background_tasks
      // socket replace and re-renders the panel from scratch. The new totals
      // prove the re-render landed; the fold choice must survive it.
      await publishTasks(
        request,
        conversationId,
        buildTaskRows(ids, { totalTokens: 90_300, runningTokens: 18_400 }),
      );
      await expect(row.locator(".bg-task-tokens")).toHaveText("90.3k tok");
      await expect(fold).toHaveAttribute("aria-expanded", "false");
      await expect(fold).toHaveText("▸");
      await expect(tree).toBeHidden();
    } finally {
      await cleanupConversation(request, conversationId);
    }
  });

  test("a task without workflowProgress renders flat with no chevron", async ({ page, request }) => {
    const ids = testIds();
    const seedText = `workflow-tree-flat-${ids.workflowTaskId}`;
    let conversationId = "";
    try {
      conversationId = await seedConversation(request, seedText);
      await publishTasks(request, conversationId, buildTaskRows(ids));
      const panel = await openConversationTasksPanel(page, seedText);
      await expect(panel.locator("#background-tasks-summary")).toContainText("2 background tasks running");

      const bashRow = page.locator(`.bg-task-row[data-task-id="${ids.bashTaskId}"]`);
      await expect(bashRow).toBeVisible();
      await expect(bashRow.locator(".bg-task-badge")).toHaveText("Bash");
      await expect(bashRow.locator(".bg-task-fold")).toHaveCount(0);
      await expect(page.locator(`.bg-task-tree[data-task-id="${ids.bashTaskId}"]`)).toHaveCount(0);
      // The only chevron in the panel belongs to the workflow row.
      await expect(panel.locator(".bg-task-fold")).toHaveCount(1);
    } finally {
      await cleanupConversation(request, conversationId);
    }
  });

  test("a narrow phone viewport keeps flat-row and agent token counts visible", async ({ page, request }) => {
    const ids = testIds();
    const seedText = `workflow-tree-mobile-${ids.workflowTaskId}`;
    let conversationId = "";
    try {
      conversationId = await seedConversation(request, seedText);
      await publishTasks(request, conversationId, buildTaskRows(ids));

      // The sidebar collapses behind the burger at phone width, so restore
      // the conversation via copilot_last_conv instead of the .conv-item
      // click (the pattern the relay-question-ui mobile specs use).
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript((id) => {
        localStorage.setItem("copilot_last_conv", id);
      }, conversationId);
      await page.goto(`/?token=${encodeURIComponent(token)}`);
      await page.waitForLoadState("networkidle");

      const panel = page.locator("#background-tasks-panel");
      await expect(panel).toBeVisible();
      if ((await panel.getAttribute("open")) === null) {
        await page.locator("#background-tasks-summary").click();
      }
      await expect(panel).toHaveAttribute("open", "");

      // The flat row's token count: present, on screen, and not crowded out
      // by the description/detail text at 390px.
      const rowTokens = page.locator(`.bg-task-row[data-task-id="${ids.workflowTaskId}"] .bg-task-tokens`);
      await expect(rowTokens).toHaveText("82.4k tok");
      await expect(rowTokens).toBeVisible();
      const rowTokensBox = await rowTokens.boundingBox();
      expect(rowTokensBox?.width ?? 0).toBeGreaterThan(0);
      expect(rowTokensBox.x).toBeGreaterThanOrEqual(0);
      expect(rowTokensBox.x + rowTokensBox.width).toBeLessThanOrEqual(390);

      // And an agent row's token count on its own metrics line.
      const tree = page.locator(`.bg-task-tree[data-task-id="${ids.workflowTaskId}"]`);
      await expect(tree).toBeVisible();
      const agentMeta = tree.locator(".bg-task-agent-meta").first();
      await expect(agentMeta).toContainText("62.2k tok");
      await expect(agentMeta).toBeVisible();
      const agentMetaBox = await agentMeta.boundingBox();
      expect(agentMetaBox?.width ?? 0).toBeGreaterThan(0);
      expect(agentMetaBox.x).toBeGreaterThanOrEqual(0);
      expect(agentMetaBox.x).toBeLessThan(390);
    } finally {
      await cleanupConversation(request, conversationId);
    }
  });
});
