import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

import { resolveDatabaseFile } from "../server/services/database-file.mjs";
import { repoRoot, startRelayServer } from "./relay-server-harness.mjs";

/**
 * The queued first chat with a fake store: the first Claude chat on a relay
 * whose Claude Agent SDK is not installed yet.
 *
 * The launch gate never makes the chat wait: the new chat and the send answer
 * at once, the conversation gets the "Installing the Claude Agent SDK" note,
 * and the message stays queued. When the install ends the session gets its
 * launch back, the worker starts from the store's folder, the note becomes
 * the "started" note and the message is delivered.
 *
 * Fakes, and nothing else:
 *  - the store's `npm ci` is the stub installer
 *    (server/services/fixtures/agent-sdk-install-stub), stalling a few
 *    seconds, into a scratch store inside this relay's state root;
 *  - the Claude worker is a stand-in (tests/fixtures/claude-stand-in-session-
 *    worker.mjs), launched by the relay through
 *    COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH the way it launches the real one. It
 *    records the SDK folder it was launched with and answers each delivered
 *    message with a canned reply over the real worker contracts (socket,
 *    heartbeat, /api/response). It loads no SDK: the stub installs package.json
 *    files only, and no model is asked.
 *
 * Its own relay: worker launches allowed, session-worker routing on (the
 * shared relay has neither), the port and token in its config.json (where a
 * worker finds its relay), and tmux, where the host has it, on a socket
 * directory of its own that is killed afterwards.
 *
 * The Claude provider is switched on by writing its settings rows, as the
 * other Claude specs do: the Settings save would start the SDK install by
 * itself (a provider set up installs its SDK) before the first chat could
 * meet the gate.
 */

const fixtures = path.join(repoRoot, "server", "services", "fixtures");
const standInWorker = path.join(repoRoot, "tests", "fixtures", "claude-stand-in-session-worker.mjs");
const CLAUDE_PIN = JSON.parse(fs.readFileSync(path.join(repoRoot, "server", "agent-sdks", "claude", "pin.json"), "utf8"));
const CLAUDE_PINNED = CLAUDE_PIN.dependencies["@anthropic-ai/claude-agent-sdk"];

const MODEL = "claude-opus-5";
const CLAUDE_SETTINGS = {
  claude_enabled: "true",
  claude_model: MODEL,
  claude_models: JSON.stringify([MODEL]),
  claude_model_efforts: JSON.stringify({ [MODEL]: ["low", "medium", "high"] }),
};

const INSTALLING_NOTE = "⏳ Installing the Claude Agent SDK on the relay host, once for this version. Your message is delivered when it is ready.";
const STARTED_NOTE = /✅ The worker for this conversation started at \d\d:\d\d UTC\. The queued message is being delivered\./;
const PROMPT = "Sort the lantern harbour field notes by tide height.";
const REPLY = `Stand-in worker reply: ${PROMPT}`;
// How long the stub installer stalls: long enough to open the chat and send
// while the store is still installing.
const STUB_STALL_SECONDS = 12;
// The install, a worker launch (on Windows a console start and a process
// list read) and one delivery, on a loaded machine.
const LAUNCH_TIMEOUT = 90_000;

