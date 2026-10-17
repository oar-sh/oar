import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createApiClient } from "../shared/worker-runtime/api-client.mjs";
import { createHeartbeatController } from "../shared/worker-runtime/heartbeat.mjs";
import { sleep, startRelayServer } from "./relay-server-harness.mjs";

// A relay restart must not forget the running background tasks of the
// workers that outlive it. The relay holds the task sets in memory, so its
// new runtime starts without them; the worker's heartbeat carries a digest of
// its task ids, the relay notices that it is out of step and asks for the set
// again. Until the workers had time to report, a suspend is held back.
//
// This spec boots its OWN relay and restarts it on the same state. The
// "worker" is this process: the real heartbeat controller and API client of
// the session workers, around one running shell that never ends.

// Long enough to be seen right after a restart on a slow machine, short
// enough to wait out. Production: 45 s.
const BOOT_WINDOW_MS = 15_000;
const PLACEHOLDER_ID = "unreported-background-work";

let relay = null;

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
    overrides: { OAR_BOOT_REPORTING_WINDOW_MS: String(BOOT_WINDOW_MS) },
  });
}

async function restartRelay() {
  await relay.kill();
  relay = await startRelay(relay.state);
}

// A conversation whose only turn is answered: nothing runs in it but what the
// worker reports. Only its message is ever pending when this runs.
async function idleConversation(text) {
  const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
  expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
  const { conversationId, messageId, ownerSessionId } = queued.payload;
  const synced = await api("/api/session-sync", { method: "POST", body: { sdk_session_id: conversationId, conversation_id: conversationId } });
  expect(synced.status, JSON.stringify(synced.payload)).toBe(200);
  const headers = ownerSessionId ? { "x-relay-session-id": String(ownerSessionId) } : {};
  let handed = false;
  for (let attempt = 0; attempt < 40 && !handed; attempt += 1) {
    handed = String((await api("/api/pending", { headers })).payload?.message?.id || "") === messageId;
    if (!handed) await sleep(250);
  }
  expect(handed, "the message was handed out").toBe(true);
  const answered = await api("/api/response", { method: "POST", body: { messageId, conversationId, text: "started it in the background", model: "gpt-5.4-mini" } });
  expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
  return conversationId;
}

/**
 * A session worker as the relay sees one: its identity headers on every
 * request, a task set it owns, the real heartbeat. `digest: false` is a
 * worker on older code, which sends no digest and cannot be asked.
 */
function fakeWorker(conversationId, { digest = true } = {}) {
  const posts = [];
  const tasks = [];
  const client = createApiClient({
    serverUrl: relay.baseUrl,
    token: relay.token,
    getHeaders: () => ({
      "x-relay-session-id": conversationId,
      "x-relay-conversation-id": conversationId,
      "x-relay-process-pid": String(process.pid),
    }),
  });
  const send = async (method, route, body) => {
    posts.push({ route, body });
    return client(method, route, body);
  };
  let timer = null;
  const worker = {
    posts,
    tasks,
    backgroundWork: false,
    publish: (extra = {}) => send("POST", "/api/background-tasks", { conversationId, tasks, ...extra }),
  };
  const heartbeat = createHeartbeatController({
    api: send,
    pollMs: 60_000,
    getSessionReady: () => true,
    getHeartbeatTimer: () => timer,
    setHeartbeatTimer: (value) => { timer = value; },
    getActiveQueueMessageId: () => "",
    getSteeringState: () => ({ turnActive: false, autoCompactWindow: { active: null, backgroundWork: worker.backgroundWork } }),
    ...(digest ? {
      getBackgroundTaskIds: () => tasks.map((task) => task.taskId),
      onResyncBackgroundTasks: () => worker.publish({ resync: true }),
    } : {}),
  });
  worker.beat = async () => { expect(await heartbeat.pulseHeartbeat(), "the relay answered the heartbeat").toBe(true); };
  return worker;
}

const detail = async (conversationId) => (await api(`/api/conversation/${conversationId}?limit=5`)).payload;
// Without the CI blockers: a workspace that has a blocker gets its CI looked
// at too, and what that finds for the checkout under test is not the point.
const blockers = async () => (await api("/api/host/suspend")).payload.blockers.filter((blocker) => !String(blocker.kind).startsWith("ci"));

async function openApp(page, conversationId) {
  await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
  await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
}

