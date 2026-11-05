import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { relayDbPath, relayToken } from "./e2e-env.mjs";

// The live poll's diet, against the shared e2e relay. A busy window: six
// finished turns, each with 230 main-agent tool lines (the finished cap
// keeps 200 and marks the rest), 3 sub-agents × 50 lines and 8 thoughts,
// written into the test relay's database, and one running turn queued and
// taken off the queue (no CLI runs on the test server).
//
// Every 900 ms the page polls the conversation. Once it holds the finished
// replies, it names them (`heldDetails`) and the relay leaves their tool
// lines and thoughts out: the poll stays under 80 KB, where the same request
// without the param (what 9d145e4d sent every time) is over it. A finished
// turn renders the same after held polls as after the open load (stream
// view on). A tool line added to a held reply comes with the next poll. The
// "… N earlier tool lines omitted" row heads the turn's stream; with
// OAR_E2E_SCREENSHOT_DIR set it is shot on a phone, dark and light.

const SHOT_DIR = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim();
const POLL_BYTES_BOUND = 80 * 1024;
const TURNS = 6;
const MAIN_LINES = 230;
const SUBAGENT_LINES = 50;
const THOUGHTS = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dequeue(request, headers, messageId, ownerSessionId) {
  const dequeueHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const dequeued = await request.get("/api/pending", { headers: dequeueHeaders });
    expect(dequeued.ok()).toBeTruthy();
    const message = (await dequeued.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

// The worker's heartbeat while the turn runs: without it the CLI reads as
// offline after a while and the live bubble goes with it.
function keepWorkerAlive(request, headers, messageId) {
  const beat = () => request.post("/api/heartbeat", { headers, data: { activeQueueMessageId: messageId } }).catch(() => {});
  void beat();
  const timer = setInterval(beat, 2_000);
  return () => clearInterval(timer);
}

// Six finished turns before the running one, as a busy session leaves them.
function seedFinishedTurns(conversationId, stamp) {
  const db = new Database(relayDbPath());
  const base = Date.now() - 60 * 60 * 1000;
  const iso = (offset) => new Date(base + offset).toISOString();
  const replies = [];
  try {
    db.transaction(() => {
      for (let turn = 0; turn < TURNS; turn += 1) {
        const ask = `ask-${stamp}-${turn}`;
        const reply = `reply-${stamp}-${turn}`;
        replies.push(reply);
        const t0 = turn * 60_000;
        db.prepare(`INSERT INTO messages (id, conversation_id, role, text, mode, timestamp) VALUES (?, ?, 'user', ?, 'agent', ?)`)
          .run(ask, conversationId, `Step ${turn} of the widget cache plan`, iso(t0));
        db.prepare(`INSERT INTO messages (id, conversation_id, role, text, mode, timestamp, source_message_id) VALUES (?, ?, 'assistant', ?, 'agent', ?, ?)`)
          .run(reply, conversationId, `Step ${turn} done: the widget cache keeps ${turn + 2} entries.`, iso(t0 + 50_000), ask);
        db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, response_message_id) VALUES (?, ?, 'prompt', 'done', ?, ?)`)
          .run(ask, conversationId, iso(t0), reply);
        const activity = db.prepare(`INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, relay_mode, text, created_at, subagent_run_id, turn_seq) VALUES (?, ?, ?, 'agent', ?, ?, ?, ?)`);
        const thought = db.prepare(`INSERT INTO relay_thought (queue_message_id, response_message_id, conversation_id, relay_mode, reasoning_id, seq, text, done, created_at, turn_seq) VALUES (?, ?, ?, 'agent', ?, ?, ?, 1, ?, ?)`);
        let seq = 0;
        for (let n = 0; n < MAIN_LINES; n += 1) {
          // The thoughts come after the first 31 tool lines, so the row for
          // the 30 the cap leaves out heads the turn's stream.
          if (n > 30 && (n - 31) % 25 === 0 && (n - 31) / 25 < THOUGHTS) {
            seq += 1;
            thought.run(ask, reply, conversationId, `r-${turn}-${n}`, (n - 31) / 25 + 1, `Next: check widget file ${n} of step ${turn} for stale entries.`, iso(t0 + n), seq);
          }
          seq += 1;
          activity.run(ask, reply, conversationId, `Tool (view): src/widgets/step-${turn}/widget-${n}.js`, iso(t0 + n), null, seq);
        }
        for (let sub = 0; sub < 3; sub += 1) {
          for (let n = 0; n < SUBAGENT_LINES; n += 1) {
            seq += 1;
            activity.run(ask, reply, conversationId, `Tool (grep): widget-${turn}-${sub}-part-${n}`, iso(t0 + 1000 + n), `toolu_fixture_${stamp}_${turn}_${sub}`, seq);
          }
        }
      }
    })();
  } finally {
    db.close();
  }
  return replies;
}

test.describe("poll diet", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("held replies leave the poll; the turn renders the same; a late tool line comes through", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const queued = await request.post("/api/message", { headers, data: { text: `Wrap up the widget cache ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" } });
    expect(queued.ok()).toBeTruthy();
    const body = await queued.json();
    const conversationId = String(body.conversationId);
    const messageId = String(body.messageId);
    await dequeue(request, headers, messageId, String(body?.ownerSessionId || ""));
    const replies = seedFinishedTurns(conversationId, stamp);
    const stopBeating = keepWorkerAlive(request, headers, messageId);

    try {
      expect((await request.post("/api/activity", { headers, data: { messageId, conversationId, mode: "agent", text: "Tool (view): src/widgets/index.js" } })).ok()).toBeTruthy();

      const isPoll = (response) => response.url().includes(`/api/conversation/${conversationId}?`);
      const isHeldPoll = (response) => isPoll(response) && response.url().includes("heldDetails=");
      await page.addInitScript((id) => {
        window.localStorage.setItem("copilot_last_conv", id);
        window.localStorage.setItem("copilot_stream_view", "1");
      }, conversationId);
      await page.goto(`/?token=${encodeURIComponent(token)}`);
      await page.waitForFunction(() => typeof window.openConversation === "function");
      await expect(page.locator("#cli-dot")).toHaveClass("online");
      await expect(page.locator("#thinking-indicator")).toBeVisible();

      const turn = page.locator(`.msg.assistant[data-message-id="${replies[3]}"]`);
      await expect(turn.locator(".msg-turn-stream")).toBeVisible();
      await expect(turn.locator(".msg-stream-omitted")).toHaveText("… 30 earlier tool lines omitted");
      const snapshot = () => turn.evaluate((node) => node.querySelector(".msg-bubble").innerHTML);
      const opened = await snapshot();

      // Three polls that name the held replies.
      let lastHeld = null;
      for (let i = 0; i < 3; i += 1) lastHeld = await page.waitForResponse(isHeldPoll);
      const url = new URL(lastHeld.url());
      expect(url.searchParams.get("heldDetails").split(",").length).toBe(TURNS);
      const heldBytes = Buffer.byteLength(await lastHeld.body());
      // The same request as 9d145e4d made it: no heldDetails.
      url.searchParams.delete("heldDetails");
      const fullBytes = Buffer.byteLength(await (await request.get(`${url.pathname}${url.search}`, { headers })).body());
      console.log(`poll with held replies: ${heldBytes} bytes; the same window in full: ${fullBytes} bytes`);
      expect(heldBytes).toBeLessThan(POLL_BYTES_BOUND);
      expect(fullBytes).toBeGreaterThan(POLL_BYTES_BOUND);

      // The finished turn reads the same as after the open load.
      expect(await snapshot()).toBe(opened);

      // Switching the view after held polls redraws the turns whole from the
      // kept window, which must hold what the store gave back. Read in the
      // same tick as the switch: the next poll would redraw them anyway.
      const toggled = await page.evaluate((id) => {
        const bubble = () => document.querySelector(`.msg.assistant[data-message-id="${id}"] .msg-bubble`);
        window.updateStreamViewSetting(false);
        const grouped = {
          stream: !!bubble().querySelector(".msg-turn-stream"),
          tools: bubble().querySelector("details.msg-activity > summary")?.textContent.trim() || "",
          thoughts: bubble().querySelector(".msg-thoughts > summary")?.textContent.trim() || "",
        };
        window.updateStreamViewSetting(true);
        return { grouped, stream: bubble().innerHTML };
      }, replies[3]);
      expect(toggled.grouped).toEqual({ stream: false, tools: "🔧 Tool activity (200)", thoughts: `💭 Thoughts (${THOUGHTS})` });
      expect(toggled.stream).toBe(opened);

      // A tool line lands on a held reply after the turn: the next poll
      // brings that reply in full and the line shows.
      const db = new Database(relayDbPath());
      try {
        const row = db.prepare("SELECT queue_message_id AS ask, MAX(turn_seq) AS seq FROM relay_activity WHERE response_message_id = ?").get(replies[3]);
        db.prepare("INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, relay_mode, text, created_at, turn_seq) VALUES (?, ?, ?, 'agent', ?, ?, ?)")
          .run(row.ask, replies[3], conversationId, `Tool (view): src/widgets/late-${stamp}.js`, new Date().toISOString(), row.seq + 1);
      } finally {
        db.close();
      }
      await expect(turn.locator(".msg-stream-tool").last()).toContainText(`late-${stamp}.js`, { timeout: 10_000 });
      await expect(turn.locator(".msg-stream-omitted")).toHaveText("… 31 earlier tool lines omitted");

      // The row for the lines the cap left out heads the turn's stream.
      const first = turn.locator(".msg-turn-stream > :first-child");
      await expect(first).toHaveClass(/msg-stream-omitted/);
      await expect(first).toHaveText("… 31 earlier tool lines omitted");
      if (SHOT_DIR) {
        // On a phone the page opens with the sidebar closed.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await expect(page.locator("#cli-dot")).toHaveClass("online");
        await expect(first).toHaveText("… 31 earlier tool lines omitted");
        for (const theme of ["dark", "light"]) {
          await page.evaluate((value) => {
            window.updateTheme(value);
            const select = document.getElementById("theme-select");
            if (select) select.value = value;
          }, theme);
          await turn.evaluate((node) => node.scrollIntoView({ block: "start" }));
          await page.screenshot({ path: `${SHOT_DIR}/finished-stream-omitted-phone-${theme}.png` });
        }
        await page.evaluate(() => window.updateTheme("dark"));
      }
    } finally {
      stopBeating();
      await request.post("/api/response", { headers, data: { messageId, conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" } }).catch(() => {});
    }
  });
});
