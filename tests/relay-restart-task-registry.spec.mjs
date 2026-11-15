import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { sleep, startRelayServer } from "./relay-server-harness.mjs";
import { attemptOf, createFakeWorker, respondAsWorker, settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

// What a relay restart used to drop although the workers kept running, and
// the opt-in note for a turn it cut off:
//
//  - The task console's rows: the output of a running shell, the ended rows
//    of the last hour. They are stored and come back; a running one is held
//    until its worker reports, and marked ended when it never does.
//  - "After a relay restart, tell interrupted sessions to carry on": a turn
//    whose worker no longer had it after the restart, and that cannot run
//    again, gets one relay note in its conversation.
//
// This spec boots its OWN relay and restarts it on the same state. The
// "worker" is this process (helpers/fake-worker.mjs: the real heartbeat
// controller of the session workers).

let relay = null;
// The relay restarts on the same port; the workers follow whichever runs.
const onRelay = { baseUrl: () => relay.baseUrl, token: () => relay.token };
// The shells' output files, made by the tests that use them and removed
// after them (not at module load: every process that loads this file would
// make one).
let outputDir = "";

function api(route, { method = "GET", body, headers = {} } = {}) {
  return fetch(`${relay.baseUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, payload: await response.json().catch(() => null) }));
}

function startRelay(state = null) {
  return startRelayServer({
    token: state ? relay.token : randomUUID(),
    ...(state ? { port: relay.port, state } : {}),
  });
}

async function restartRelay() {
  await relay.kill();
  relay = await startRelay(relay.state);
}

// A queued message taken off the queue by "the worker": processing, owned.
async function runningTurn(text) {
  const { conversationId, messageId, worker } = await startConversation({ text }, onRelay);
  await worker.take(messageId);
  return { conversationId, messageId, sessionId: worker.sessionId };
}

async function idleConversation(text) {
  const turn = await runningTurn(text);
  const answered = await respondAsWorker(turn.messageId, { conversationId: turn.conversationId, text: "started it in the background", model: "gpt-5.4-mini" });
  expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
  return turn;
}

/**
 * A session worker as the relay sees one (helpers/fake-worker.mjs), with a
 * task set it owns.
 */
function fakeWorker(sessionId, conversationId) {
  const tasks = [];
  const base = createFakeWorker({ ...onRelay, sessionId, conversationId });
  // What this worker sent from here on: its heartbeats and task posts.
  const from = base.calls.length;
  const send = async (route, body) => {
    const sent = await base.post(route, body);
    expect(sent.status, `${route}: ${JSON.stringify(sent.payload)}`).toBe(200);
  };
  const worker = {
    base,
    get posts() { return base.calls.slice(from); },
    tasks,
    publish: (extra = {}) => send("/api/background-tasks", { conversationId: sessionId, tasks, ...extra }),
    settle: (body) => send("/api/background-task-settled", { conversationId: sessionId, ...body }),
    beat: async () => { expect(await base.beat(), "the relay answered the heartbeat").toBe(true); },
  };
  base.use({
    getSteering: () => ({ turnActive: false, autoCompactWindow: { active: null, backgroundWork: false } }),
    getBackgroundTaskIds: () => tasks.map((task) => task.taskId),
    onResyncBackgroundTasks: () => worker.publish({ resync: true }),
  });
  return worker;
}

function shellTask(name, lines) {
  const outputPath = path.join(outputDir, `${name}.log`);
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`);
  return { taskId: `task_fixture_${name}_${Date.now()}`, taskType: "local_bash", description: `npm run ${name}`, startedAt: Date.now() - 60_000, outputPath, outputKind: "file" };
}

// A conversation bound to its session (made as the web client makes one): a
// first turn, answered.
async function boundConversation() {
  const first = await startConversation({ text: "set up the scene" }, onRelay);
  await first.worker.take(first.messageId);
  expect((await first.worker.respond(first.messageId, { text: "scene ready", model: "gpt-5.4-mini" })).status).toBe(200);
  return first.conversationId;
}

// A message its session's "worker" takes off the queue: processing, owned.
async function ownedRunningTurn(conversationId, text) {
  const queued = await api("/api/message", { method: "POST", body: { conversationId, text, relayMode: "agent", model: "gpt-5.4-mini" } });
  expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
  const { messageId, ownerSessionId } = queued.payload;
  expect(ownerSessionId, "the turn is owned by the session").toBe(conversationId);
  const worker = fakeWorker(ownerSessionId, conversationId);
  await worker.base.take(messageId);
  return { conversationId, messageId, worker };
}

const detail = async (conversationId) => (await api(`/api/conversation/${conversationId}?limit=5`)).payload;
const output = (conversationId, taskId) => api(`/api/conversation/${conversationId}/background-task/${taskId}/output`);

async function openApp(page, conversationId) {
  await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
  await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
}

async function unfoldTasksPanel(page) {
  const panel = page.locator("#background-tasks-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  if ((await panel.getAttribute("open")) === null) await page.locator("#background-tasks-summary").click();
  await expect(panel).toHaveAttribute("open", "");
}

test.describe.serial("the task registry across a relay restart", () => {
  test.setTimeout(150_000);

  test.beforeAll(async () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "oar-e2e-task-registry-"));
    relay = await startRelay();
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
    if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
    outputDir = "";
  });

  test("a running shell's console and an ended row come back; the worker's set makes the shell live again", async ({ page }) => {
    const { conversationId, sessionId } = await idleConversation(`soak run ${Date.now()}`);
    const worker = fakeWorker(sessionId, conversationId);
    const soak = shellTask("soak", ["soak: warming up", "soak: 40 of 100"]);
    const lint = shellTask("lint", ["lint: 12 files", "lint: clean"]);
    worker.tasks.push(soak, lint);
    await worker.beat();
    await worker.publish();
    // The lint run ends before the restart: an ended row with its status.
    await worker.settle({ taskId: lint.taskId, status: "completed", exitCode: 0 });
    worker.tasks.splice(worker.tasks.indexOf(lint), 1);
    await worker.publish();
    expect((await detail(conversationId)).endedBackgroundTasks.map((task) => [task.taskId, task.status])).toEqual([[lint.taskId, "completed"]]);

    await restartRelay();

    // Before the worker reports: nothing reads as running, both consoles read.
    const held = await detail(conversationId);
    expect(held.backgroundTasks).toEqual([]);
    expect(held.endedBackgroundTasks.map((task) => [task.taskId, task.status, task.exitCode])).toEqual([[lint.taskId, "completed", 0]]);
    const soakRead = await output(conversationId, soak.taskId);
    expect(soakRead.status, JSON.stringify(soakRead.payload)).toBe(200);
    // Held until its worker reports: neither running nor stoppable yet.
    expect(soakRead.payload).toEqual(expect.objectContaining({ kind: "file", ended: false, status: "held", held: true }));
    expect(soakRead.payload.task.stoppable).toBe(false);
    expect(soakRead.payload.text).toContain("soak: 40 of 100");
    const lintRead = await output(conversationId, lint.taskId);
    expect(lintRead.status).toBe(200);
    expect(lintRead.payload).toEqual(expect.objectContaining({ ended: true, status: "completed", exitCode: 0 }));
    expect(lintRead.payload.text).toContain("lint: clean");

    // The worker's heartbeat: asked for its set, it sends it; the shell is live.
    const before = worker.posts.length;
    await worker.beat();
    expect(worker.posts.slice(before).map((post) => [post.route, post.body.resync === true])).toEqual([
      ["/api/heartbeat", false],
      ["/api/background-tasks", true],
    ]);
    const live = await detail(conversationId);
    expect((await output(conversationId, soak.taskId)).payload).toEqual(expect.objectContaining({ status: "running", ended: false }));
    expect(live.backgroundTasks.map((task) => [task.taskId, task.outputPath])).toEqual([[soak.taskId, soak.outputPath]]);
    expect(live.endedBackgroundTasks.map((task) => task.taskId)).toEqual([lint.taskId]);

    await openApp(page, conversationId);
    await unfoldTasksPanel(page);
    await expect(page.locator(`.bg-task-row:not(.bg-task-row-ended)[data-task-id="${soak.taskId}"]`)).toBeVisible();
    const endedRow = page.locator(`.bg-task-row-ended[data-task-id="${lint.taskId}"]`);
    await expect(endedRow).toBeVisible();
    await endedRow.locator("[data-task-console]").click();
    await expect(page.locator("#task-console-modal")).toHaveClass(/visible/);
    await expect(page.locator("#task-console-body")).toContainText("lint: clean");
    await expect(page.locator("#task-console-modal")).not.toContainText("no longer available");

    worker.tasks.length = 0;
    await worker.publish();
  });

  test("a worker that does not come back has its running shell marked ended, not running", async () => {
    const { conversationId, sessionId } = await idleConversation(`render queue ${Date.now()}`);
    const worker = fakeWorker(sessionId, conversationId);
    const render = shellTask("render", ["render: frame 1", "render: frame 2"]);
    worker.tasks.push(render);
    await worker.beat();
    await worker.publish();

    // The worker is gone with the relay: it never beats again.
    await restartRelay();
    expect((await detail(conversationId)).backgroundTasks).toEqual([]);
    await expect.poll(async () => (await detail(conversationId)).endedBackgroundTasks.map((task) => [task.taskId, task.status]), { timeout: 40_000 })
      .toEqual([[render.taskId, "unknown"]]);
    expect((await detail(conversationId)).backgroundTasks).toEqual([]);
    const read = await output(conversationId, render.taskId);
    expect(read.payload).toEqual(expect.objectContaining({ ended: true, status: "unknown" }));
    expect(read.payload.text).toContain("render: frame 2");
  });
});

