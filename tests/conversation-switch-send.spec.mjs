import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

/**
 * Switching conversations quickly, then sending in the one the user stopped
 * at, against the shared e2e relay.
 *
 * Leaving a conversation with a typed draft saves that draft. Here the save
 * is held by a page route, as a slow link holds it, while the user
 * keeps clicking: a quick run through several conversations, and a click
 * back on the conversation that was still open. The last click must win at
 * once: the title, the conversation the message is sent to, the user's own
 * bubble and the live reply all belong to it, and the held draft still
 * reaches the relay when the link lets it through.
 *
 * Once sent, the live reply stays up through the two things a slow or busy
 * link does to it: a poll answer read before the worker took the message that
 * arrives after the socket said it had, and a stream frame the socket drops.
 *
 * The isolated server runs no CLI, so the turn is a dequeued row and its
 * stream is posted by the spec in the worker's place.
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

// A finished first turn on a session-bound conversation: follow-ups from the
// composer are accepted only there.
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
    data: { sdk_session_id: `pw-sid-switch-${stamp}-${conversationId.slice(0, 8)}`, conversation_id: conversationId },
  });
  expect(synced.ok()).toBeTruthy();
  const responded = await request.post("/api/response", {
    headers,
    data: { messageId, conversationId, text: `${title} reply`, model: "gpt-5.4-mini", mode: "agent" },
  });
  expect(responded.ok()).toBeTruthy();
  return { conversationId, title: `${title} ${stamp}` };
}

// Holds every draft save of one conversation until release() is called.
async function holdDraftSaves(page, conversationId) {
  const held = [];
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(`**/api/conversation/${conversationId}/draft`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    held.push(route.request());
    await gate;
    await route.continue();
  });
  return {
    held,
    async release() {
      release();
      await Promise.all(held.map((request) => request.response()));
    },
  };
}

// The next live-poll read of the conversation reaches the relay at once, but
// its answer waits for release(): an answer read while the message still
// waited in the queue, arriving after the socket said a worker had taken it.
async function holdNextPollAnswer(page, conversationId) {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  let read = () => {};
  const wasRead = new Promise((resolve) => { read = resolve; });
  let armed = true;
  await page.route(`**/api/conversation/${conversationId}?*`, async (route) => {
    const limit = Number(new URL(route.request().url()).searchParams.get("limit") || 0);
    if (!armed || route.request().method() !== "GET" || limit <= 1) return route.continue();
    armed = false;
    const response = await route.fetch();
    read();
    await gate;
    await route.fulfill({ response });
  });
  return { wasRead, release };
}

// Drops the relay's stream frames while `drop` is set. They are sent volatile,
// and a connection still busy with an earlier packet drops them the same way.
async function routeStreamFrames(page) {
  const frames = { drop: false, dropped: 0 };
  await page.routeWebSocket(/socket\.io/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (frames.drop && String(message).includes('"relay_stream"')) {
        frames.dropped += 1;
        return;
      }
      ws.send(message);
    });
  });
  return frames;
}

const isPollOf = (conversationId) => (request) => request.method() === "GET"
  && request.url().includes(`/api/conversation/${conversationId}?`)
  && Number(new URL(request.url()).searchParams.get("limit") || 0) > 1;

const row = (page, id) => page.locator(`#conv-list .conv-item[data-conversation-id="${id}"]`);

async function openPage(page, token, conversationId) {
  await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, conversationId);
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
  // Only the socket's connect handler turns the dot green: from here on the
  // page receives the turn's status and stream.
  await expect(page.locator("#cli-dot")).toHaveClass("online");
}

