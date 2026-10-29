import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// A plan board's action queues the follow-up that carries the plan out. The
// spec is the worker: it dequeues the turn, posts the board the way a worker
// does, and then presses the action the way the page does.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dequeue(request, headers, messageId, ownerSessionId) {
  const dequeueHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    // The connection may be one that was kept while the page was at work and
    // has been closed since: the next round asks again.
    const dequeued = await request.get("/api/pending", { headers: dequeueHeaders }).catch(() => null);
    if (!dequeued) {
      await sleep(200);
      continue;
    }
    expect(dequeued.ok()).toBeTruthy();
    const message = (await dequeued.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

test("a plan board action queues its follow-up message", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  let conversationId = "";
  let messageId = "";
  let followUpId = "";
  try {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `Plan the change ${stamp}`, relayMode: "plan", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    await dequeue(request, headers, messageId, String(queuedBody?.ownerSessionId || ""));

    const created = await request.post("/api/relay-board", {
      headers,
      data: {
        queueId: messageId,
        messageId,
        conversationId,
        mode: "plan",
        boardType: "plan_ready",
        title: "Plan ready for review",
        body: "1. Rename the module\n2. Update the imports",
        actions: [
          { id: "autopilot", label: "Implement in autopilot", mode: "autopilot" },
          { id: "exit_only", label: "Exit plan mode" },
        ],
        recommendedAction: "autopilot",
      },
    });
    expect(created.ok()).toBeTruthy();
    const boardId = String((await created.json())?.board?.id || "");
    expect(boardId).toBeTruthy();

    // While the turn runs, the board lives in the turn's live bubble.
    await page.setViewportSize({ width: 412, height: 915 });
    await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    const board = page.locator(`.relay-board-inline[data-board-id="${boardId}"]`);
    await expect(board).toBeVisible();
    await expect(page.locator("#thinking-indicator .relay-board-inline")).toHaveCount(1);
    await expect(board.locator(".relay-board-body")).toContainText("Rename the module");

    // The reply takes it over: inside the reply's bubble, no card of its own.
    await request.post("/api/response", {
      headers,
      data: { messageId, conversationId, text: "The plan is ready.", model: "gpt-5.4-mini", mode: "plan" },
    });
    const reply = page.locator(`.msg.assistant[data-source-message-id="${messageId}"]`);
    await expect(reply.locator(".msg-bubble")).toContainText("The plan is ready.");
    await expect(reply.locator(".msg-bubble .relay-board-inline")).toHaveCount(1);
    await expect(page.locator(".relay-board-inline")).toHaveCount(1);
    await expect(page.locator(".relay-board-container")).toHaveCount(0);
    await expect(board.getByRole("button", { name: "Implement in autopilot" })).toBeVisible();
    await expect(page.locator("#mode-select")).toHaveValue("plan");

    // The buttons work from inside the bubble, and the choice stays on show.
    const acting = page.waitForResponse((response) => response.url().includes(`/api/relay-board/${boardId}/action`));
    await board.getByRole("button", { name: "Implement in autopilot" }).click();
    const acted = await acting;
    expect(acted.status()).toBe(200);
    followUpId = String((await acted.json())?.queuedMessageId || "");
    expect(followUpId).toBeTruthy();
    await expect(board.locator(".relay-board-outcome")).toHaveText("Chosen: Implement in autopilot");
    await expect(board.locator("button")).toHaveCount(0);
    await expect(board.locator(".relay-board-body")).toContainText("Rename the module");
    // The session goes on in the mode that was chosen.
    await expect(page.locator("#mode-select")).toHaveValue("autopilot");

    // A reload finds the settled board where it was, and the mode with it.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(reply.locator(".msg-bubble .relay-board-outcome")).toHaveText("Chosen: Implement in autopilot");
    await expect(page.locator("#mode-select")).toHaveValue("autopilot");

    // The follow-up is a message like any other: a worker is handed it.
    await dequeue(request, headers, followUpId, String(queuedBody?.ownerSessionId || ""));
  } finally {
    for (const id of [followUpId, messageId].filter(Boolean)) {
      await request.post("/api/response", {
        headers,
        data: { messageId: id, conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" },
      }).catch(() => {});
    }
    if (conversationId) await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});

test("a reply that is the plan shows it once, with the buttons below", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const plan = `1. Split the parser ${stamp}\n2. Move the tests`;
  let conversationId = "";
  let messageId = "";
  try {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `Plan the split ${stamp}`, relayMode: "plan", model: "gpt-5.4-mini" },
    });
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    await dequeue(request, headers, messageId, String(queuedBody?.ownerSessionId || ""));
    const created = await request.post("/api/relay-board", {
      headers,
      data: {
        queueId: messageId,
        messageId,
        conversationId,
        mode: "plan",
        boardType: "plan_ready",
        title: "Plan ready for review",
        body: plan,
        actions: [{ id: "autopilot", label: "Implement in autopilot", mode: "autopilot" }],
      },
    });
    expect(created.ok()).toBeTruthy();
    await request.post("/api/response", {
      headers,
      data: { messageId, conversationId, text: `Here is what I would do.\n\n${plan}`, model: "gpt-5.4-mini", mode: "plan" },
    });

    await page.setViewportSize({ width: 412, height: 915 });
    await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    const reply = page.locator(`.msg.assistant[data-source-message-id="${messageId}"] .msg-bubble`);
    await expect(reply.locator(".relay-board-inline")).toHaveCount(1);
    await expect(reply.locator(".relay-board-inline .relay-board-body")).toHaveCount(0);
    await expect(reply.getByRole("button", { name: "Implement in autopilot" })).toBeVisible();
    await expect(reply.getByText(`Split the parser ${stamp}`)).toHaveCount(1);
    await page.screenshot({ path: "/tmp/oar-plan-board-in-reply.png" });
  } finally {
    if (messageId) {
      await request.post("/api/response", {
        headers,
        data: { messageId, conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" },
      }).catch(() => {});
    }
    if (conversationId) await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});

