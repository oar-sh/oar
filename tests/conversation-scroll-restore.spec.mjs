import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

/**
 * A reader who loaded older pages of a long conversation and scrolled back
 * into them, then switched to another conversation and back, finds the
 * conversation as they left it: the same rows loaded and the same message at
 * the top of the view. After a reload the same message is back at the top,
 * in a window around it. A reader at the end comes back to the end, with
 * what was written meanwhile.
 *
 * The isolated server runs no CLI, so the turns are dequeued rows answered by
 * the spec in the worker's place.
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
    data: { sdk_session_id: `pw-sid-scroll-${stamp}-${conversationId.slice(0, 8)}`, conversation_id: conversationId },
  });
  expect(synced.ok()).toBeTruthy();
  const responded = await request.post("/api/response", {
    headers,
    data: { messageId, conversationId, text: `${title} first reply`, model: "gpt-5.4-mini", mode: "agent" },
  });
  expect(responded.ok()).toBeTruthy();
  return { conversationId, title: `${title} ${stamp}` };
}

async function addTurn(request, headers, conversationId, text, reply) {
  const queued = await request.post("/api/message", {
    headers,
    data: { conversationId, text, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const { messageId } = await queued.json();
  const responded = await request.post("/api/response", {
    headers,
    data: { messageId, conversationId, text: reply, model: "gpt-5.4-mini", mode: "agent" },
  });
  expect(responded.ok()).toBeTruthy();
}

const FILLER = "The trellis needs another coat of linseed oil before the frost, and the twine on the bean poles has frayed where the wind rubs it against the fence. ";

function replyText(index, stamp) {
  const long = index % 3 === 0;
  return `Garden note ${index} ${stamp}. ${long ? FILLER.repeat(6) : "Short answer."}`;
}

const row = (page, id) => page.locator(`#conv-list .conv-item[data-conversation-id="${id}"]`);
const bubble = (page, text) => page.locator("#messages .msg", { hasText: text });

// What the page shows right now, measured in the transcript.
async function snapshot(page) {
  return page.evaluate(() => {
    const el = document.getElementById("messages");
    const box = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll(".msg[data-message-id]")];
    const top = rows.find((node) => node.getBoundingClientRect().bottom > box.top + 1) || null;
    return {
      rowCount: rows.length,
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      topId: top?.dataset.messageId || null,
      topOffset: top ? Math.round(top.getBoundingClientRect().top - box.top) : null,
      hasLoadMore: !!document.getElementById("history-load-more"),
      distanceFromBottom: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
      jumpButtonVisible: !!document.getElementById("jump-to-bottom-btn")?.classList.contains("visible"),
    };
  });
}

async function offsetOf(page, messageId) {
  return page.evaluate((mid) => {
    const el = document.getElementById("messages");
    const node = el.querySelector(`.msg[data-message-id="${CSS.escape(mid)}"]`);
    if (!node) return null;
    return Math.round(node.getBoundingClientRect().top - el.getBoundingClientRect().top);
  }, messageId);
}

test.use({ viewport: { width: 1280, height: 800 } });

// Sets "Messages kept per conversation for switching back" in Settings.
async function setRetention(page, value) {
  await page.evaluate(() => window.openSettingsModal("general"));
  const slider = page.locator("#conversation-window-retention-slider");
  await expect(slider).toBeVisible();
  await slider.evaluate((node, next) => {
    node.value = String(next);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await expect(page.locator("#conversation-window-retention-value")).toHaveText(`${value} messages`);
  await page.evaluate(() => window.closeSettingsModal());
}

// The control's own handler, called where it is: a click would first scroll
// the control (at the top of the transcript) into view.
async function loadOlderOnce(page) {
  const current = await snapshot(page);
  await page.evaluate(() => window.loadOlderConversationMessages());
  await expect.poll(async () => (await snapshot(page)).rowCount).toBeGreaterThan(current.rowCount);
  await sleep(500);
}

async function runScenario({ page, request }, {
  name,
  turns,
  minLoaded = 0,
  addWhileAway = 0,
  targetIndex = 11,
  mode = "switch",
  retention = null,
  stayAtTail = false,
}) {
  test.setTimeout(240_000);
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = `scroll-${name}-${Date.now()}`;
  const long = await seedConversation(request, headers, "Sketch the allotment rota", stamp);
  const short = await seedConversation(request, headers, "Price the greenhouse panes", stamp);
  // The measured offsets, for the test report.
  const report = (line) => console.log(`[scroll-restore:${name}] ${line}`);
  try {
    for (let index = 1; index <= turns; index += 1) {
      await addTurn(request, headers, long.conversationId, `Question ${index} about the rota ${stamp}`, replyText(index, stamp));
    }
    const longNewest = `Garden note ${turns} ${stamp}`;
    const shortNewest = `Panes cost less in spring ${stamp}`;
    await addTurn(request, headers, short.conversationId, `What do panes cost ${stamp}`, shortNewest);

    await page.addInitScript((id) => {
      localStorage.setItem("copilot_last_conv", id);
    }, long.conversationId);

    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await expect(page.locator("#cli-dot")).toHaveClass("online");
    await expect(page.locator("#chat-title")).toHaveText(long.title);
    await expect(bubble(page, longNewest)).toBeVisible();
    await sleep(500);
    if (retention) await setRetention(page, retention);

    if (stayAtTail) {
      const left = await snapshot(page);
      expect(left.distanceFromBottom).toBeLessThanOrEqual(4);
      await row(page, short.conversationId).click();
      await expect(page.locator("#chat-title")).toHaveText(short.title);
      await expect(bubble(page, shortNewest)).toBeVisible();
      for (let index = 1; index <= addWhileAway; index += 1) {
        await addTurn(request, headers, long.conversationId, `Later question ${index} ${stamp}`, `Later note ${index} ${stamp}`);
      }
      await sleep(800);
      await row(page, long.conversationId).click();
      await expect(page.locator("#chat-title")).toHaveText(long.title);
      await expect(bubble(page, `Later note ${addWhileAway} ${stamp}`)).toBeVisible();
      await sleep(1000);
      const back = await snapshot(page);
      report(`back at the end: ${back.distanceFromBottom}px from the bottom, ${back.rowCount} rows (left ${left.rowCount})`);
      expect(back.distanceFromBottom, "back at the end").toBeLessThanOrEqual(4);
      expect(back.rowCount, "the rows written meanwhile joined").toBe(left.rowCount + addWhileAway * 2);
      await expect(bubble(page, longNewest)).toBeAttached();
      return;
    }

    for (let pass = 1; pass <= 8; pass += 1) {
      const current = await snapshot(page);
      if (pass > 2 && current.rowCount >= minLoaded) break;
      if (!current.hasLoadMore) break;
      await page.locator("#history-load-more button").click();
      await expect.poll(async () => (await snapshot(page)).rowCount).toBeGreaterThan(current.rowCount);
      await sleep(500);
    }

    // Read an old message: a row near the top of the loaded window at the
    // top of the view, far enough down that the loader fetches no more.
    const target = await page.evaluate((index) => {
      const el = document.getElementById("messages");
      const rows = [...el.querySelectorAll(".msg[data-message-id]")];
      const node = rows[index];
      el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top;
      return node.dataset.messageId;
    }, targetIndex);
    await sleep(800);
    const left = await snapshot(page);
    const targetOffsetLeft = await offsetOf(page, target);

    if (mode === "reload") {
      await page.reload();
      await page.waitForFunction(() => typeof window.openConversation === "function");
      await expect(page.locator("#chat-title")).toHaveText(long.title);
      await expect(page.locator(`#messages .msg[data-message-id="${target}"]`)).toBeAttached();
    } else {
      await row(page, short.conversationId).click();
      await expect(page.locator("#chat-title")).toHaveText(short.title);
      await expect(bubble(page, shortNewest)).toBeVisible();
      for (let index = 1; index <= addWhileAway; index += 1) {
        await addTurn(request, headers, long.conversationId, `Later question ${index} ${stamp}`, `Later note ${index} ${stamp}`);
      }
      await sleep(800);

      await row(page, long.conversationId).click();
      await expect(page.locator("#chat-title")).toHaveText(long.title);
      if (!retention) await expect(bubble(page, longNewest)).toBeAttached();
    }
    await sleep(1500);
    const back = await snapshot(page);
    const targetOffsetBack = await offsetOf(page, target);
    report(`message read at ${targetOffsetLeft}px when left, ${targetOffsetBack}px back; ${back.rowCount} rows (left ${left.rowCount})`);

    expect(targetOffsetBack, "the message read is still in the transcript").not.toBeNull();
    expect(Math.abs(targetOffsetBack - targetOffsetLeft), "the message read is where it was").toBeLessThanOrEqual(4);
    expect(back.topId).toBe(left.topId);
    if (mode === "reload") {
      // A window around the message read, with the way to the end.
      expect(back.jumpButtonVisible, "the jump-to-bottom button is there").toBe(true);
    } else if (retention) {
      expect(back.rowCount, "the kept rows").toBeGreaterThanOrEqual(Math.min(retention, left.rowCount));
    } else {
      expect(back.rowCount, "rows loaded after the switch back").toBeGreaterThanOrEqual(left.rowCount);
    }
    if (mode === "reload" || retention) {
      // An older page loads above the message read and leaves it in place.
      if ((await snapshot(page)).hasLoadMore) await loadOlderOnce(page);
      const afterOlder = await offsetOf(page, target);
      report(`message read at ${afterOlder}px after an older page`);
      expect(afterOlder).not.toBeNull();
      expect(Math.abs(afterOlder - targetOffsetLeft), "an older page keeps the message read in place").toBeLessThanOrEqual(4);
    }
  } finally {
    for (const conversation of [long, short]) {
      await request.delete(`/api/conversation/${conversation.conversationId}`, { headers }).catch(() => {});
    }
  }
}

test("older pages and the reading position survive a switch away and back", async ({ page, request }) => {
  await runScenario({ page, request }, { name: "basic", turns: 44 });
});

test("more than a hundred loaded rows survive a switch away and back", async ({ page, request }) => {
  await runScenario({ page, request }, { name: "over-100", turns: 74, minLoaded: 110 });
});

test("the reading position survives rows written while the reader was away", async ({ page, request }) => {
  await runScenario({ page, request }, { name: "written-away", turns: 44, addWhileAway: 3 });
});

test("after a reload the message read is back at its place, with the way to the end and older pages above", async ({ page, request }) => {
  await runScenario({ page, request }, { name: "reload", turns: 44, mode: "reload", targetIndex: 15 });
});

test("a reader at the end comes back to the end, with the rows written meanwhile", async ({ page, request }) => {
  await runScenario({ page, request }, { name: "at-tail", turns: 12, addWhileAway: 1, stayAtTail: true });
});

test("with a lower cap the kept rows around the message read still bring it back to its place", async ({ page, request }) => {
  await runScenario({ page, request }, { name: "retention", turns: 74, minLoaded: 120, retention: 100 });
});
