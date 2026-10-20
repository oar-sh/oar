import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createApiClient } from "../shared/worker-runtime/api-client.mjs";
import { createHeartbeatController } from "../shared/worker-runtime/heartbeat.mjs";
import { sleep, startRelayServer } from "./relay-server-harness.mjs";

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
// "worker" is this process: the real heartbeat controller and API client of
// the session workers.

let relay = null;
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "oar-e2e-task-registry-"));

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
  const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
  expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
  const { conversationId, messageId, ownerSessionId } = queued.payload;
  const synced = await api("/api/session-sync", { method: "POST", body: { sdk_session_id: conversationId, conversation_id: conversationId } });
  expect(synced.status, JSON.stringify(synced.payload)).toBe(200);
  const sessionId = String(ownerSessionId || conversationId);
  let handed = false;
  for (let attempt = 0; attempt < 40 && !handed; attempt += 1) {
    handed = String((await api("/api/pending", { headers: { "x-relay-session-id": sessionId } })).payload?.message?.id || "") === messageId;
    if (!handed) await sleep(250);
  }
  expect(handed, "the message was handed out").toBe(true);
  return { conversationId, messageId, sessionId };
}

async function idleConversation(text) {
  const turn = await runningTurn(text);
  const answered = await api("/api/response", { method: "POST", body: { messageId: turn.messageId, conversationId: turn.conversationId, text: "started it in the background", model: "gpt-5.4-mini" } });
  expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
  return turn;
}

function fakeWorker(sessionId, conversationId) {
  const posts = [];
  const tasks = [];
  const client = createApiClient({
    serverUrl: relay.baseUrl,
    token: relay.token,
    getHeaders: () => ({
      "x-relay-session-id": sessionId,
      "x-relay-conversation-id": conversationId,
      "x-relay-process-pid": String(process.pid),
    }),
  });
  // The relay changes under the worker: every call goes to the current one.
  const send = async (method, route, body) => {
    posts.push({ route, body });
    return client(method, route, body);
  };
  let timer = null;
  const worker = {
    posts,
    tasks,
    publish: (extra = {}) => send("POST", "/api/background-tasks", { conversationId: sessionId, tasks, ...extra }),
    settle: (body) => send("POST", "/api/background-task-settled", { conversationId: sessionId, ...body }),
  };
  const heartbeat = createHeartbeatController({
    api: send,
    pollMs: 60_000,
    getSessionReady: () => true,
    getHeartbeatTimer: () => timer,
    setHeartbeatTimer: (value) => { timer = value; },
    getActiveQueueMessageId: () => "",
    getSteeringState: () => ({ turnActive: false, autoCompactWindow: { active: null, backgroundWork: false } }),
    getBackgroundTaskIds: () => tasks.map((task) => task.taskId),
    onResyncBackgroundTasks: () => worker.publish({ resync: true }),
  });
  worker.beat = async () => { expect(await heartbeat.pulseHeartbeat(), "the relay answered the heartbeat").toBe(true); };
  return worker;
}

function shellTask(name, lines) {
  const outputPath = path.join(outputDir, `${name}.log`);
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`);
  return { taskId: `task_fixture_${name}_${Date.now()}`, taskType: "local_bash", description: `npm run ${name}`, startedAt: Date.now() - 60_000, outputPath, outputKind: "file" };
}

const ROUTED = { COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED: "1" };

// A conversation bound to its session: a first turn, answered.
async function boundConversation() {
  const first = await api("/api/message", { method: "POST", body: { text: "set up the scene", relayMode: "agent", model: "gpt-5.4-mini" } });
  expect(first.status, JSON.stringify(first.payload)).toBe(200);
  const { conversationId, ownerSessionId } = first.payload;
  const synced = await api("/api/session-sync", { method: "POST", body: { sdk_session_id: conversationId, conversation_id: conversationId } });
  expect(synced.status, JSON.stringify(synced.payload)).toBe(200);
  // An owned row goes only to a worker the relay knows: one heartbeat first.
  const headers = ownerSessionId ? { "x-relay-session-id": String(ownerSessionId), "x-relay-process-pid": String(process.pid) } : {};
  if (ownerSessionId) await fakeWorker(String(ownerSessionId), conversationId).beat();
  let handed = false;
  for (let attempt = 0; attempt < 40 && !handed; attempt += 1) {
    handed = String((await api("/api/pending", { headers })).payload?.message?.id || "") === first.payload.messageId;
    if (!handed) await sleep(250);
  }
  expect(handed, "the first message was handed out").toBe(true);
  expect((await api("/api/response", { method: "POST", body: { messageId: first.payload.messageId, conversationId, text: "scene ready", model: "gpt-5.4-mini" } })).status).toBe(200);
  return conversationId;
}

// A message its session's "worker" takes off the queue: processing, owned.
async function ownedRunningTurn(conversationId, text) {
  const queued = await api("/api/message", { method: "POST", body: { conversationId, text, relayMode: "agent", model: "gpt-5.4-mini" } });
  expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
  const { messageId, ownerSessionId } = queued.payload;
  expect(ownerSessionId, "the turn is owned by the session").toBe(conversationId);
  const worker = fakeWorker(ownerSessionId, conversationId);
  await worker.beat();
  let handed = false;
  for (let attempt = 0; attempt < 40 && !handed; attempt += 1) {
    const pending = await api("/api/pending", { headers: { "x-relay-session-id": ownerSessionId, "x-relay-process-pid": String(process.pid) } });
    handed = String(pending.payload?.message?.id || "") === messageId;
    if (!handed) await sleep(250);
  }
  expect(handed, "the turn was handed to its worker").toBe(true);
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
    relay = await startRelay();
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
    fs.rmSync(outputDir, { recursive: true, force: true });
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

// Session worker routing on (the harness pins it off for queue specs): a
// turn is owned by its session's worker, and that worker's heartbeat is what
// tells the relay, after the restart, that it no longer has the turn.
test.describe.serial("a turn a relay restart cut off", () => {
  test.setTimeout(150_000);

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID(), overrides: ROUTED });
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
    const activity = await api("/api/activity", { method: "POST", body: { messageId: started.messageId, conversationId: started.conversationId, text: "Reading src/camera.ts" } });
    expect(activity.status, JSON.stringify(activity.payload)).toBe(200);
    const fresh = await ownedRunningTurn(freshConversation, `rename the zoom helper ${Date.now()}`);

    await relay.kill();
    relay = await startRelayServer({ token: relay.token, port: relay.port, state: relay.state, overrides: ROUTED });
    expect((await api("/api/settings/restart-resume")).payload.enabled, "a setting of the relay").toBe(true);

    // The workers live on, without the turns: their heartbeats say so.
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
