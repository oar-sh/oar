import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";
import { openComposerSettings } from "./composer-settings-helpers.mjs";

/**
 * Back and forward through sessions (session-history.mjs):
 *
 *  - each switch is one history entry with `?conv=<id>` in the address; back
 *    and forward walk them, the document title names the session, a reload
 *    opens the session in the address;
 *  - on a phone, back at the visit's first session opens the session list;
 *  - back closes the ⚙ sheet, git changes, a row's menu, the emoji picker,
 *    the Inbox and Status first and stays on the session (one opened from
 *    the other too); an overlay opened with sessions ahead leaves forward
 *    history alone;
 *  - back and forward step over a session deleted since, after a reload too;
 *  - a link survives a touch before the login and during the load; an
 *    unknown one leaves nothing open and says so (a waiting question does not
 *    open its session then), an archived one shows its title; the share page
 *    writes no history.
 *
 * The isolated server runs no CLI: each conversation's first turn is a
 * dequeued row answered by the spec in the worker's place. Titles are invented.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dequeue(request, headers, messageId, ownerSessionId = "") {
  const dequeueHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await request.get("/api/pending", { headers: dequeueHeaders });
    expect(response.ok()).toBeTruthy();
    const message = (await response.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(150);
  }
  throw new Error("the queued message was never handed out");
}

// A session-bound conversation with a finished first turn.
async function seedConversation(request, headers, title, stamp) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text: `${title} ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "");
  const messageId = String(body?.messageId || "");
  expect(conversationId).toBeTruthy();
  await dequeue(request, headers, messageId, String(body?.ownerSessionId || ""));
  const synced = await request.post("/api/session-sync", {
    headers,
    data: { sdk_session_id: `pw-sid-back-${stamp}-${conversationId.slice(0, 8)}`, conversation_id: conversationId },
  });
  expect(synced.ok()).toBeTruthy();
  const responded = await request.post("/api/response", {
    headers,
    data: { messageId, conversationId, text: `${title} first reply`, model: "gpt-5.4-mini", mode: "agent" },
  });
  expect(responded.ok()).toBeTruthy();
  return { id: conversationId, title: `${title} ${stamp}` };
}

async function seedThree(request, stamp) {
  const headers = { Authorization: `Bearer ${relayToken()}` };
  return [
    await seedConversation(request, headers, "Sort the seed packets", stamp),
    await seedConversation(request, headers, "Plan the allotment rota", stamp),
    await seedConversation(request, headers, "Fix the greenhouse latch", stamp),
  ];
}

// A conversation whose first turn waits on a question (the turn stays open).
async function seedQuestion(request, headers, title, stamp) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text: `${title} ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "");
  const messageId = String(body?.messageId || "");
  expect(conversationId).toBeTruthy();
  await dequeue(request, headers, messageId, String(body?.ownerSessionId || ""));
  const created = await request.post("/api/relay-question", {
    headers,
    data: {
      queueId: messageId,
      messageId,
      conversationId,
      mode: "agent",
      prompt: `${title}: which bed first?`,
      choices: ["The north bed", "The south bed"],
      allowFreeform: false,
      timeout_ms: 120000,
    },
  });
  expect(created.ok()).toBeTruthy();
  const questionId = String((await created.json())?.question?.id || "");
  expect(questionId).toBeTruthy();
  return { id: conversationId, title: `${title} ${stamp}`, messageId, questionId };
}

const row = (page, id) => page.locator(`#conv-list .conv-item[data-conversation-id="${id}"]`);
const convParam = (page) => new URL(page.url()).searchParams.get("conv");
const authHeaders = () => ({ Authorization: `Bearer ${relayToken()}` });
const onOverlayEntry = (page) => page.evaluate(() => Boolean(history.state?.oarOverlay));
// No relay has a conversation with this id.
const UNKNOWN_ID = "0f0f0f0f-dead-4bee-8a11-000000000404";

async function openApp(page, first) {
  await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, first.id);
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
  await expect(page.locator("#chat-title")).toHaveText(first.title);
  await expect.poll(() => convParam(page)).toBe(first.id);
}

async function expectOn(page, conversation) {
  await expect(page.locator("#chat-title")).toHaveText(conversation.title);
  await expect.poll(() => convParam(page)).toBe(conversation.id);
  await expect.poll(() => page.title()).toBe(conversation.title);
}

test.describe("back and forward through sessions on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("each switch is one entry: back, back, forward walk them; a reload keeps the session", async ({ page, request }) => {
    const [first, second, third] = await seedThree(request, `desk-${Date.now()}`);
    await openApp(page, first);
    const lengthAtLoad = await page.evaluate(() => history.length);

    await row(page, second.id).click();
    await expectOn(page, second);
    await row(page, third.id).click();
    await expectOn(page, third);
    // Reopening the one on screen adds nothing.
    await row(page, third.id).click();
    expect(await page.evaluate(() => history.length)).toBe(lengthAtLoad + 2);

    await page.goBack();
    await expectOn(page, second);
    await page.goBack();
    await expectOn(page, first);
    await page.goForward();
    await expectOn(page, second);

    // The address wins over the last-opened one on a reload.
    await page.evaluate((id) => localStorage.setItem("copilot_last_conv", id), third.id);
    await page.reload();
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await expectOn(page, second);
  });

  test("back closes git changes, a row's menu, the emoji picker, the Inbox and Status first; forward survives an overlay", async ({ page, request }) => {
    const [first, second, third] = await seedThree(request, `overlay-${Date.now()}`);
    await openApp(page, first);
    await row(page, second.id).click();
    await expectOn(page, second);

    await page.evaluate(() => window.openGitChangesModal());
    await expect(page.locator("#git-changes-modal")).toHaveClass(/\bvisible\b/);
    await expect.poll(() => onOverlayEntry(page)).toBe(true);
    await page.goBack();
    await expect(page.locator("#git-changes-modal")).not.toHaveClass(/\bvisible\b/);
    await expectOn(page, second);

    await row(page, third.id).click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();
    await expect.poll(() => onOverlayEntry(page)).toBe(true);
    await page.goBack();
    await expect(page.locator(".context-menu")).toHaveCount(0);
    await expectOn(page, second);

    await page.evaluate(() => window.toggleEmojiPicker());
    await expect(page.locator("#emoji-popup")).toHaveClass(/\bvisible\b/);
    await expect.poll(() => onOverlayEntry(page)).toBe(true);
    await page.goBack();
    await expect(page.locator("#emoji-popup")).not.toHaveClass(/\bvisible\b/);
    await expectOn(page, second);

    // Back leaves the Inbox for the session it was opened from.
    await page.locator("#inbox-btn").click();
    await expect(page.locator("body")).toHaveClass(/\binbox-view-active\b/);
    await expect.poll(() => onOverlayEntry(page)).toBe(true);
    await page.goBack();
    await expect(page.locator("body")).not.toHaveClass(/\binbox-view-active\b/);
    await expectOn(page, second);

    // Status the same way.
    await page.locator("#status-btn").click();
    await expect(page.locator("body")).toHaveClass(/\bstatus-view-active\b/);
    await expect.poll(() => onOverlayEntry(page)).toBe(true);
    await page.goBack();
    await expect(page.locator("body")).not.toHaveClass(/\bstatus-view-active\b/);
    await expectOn(page, second);

    // With a session ahead, an overlay takes no entry: back closes it and
    // stays, and forward still leads on.
    await row(page, third.id).click();
    await expectOn(page, third);
    await page.goBack();
    await expectOn(page, second);
    const length = await page.evaluate(() => history.length);
    await page.evaluate(() => window.openGitChangesModal());
    await expect(page.locator("#git-changes-modal")).toHaveClass(/\bvisible\b/);
    await page.goBack();
    await expect(page.locator("#git-changes-modal")).not.toHaveClass(/\bvisible\b/);
    await expectOn(page, second);
    await page.evaluate(() => window.openGitChangesModal());
    await page.evaluate(() => window.closeGitChangesModal());
    expect(await page.evaluate(() => history.length)).toBe(length);
    await page.goForward();
    await expectOn(page, third);
  });

  test("one view opened from the other: back leaves both for the session, in either order", async ({ page, request }) => {
    const only = await seedConversation(request, authHeaders(), "Sharpen the hoe", `chain-${Date.now()}`);
    await openApp(page, only);
    const views = { inbox: "#inbox-btn", status: "#status-btn" };
    for (const [first, second] of [["status", "inbox"], ["inbox", "status"]]) {
      await page.locator(views[first]).click();
      await expect(page.locator("body")).toHaveClass(new RegExp(`\\b${first}-view-active\\b`));
      await page.locator(views[second]).click();
      await expect(page.locator("body")).toHaveClass(new RegExp(`\\b${second}-view-active\\b`));
      await expect(page.locator("body")).not.toHaveClass(new RegExp(`\\b${first}-view-active\\b`));
      await expect.poll(() => onOverlayEntry(page)).toBe(true);

      await page.goBack();
      await expect(page.locator("body")).not.toHaveClass(/\b(inbox|status)-view-active\b/);
      // The session's own title and transcript, not the view's.
      await expectOn(page, only);
      await expect(page.locator("#messages .inbox-view, #messages .status-view")).toHaveCount(0);
      await expect(page.locator("#messages")).toContainText("Sharpen the hoe first reply");
      await expect(page.locator("#input-area")).toBeVisible();
    }
  });

  test("a link survives a touch before the login and one during the load", async ({ page, browser, request }) => {
    const headers = authHeaders();
    const stamp = `link-${Date.now()}`;
    const last = await seedConversation(request, headers, "Water the seedlings", stamp);
    const linked = await seedConversation(request, headers, "Mend the cold frame", stamp);

    await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, last.id);
    await page.goto(`/?conv=${encodeURIComponent(linked.id)}`);
    const tokenInput = page.locator("#token-input");
    await expect(tokenInput).toBeVisible();
    await tokenInput.click();
    await expect.poll(() => convParam(page)).toBe(linked.id);
    await tokenInput.fill(relayToken());
    await tokenInput.press("Enter");
    await expectOn(page, linked);

    // Logged in, with the relay holding its answer: the click lands once the
    // history base is armed, and before the link is read. A click before the
    // app has armed lays nothing and would prove nothing: it is repeated
    // until the base is laid.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const slow = await context.newPage();
      await slow.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, last.id);
      let release = () => {};
      const held = new Promise((resolve) => { release = resolve; });
      await slow.route("**/api/status", async (route) => {
        await held;
        await route.continue();
      });
      await slow.goto(`/?token=${encodeURIComponent(relayToken())}&conv=${encodeURIComponent(linked.id)}`);
      await expect.poll(async () => {
        await slow.mouse.click(640, 400);
        return slow.evaluate(() => Boolean(history.state?.oarLaid));
      }, { timeout: 15_000 }).toBe(true);
      await slow.keyboard.press("Shift");
      expect(convParam(slow)).toBe(linked.id);
      // From here every status call goes through at once.
      release();
      await expect(slow.locator("#chat-title")).toHaveText(linked.title, { timeout: 20_000 });
      await expect.poll(() => convParam(slow)).toBe(linked.id);
    } finally {
      await context.close();
    }
  });

  test("an unknown link says so: no stand-in chat, no ?conv, the last-opened one kept", async ({ page, request }) => {
    const last = await seedConversation(request, authHeaders(), "Label the compost bins", `unknown-${Date.now()}`);
    // Set once: the reload below must find what the unknown link left.
    await page.addInitScript((id) => {
      if (sessionStorage.getItem("pw-last-set")) return;
      sessionStorage.setItem("pw-last-set", "1");
      localStorage.setItem("copilot_last_conv", id);
    }, last.id);
    await page.goto(`/?token=${encodeURIComponent(relayToken())}&conv=${UNKNOWN_ID}`);
    await expect(page.locator("#relay-toast")).toContainText("not on this relay");
    await expect(page.locator("#chat-title")).toHaveText("Select or start a conversation");
    await expect.poll(() => convParam(page)).toBe(null);
    await expect.poll(() => page.title()).not.toContain(UNKNOWN_ID);
    expect(await page.evaluate(() => localStorage.getItem("copilot_last_conv"))).toBe(last.id);

    // A reload opens the last-opened one, not the unknown one again.
    await page.reload();
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await expectOn(page, last);
  });

  test("an unknown link with a question waiting says so, and the question's session does not open by itself", async ({ page, request }) => {
    const headers = authHeaders();
    const stamp = `unknown-ask-${Date.now()}`;
    const last = await seedConversation(request, headers, "Net the currant bushes", stamp);
    const asking = await seedQuestion(request, headers, "Choose the bean bed", stamp);
    try {
      await page.addInitScript((id) => {
        if (sessionStorage.getItem("pw-last-set")) return;
        sessionStorage.setItem("pw-last-set", "1");
        localStorage.setItem("copilot_last_conv", id);
      }, last.id);
      await page.goto(`/?token=${encodeURIComponent(relayToken())}&conv=${UNKNOWN_ID}`);
      await expect(page.locator("#relay-toast")).toContainText("not on this relay");
      await expect(page.locator("#pending-question-banner")).toBeVisible();
      // The load's own look at the questions, then the next poll (every 3 s): neither opens it.
      for (let round = 0; round < 2; round += 1) {
        await page.waitForResponse((response) => response.url().includes("/api/relay-questions"), { timeout: 10_000 });
        await sleep(800);
        await expect(page.locator("#chat-title")).toHaveText("Select or start a conversation");
      }
      expect(convParam(page)).toBe(null);
      expect(await page.evaluate(() => localStorage.getItem("copilot_last_conv"))).toBe(last.id);

      // The banner still leads there when the reader asks.
      await page.locator("#pending-question-banner").click();
      await expectOn(page, asking);
    } finally {
      await request.post(`/api/relay-question/${asking.questionId}/answer`, { headers, data: { answer: "The north bed" } }).catch(() => {});
      await request.post("/api/response", {
        headers,
        data: { messageId: asking.messageId, conversationId: asking.id, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" },
      }).catch(() => {});
      await request.delete(`/api/conversation/${asking.id}`, { headers }).catch(() => {});
    }
  });

  test("back steps over a session deleted since, after a reload too", async ({ page, request }) => {
    const [first, second, third] = await seedThree(request, `gone-${Date.now()}`);
    await openApp(page, first);
    await row(page, second.id).click();
    await expectOn(page, second);
    await row(page, third.id).click();
    await expectOn(page, third);

    // Deleted elsewhere. The page is connected, so the socket tells it
    // first; the relay's 404 when a tab only finds out by going there is
    // covered by the unit tests (session-history.test.mjs).
    const deleted = await request.delete(`/api/conversation/${second.id}`, { headers: authHeaders() });
    expect(deleted.ok()).toBeTruthy();
    await page.reload();
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await expectOn(page, third);

    // Back walks past it to the one before: no stand-in chat, nothing stuck.
    await page.goBack();
    await expectOn(page, first);
    await expect(row(page, second.id)).toHaveCount(0);
    // And forward walks past it the other way.
    await page.goForward();
    await expectOn(page, third);
    await page.goBack();
    await expectOn(page, first);
  });

  test("an archived link shows its title, in the header, the document and the archived list", async ({ page, request }) => {
    const headers = authHeaders();
    const archived = await seedConversation(request, headers, "Retire the old trellis", `archived-${Date.now()}`);
    const done = await request.post(`/api/conversation/${archived.id}/archive`, { headers, data: {} });
    expect(done.ok()).toBeTruthy();
    await page.goto(`/?token=${encodeURIComponent(relayToken())}&conv=${encodeURIComponent(archived.id)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await expectOn(page, archived);
    await page.locator("#conv-archived-toggle").click();
    await expect(row(page, archived.id)).toHaveClass(/\bactive\b/);
  });
});

test.describe("the share page", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("writes no history and ignores ?conv=", async ({ browser, request }) => {
    const headers = authHeaders();
    const shared = await seedConversation(request, headers, "Draw the bed plan", `share-${Date.now()}`);
    const share = await request.post(`/api/conversation/${shared.id}/share`, { headers });
    expect(share.ok()).toBeTruthy();
    const shareToken = String((await share.json())?.token || "");
    const context = await browser.newContext();
    try {
      const sharedPage = await context.newPage();
      await sharedPage.goto(`/shared/${shareToken}?conv=${UNKNOWN_ID}`);
      await expect(sharedPage.locator("#messages .msg.assistant").last()).toContainText("Draw the bed plan first reply");
      const lengthAtLoad = await sharedPage.evaluate(() => history.length);
      await sharedPage.locator("#messages").click();
      await sharedPage.keyboard.press("Escape");
      await sleep(300);
      expect(await sharedPage.evaluate(() => history.length)).toBe(lengthAtLoad);
      expect(await sharedPage.evaluate(() => history.state?.oarConv ?? null)).toBe(null);
      expect(new URL(sharedPage.url()).searchParams.get("conv")).toBe(UNKNOWN_ID);
    } finally {
      await context.close();
      await request.delete(`/api/conversation/${shared.id}/share`, { headers }).catch(() => {});
    }
  });
});

test.describe("back and forward through sessions on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("back at the first session opens the session list", async ({ page, request }) => {
    const [first, second] = await seedThree(request, `phone-${Date.now()}`);
    await openApp(page, first);
    // The list entry is laid at the first touch, as the back guard's floor is.
    await page.locator("#messages").tap();
    await expect.poll(() => page.evaluate(() => history.state?.oarConv)).toBe(first.id);

    await page.goBack();
    await expect(page.locator("#sidebar")).toHaveClass(/\bopen\b/);
    await expect(page.locator("#chat-title")).toHaveText(first.title);

    // Picking a session from the list pushes as normal (over the list); back opens the list again.
    await row(page, second.id).click();
    await expect(page.locator("#sidebar")).not.toHaveClass(/\bopen\b/);
    await expectOn(page, second);
    await page.goBack();
    await expect(page.locator("#sidebar")).toHaveClass(/\bopen\b/);
    await expect(page.locator("#chat-title")).toHaveText(second.title);

    // The sidebar opened by hand is an overlay: back closes it first.
    // First the list closed by hand (as a tap beside it does): forward to the session it came from.
    await page.evaluate(() => window.closeSidebar?.());
    await expect(page.locator("#sidebar")).not.toHaveClass(/\bopen\b/);
    await expect.poll(() => page.evaluate(() => history.state?.oarConv)).toBe(second.id);
    await page.locator("#sidebar-toggle").click();
    await expect(page.locator("#sidebar")).toHaveClass(/\bopen\b/);
    await expect.poll(() => page.evaluate(() => Boolean(history.state?.oarOverlay))).toBe(true);
    await page.goBack();
    await expect(page.locator("#sidebar")).not.toHaveClass(/\bopen\b/);
    await expectOn(page, second);
  });

  test("with the ⚙ sheet open, back closes it and stays on the session", async ({ page, request }) => {
    const [first, second] = await seedThree(request, `sheet-${Date.now()}`);
    await openApp(page, first);
    await page.locator("#messages").tap();
    await page.locator("#sidebar-toggle").click();
    await expect(page.locator("#sidebar")).toHaveClass(/\bopen\b/);
    await row(page, second.id).click();
    await expectOn(page, second);

    const panel = await openComposerSettings(page);
    await expect.poll(() => page.evaluate(() => Boolean(history.state?.oarOverlay))).toBe(true);
    await page.goBack();
    await expect(panel).toBeHidden();
    await expectOn(page, second);

    // Closed by hand instead: its entry goes, and back switches the session.
    await openComposerSettings(page);
    await page.locator("#composer-settings-close").click();
    await expect(panel).toBeHidden();
    await expect.poll(() => page.evaluate(() => Boolean(history.state?.oarOverlay))).toBe(false);
    await page.goBack();
    await expectOn(page, first);
  });
});
