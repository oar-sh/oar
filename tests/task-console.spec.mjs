import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { relayToken } from "./e2e-env.mjs";

// The task console, against the shared e2e relay. A task row names a real
// file under the OS temp dir as its `outputPath`; the relay reads that file
// itself, so no worker is needed (the queued turn never runs). The spec
// writes and appends to the file to drive the live view, ages its mtime for
// the stall hint, and ends the task with a second set plus a settle post.

const HEALTH_POLL_WAIT_MS = 25_000;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oar-e2e-task-console-"));
}

async function startConversation(request, headers, text) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text, relayMode: "autopilot", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  return String((await queued.json())?.conversationId || "");
}

async function publishTasks(request, headers, conversationId, tasks) {
  const published = await request.post("/api/background-tasks", { headers, data: { conversationId, tasks } });
  expect(published.ok()).toBeTruthy();
}

async function openPanel(page, token, conversationId) {
  await page.addInitScript((id) => localStorage.setItem("copilot_last_conv", id), conversationId);
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");
  const panel = page.locator("#background-tasks-panel");
  await expect(panel).toBeVisible();
  if ((await panel.getAttribute("open")) === null) await page.locator("#background-tasks-summary").click();
  await expect(panel).toHaveAttribute("open", "");
}

// 2,600 numbered build lines (more than one 2,000-line tail), a progress
// bar redrawn with `\r`, a repeated line, and a vitest run with one failure.
function lanternLog() {
  const lines = [];
  for (let index = 1; index <= 2600; index += 1) {
    lines.push(`compile step ${String(index).padStart(4, "0")} of the lantern bundle`);
  }
  lines.push("bundle 10%\rbundle 55%\rbundle 100%");
  for (let index = 0; index < 4; index += 1) lines.push("waiting for the wick cache");
  lines.push(
    "",
    " RUN  v2.1.8 /home/dev/lantern-app",
    "",
    " ✓ src/wick.test.ts (40 tests) 8ms",
    " ❯ src/flame.test.ts (3 tests | 1 failed) 14ms",
    "   × flame > keeps its colour in the wind 6ms",
    "     → expected 'blue' to be 'amber' // Object.is equality",
    "",
    " FAIL  src/flame.test.ts > flame > keeps its colour in the wind",
    "AssertionError: expected 'blue' to be 'amber' // Object.is equality",
    "",
    " Test Files  1 failed | 1 passed (2)",
    "      Tests  1 failed | 42 passed (43)",
    "   Duration  1.21s",
    "",
  );
  return `${lines.join("\n")}`;
}