// ─── Approve plan and plan-only sessions ───────────────────────────

const APPROVE_LINE = "Plan approved by the user. Do not implement. Finish only the plan-only steps you were given, then stop.";

/** A plan turn with its card, as a worker leaves it: the reply posted, the card pending. */
async function planCard(request, headers, { stamp, planOnly = false, actions = null } = {}) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text: `Plan the change ${stamp}`, relayMode: "plan", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "");
  const messageId = String(body?.messageId || "");
  const ownerSessionId = String(body?.ownerSessionId || "");
  // As a CLI does at its first turn: the conversation is bound to its session,
  // so a second message can follow.
  const synced = await request.post("/api/session-sync", { headers, data: { sdk_session_id: conversationId, conversation_id: conversationId } });
  expect(synced.ok()).toBeTruthy();
  await dequeue(request, headers, messageId, ownerSessionId);
  if (planOnly) {
    const flagged = await request.patch(`/api/conversation/${conversationId}/preferences`, { headers, data: { planOnly: true } });
    expect(flagged.ok()).toBeTruthy();
  }
  const created = await request.post("/api/relay-board", {
    headers,
    data: {
      queueId: messageId,
      messageId,
      conversationId,
      mode: "plan",
      boardType: "plan_ready",
      title: "Plan ready for review",
      body: `1. Rename the module ${stamp}\n2. Update the imports`,
      // Stored as a card from before "Approve plan" existed.
      actions: actions || [
        { id: "autopilot", label: "Implement in autopilot", mode: "autopilot" },
        { id: "interactive", label: "Stop here and prompt myself", mode: "agent" },
        { id: "exit_only", label: "Stop here", mode: "agent" },
      ],
      recommendedAction: "autopilot",
    },
  });
  expect(created.ok()).toBeTruthy();
  const boardId = String((await created.json())?.board?.id || "");
  await request.post("/api/response", {
    headers,
    data: { messageId, conversationId, text: "The plan is ready.", model: "gpt-5.4-mini", mode: "plan" },
  });
  return { conversationId, messageId, ownerSessionId, boardId };
}

