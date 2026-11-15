import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";
import { createFakeWorker, settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

/**
 * The loop guard as a relay setting: after how many prompts between agents
 * the user is asked (Settings → Relays → Agent sessions), "Allow for this
 * session" on its card, the sessions it is off for (listed with Revoke, kept
 * across a restart), a lane's free reports to the session that started it,
 * and the card a held schedule firing puts in the Inbox.
 *
 * No model runs here. The spec calls POST /api/remote-relays/tool the way a
 * worker's tool adapter does, with the id of the conversation the "agent"
 * runs in; a turn the card sits on is a message this process took as the
 * session's worker (helpers/fake-worker.mjs). The relay is the spec's own
 * (the shared one keeps its settings), restarted on the same state once.
 *
 * Each conversation may write 10 times a minute through the tool: the
 * sends here are paced by the relay's own retryAfterSeconds.
 */

const CARD_TIMEOUT = 20_000;
// The send that raises the card may first wait out the write limit (10 a
// minute per conversation, checked before the loop guard): its card can come
// a whole minute later.
const WRITE_LIMIT_BACKOFF = 70_000;

let relay = null;
const onRelay = { baseUrl: () => relay.baseUrl, token: () => relay.token };

async function api(route, { method = "GET", body } = {}) {
  const response = await fetch(`${relay.baseUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

/** One tool call, retried after the relay's per-minute write limit. */
async function tool(conversationId, action, args = {}) {
  for (;;) {
    const result = await api("/api/remote-relays/tool", { method: "POST", body: { conversationId, action, args } });
    if (result.status !== 429) return result;
    await sleep((Number(result.payload?.retryAfterSeconds) || 5) * 1000 + 250);
  }
}

async function pendingCards(conversationId) {
  const { payload } = await api(`/api/relay-questions?status=pending&conversationId=${encodeURIComponent(conversationId)}`);
  return (payload?.questions || []).filter((question) => question?.context?.source === "remote_relay");
}

async function waitForCard(conversationId, timeoutMs = CARD_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [card] = await pendingCards(conversationId);
    if (card) return card;
    await sleep(150);
  }
  throw new Error(`No loop guard card appeared for conversation ${conversationId.slice(0, 8)}`);
}

/**
 * `count` sends from `from` to `to` that must raise no card: a card would
 * hold the call until answered, so one that shows up fails the test at once.
 */
async function sendWithoutCard(from, to, count, label) {
  for (let index = 0; index < count; index += 1) {
    let settled = false;
    const call = tool(from, "send", { relay: "this", session: to, text: `${label} ${index + 1}`, wait_seconds: 0 }).finally(() => { settled = true; });
    const watch = (async () => {
      while (!settled) {
        if ((await pendingCards(from)).length) throw new Error(`${label} ${index + 1}: a loop guard card was raised`);
        await sleep(200);
      }
    })();
    const [sent] = await Promise.all([call, watch]);
    expect(sent.status, `${label} ${index + 1}: ${JSON.stringify(sent.payload)}`).toBe(200);
  }
}

/** The send that should raise the card: started, its card awaited. */
async function sendExpectingCard(from, to, label) {
  const call = tool(from, "send", { relay: "this", session: to, text: label, wait_seconds: 0 });
  const card = await waitForCard(from, CARD_TIMEOUT + WRITE_LIMIT_BACKOFF);
  return { call, card };
}

function answerCard(card, answer) {
  return api(`/api/relay-question/${encodeURIComponent(card.id)}/answer`, {
    method: "POST",
    body: { answer, ...(card.sdkSessionId ? { sdk_session_id: card.sdkSessionId } : {}) },
  });
}

/** A conversation whose first message this process took as its worker: its turn runs. */
async function conversationWithRunningTurn(text) {
  const { conversationId, messageId, worker } = await startConversation({ text }, onRelay);
  await worker.take(messageId);
  return conversationId;
}

/** A conversation whose first turn is answered: nothing runs in it. */
async function idleConversation(text) {
  const { conversationId, messageId, worker } = await startConversation({ text }, onRelay);
  await worker.take(messageId);
  const answered = await worker.respond(messageId, { text: "noted", model: "gpt-5.4-mini" });
  expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
  return conversationId;
}

/** The page has signed in: the app's own session proof opens /api/status. */
async function waitForSignIn(page) {
  await expect.poll(() => page.evaluate(async () => (await fetch("/api/status", { headers: { "X-OAR-Session-Proof": localStorage.getItem("oar_session_proof") || "" } })).status), { timeout: 30_000 }).toBe(200);
}

async function openRelaysSettings(page) {
  await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
  await waitForSignIn(page);
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
  await page.evaluate(() => window.openSettingsModal("relays"));
  await expect(page.locator("#settings-panel-relays")).toBeVisible();
  await expect(page.locator("#agent-sessions-section")).toBeVisible();
}

test.describe.serial("the loop guard as a relay setting", () => {
  test.describe.configure({ timeout: 360_000 });

  let lead = "";
  let leadTitle = "";
  let target = "";

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
    expect((await api("/api/settings/pwa-app-name", { method: "POST", body: { appName: "win-test" } })).status).toBe(200);
    expect((await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).status).toBe(200);
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  test("Settings → Agent sessions shows the limit; 10 is kept across a reload and the GET answers it", async ({ page }) => {
    const before = await api("/api/settings/agent-sessions");
    expect(before.payload.agentPromptsBeforeAsking).toBe(30);
    expect(before.payload.loopGuard).toEqual({ off: [] });

    await openRelaysSettings(page);
    const input = page.locator("#agent-sessions-loop-guard-input");
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("30");
    await expect(page.locator("#agent-sessions-loop-guard-value")).toHaveText("Ask after 30 prompts");
    await expect(page.locator("#agent-sessions-loop-guard-off")).toBeHidden();

    await input.fill("10");
    await input.press("Tab");
    await expect(page.locator("#agent-sessions-status")).toHaveText("The loop guard asks after 10 prompts between agents.");
    await expect(page.locator("#agent-sessions-loop-guard-value")).toHaveText("Ask after 10 prompts");

    await page.reload();
    await waitForSignIn(page);
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await page.evaluate(() => window.openSettingsModal("relays"));
    await expect(page.locator("#agent-sessions-loop-guard-input")).toHaveValue("10");
    expect((await api("/api/settings/agent-sessions")).payload.agentPromptsBeforeAsking).toBe(10);
  });

  test("the 11th prompt raises the card with three choices; Allow for this session stops it until Revoke", async ({ page }) => {
    leadTitle = `loop lead ${Date.now()}`;
    lead = await conversationWithRunningTurn(leadTitle);
    target = await idleConversation("loop target");

    await sendWithoutCard(lead, target, 10, "step");
    const eleventh = await sendExpectingCard(lead, target, "step 11");
    expect(eleventh.card.choices).toEqual(["Allow", "Allow for this session", "Deny"]);
    expect(eleventh.card.prompt).toContain("The agent has sent 10 prompts to other agents since your last message. Let it go on?");
    expect(eleventh.card.context.variant).toBe("loop_guard");
    // The Inbox lists it too.
    const inbox = await api("/api/inbox");
    const own = inbox.payload.relays.find((entry) => entry.self);
    expect(own.items.some((item) => item.id === eleventh.card.id)).toBe(true);

    // The user clicks it in the session.
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, lead);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await waitForSignIn(page);
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await page.evaluate((id) => window.openConversation(id), lead);
    const sessionChoice = page.getByRole("button", { name: "Allow for this session", exact: true }).first();
    await expect(sessionChoice).toBeVisible({ timeout: CARD_TIMEOUT });
    await sessionChoice.click();
    const allowed = await eleventh.call;
    expect(allowed.status, JSON.stringify(allowed.payload)).toBe(200);

    const settings = (await api("/api/settings/agent-sessions")).payload;
    expect(settings.loopGuard.off.map((entry) => entry.conversationId)).toEqual([lead]);
    await page.evaluate(() => window.openSettingsModal("relays"));
    const offList = page.locator("#agent-sessions-loop-guard-off");
    await expect(offList).toBeVisible();
    await expect(offList).toContainText(`Loop guard off for: ${leadTitle}`);

    // The 12th through the 30th: no card.
    await sendWithoutCard(lead, target, 19, "free");

    // Revoke in the settings: the count ran on, so the next prompt asks again.
    await offList.getByRole("button", { name: "Revoke" }).click();
    await expect(offList).toBeHidden();
    await expect(page.locator("#agent-sessions-status")).toHaveText("The loop guard asks in that session again.");
    expect((await api("/api/settings/agent-sessions")).payload.loopGuard.off).toEqual([]);
    const asked = await sendExpectingCard(lead, target, "after revoke");
    // Back on the off-list for the restart below.
    expect((await answerCard(asked.card, "Allow for this session")).status).toBe(200);
    expect((await asked.call).status).toBe(200);
  });

  test("after a restart the session is still off and no card comes past the limit", async () => {
    await relay.kill();
    relay = await startRelayServer({ token: relay.token, port: relay.port, state: relay.state });

    const settings = (await api("/api/settings/agent-sessions")).payload;
    expect(settings.agentPromptsBeforeAsking).toBe(10);
    expect(settings.loopGuard.off.map((entry) => [entry.conversationId, entry.title])).toEqual([[lead, leadTitle]]);
    // The count starts at 0 again; past the limit nothing asks.
    await sendWithoutCard(lead, target, 12, "after restart");
  });

  test("a lane reports to the lead that created it, in turns on the lead's prompt: no card", async () => {
    const lead4 = await conversationWithRunningTurn(`lane lead ${Date.now()}`);
    const creating = tool(lead4, "create_session", { relay: "this", text: "collect the numbers and report back", title: "loop lane", wait_seconds: 0 });
    // The once-per-conversation card for starting sessions here.
    const startCard = await waitForCard(lead4);
    expect(startCard.context.header).toBe("Agent sessions");
    expect((await answerCard(startCard, "Allow")).status).toBe(200);
    const created = await creating;
    expect(created.status, JSON.stringify(created.payload)).toBe(200);
    const lane = created.payload.session;

    // The lane's turn runs on the lead's prompt.
    const worker = createFakeWorker({ ...onRelay, sessionId: lane, conversationId: lane });
    await worker.take(created.payload.message_id);
    await sendWithoutCard(lane, lead4, 15, "report");
  });

  test("a held schedule firing puts a card in the setter's Inbox; Allow once lets the next firing go", async () => {
    const setter = await idleConversation(`schedule setter ${Date.now()}`);
    await sendWithoutCard(setter, target, 9, "before the schedule");
    // The 10th prompt: a schedule into the target, due in a few seconds.
    const at = new Date(Date.now() + 5_000).toISOString();
    const made = await tool(setter, "schedule", { session: target, title: "Night check", text: "Check in.", at, every_minutes: 5 });
    expect(made.status, JSON.stringify(made.payload)).toBe(200);
    const scheduleId = made.payload.schedule_id;

    const deadline = Date.now() + 30_000;
    let card = null;
    while (!card && Date.now() < deadline) {
      const inbox = await api("/api/inbox");
      card = inbox.payload.relays.find((entry) => entry.self).items
        .find((item) => item.kind === "ask" && item.status === "pending" && item.session?.id === setter) || null;
      if (!card) await sleep(500);
    }
    expect(card, "the held firing's card").toBeTruthy();
    expect(card.question).toBe("Schedule 'Night check' into 'loop target' is held by the loop guard (10 prompts since your last message).");
    expect(card.options).toEqual(["Allow once", "Allow for this session", "Leave held"]);
    expect(card.askedBy ?? null).toBeNull();
    const listed = await tool(setter, "list_schedules");
    expect(listed.payload.schedules.find((schedule) => schedule.id === scheduleId).heldForApproval).toBe(true);

    const answered = await api(`/api/relay-question/${encodeURIComponent(card.id)}/answer`, { method: "POST", body: { choice: "Allow once" } });
    expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
    // The held firing is looked at again every minute.
    await expect.poll(async () => {
      const schedules = (await tool(setter, "list_schedules")).payload.schedules;
      const schedule = schedules.find((entry) => entry.id === scheduleId);
      return { fired: schedule.firedCount, held: schedule.heldForApproval === true };
    }, { timeout: 90_000, intervals: [2_000] }).toEqual({ fired: 1, held: false });
    const inbox = await api("/api/inbox");
    const still = inbox.payload.relays.find((entry) => entry.self).items.find((item) => item.id === card.id);
    expect(still?.status ?? "gone").not.toBe("pending");
    expect((await tool(setter, "unschedule", { schedule_id: scheduleId })).status).toBe(200);
  });
});
