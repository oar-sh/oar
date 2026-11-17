import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { relayLogDir, relayToken } from "./e2e-env.mjs";
import { startRelayServer } from "./relay-server-harness.mjs";
import { readRelaySecretsFile, relaySecretsPath } from "../server/services/owner-secret-store.mjs";
import { mintAgentTokenWithKey } from "../shared/relay-credentials.mjs";

// The worker log view, against the shared e2e relay. No worker runs (CLI
// spawn is disabled there): the spec writes the conversation's log file
// itself, where the relay's workers would (relayLogDir(), named after the
// conversation's SDK session), and appends to it, rolls it over, and puts
// credentials in it to drive the view.

// Credential-shaped values are put together at run time: the hygiene scan
// refuses token shapes in the source.
const fake = (...parts) => parts.join("");

async function startConversation(request, headers, text) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text, relayMode: "autopilot", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  return String((await queued.json())?.conversationId || "");
}

// Where the relay looks for the conversation's log (the route says).
async function logPathOf(request, headers, conversationId) {
  const answer = await request.get(`/api/conversation/${encodeURIComponent(conversationId)}/worker-log`, { headers });
  expect(answer.ok()).toBeTruthy();
  const body = await answer.json();
  expect(body.dir).toBe(relayLogDir());
  expect(body.path, "the conversation names its log file").toBeTruthy();
  return String(body.path);
}

async function openApp(page, token, conversationId) {
  await page.addInitScript((id) => localStorage.setItem("copilot_last_conv", id), conversationId);
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("#startup-loading")).toHaveCount(0);
}

async function openWorkerLog(page) {
  await page.locator("#chat-actions-menu-btn").click();
  const entry = page.locator("#chat-menu-worker-log");
  await expect(entry).toBeVisible();
  await expect(entry).toHaveText("📜 Worker log");
  await entry.click();
  await expect(page.locator("#worker-log-modal")).toHaveClass(/visible/);
  await expect(page.locator("#chat-actions-menu")).toBeHidden();
}

function numberedLines(count, label) {
  const lines = [];
  for (let index = 1; index <= count; index += 1) lines.push(`[claude 2026-11-15T09:00:00.000Z] ${label} ${String(index).padStart(4, "0")}`);
  return `${lines.join("\n")}\n`;
}