async function openConversation(page, token, conversationId) {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, conversationId);
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");
}

async function cleanup(request, headers, conversationId) {
  if (!conversationId) return;
  await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
}

test("\"Approve plan\" on a card: its line runs in agent mode once, and the session stays in plan", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  let conversationId = "";
  try {
    const card = await planCard(request, headers, { stamp: Date.now() });
    conversationId = card.conversationId;
    await openConversation(page, token, conversationId);
    const board = page.locator(`.relay-board-inline[data-board-id="${card.boardId}"]`);
    // A card stored before the button existed gets it, first.
    await expect(board.locator("button").first()).toHaveText("Approve plan");
    const acting = page.waitForResponse((response) => response.url().includes(`/api/relay-board/${card.boardId}/action`));
    await board.getByRole("button", { name: "Approve plan" }).click();
    const acted = await acting;
    expect(acted.status()).toBe(200);
    const followUpId = String((await acted.json())?.queuedMessageId || "");
    expect(followUpId).toBeTruthy();
    await expect(board.locator(".relay-board-outcome")).toHaveText("Chosen: Approve plan");
    await expect(page.locator("#mode-select")).toHaveValue("plan");
    const conversation = await (await request.get(`/api/conversation/${conversationId}`, { headers })).json();
    expect(conversation.preferredRelayMode).toBe("plan");
    // The follow-up is exactly the line, in agent mode, and nothing more.
    const followUp = conversation.messages.find((message) => message.id === followUpId);
    expect(followUp.text).toBe(APPROVE_LINE);
    expect(followUp.mode).toBe("agent");
    await dequeue(request, headers, followUpId, card.ownerSessionId);
    await request.post("/api/response", { headers, data: { messageId: followUpId, conversationId, text: "Committed the plan doc.", model: "gpt-5.4-mini", mode: "agent" } });
    // The owner's next message from the composer plans again, and the saved mode stays plan.
    await page.locator("#msg-input").fill(`And the tests? ${Date.now()}`);
    const sending = page.waitForResponse((response) => response.url().endsWith("/api/message") && response.request().method() === "POST");
    await page.locator("#send-btn").click();
    const sent = await (await sending).json();
    const after = await (await request.get(`/api/conversation/${conversationId}`, { headers })).json();
    expect(after.messages.find((message) => message.id === sent.messageId)?.mode).toBe("plan");
    expect(after.preferredRelayMode).toBe("plan");
    await expect(page.locator("#mode-select")).toHaveValue("plan");
  } finally {
    await cleanup(request, headers, conversationId);
  }
});

test("a plan-only session's card recommends \"Approve plan\" and asks before leaving plan mode", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  let conversationId = "";
  try {
    const card = await planCard(request, headers, { stamp: Date.now(), planOnly: true });
    conversationId = card.conversationId;
    await openConversation(page, token, conversationId);
    const board = page.locator(`.relay-board-inline[data-board-id="${card.boardId}"]`);
    await expect(board.locator(".relay-board-action-recommended")).toHaveText("Approve plan");
    // The mode select says plan-only.
    await expect(page.locator("#mode-select")).toHaveAttribute("data-plan-only", "true");

    const questions = [];
    page.once("dialog", async (dialog) => { questions.push(dialog.message()); await dialog.dismiss(); });
    await board.getByRole("button", { name: "Implement in autopilot" }).click();
    await expect.poll(() => questions.length).toBe(1);
    expect(questions[0]).toBe("This session is plan-only. Implement in autopilot leaves plan mode. Go on?");
    // Cancelled: nothing settled, nothing queued.
    await expect(board.getByRole("button", { name: "Implement in autopilot" })).toBeEnabled();
    expect((await (await request.get(`/api/relay-board/${card.boardId}`, { headers })).json()).board.status).toBe("pending");

    page.once("dialog", async (dialog) => { questions.push(dialog.message()); await dialog.accept(); });
    const acting = page.waitForResponse((response) => response.url().includes(`/api/relay-board/${card.boardId}/action`));
    await board.getByRole("button", { name: "Stop here and prompt myself" }).click();
    expect((await acting).status()).toBe(200);
    expect(questions[1]).toBe("This session is plan-only. Stop here and prompt myself leaves plan mode. Go on?");
    await expect(board.locator(".relay-board-outcome")).toHaveText("Chosen: Stop here and prompt myself");
  } finally {
    await cleanup(request, headers, conversationId);
  }
});

