import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { sleep, startRelayServer } from "./relay-server-harness.mjs";
import { fakeWorkerFor, settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

// A queued relay restart shows a banner on every page: the sessions it waits
// for (links), how long it has waited, that new messages are held, the
// background tasks and whether they survive, and Restart now / Cancel. Past
// the maximum wait it asks (Restart now / Keep waiting / Cancel) and never
// restarts by itself.
//
// The relay is never restarted here. The queued restart waits for a turn
// this process holds open as the session's worker (helpers/fake-worker.mjs,
// kept alive by its heartbeat) and is cancelled before the turn is answered;
// "Restart now" is answered by page.route. Each block boots its OWN relay:
// a queued restart holds every turn of the relay it runs on.

function apiOf(relay) {
  return (route, { method = "GET", body, headers = {} } = {}) => fetch(`${relay.baseUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, payload: await response.json().catch(() => null) }));
}

/**
 * A session worker as the relay sees one (helpers/fake-worker.mjs), with a
 * task set: the heartbeat names the turn it holds and the tasks it runs.
 */
function fakeWorker(relay, queued) {
  const base = fakeWorkerFor(queued, { baseUrl: () => relay.baseUrl, token: () => relay.token });
  const worker = {
    base,
    tasks: [],
    publish: async () => {
      const published = await base.post("/api/background-tasks", { conversationId: base.sessionId, tasks: worker.tasks });
      expect(published.status, JSON.stringify(published.payload)).toBe(200);
    },
    beat: async () => { expect(await base.beat(), "the relay answered the heartbeat").toBe(true); },
  };
  base.use({
    getSteering: () => ({ turnActive: base.holding.length > 0 }),
    getBackgroundTaskIds: () => worker.tasks.map((task) => task.taskId),
    onResyncBackgroundTasks: () => worker.publish(),
  });
  return worker;
}

/** A conversation with one turn handed out and still running. */
async function runningTurn(relay, text) {
  const started = await startConversation({ text }, { baseUrl: relay.baseUrl, token: relay.token });
  const { conversationId, messageId } = started;
  const worker = fakeWorker(relay, started);
  await worker.base.take(messageId);
  return { conversationId, messageId, worker };
}

/** A conversation whose turn is answered, with a worker that runs one background shell. */
async function backgroundOnly(relay, text, description) {
  const turn = await runningTurn(relay, text);
  const answered = await turn.worker.base.respond(turn.messageId, { text: "started it in the background", model: "gpt-5.4-mini" });
  expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
  turn.worker.tasks.push({ taskId: `task_fixture_${Date.now()}`, taskType: "local_bash", description, startedAt: Date.now() - 60_000 });
  await turn.worker.beat();
  await turn.worker.publish();
  return turn;
}

async function loadApp(page, relay) {
  // Signed in once the token was accepted: on a busy machine the app's
  // functions exist before its first authorised call answered.
  const signedIn = page.waitForResponse((response) => response.url().includes("/api/status") && response.ok());
  await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
  await signedIn;
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.openRestartRelayConfirmation === "function");
}

async function queueRestart(relay) {
  const queued = await apiOf(relay)("/api/relay/shutdown", { method: "POST", body: { reason: "e2e", requestedBy: "e2e", restart: true } });
  expect(queued.status).toBe(200);
  // Must stay queued: a restart that went ahead would take the relay down.
  expect(queued.payload.status, JSON.stringify(queued.payload)).toBe("queued");
  return queued.payload;
}

// Keeps the held turn alive: a turn whose worker goes quiet is requeued,
// and a queued restart with nothing processing goes ahead.
function keepBeating(worker) {
  const timer = setInterval(() => { void worker.beat().catch(() => {}); }, 5_000);
  return () => clearInterval(timer);
}

test.describe.serial("queued relay restart banner", () => {
  test.setTimeout(90_000);
  let relay = null;
  let turn = null;
  let stopBeating = () => {};

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
    turn = await runningTurn(relay, `long refactor ${Date.now()}`);
    stopBeating = keepBeating(turn.worker);
  });

  test.afterEach(async () => {
    if (relay) await apiOf(relay)("/api/relay/shutdown/cancel", { method: "POST", body: { requestedBy: "e2e-cleanup" } }).catch(() => {});
  });

  test.afterAll(async () => {
    stopBeating();
    if (relay) await relay.stop();
    relay = null;
  });

  test("the confirmation lists the turn it waits for and the background task that survives", async ({ page }) => {
    const background = await backgroundOnly(relay, `nightly export ${Date.now()}`, "npm run export");
    await loadApp(page, relay);
    await page.evaluate(() => window.openRestartRelayConfirmation());
    const body = page.locator("#summary-modal-body");
    await expect(body).toContainText("The restart waits until these running turns end");
    await expect(body).toContainText("new messages are held");
    await expect(body).toContainText("After 30 min the banner asks");
    await expect(body).toContainText("These background tasks keep running");
    await expect(body).toContainText("1 background agent: npm run export");
    await expect(body.locator("button", { hasText: "Restart when idle" })).toBeVisible();
    await expect(body.locator("button", { hasText: "Restart now" })).toBeVisible();
    await page.evaluate(() => window.closeSummaryModal());
    background.worker.tasks.length = 0;
    await background.worker.publish();
  });

  test("queued: every page shows the banner with the sessions it waits for; Cancel clears it everywhere", async ({ page, browser }) => {
    await loadApp(page, relay);
    const answer = await queueRestart(relay);
    // An API caller (an agent) gets the same picture in its answer.
    expect(answer.waitingFor.map((entry) => entry.conversationId)).toEqual([turn.conversationId]);
    expect(answer.maxWaitMs).toBe(30 * 60_000);

    const banner = page.locator("#pending-action-banner");
    await expect(banner).toHaveClass(/visible/);
    const row = banner.locator('.pending-action-row[data-pending="relay-shutdown"]');
    await expect(row.locator(".pending-action-text")).toHaveText("🌄 Relay restart queued — waiting for 1 session");
    await expect(row.locator(".relay-restart-waited")).toContainText("waited less than a minute of 30 min");
    await expect(row.locator(".relay-restart-held")).toContainText("New messages are held until the restart");
    const link = row.locator(`.relay-restart-waiting-for a[data-conversation-id="${turn.conversationId}"]`);
    await expect(link).toBeVisible();
    await expect(row.locator("button", { hasText: "Restart now" })).toBeVisible();
    await expect(page.locator("#chat-menu-restart-relay")).toHaveText("🌄 Restart pending…");

    // The link opens the session it waits for.
    await link.click();
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem("copilot_last_conv"))).toBe(turn.conversationId);

    // A second client sees the same banner and cancels it for both.
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    try {
      await loadApp(other, relay);
      const otherRow = other.locator('#pending-action-banner .pending-action-row[data-pending="relay-shutdown"]');
      await expect(otherRow).toContainText("waiting for 1 session");
      await otherRow.locator("button", { hasText: "Cancel restart" }).click();
      await expect(other.locator("#pending-action-banner")).not.toHaveClass(/visible/);
      await expect(banner).not.toHaveClass(/visible/);
      await expect(page.locator("#chat-menu-restart-relay")).toHaveText("🌄 Restart web relay");
    } finally {
      await otherContext.close();
    }
    const state = await apiOf(relay)("/api/relay/shutdown");
    expect(state.payload.status).toBe("idle");
  });

  test("Restart now asks first and names the session it does not wait for", async ({ page }) => {
    await loadApp(page, relay);
    await queueRestart(relay);
    const row = page.locator('#pending-action-banner .pending-action-row[data-pending="relay-shutdown"]');
    await expect(row).toBeVisible();
    // The immediate request never reaches the relay.
    const sent = [];
    await page.route("**/api/relay/shutdown", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sent.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, accepted: true, status: "shutting_down" }) });
    });
    await row.locator("button", { hasText: "Restart now" }).click();
    const body = page.locator("#summary-modal-body");
    await expect(body).toContainText("Restart now without waiting for 1 session");
    await expect(body).toContainText("report back to the restarted relay");
    await body.locator("button", { hasText: "Restart now" }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual(expect.objectContaining({ restart: true, immediate: true }));
  });
});

test.describe.serial("queued relay restart past its maximum wait", () => {
  test.setTimeout(90_000);
  // Seconds instead of minutes; the setting's smallest step is 5 min.
  const MAX_WAIT_MS = 4_000;
  let relay = null;
  let turn = null;
  let stopBeating = () => {};

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID(), overrides: { OAR_RELAY_RESTART_MAX_WAIT_MS: String(MAX_WAIT_MS) } });
    turn = await runningTurn(relay, `long migration ${Date.now()}`);
    stopBeating = keepBeating(turn.worker);
  });

  test.afterAll(async () => {
    stopBeating();
    if (relay) {
      await apiOf(relay)("/api/relay/shutdown/cancel", { method: "POST", body: { requestedBy: "e2e-cleanup" } }).catch(() => {});
      await relay.stop();
    }
    relay = null;
  });

  test("the banner turns into a question; Keep waiting starts another period; nothing restarts by itself", async ({ page }) => {
    await loadApp(page, relay);
    await queueRestart(relay);
    const row = page.locator('#pending-action-banner .pending-action-row[data-pending="relay-shutdown"]');
    await expect(row).toHaveAttribute("data-asking", "1", { timeout: MAX_WAIT_MS + 10_000 });
    await expect(row.locator(".pending-action-text")).toContainText("has waited");
    await expect(row.locator(".pending-action-text")).toContainText("for 1 session — restart now, keep waiting or cancel?");
    await expect(row.locator("button")).toHaveText(["Restart now", /^Keep waiting/, "Cancel restart"]);

    // Still queued well past the wait: it asks, it does not restart.
    await sleep(MAX_WAIT_MS);
    const asking = await apiOf(relay)("/api/relay/shutdown");
    expect(asking.payload.status).toBe("queued");
    expect(asking.payload.question).not.toBeNull();

    await row.locator("button", { hasText: "Keep waiting" }).click();
    await expect(row).not.toHaveAttribute("data-asking", "1");
    await expect(row.locator(".pending-action-text")).toHaveText("🌄 Relay restart queued — waiting for 1 session");
    const extended = await apiOf(relay)("/api/relay/shutdown");
    expect(extended.payload.keptWaiting).toBe(1);
    // …and asks again after the next period.
    await expect(row).toHaveAttribute("data-asking", "1", { timeout: MAX_WAIT_MS + 10_000 });

    await row.locator("button", { hasText: "Cancel restart" }).click();
    await expect(page.locator("#pending-action-banner")).not.toHaveClass(/visible/);
    expect((await apiOf(relay)("/api/relay/shutdown")).payload.status).toBe("idle");
  });
});