// A turn is owned by its session's worker, and that worker's heartbeat is
// what tells the relay, after the restart, that it no longer has the turn.
test.describe.serial("a turn a relay restart cut off", () => {
  test.setTimeout(150_000);

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  test("with the setting on, a turn the restart cut off gets one relay note; a requeued one gets none", async ({ page }) => {
    expect((await api("/api/settings/restart-resume")).payload).toEqual({ enabled: false, default: false });
    const switched = await api("/api/settings/restart-resume", { method: "POST", body: { enabled: true } });
    expect(switched.payload).toEqual({ enabled: true, default: false });

    // A turn that had started (it reported activity), and one that had not.
    const startedConversation = await boundConversation();
    const freshConversation = await boundConversation();
    const started = await ownedRunningTurn(startedConversation, `refactor the orbit camera ${Date.now()}`);
    const activity = await api("/api/activity", { method: "POST", body: { ...attemptOf(started.messageId), messageId: started.messageId, conversationId: started.conversationId, text: "Reading src/camera.ts" } });
    expect(activity.status, JSON.stringify(activity.payload)).toBe(200);
    const fresh = await ownedRunningTurn(freshConversation, `rename the zoom helper ${Date.now()}`);

    await relay.kill();
    // The workers live on, without the turns: let go while the relay is
    // down, so no heartbeat tells the new one that a turn is still held.
    started.worker.base.release(started.messageId);
    fresh.worker.base.release(fresh.messageId);
    relay = await startRelayServer({ token: relay.token, port: relay.port, state: relay.state });
    expect((await api("/api/settings/restart-resume")).payload.enabled, "a setting of the relay").toBe(true);

    // Their heartbeats say that they have no turn.
    const notesOf = async (conversationId) => ((await api(`/api/conversation/${conversationId}?limit=20`)).payload?.messages || [])
      .filter((message) => message.kind === "relay-restart-resume");
    await expect.poll(async () => {
      await started.worker.beat();
      await fresh.worker.beat();
      return (await notesOf(started.conversationId)).length;
    }, { timeout: 30_000, intervals: [1_000] }).toBe(1);

    const [note] = await notesOf(started.conversationId);
    expect(note.role).toBe("user");
    expect(note.text).toMatch(/^Automatic message from OAR, not from the user: the relay restarted at \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    expect(note.text).not.toContain("refactor the orbit camera");
    const messages = (await api(`/api/conversation/${started.conversationId}?limit=20`)).payload.messages;
    expect(messages.filter((message) => message.role === "user" && String(message.text).startsWith("refactor the orbit camera")), "the user's message is not sent again").toHaveLength(1);

    // The turn that had not started runs again by itself: no note.
    expect(await notesOf(fresh.conversationId)).toEqual([]);

    // Further heartbeats add nothing.
    await started.worker.beat();
    await sleep(500);
    expect(await notesOf(started.conversationId)).toHaveLength(1);

    await openApp(page, started.conversationId);
    const row = page.locator(`.msg.relay-restart-resume[data-message-id="${note.id}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator(".relay-event-tag")).toHaveText("relay");
    await expect(row.locator(".relay-event-text")).toHaveText("Relay restarted · the interrupted turn was asked to carry on");
  });
});