test.describe("worker log view", () => {
  test("no log yet, then a long log: tail, live lines, Jump to end, Load earlier, Escape, a switch from the Inbox", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const conversationId = await startConversation(request, headers, `Read the worker log ${stamp}`);
    const logPath = await logPathOf(request, headers, conversationId);
    fs.rmSync(logPath, { force: true });
    try {
      await openApp(page, token, conversationId);
      await openWorkerLog(page);

      // 1. No log yet: the view says so and names where the log will be.
      const status = page.locator("#worker-log-status");
      await expect(status).toContainText("No worker log yet");
      await expect(page.locator("#worker-log-path")).toContainText(relayLogDir());

      // The file appears while the view is open: its lines come live.
      fs.writeFileSync(logPath, `[claude ${new Date().toISOString()}] worker started ${stamp}\n`);
      const body = page.locator("#worker-log-body");
      await expect(body).toContainText(`worker started ${stamp}`, { timeout: 10_000 });
      await expect(status).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(page.locator("#worker-log-modal")).not.toHaveClass(/visible/);

      // 2. 2,600 lines: the last 2,000, then Load earlier brings the first.
      fs.writeFileSync(logPath, numberedLines(2600, "turn line"));
      await openWorkerLog(page);
      await expect(body).toContainText("turn line 2600");
      await expect(body.locator(".tc-line")).toHaveCount(2000);
      await expect(body).not.toContainText("turn line 0600");
      await expect(body.locator(".tc-line").first()).toContainText("turn line 0601");
      await expect(page.locator("#worker-log-path")).toHaveText(logPath);
      await expect(page.locator("#worker-log-meta")).toContainText("last write");
      const earlier = page.locator("#worker-log-earlier");
      await expect(earlier).toBeVisible();
      await earlier.click();
      await expect(body.locator(".tc-line").first()).toContainText("turn line 0001");
      await expect(body.locator(".tc-line")).toHaveCount(2600);
      await expect(earlier).toBeHidden();

      // 3. Appended lines arrive without a reload; scrolled up, Jump to end shows.
      fs.appendFileSync(logPath, `[claude] live line one ${stamp}\n`);
      await expect(body).toContainText(`live line one ${stamp}`, { timeout: 10_000 });
      await page.locator("#worker-log-scroll").evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
      fs.appendFileSync(logPath, `[claude] live line two ${stamp}\n`);
      await expect(body).toContainText(`live line two ${stamp}`, { timeout: 10_000 });
      const jump = page.locator("#worker-log-jump");
      await expect(jump).toBeVisible();
      await jump.click();
      await expect(jump).toBeHidden();

      // 6. Opening the Inbox (no conversation open, inbox-ui.js) closes it, and
      // its room: nothing more arrives for it.
      await page.evaluate(() => window.toggleInboxView());
      await expect(page.locator("#worker-log-modal")).not.toHaveClass(/visible/);
      await expect(page.locator("#worker-log-body .tc-line")).toHaveCount(0);
    } finally {
      fs.rmSync(logPath, { force: true });
    }
  });

  test("credentials never reach the page, and a log rolled over at a relaunch resets the view", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const conversationId = await startConversation(request, headers, `Scrub the worker log ${stamp}`);
    const logPath = await logPathOf(request, headers, conversationId);
    const anthropicKey = fake("sk-", "ant-", "api03-", "Qw3rTy7uIoP1aSdFgHjK", String(stamp));
    const bearerValue = fake("ya29", ".a0AfB", "_byC9xQ", String(stamp));
    const cookieValue = fake("Qm9i", "Q29va2ll", String(stamp));
    const agentToken = fake("oar", "a1_", "s.", "Y29udi0x", ".", "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFi", String(stamp));
    const raw = [anthropicKey, bearerValue, cookieValue, agentToken];
    fs.writeFileSync(logPath, [
      `[claude ${new Date().toISOString()}] provider error: invalid x-api-key ${anthropicKey}`,
      `[grok] request headers: Authorization: Bearer ${bearerValue}`,
      "",
    ].join("\n"));

    // Everything the page receives: the route's JSON and every socket frame.
    const received = [];
    const chunkFrames = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", (frame) => {
        const text = String(frame.payload || "");
        received.push(text);
        if (text.includes("worker_log_chunk")) chunkFrames.push(text);
      });
    });
    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("/worker-log") && !url.includes("/socket.io/")) return;
      try {
        const text = await response.text();
        received.push(text);
        if (text.includes("worker_log_chunk")) chunkFrames.push(text);
      } catch {}
    });
    try {
      await openApp(page, token, conversationId);
      await openWorkerLog(page);
      const body = page.locator("#worker-log-body");
      await expect(body).toContainText("x-api-key sk-[redacted]");
      await expect(body).toContainText("Authorization: Bearer [redacted]");

      // 4. Live: a cookie header and an agent token.
      fs.appendFileSync(logPath, `[grok] Cookie: sid=${cookieValue}; theme=dark\n[relay] 401 for ${agentToken}\n`);
      await expect(body).toContainText("Cookie: [redacted]", { timeout: 10_000 });
      await expect(body).toContainText("401 for oara1_[redacted]");
      await expect.poll(() => chunkFrames.length).toBeGreaterThan(0);
      const dom = await page.locator("#worker-log-modal").evaluate((node) => node.outerHTML);
      for (const value of raw) {
        expect(dom.includes(value), "the raw value is not in the DOM").toBe(false);
        expect(received.some((text) => text.includes(value)), "the raw value is in no response or frame").toBe(false);
      }
      expect(chunkFrames.some((text) => text.includes("[redacted]")), "the chunk carried the scrubbed form").toBe(true);

      // 5. Rotation: the file becomes .1 and a new one starts; the view resets.
      fs.renameSync(logPath, `${logPath}.1`);
      fs.writeFileSync(logPath, `[claude] relaunched ${stamp}\n`);
      await expect(body).toContainText(`relaunched ${stamp}`, { timeout: 10_000 });
      await expect(body).not.toContainText("x-api-key");
      await expect(page.locator("#worker-log-meta")).toContainText(`${path.basename(logPath)}.1`);
    } finally {
      fs.rmSync(logPath, { force: true });
      fs.rmSync(`${logPath}.1`, { force: true });
    }
  });

  // relay_tool read_worker_log, as a session's agent calls it: its own
  // conversation's log, scrubbed; never another's. With the agent sessions
  // setting off (its default): reading the own log needs no other session.
  test("an agent reads its own worker log with relay_tool read_worker_log, and only its own", async () => {
    const relay = await startRelayServer({ token: randomUUID() });
    try {
      const api = async (route, { method = "GET", body, token = relay.token } = {}) => {
        const response = await fetch(`${relay.baseUrl}${route}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: response.status, payload: await response.json().catch(() => null) };
      };
      expect((await api("/api/settings/agent-sessions")).payload?.enabled, "agent sessions are off").toBe(false);
      const start = async (text) => {
        const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "autopilot", model: "gpt-5.4-mini" } });
        expect(queued.status).toBe(200);
        return String(queued.payload?.conversationId || "");
      };
      const stamp = Date.now();
      const convA = await start(`Worker log reader A ${stamp}`);
      const convB = await start(`Worker log reader B ${stamp}`);
      const logOf = async (conversationId) => String((await api(`/api/conversation/${encodeURIComponent(conversationId)}/worker-log`)).payload?.path || "");
      const pathA = await logOf(convA);
      const pathB = await logOf(convB);
      expect(path.dirname(pathA)).toBe(path.join(relay.stateRoot, "logs"));
      const anthropicKey = fake("sk-", "ant-", "api03-", "Zx9cVb7nM4lK2jH8gF6d", String(stamp));
      fs.mkdirSync(path.dirname(pathA), { recursive: true });
      fs.writeFileSync(pathA, `[claude] conversation A line ${stamp}\n[claude] provider error: invalid x-api-key ${anthropicKey}\n`);
      fs.writeFileSync(pathB, `[claude] conversation B line ${stamp}\n`);

      // A session's agent token, as its worker gets it (OAR_AGENT_TOKEN). Never printed.
      const { secrets } = readRelaySecretsFile(relaySecretsPath(relay.dataDir));
      expect(Boolean(secrets?.agentKey), "the test relay has an agent key").toBe(true);
      const tokenOf = (conversationId) => mintAgentTokenWithKey(secrets.agentKey, { kind: "session", subject: conversationId });
      const readLog = (token, args = { relay: "this" }) => api("/api/remote-relays/tool", { method: "POST", token, body: { action: "read_worker_log", args } });

      const own = await readLog(tokenOf(convA));
      expect(own.status, JSON.stringify(own.payload)).toBe(200);
      const ownText = JSON.stringify(own.payload);
      expect(own.payload.tail).toContain(`[claude] conversation A line ${stamp}`);
      expect(own.payload.tail).toContain("[claude] provider error: invalid x-api-key sk-[redacted]");
      expect(ownText.includes(anthropicKey), "the key is not in the answer").toBe(false);
      expect(ownText.includes("conversation B line"), "nothing of the other conversation").toBe(false);
      expect(own.payload.log.path).toBe(pathA);

      // Another conversation's token reads that conversation's log, never A's.
      const other = await readLog(tokenOf(convB));
      expect(other.status).toBe(200);
      expect(other.payload.tail).toEqual([`[claude] conversation B line ${stamp}`]);
      // Naming A is refused, not ignored.
      const naming = await readLog(tokenOf(convB), { relay: "this", session: convA });
      expect(naming.status).toBe(400);
      expect(JSON.stringify(naming.payload).includes("conversation A line")).toBe(false);
      // The route itself, called with B's token for A: 403.
      const direct = await api(`/api/conversation/${encodeURIComponent(convA)}/worker-log`, { token: tokenOf(convB) });
      expect(direct.status).toBe(403);
      expect(direct.payload.code).toBe("AUTH_CONVERSATION_MISMATCH");
      // The cli token names a conversation but owns none: refused.
      const cliToken = mintAgentTokenWithKey(secrets.agentKey, { kind: "cli" });
      const cli = await api("/api/remote-relays/tool", { method: "POST", token: cliToken, body: { conversationId: convA, action: "read_worker_log", args: { relay: "this" } } });
      expect(cli.status, JSON.stringify(cli.payload)).toBe(403);
      expect([cli.payload.code, cli.payload.remoteCode]).toEqual(["REMOTE_RELAY_HTTP_403", "AUTH_PERSON_REQUIRED"]);
      expect(JSON.stringify(cli.payload).includes("conversation A line")).toBe(false);
    } finally {
      await relay.stop();
    }
  });

  test("the menu entry is absent in a shared view", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const conversationId = await startConversation(request, headers, `Share without the worker log ${Date.now()}`);
    const shared = await request.post(`/api/conversation/${encodeURIComponent(conversationId)}/share`, { headers });
    expect(shared.ok()).toBeTruthy();
    const shareToken = String((await shared.json()).token || "");
    expect(shareToken).toBeTruthy();
    try {
      await page.goto(`/shared/${shareToken}`);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("#chat-menu-worker-log")).toBeHidden();
      await page.evaluate(() => document.getElementById("chat-menu-worker-log")?.click());
      await expect(page.locator("#worker-log-modal")).not.toHaveClass(/visible/);
    } finally {
      await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}/share`, { headers }).catch(() => {});
    }
  });
});