for (const profile of [
  { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, touch: false },
  { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, touch: true },
]) {
  test.describe(`switching conversations, then sending, on a ${profile.name} viewport`, () => {
    test.use(profile.use);

    // A click on a row, the way a user makes it: on a phone the list is an
    // overlay, opened from the burger first unless it is still open.
    async function pick(page, id) {
      if (profile.touch) {
        await page.evaluate(() => window.toggleSidebar?.(true));
        await row(page, id).tap();
      } else {
        await row(page, id).click();
      }
    }

    // The composer's send; resolves with what was posted and the relay's answer.
    async function send(page, text) {
      const posted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/message"));
      await page.fill("#msg-input", text);
      if (profile.touch) await page.locator("#send-btn").tap(); else await page.locator("#send-btn").click();
      const response = await posted;
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      return {
        posted: response.request().postDataJSON(),
        conversationId: String(body?.conversationId || ""),
        messageId: String(body?.messageId || ""),
        ownerSessionId: String(body?.ownerSessionId || ""),
      };
    }

    // The worker's part: it takes the message and streams the start of a reply.
    async function streamReply(request, headers, sent, streamText) {
      await dequeue(request, headers, sent.messageId, sent.ownerSessionId);
      const streamed = await request.post("/api/stream", {
        headers,
        data: { messageId: sent.messageId, conversationId: sent.conversationId, text: streamText, mode: "agent", done: false },
      });
      expect(streamed.ok()).toBeTruthy();
    }

    async function finish(request, headers, sent) {
      if (!sent?.conversationId || !sent?.messageId) return;
      await request.post("/api/response", {
        headers,
        data: { messageId: sent.messageId, conversationId: sent.conversationId, text: "playwright cleanup", model: "gpt-5.4-mini", mode: "agent" },
      }).catch(() => {});
    }

    test("a quick run through several conversations sends in the last one clicked", async ({ page, request }) => {
      const token = relayToken();
      const headers = { Authorization: `Bearer ${token}` };
      const stamp = `${profile.name}-${Date.now()}`;
      const first = await seedConversation(request, headers, "Plan the garden app release", stamp);
      const second = await seedConversation(request, headers, "Sketch the kite flight log", stamp);
      const last = await seedConversation(request, headers, "Tidy the recipe index", stamp);
      const text = `Please add the oat cookies ${stamp}`;
      const streamText = `Adding the oat cookies now ${stamp}`;
      let sent = null;
      try {
        await openPage(page, token, first.conversationId);
        await expect(page.locator("#chat-title")).toHaveText(first.title);
        await expect(page.locator("#messages .msg.user", { hasText: first.title })).toBeVisible();

        const draftSaves = await holdDraftSaves(page, first.conversationId);
        await page.fill("#msg-input", "half-written note about the release");
        await pick(page, second.conversationId);
        await pick(page, last.conversationId);
        if (profile.touch) await expect(page.locator("#sidebar")).not.toHaveClass(/\bopen\b/);
        // Typed and sent straight after the last click, while the draft of
        // the first conversation is still on its way.
        sent = await send(page, text);
        await draftSaves.release();
        expect(draftSaves.held.length).toBeGreaterThan(0);
        expect(draftSaves.held[0].postDataJSON()?.draftText).toBe("half-written note about the release");

        await streamReply(request, headers, sent, streamText);
        await expect(page.locator("#chat-title")).toHaveText(last.title);
        await expect(page.locator("#messages .msg.user", { hasText: last.title })).toBeVisible();
        await expect(page.locator("#messages .msg.user", { hasText: text })).toBeVisible();
        await expect(page.locator("#thinking-stream")).toContainText(streamText);
        await expect(row(page, last.conversationId)).toHaveClass(/\bactive\b/);
        expect(sent.posted.conversationId).toBe(last.conversationId);
      } finally {
        await finish(request, headers, sent);
        for (const conversation of [first, second, last]) {
          await request.delete(`/api/conversation/${conversation.conversationId}`, { headers }).catch(() => {});
        }
      }
    });

    test("a click back on the conversation still open keeps it open and sends there", async ({ page, request }) => {
      const token = relayToken();
      const headers = { Authorization: `Bearer ${token}` };
      const stamp = `${profile.name}-${Date.now()}`;
      const open = await seedConversation(request, headers, "Count the library returns", stamp);
      const other = await seedConversation(request, headers, "Draft the bike route notes", stamp);
      const text = `Also count the atlases ${stamp}`;
      const streamText = `Counting the atlases ${stamp}`;
      let sent = null;
      try {
        await openPage(page, token, open.conversationId);
        await expect(page.locator("#chat-title")).toHaveText(open.title);
        await expect(page.locator("#messages .msg.user", { hasText: open.title })).toBeVisible();

        const draftSaves = await holdDraftSaves(page, open.conversationId);
        await page.fill("#msg-input", "half-written note about the returns");
        await pick(page, other.conversationId);
        await pick(page, open.conversationId);
        await expect(page.locator("#chat-title")).toHaveText(open.title);
        await expect(page.locator("#msg-input")).toHaveValue("half-written note about the returns");

        sent = await send(page, text);
        expect(sent.posted.conversationId).toBe(open.conversationId);
        await expect(page.locator("#messages .msg.user", { hasText: text })).toBeVisible();
        // The save the first click started gets through only now.
        await draftSaves.release();
        expect(draftSaves.held[0].postDataJSON()?.draftText).toBe("half-written note about the returns");

        await streamReply(request, headers, sent, streamText);
        await expect(page.locator("#chat-title")).toHaveText(open.title);
        await expect(page.locator("#messages .msg.user", { hasText: open.title })).toBeVisible();
        await expect(page.locator("#messages .msg.user", { hasText: text })).toBeVisible();
        await expect(page.locator("#thinking-stream")).toContainText(streamText);
        await expect(row(page, open.conversationId)).toHaveClass(/\bactive\b/);
      } finally {
        await finish(request, headers, sent);
        for (const conversation of [open, other]) {
          await request.delete(`/api/conversation/${conversation.conversationId}`, { headers }).catch(() => {});
        }
      }
    });

    test("a poll answer read before the worker took the message leaves the live reply on screen", async ({ page, request }) => {
      const token = relayToken();
      const headers = { Authorization: `Bearer ${token}` };
      const stamp = `${profile.name}-${Date.now()}`;
      const first = await seedConversation(request, headers, "Water the fern shelf", stamp);
      const last = await seedConversation(request, headers, "Repot the basil", stamp);
      const text = `Use the clay pot ${stamp}`;
      const streamText = `Repotting into the clay pot ${stamp}`;
      let sent = null;
      try {
        await openPage(page, token, first.conversationId);
        await pick(page, last.conversationId);
        await expect(page.locator("#chat-title")).toHaveText(last.title);
        sent = await send(page, text);

        const answer = await holdNextPollAnswer(page, last.conversationId);
        await answer.wasRead;
        await streamReply(request, headers, sent, streamText);
        await expect(page.locator("#thinking-stream")).toContainText(streamText);
        const nextPoll = page.waitForRequest(isPollOf(last.conversationId), { timeout: 5000 });
        answer.release();
        // The held answer settles its poll round; the turn still runs, so the
        // page goes on polling and the reply comes back from the next answer.
        await nextPoll;
        await expect(page.locator("#thinking-stream")).toContainText(streamText);
        await expect(page.locator("#messages .msg.user", { hasText: text })).toBeVisible();
      } finally {
        await finish(request, headers, sent);
        for (const conversation of [first, last]) {
          await request.delete(`/api/conversation/${conversation.conversationId}`, { headers }).catch(() => {});
        }
      }
    });

    test("a reply frame the socket dropped shows from the live poll", async ({ page, request }) => {
      const token = relayToken();
      const headers = { Authorization: `Bearer ${token}` };
      const stamp = `${profile.name}-${Date.now()}`;
      const first = await seedConversation(request, headers, "Sweep the porch steps", stamp);
      const last = await seedConversation(request, headers, "Oil the gate hinge", stamp);
      const text = `Use the thin oil ${stamp}`;
      const streamText = `Oiling the hinge now ${stamp}`;
      let sent = null;
      try {
        const frames = await routeStreamFrames(page);
        await openPage(page, token, first.conversationId);
        await pick(page, last.conversationId);
        await expect(page.locator("#chat-title")).toHaveText(last.title);
        sent = await send(page, text);
        await dequeue(request, headers, sent.messageId, sent.ownerSessionId);
        await expect(page.locator("#thinking-indicator")).toHaveCount(1);

        frames.drop = true;
        const streamed = await request.post("/api/stream", {
          headers,
          data: { messageId: sent.messageId, conversationId: sent.conversationId, text: streamText, mode: "agent", done: false },
        });
        expect(streamed.ok()).toBeTruthy();
        await expect.poll(() => frames.dropped).toBeGreaterThan(0);
        frames.drop = false;
        await expect(page.locator("#thinking-stream")).toContainText(streamText);
      } finally {
        await finish(request, headers, sent);
        for (const conversation of [first, last]) {
          await request.delete(`/api/conversation/${conversation.conversationId}`, { headers }).catch(() => {});
        }
      }
    });
  });
}