// The panel is a <details>, closed whenever it (re)appears.
async function unfoldTasksPanel(page) {
  const panel = page.locator("#background-tasks-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  if ((await panel.getAttribute("open")) === null) await page.locator("#background-tasks-summary").click();
  await expect(panel).toHaveAttribute("open", "");
}

test.describe.serial("background tasks across a relay restart", () => {
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    relay = await startRelay();
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  test("a running shell is back after the restart: panel, session state, suspend blocker", async ({ page }) => {
    const conversationId = await idleConversation(`soak run ${Date.now()}`);
    const taskId = `task_fixture_shell_${Date.now()}`;
    const startedAt = Date.now() - 90_000;
    const worker = fakeWorker(conversationId);
    worker.tasks.push({ taskId, taskType: "local_bash", description: "npm run soak", startedAt });
    await worker.beat();
    await worker.publish();

    await openApp(page, conversationId);
    await unfoldTasksPanel(page);
    const row = page.locator(`.bg-task-row[data-task-id="${taskId}"]`);
    await expect(row).toBeVisible();
    expect((await detail(conversationId)).sessionState).toBe("background_only");
    expect((await blockers()).filter((blocker) => blocker.kind === "background").map((blocker) => blocker.conversationId)).toEqual([conversationId]);

    // The runtime is replaced; the worker and its shell are not.
    await restartRelay();
    const justStarted = await blockers();
    expect(justStarted.map((blocker) => blocker.kind)).toEqual(["boot"]);
    expect(justStarted[0].detail).toBe("the relay just started, sessions are still reporting");
    const forgotten = await detail(conversationId);
    expect(forgotten.backgroundTasks, "the new runtime starts without the set").toEqual([]);
    expect(forgotten.sessionState).toBe("idle");

    // The worker's next heartbeat: the relay asks, the worker sends the set again.
    const before = worker.posts.length;
    await worker.beat();
    expect(worker.posts.slice(before).map((post) => [post.route, post.body.resync === true])).toEqual([
      ["/api/heartbeat", false],
      ["/api/background-tasks", true],
    ]);
    // In step again: the following heartbeat is not asked.
    await worker.beat();
    expect(worker.posts.at(-1).route).toBe("/api/heartbeat");

    const restored = await detail(conversationId);
    expect(restored.sessionState).toBe("background_only");
    expect(restored.backgroundTasks.map((task) => task.taskId)).toEqual([taskId]);
    expect(restored.sessionTasks.filter((task) => task.status === "running")).toEqual([
      expect.objectContaining({ id: taskId, kind: "shell", description: "npm run soak", startedAt: new Date(startedAt).toISOString() }),
    ]);
    const listed = (await api("/api/conversations")).payload.conversations.find((conversation) => conversation.id === conversationId);
    expect(listed.sessionState).toBe("background_only");

    // The page reconnected to the new runtime and has the task again.
    await unfoldTasksPanel(page);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator(".bg-task-desc")).toHaveText("npm run soak");

    const background = { kind: "background", conversationId, count: 1, detail: "1 background agent: npm run soak" };
    expect(await blockers()).toEqual(expect.arrayContaining([expect.objectContaining(background)]));
    // The boot blocker goes after its window; the task goes on blocking.
    await expect.poll(async () => (await blockers()).map((blocker) => blocker.kind), { timeout: BOOT_WINDOW_MS + 15_000 }).toEqual(["background"]);

    worker.tasks.length = 0;
    await worker.publish();
  });

  test("a worker on older code that reports background work shows a placeholder until it sends its set", async ({ page }) => {
    const conversationId = await idleConversation(`render queue ${Date.now()}`);
    const taskId = `task_fixture_render_${Date.now()}`;
    const worker = fakeWorker(conversationId, { digest: false });
    worker.tasks.push({ taskId, taskType: "local_bash", description: "npm run render", startedAt: Date.now() - 90_000 });
    worker.backgroundWork = true;
    await worker.beat();
    await worker.publish();
    expect((await detail(conversationId)).backgroundTasks.map((task) => task.taskId)).toEqual([taskId]);

    await restartRelay();
    // The page is there before the worker's first heartbeat: it learns of
    // the placeholder from the relay, not from its own first fetch.
    await openApp(page, conversationId);
    // Its heartbeat carries no digest, so the relay cannot ask; it carries
    // the flag that says background work is running.
    await worker.beat();
    expect(worker.posts.at(-1).route, "an older worker is never asked for its set").toBe("/api/heartbeat");

    const flagged = await detail(conversationId);
    expect(flagged.sessionState).toBe("background_only");
    expect(flagged.sessionTasks).toEqual([expect.objectContaining({
      id: PLACEHOLDER_ID,
      status: "running",
      placeholder: true,
      description: "background work, details not reported since the relay restarted (Kill session in its ⋯ menu ends it)",
    })]);
    expect(flagged.backgroundTasks.map((task) => task.taskId)).toEqual([PLACEHOLDER_ID]);
    expect((await blockers()).filter((blocker) => blocker.kind === "background")).toEqual([
      expect.objectContaining({ conversationId, count: 1, detail: "1 background agent: background work, details not reported since the relay restarted (Kill session in its ⋯ menu ends it)" }),
    ]);

    await unfoldTasksPanel(page);
    const placeholder = page.locator(`.bg-task-row[data-task-id="${PLACEHOLDER_ID}"]`);
    await expect(placeholder).toBeVisible({ timeout: 30_000 });
    await expect(placeholder.locator(".bg-task-desc")).toHaveText("background work, details not reported since the relay restarted (Kill session in its ⋯ menu ends it)");
    await expect(placeholder.locator(".bg-task-stop"), "nothing to stop: the relay does not know the task").toHaveCount(0);

    // The worker's next progress update is its real set: it replaces the placeholder.
    await worker.publish();
    const real = page.locator(`.bg-task-row[data-task-id="${taskId}"]`);
    await expect(real).toBeVisible();
    await expect(placeholder).toHaveCount(0);
    const reported = await detail(conversationId);
    expect(reported.sessionTasks.filter((task) => task.status === "running").map((task) => task.id)).toEqual([taskId]);

    worker.tasks.length = 0;
    await worker.publish();
  });
});