test.describe.serial("the queued first chat with a fake store", () => {
  test.describe.configure({ timeout: 240_000 });

  let relay = null;
  let tmuxDir = "";

  const recordsDir = () => path.join(relay.stateRoot, "worker-records");
  const readRecords = () => (fs.existsSync(recordsDir())
    ? fs.readdirSync(recordsDir()).filter((name) => name.endsWith(".json")).map((name) => {
      try { return JSON.parse(fs.readFileSync(path.join(recordsDir(), name), "utf8")); } catch { return null; }
    }).filter(Boolean)
    : []);

  async function relayApi(method, route, body) {
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let parsed = null;
    try { parsed = await response.json(); } catch {}
    return { status: response.status, body: parsed };
  }

  const claudeSdkStatus = async () => (await relayApi("GET", "/api/agent-sdks/status")).body?.sdks?.claude || null;

  function seedClaudeSettings() {
    const db = new Database(resolveDatabaseFile(relay.dataDir).path);
    try {
      const now = new Date().toISOString();
      const upsert = db.prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `);
      for (const [key, value] of Object.entries(CLAUDE_SETTINGS)) upsert.run(key, value, now);
    } finally {
      db.close();
    }
  }

  function killOwnTmuxServer() {
    if (!tmuxDir) return;
    try {
      execFileSync("tmux", ["kill-server"], { stdio: "ignore", env: { ...process.env, TMUX_TMPDIR: tmuxDir, TMUX: "" } });
    } catch {
      // No server (no worker was launched in tmux, or no tmux on this host).
    }
  }

  test.beforeAll(async () => {
    // host-platform: the store and the relay spawn the launcher this host's OS can run.
    const stubExt = process.platform === "win32" ? ".cmd" : ".sh"; // host-platform: launcher per OS
    relay = await startRelayServer({
      token: randomUUID(),
      allowCli: true,
      persistWorkerConfig: true,
      overrides: ({ stateRoot }) => {
        tmuxDir = path.join(stateRoot, "tmux");
        fs.mkdirSync(tmuxDir, { recursive: true, mode: 0o700 });
        return {
          COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED: "1",
          COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH: standInWorker,
          COPILOT_WEB_RELAY_AGENT_SDK_INSTALL_COMMAND: path.join(fixtures, `agent-sdk-install-stub${stubExt}`),
          OAR_SDK_DIR: path.join(stateRoot, "sdks"),
          // This checkout's devDependencies must not stand in for the store.
          OAR_AGENT_SDK_SOURCE: "store",
          AGENT_SDK_STUB_SLEEP: String(STUB_STALL_SECONDS),
          TMUX_TMPDIR: tmuxDir,
          // Not a tmux pane of whoever started the suite.
          TMUX: "",
          TMUX_PANE: "",
        };
      },
    });
    seedClaudeSettings();
  });

  test.afterAll(async () => {
    if (relay) {
      // Deleting a conversation stops its worker; the records name any left.
      const listed = await relayApi("GET", "/api/conversations").catch(() => null);
      const conversations = Array.isArray(listed?.body) ? listed.body : (listed?.body?.conversations || []);
      for (const conversation of conversations) {
        await relayApi("DELETE", `/api/conversation/${encodeURIComponent(conversation.id)}`).catch(() => {});
      }
      for (const record of readRecords()) {
        try { process.kill(record.pid); } catch {}
      }
    }
    killOwnTmuxServer();
    if (relay) await relay.stop();
    relay = null;
  });

  test("the chat opens at once, says the SDK installs, and the message is answered from the store's folder", async ({ page }) => {
    // Nothing installed it at start: no Claude chat or setup existed then.
    expect((await claudeSdkStatus())?.state).toBe("missing");

    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");

    // New Chat → Claude.
    await expect(page.locator("#new-conv-btn")).toBeEnabled();
    await page.locator("#new-conv-btn").click();
    await expect(page.locator("#new-conversation-model-modal")).toHaveClass(/visible/);
    await page.locator("#new-conversation-provider-select").selectOption("claude");
    await page.locator("#new-conversation-model-select").selectOption(MODEL);
    const bootstrapped = page.waitForResponse((response) => response.url().endsWith("/api/conversation/bootstrap")
      && response.request().method() === "POST");
    await page.locator("#new-conversation-model-confirm").click();
    const bootstrap = await bootstrapped;
    const bootstrapBody = await bootstrap.json();
    // Answered at once and without an error: the gate deferred the launch.
    expect(bootstrap.status(), JSON.stringify(bootstrapBody)).toBe(200);
    expect(bootstrapBody.ok).toBe(true);
    expect(bootstrapBody.selectedProviderType).toBe("claude");
    const conversationId = String(bootstrapBody.conversationId || "");
    expect(conversationId).toBeTruthy();
    expect(bootstrapBody.ownerSessionId).toBe(conversationId);

    await expect(page.locator("#new-conversation-model-modal")).not.toHaveClass(/visible/);
    await expect(page.locator(`.conv-item.active[onclick*="${conversationId}"]`)).toHaveCount(1);
    await expect(page.locator("#relay-toast.visible")).toHaveCount(0);

    // The note, in the open conversation.
    const note = page.locator(".msg.assistant.msg-worker-launch");
    await expect(note).toHaveCount(1);
    await expect(note).toHaveClass(/msg-worker-launch-installing/);
    await expect(note.locator(".msg-bubble")).toContainText(INSTALLING_NOTE);
    const noteId = await note.getAttribute("data-message-id");
    expect(noteId).toBeTruthy();

    // The first message, sent while the SDK still installs: accepted at once
    // and queued, no worker yet.
    await page.fill("#msg-input", PROMPT);
    await expect(page.locator("#send-btn")).toBeEnabled();
    const sent = page.waitForResponse((response) => response.url().endsWith("/api/message")
      && response.request().method() === "POST");
    await page.click("#send-btn");
    const send = await sent;
    expect(send.status(), await send.text()).toBe(200);
    await expect(page.locator(".msg.user", { hasText: PROMPT })).toBeVisible();
    await expect(page.locator("#relay-toast.visible")).toHaveCount(0);
    expect((await claudeSdkStatus())?.state, "the stub installer is still stalling").toBe("installing");
    expect(readRecords(), "no worker launched before the SDK is ready").toEqual([]);
    await expect(page.locator(".msg.assistant", { hasText: REPLY })).toHaveCount(0);

    // The install ends: the same note turns into the started note ...
    const started = page.locator(`.msg.assistant.msg-worker-launch-started[data-message-id="${noteId}"]`);
    await expect(started).toHaveCount(1, { timeout: LAUNCH_TIMEOUT });
    await expect(started.locator(".msg-bubble")).toContainText(STARTED_NOTE);
    await expect(page.locator(".msg.msg-worker-launch-installing")).toHaveCount(0);

    // ... and the queued message is answered by the worker.
    await expect(page.locator(".msg.assistant", { hasText: REPLY }).last()).toBeVisible({ timeout: LAUNCH_TIMEOUT });

    // The store holds the pinned version, in its versioned folder in the
    // scratch store, with its marker.
    const sdk = await claudeSdkStatus();
    expect(sdk?.state).toBe("ready");
    expect(sdk?.installed).toBe(CLAUDE_PINNED);
    expect(path.dirname(path.dirname(sdk.dir))).toBe(path.join(relay.stateRoot, "sdks"));
    expect(fs.existsSync(path.join(sdk.dir, "oar-sdk.json"))).toBe(true);

    // One worker, launched for this conversation as a Claude worker, with the
    // store's folder in OAR_AGENT_SDK_DIR_CLAUDE; it answered the message.
    const records = readRecords();
    expect(records, JSON.stringify(records)).toHaveLength(1);
    const [record] = records;
    expect(record.sessionId).toBe(conversationId);
    expect(record.kind).toBe("claude");
    expect(record.sdkDir && path.resolve(record.sdkDir)).toBe(path.resolve(sdk.dir));
    expect(record.sdkEntryPresent).toBe(true);
    expect(record.sdkMarkerPresent).toBe(true);
    expect(record.replies.map((reply) => reply.text)).toEqual([REPLY]);
  });
});