test("a card settled elsewhere while its question is open queues nothing more", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  let conversationId = "";
  try {
    const card = await planCard(request, headers, { stamp: Date.now(), planOnly: true });
    conversationId = card.conversationId;
    await openConversation(page, token, conversationId);
    const board = page.locator(`.relay-board-inline[data-board-id="${card.boardId}"]`);
    const dialogs = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.type());
      if (dialog.type() === "confirm") {
        // The other view (the Inbox, another page) settles it first.
        const elsewhere = await request.post(`/api/relay-board/${card.boardId}/action`, { headers, data: { actionId: "approve_only" } });
        expect(elsewhere.ok()).toBeTruthy();
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    });
    // The page's own request (the API call above is not the page's).
    const acting = page.waitForResponse((response) => response.url().includes(`/api/relay-board/${card.boardId}/action`));
    await board.getByRole("button", { name: "Implement in autopilot" }).click();
    expect((await acting).status()).toBe(409);
    await expect(board.locator(".relay-board-outcome")).toHaveText("Chosen: Approve plan");
    expect(dialogs).toEqual(["confirm"]);
    const conversation = await (await request.get(`/api/conversation/${conversationId}`, { headers })).json();
    // Besides the plan prompt, only the line the other view's choice queued.
    const userTexts = conversation.messages.filter((message) => message.role === "user").map((message) => message.text);
    expect(userTexts.slice(1)).toEqual([APPROVE_LINE]);
    expect(conversation.preferredRelayMode).toBe("plan");
  } finally {
    await cleanup(request, headers, conversationId);
  }
});

test("the Inbox lists a plan card and answers it", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  let conversationId = "";
  try {
    const stamp = Date.now();
    const card = await planCard(request, headers, { stamp });
    conversationId = card.conversationId;
    await openConversation(page, token, conversationId);
    const button = page.locator("#inbox-btn");
    // On screen and topmost at its centre (inbox.spec.mjs's check): a phone's
    // drawer has to open first.
    const reachable = () => button.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || rect.left < 0 || rect.right > window.innerWidth) return false;
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(top && (top === node || node.contains(top)));
    });
    if (!(await reachable())) await page.locator("#sidebar-toggle").click();
    await expect.poll(reachable).toBe(true);
    await button.click();    const item = page.locator(`.inbox-item.inbox-plan[data-item-id="${card.boardId}"]`);
    await expect(item).toBeVisible();
    await expect(item.locator(".inbox-item-kind")).toHaveText("Plan · ready for review");
    await expect(item.locator("details.inbox-plan-body")).not.toHaveAttribute("open", "");
    await item.locator("details.inbox-plan-body summary").click();
    await expect(item.locator(".inbox-plan-text")).toContainText(`Rename the module ${stamp}`);
    const acting = page.waitForResponse((response) => response.url().includes(`/api/relay-board/${card.boardId}/action`));
    await item.getByRole("button", { name: "Approve plan" }).click();
    expect((await acting).status()).toBe(200);
    const settled = page.locator(`.inbox-item.inbox-plan[data-item-id="${card.boardId}"]`);
    await expect(settled.locator(".inbox-item-outcome")).toHaveText("Chosen: Approve plan");
    await expect(settled.locator("button.inbox-plan-action")).toHaveCount(0);
    expect((await (await request.get(`/api/relay-board/${card.boardId}`, { headers })).json()).board.selectedAction).toBe("approve_only");
  } finally {
    await cleanup(request, headers, conversationId);
  }
});