test.describe("task console", () => {
  test("a shell task opens its console: tail, live lines, earlier pages, chip, first failure, Stop", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const dir = tempDir();
    const outputPath = path.join(dir, "lantern-checks.log");
    fs.writeFileSync(outputPath, lanternLog());
    const taskId = `lantern-${stamp}`;
    let conversationId = "";
    try {
      conversationId = await startConversation(request, headers, `Run the lantern checks ${stamp}`);
      await publishTasks(request, headers, conversationId, [
        { taskId, taskType: "local_bash", description: "Run the lantern checks", startedAt: stamp - 90_000, outputPath, outputKind: "file" },
        { taskId: `cloud-${stamp}`, taskType: "local_bash", description: "Cloud shell without output", startedAt: stamp, outputKind: "none" },
      ]);
      await openPanel(page, token, conversationId);

      // A provider without output keeps a plain title that says so.
      const quietRow = page.locator(`.bg-task-row[data-task-id="cloud-${stamp}"]`);
      await expect(quietRow.locator("[data-task-console]")).toHaveCount(0);
      await expect(quietRow.locator(".bg-task-desc")).toHaveAttribute("title", "output not available for this provider");

      await page.locator(`[data-task-console="${taskId}"]`).click();
      const modal = page.locator("#task-console-modal");
      await expect(modal).toHaveClass(/visible/);
      await expect(page.locator("#task-console-title")).toHaveText("Run the lantern checks");
      const body = page.locator("#task-console-body");
      await expect(body).toContainText("Tests  1 failed | 42 passed (43)");
      // The redraw collapsed to its final state, the repeat folded to ×4.
      await expect(body).toContainText("bundle 100%");
      await expect(body).not.toContainText("bundle 55%");
      const folded = body.locator(".tc-line", { hasText: "waiting for the wick cache" });
      await expect(folded).toHaveCount(1);
      await expect(folded.locator(".tc-line-count")).toHaveText("×4");
      // Only the tail: the first build lines are older output.
      await expect(body).toContainText("compile step 2600");
      await expect(body).not.toContainText("compile step 0001 ");

      // Appended bytes arrive live.
      fs.appendFileSync(outputPath, `lantern live line ${stamp}\n`);
      await expect(body).toContainText(`lantern live line ${stamp}`, { timeout: 5_000 });

      // "Load earlier" prepends the older lines.
      const earlier = page.locator("#task-console-earlier");
      await expect(earlier).toBeVisible();
      await expect(earlier).toHaveText("Load earlier");
      await earlier.click();
      await expect(body).toContainText("compile step 0001 of the lantern bundle");
      await expect(earlier).toBeHidden();
      // The live line is still where it was: the end.
      await expect(body.locator(".tc-line").last()).toContainText(`lantern live line ${stamp}`);

      // The health poller's counts: the chip on the row and in the header.
      const rowChip = page.locator(`.bg-task-row[data-task-id="${taskId}"] .bg-task-chip`);
      await expect(rowChip).toHaveText("✓ 42 ✘ 1", { timeout: HEALTH_POLL_WAIT_MS });
      await expect(rowChip).toHaveClass(/bg-task-chip-fail/);
      await expect(page.locator("#task-console-chip")).toHaveText("✓ 42 ✘ 1");

      // The jump lands on the first failing test.
      const scroll = page.locator("#task-console-scroll");
      await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.locator("#task-console-failure").click();
      const target = body.locator(".tc-line-target");
      await expect(target).toHaveCount(1);
      await expect(target).toContainText("× flame > keeps its colour in the wind");
      await expect(target).toBeInViewport();
      // Scrolled up, new lines raise the "Jump to end" pill instead of moving the view.
      fs.appendFileSync(outputPath, `lantern second live line ${stamp}\n`);
      await expect(page.locator("#task-console-jump")).toBeVisible({ timeout: 5_000 });
      await page.locator("#task-console-jump").click();
      await expect(body.locator(".tc-line").last()).toBeInViewport();

      // Stop goes through the stop route (no worker here, so the relay
      // refuses it; the request is what counts).
      const stopRequest = page.waitForRequest((req) => req.method() === "POST"
        && req.url().includes(`/background-task/${encodeURIComponent(taskId)}/stop`));
      await page.locator("#task-console-stop").click();
      await stopRequest;
      await expect(page.locator("#task-console-stop")).toHaveText("Stopping…");

      // Escape closes it.
      await page.keyboard.press("Escape");
      await expect(modal).not.toHaveClass(/visible/);
    } finally {
      if (conversationId) {
        await request.post("/api/background-tasks", { headers, data: { conversationId, tasks: [] } }).catch(() => {});
        await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers }).catch(() => {});
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a quiet task shows the stall hint, amber past the setting", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const dir = tempDir();
    const outputPath = path.join(dir, "kiln-warmup.log");
    fs.writeFileSync(outputPath, "kiln warming up\nkiln at 40 degrees\n");
    const old = new Date(stamp - 5 * 60_000);
    fs.utimesSync(outputPath, old, old);
    const taskId = `kiln-${stamp}`;
    let conversationId = "";
    const setting = await request.get("/api/settings/task-stall-minutes", { headers });
    expect(setting.ok()).toBeTruthy();
    const before = Number((await setting.json())?.minutes) || 10;
    try {
      const saved = await request.post("/api/settings/task-stall-minutes", { headers, data: { minutes: 1 } });
      expect(saved.ok()).toBeTruthy();
      expect((await saved.json())?.minutes).toBe(1);

      conversationId = await startConversation(request, headers, `Warm the kiln ${stamp}`);
      await publishTasks(request, headers, conversationId, [
        { taskId, taskType: "local_bash", description: "Warm the kiln", startedAt: stamp - 10 * 60_000, outputPath },
      ]);
      await openPanel(page, token, conversationId);

      const stall = page.locator(`.bg-task-row[data-task-id="${taskId}"] .bg-task-stall`);
      await expect(stall).toHaveText(/^no output for [5-9] min$/, { timeout: HEALTH_POLL_WAIT_MS });
      await expect(stall).toHaveClass(/bg-task-stall-warn/);

      await page.locator(`[data-task-console="${taskId}"]`).click();
      await expect(page.locator("#task-console-body")).toContainText("kiln at 40 degrees");
      await expect(page.locator("#task-console-stall")).toHaveText(/^no output for [5-9] min$/);
      await expect(page.locator("#task-console-stall")).toHaveClass(/tc-stall-warn/);
      await expect(page.locator("#task-console-earlier")).toBeHidden();
    } finally {
      await request.post("/api/settings/task-stall-minutes", { headers, data: { minutes: before } }).catch(() => {});
      if (conversationId) {
        await request.post("/api/background-tasks", { headers, data: { conversationId, tasks: [] } }).catch(() => {});
        await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers }).catch(() => {});
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an ended task stays as a dimmed ✘ row whose output still opens", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const dir = tempDir();
    const outputPath = path.join(dir, "glaze-mix.log");
    fs.writeFileSync(outputPath, "mixing the glaze\nglaze too thick, giving up\n");
    const taskId = `glaze-${stamp}`;
    let conversationId = "";
    try {
      conversationId = await startConversation(request, headers, `Mix the glaze ${stamp}`);
      const task = { taskId, taskType: "local_bash", description: "Mix the glaze", startedAt: stamp - 30_000, outputPath };
      await publishTasks(request, headers, conversationId, [task]);
      await openPanel(page, token, conversationId);
      const row = page.locator(`.bg-task-row[data-task-id="${taskId}"]`);
      await expect(row).toBeVisible();
      await expect(row.locator(".bg-task-stop")).toHaveCount(1);

      // The set without the task, then how it ended.
      await publishTasks(request, headers, conversationId, []);
      const settled = await request.post("/api/background-task-settled", {
        headers,
        data: { conversationId, taskId, status: "failed", exitCode: 1, outputPath, description: task.description, taskType: task.taskType, startedAt: task.startedAt },
      });
      expect(settled.ok()).toBeTruthy();

      await expect(row).toHaveClass(/bg-task-row-ended/);
      await expect(row.locator(".bg-task-outcome")).toHaveText("✘");
      await expect(row.locator(".bg-task-stop")).toHaveCount(0);
      await expect(page.locator("#background-tasks-summary")).toHaveText("1 finished");

      await row.locator(`[data-task-console="${taskId}"]`).click();
      await expect(page.locator("#task-console-modal")).toHaveClass(/visible/);
      await expect(page.locator("#task-console-body")).toContainText("glaze too thick, giving up");
      await expect(page.locator("#task-console-meta")).toContainText("failed, exit code 1");
      await expect(page.locator("#task-console-stop")).toBeHidden();
      await page.locator(".task-console-close").click();
      await expect(page.locator("#task-console-modal")).not.toHaveClass(/visible/);

      // Dismissed, the row goes; with nothing else in it, so does the panel.
      await row.locator(".bg-task-dismiss").click();
      await expect(row).toHaveCount(0);
      await expect(page.locator("#background-tasks-panel")).toBeHidden();
    } finally {
      if (conversationId) {
        await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers }).catch(() => {});
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
