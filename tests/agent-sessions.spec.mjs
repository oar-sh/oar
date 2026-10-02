import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  FAKE_CLOUD_ENVIRONMENTS,
  FAKE_CLOUD_SLOW_FIRST_LINE,
  FAKE_CLOUD_TOKEN,
  startFakeClaudeCloudApi,
} from "./fake-claude-cloud-api.mjs";
import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * Agent sessions: an agent creates and drives sessions on its OWN relay with
 * the `remote_relay` tool (the "local target", named by the relay's name or
 * `this`), behind the setting "Agents may start and use sessions on this
 * relay".
 *
 * No model runs here. The spec calls POST /api/remote-relays/tool the way a
 * worker's tool adapter does, with the id of the conversation the "agent" runs
 * in, and plays the user where the relay asks for one (the approval card).
 *
 * Two relays, both the spec's own (the shared e2e relay keeps its settings):
 *
 *  - a plain one, as the shared relay is configured: no worker ever starts, so
 *    a created session's first turn stays queued. That is what the cap counts,
 *    and it makes the fifth concurrent create deterministic;
 *  - one that really launches Claude Cloud workers against the fake API of
 *    tests/claude-cloud.spec.mjs (same setup: routing on, a tmux server of its
 *    own), for a `claude-cloud` create with `repo` and `branch`.
 *
 * The approval card needs a turn to sit on. On the plain relay the spec takes
 * the orchestrating conversation's message off the queue as a worker would
 * (GET /api/pending); on the cloud relay the orchestrating conversation is a
 * cloud chat whose turn the fake keeps open ("slow").
 */

const SETTINGS_SHAPE = {
  limits: { minWaitSeconds: 120, maxWaitSeconds: 3600, stepSeconds: 60 },
  maxActiveSessions: 4,
};
const APPROVAL_TIMEOUT = 20_000;

function createApi(getRelay) {
  return async function api(route, { method = "GET", body, headers = {} } = {}) {
    const relay = getRelay();
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  };
}

function createToolCaller(api) {
  return (conversationId, action, args = {}) => api("/api/remote-relays/tool", {
    method: "POST",
    body: { conversationId, action, args },
  });
}

/** The pending approval card of a conversation, once the relay has raised it. */
async function waitForApprovalCard(api, conversationId) {
  const deadline = Date.now() + APPROVAL_TIMEOUT;
  while (Date.now() < deadline) {
    const { payload } = await api(`/api/relay-questions?status=pending&conversationId=${encodeURIComponent(conversationId)}`);
    const card = (payload?.questions || []).find((question) => question?.context?.source === "remote_relay");
    if (card) return card;
    await sleep(150);
  }
  throw new Error(`No approval card appeared for conversation ${conversationId.slice(0, 8)}`);
}

async function pendingCards(api, conversationId) {
  const { payload } = await api(`/api/relay-questions?status=pending&conversationId=${encodeURIComponent(conversationId)}`);
  return payload?.questions || [];
}

/** What the user's click on the card sends. */
function answerCard(api, card, answer) {
  return api(`/api/relay-question/${encodeURIComponent(card.id)}/answer`, {
    method: "POST",
    body: { answer, ...(card.sdkSessionId ? { sdk_session_id: card.sdkSessionId } : {}) },
  });
}

test.describe.serial("agent sessions on this relay", () => {
  test.describe.configure({ timeout: 120_000 });

  let relay = null;
  const api = createApi(() => relay);
  const tool = createToolCaller(api);
  let orchestrator = "";
  let orchestratorTitle = "";
  const created = [];

  // A conversation whose first message a "worker" has taken: its turn is
  // processing, as it is while an agent's tool call arrives. Called while no
  // other message is queued on this relay, so the dequeue can only return it.
  async function conversationWithRunningTurn(text) {
    const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    const { conversationId, messageId, ownerSessionId } = queued.payload;
    const synced = await api("/api/session-sync", {
      method: "POST",
      body: { sdk_session_id: conversationId, conversation_id: conversationId },
    });
    expect(synced.status, JSON.stringify(synced.payload)).toBe(200);
    const headers = ownerSessionId ? { "x-relay-session-id": String(ownerSessionId) } : {};
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const dequeued = await api("/api/pending", { headers });
      if (String(dequeued.payload?.message?.id || "") === messageId) return conversationId;
      await sleep(250);
    }
    throw new Error("The orchestrating conversation's message was never handed out");
  }

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
    const named = await api("/api/settings/pwa-app-name", { method: "POST", body: { appName: "win-test" } });
    expect(named.status).toBe(200);
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  test("with the setting off the tool is not registered and this relay is refused as a target", async () => {
    const settings = await api("/api/settings/agent-sessions");
    expect(settings.status).toBe(200);
    expect(settings.payload).toEqual({ enabled: false, maxWaitSeconds: 600, ...SETTINGS_SHAPE });

    // What a worker asks at start: nothing is paired and the local target is
    // off, so it leaves the tool out.
    const summary = await api("/api/remote-relays/summary");
    expect(summary.payload).toEqual({ count: 0, online: 0, localEnabled: false });

    orchestratorTitle = `report builder ${Date.now()}`;
    orchestrator = await conversationWithRunningTurn(orchestratorTitle);

    const listed = await tool(orchestrator, "list_relays");
    expect(listed.status).toBe(200);
    expect(listed.payload.relays).toEqual([]);
    for (const name of ["this", "win-test"]) {
      const refused = await tool(orchestrator, "create_session", { relay: name, text: "collect the numbers", wait_seconds: 0 });
      expect(refused.status, name).toBe(403);
      expect(refused.payload.code).toBe("REMOTE_RELAY_LOCAL_DISABLED");
      expect(refused.payload.error).toContain("Agents may start and use sessions on this relay");
      const read = await tool(orchestrator, "list_sessions", { relay: name });
      expect(read.status, name).toBe(403);
      expect(read.payload.code).toBe("REMOTE_RELAY_LOCAL_DISABLED");
    }
    expect(await pendingCards(api, orchestrator)).toEqual([]);
    const conversations = await api("/api/conversations");
    expect(conversations.payload.conversations.map((conversation) => conversation.id)).toEqual([orchestrator]);
  });

  test("the settings endpoint switches it on, validates and announces it, and the tool then lists this relay first", async ({ page }) => {
    for (const body of [{ enabled: "yes" }, { maxWaitSeconds: 60 }, { maxWaitSeconds: 4000 }, { maxWaitSeconds: 610 }]) {
      const refused = await api("/api/settings/agent-sessions", { method: "POST", body });
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(typeof refused.payload.error).toBe("string");
    }

    // A browser on this relay hears the change. The page is a bare document
    // of the relay (not the app), with a socket of its own.
    await page.goto(`${relay.baseUrl}/manifest.webmanifest`);
    await page.addScriptTag({ url: `${relay.baseUrl}/socket.io/socket.io.js` });
    await page.evaluate((token) => {
      window.agentSessionsEvents = [];
      window.agentSessionsSocket = window.io({ auth: { token }, forceNew: true });
      window.agentSessionsSocket.on("agent_sessions_settings_updated", (payload) => window.agentSessionsEvents.push(payload));
    }, relay.token);
    await page.waitForFunction(() => window.agentSessionsSocket.connected === true);

    const saved = await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true, maxWaitSeconds: 1800 } });
    expect(saved.status).toBe(200);
    expect(saved.payload).toEqual({ ok: true, enabled: true, maxWaitSeconds: 1800, ...SETTINGS_SHAPE });
    await expect.poll(() => page.evaluate(() => window.agentSessionsEvents)).toEqual([
      { enabled: true, maxWaitSeconds: 1800, ...SETTINGS_SHAPE },
    ]);
    await page.evaluate(() => window.agentSessionsSocket.close());
    expect((await api("/api/settings/agent-sessions")).payload).toEqual({ enabled: true, maxWaitSeconds: 1800, ...SETTINGS_SHAPE });
    expect((await api("/api/remote-relays/summary")).payload).toEqual({ count: 0, online: 0, localEnabled: true });

    const listed = await tool(orchestrator, "list_relays");
    expect(listed.status).toBe(200);
    expect(listed.payload.relays).toHaveLength(1);
    expect(listed.payload.relays[0]).toEqual({
      name: "win-test",
      self: true,
      online: true,
      version: expect.any(String),
      permission: "full",
      unlocked: true,
    });
    expect(listed.payload.limits).toEqual({ maxWaitSeconds: 1800, maxActiveSessions: 4 });

    // No mention was needed: the relay's own API answers through the tool.
    const info = await tool(orchestrator, "relay_info", { relay: "this" });
    expect(info.status, JSON.stringify(info.payload)).toBe(200);
    expect(info.payload.self).toBe(true);
    expect(info.payload.relay).toBe("win-test");
    const sessions = await tool(orchestrator, "list_sessions", { relay: "win-test" });
    expect(sessions.status).toBe(200);
    expect(sessions.payload.sessions.map((session) => session.id)).toEqual([orchestrator]);
  });

  test("the first create shows the approval card; Allow creates a session that carries the local origin", async () => {
    const prompt = "sidebar polish, part one: list the open work";
    const call = tool(orchestrator, "create_session", { relay: "this", text: prompt, title: "sidebar polish one", wait_seconds: 0 });

    const card = await waitForApprovalCard(api, orchestrator);
    expect(card.prompt).toContain("This agent wants to start sessions on this relay (github, the default folder). Sessions it starts use this relay's accounts.");
    expect(card.prompt).toContain(prompt);
    expect(card.choices).toEqual(["Allow", "Deny"]);
    expect(card.context.header).toBe("Agent sessions");
    // Nothing exists yet, and no agent can see or answer the card: not the one
    // that raised it, through the very tool it is waiting in.
    expect((await api("/api/conversations")).payload.conversations).toHaveLength(1);
    const selfAnswer = await tool(orchestrator, "answer_question", { relay: "this", question_id: card.id, choices: ["Allow"] });
    expect(selfAnswer.status).toBe(404);
    expect(selfAnswer.payload.code).toBe("REMOTE_RELAY_NOT_FOUND");
    expect((await pendingCards(api, orchestrator)).map((question) => question.id)).toEqual([card.id]);

    const answered = await answerCard(api, card, "Allow");
    expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
    const result = await call;
    expect(result.status, JSON.stringify(result.payload)).toBe(200);
    expect(result.payload).toEqual(expect.objectContaining({ ok: true, relay: "win-test", status: "queued", title: "sidebar polish one" }));
    const session = result.payload.session;
    expect(session).toBeTruthy();
    expect(session).not.toBe(orchestrator);
    created.push(session);

    // The detail payload, the list payload and the first message all say who
    // started it: an agent of this relay, in that conversation.
    const expectedOrigin = expect.objectContaining({
      local: true,
      conversationId: orchestrator,
      conversationTitle: orchestratorTitle,
      relayName: "win-test",
      hops: 0,
    });
    const detail = await api(`/api/conversation/${session}?limit=5`);
    expect(detail.status).toBe(200);
    expect(detail.payload.title).toBe("sidebar polish one");
    expect(detail.payload.origin).toEqual(expectedOrigin);
    expect(detail.payload.activeTurn).toBe(true);
    const stored = detail.payload.messages.find((message) => message.id === result.payload.message_id);
    expect(stored.origin).toEqual(expectedOrigin);
    expect(stored.text.startsWith('[Remote prompt from an agent on relay "win-test"')).toBe(true);
    expect(stored.text).toContain(prompt);
    const list = await api("/api/conversations");
    const row = list.payload.conversations.find((conversation) => conversation.id === session);
    expect(row.origin).toEqual(expectedOrigin);
    // The orchestrating conversation itself has no origin.
    expect(list.payload.conversations.find((conversation) => conversation.id === orchestrator).origin ?? null).toBeNull();

    // The agent finds it again, marked as its own.
    const sessions = await tool(orchestrator, "list_sessions", { relay: "this" });
    expect(sessions.payload.sessions.find((entry) => entry.id === session)).toEqual(
      expect.objectContaining({ createdBy: orchestrator, startedByYou: true, active: true }),
    );
    const read = await tool(orchestrator, "read_session", { relay: "this", session });
    expect(read.status).toBe(200);
    expect(read.payload.messages.map((message) => message.text)).toContain(prompt);
  });

  test("a second create needs no card, and neither does a prompt to a session it created", async () => {
    const second = await tool(orchestrator, "create_session", { relay: "this", text: "sidebar polish, part two: check the export", wait_seconds: 0 });
    expect(second.status, JSON.stringify(second.payload)).toBe(200);
    created.push(second.payload.session);
    expect(await pendingCards(api, orchestrator)).toEqual([]);

    const sent = await tool(orchestrator, "send", { relay: "this", session: created[0], text: "and note what is blocked", wait_seconds: 0 });
    expect(sent.status, JSON.stringify(sent.payload)).toBe(200);
    expect(await pendingCards(api, orchestrator)).toEqual([]);
  });

  test("an agent cannot act on the conversation it runs in", async () => {
    const send = await tool(orchestrator, "send", { relay: "this", session: orchestrator, text: "talking to myself", wait_seconds: 0 });
    expect(send.status).toBe(400);
    expect(send.payload.code).toBe("REMOTE_RELAY_OWN_SESSION");
    for (const action of ["stop", "archive"]) {
      const refused = await tool(orchestrator, action, { relay: "this", session: orchestrator });
      expect(refused.status, action).toBe(400);
      expect(refused.payload.code).toBe("REMOTE_RELAY_OWN_SESSION");
    }
    const detail = await api(`/api/conversation/${orchestrator}?limit=20`);
    expect(detail.payload.archived).toBeFalsy();
    expect(detail.payload.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  test("a session that an agent created cannot create sessions", async () => {
    const before = (await api("/api/conversations")).payload.conversations.length;
    const refused = await tool(created[0], "create_session", { relay: "this", text: "one level deeper", wait_seconds: 0 });
    expect(refused.status).toBe(403);
    expect(refused.payload.code).toBe("REMOTE_RELAY_NESTED_SESSION");
    expect(refused.payload.error).toContain("A session that an agent created cannot create sessions.");
    expect((await api("/api/conversations")).payload.conversations).toHaveLength(before);
    // It may still read and report on this relay.
    const read = await tool(created[0], "read_session", { relay: "this", session: created[1] });
    expect(read.status).toBe(200);
  });

  test("the fifth session at work is refused, and a session that stopped working frees a place", async () => {
    for (const part of ["three", "four"]) {
      const next = await tool(orchestrator, "create_session", { relay: "this", text: `sidebar polish, part ${part}`, wait_seconds: 0 });
      expect(next.status, JSON.stringify(next.payload)).toBe(200);
      created.push(next.payload.session);
    }
    expect(created).toHaveLength(4);
    const before = (await api("/api/conversations")).payload.conversations.length;

    const fifth = await tool(orchestrator, "create_session", { relay: "this", text: "sidebar polish, part five", wait_seconds: 0 });
    expect(fifth.status).toBe(409);
    expect(fifth.payload.code).toBe("REMOTE_RELAY_SESSION_LIMIT");
    expect(fifth.payload.error).toBe("4 sessions you started are still working; wait for one to finish.");
    expect([...fifth.payload.sessions].sort()).toEqual([...created].sort());
    expect((await api("/api/conversations")).payload.conversations).toHaveLength(before);

    // Deleting one of the four ends its queued turn.
    const removed = await api(`/api/conversation/${created[3]}`, { method: "DELETE" });
    expect(removed.status, JSON.stringify(removed.payload)).toBe(200);
    const again = await tool(orchestrator, "create_session", { relay: "this", text: "sidebar polish, part five", wait_seconds: 0 });
    expect(again.status, JSON.stringify(again.payload)).toBe(200);
    expect(await pendingCards(api, orchestrator)).toEqual([]);
  });

  test("switching the setting off closes this relay to the agent again", async () => {
    const off = await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: false } });
    expect(off.payload).toEqual({ ok: true, enabled: false, maxWaitSeconds: 1800, ...SETTINGS_SHAPE });
    const refused = await tool(orchestrator, "read_session", { relay: "this", session: created[0] });
    expect(refused.status).toBe(403);
    expect(refused.payload.code).toBe("REMOTE_RELAY_LOCAL_DISABLED");
    expect((await api("/api/remote-relays/summary")).payload.localEnabled).toBe(false);
  });
});

test.describe.serial("an agent starts a Claude Cloud session on this relay", () => {
  test.describe.configure({ timeout: 120_000 });
  test.skip(process.platform === "win32", "the spec isolates its workers in a tmux server of its own");

  const REPO_URL = "https://github.com/example-org/agent-made";
  const BRANCH = "feature/agent-run";
  const ORCHESTRATOR_REPO = "https://github.com/example-org/sample-repo";
  // A turn crosses the relay, a worker process and the fake API.
  const TURN_TIMEOUT = 60_000;

  let fake = null;
  let relay = null;
  let tmuxDir = "";
  const api = createApi(() => relay);
  const tool = createToolCaller(api);

  function killOwnTmuxServer() {
    if (!tmuxDir) return;
    try {
      execFileSync("tmux", ["kill-server"], { stdio: "ignore", env: { ...process.env, TMUX_TMPDIR: tmuxDir, TMUX: "" } });
    } catch {
      // No server (no worker was ever launched, or no tmux on this host).
    }
  }

  function createsFor(repoUrl) {
    return fake.requestsTo("POST", "/v1/code/sessions")
      .filter((request) => request.body?.config?.sources?.[0]?.url === repoUrl);
  }

  async function bootstrapCloudChat(repoUrl, title) {
    const bootstrap = await api("/api/conversation/bootstrap", {
      method: "POST",
      body: { providerType: "claude-cloud", title, cloudSource: { repoUrl } },
    });
    expect(bootstrap.status, JSON.stringify(bootstrap.payload)).toBe(200);
    return bootstrap.payload.conversationId;
  }

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    fake = await startFakeClaudeCloudApi();
    relay = await startRelayServer({
      token: randomUUID(),
      allowCli: true,
      persistWorkerConfig: true,
      overrides: ({ stateRoot }) => {
        tmuxDir = path.join(stateRoot, "tmux");
        fs.mkdirSync(tmuxDir, { recursive: true, mode: 0o700 });
        return {
          COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED: "1",
          OAR_CLAUDE_CLOUD_API_BASE_URL: fake.baseUrl,
          CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLOUD_TOKEN,
          TMUX_TMPDIR: tmuxDir,
          // Not a tmux pane of whoever started the suite.
          TMUX: "",
          TMUX_PANE: "",
          // Only cloud conversations are created here. Should anything else ever
          // be launched, it runs this instead of a Copilot CLI.
          COPILOT_WEB_RELAY_CLI_EXECUTABLE: "/bin/false",
        };
      },
    });
  });

  test.afterAll(async () => {
    // Deleting a conversation stops its worker; whatever is left goes with the
    // spec's own tmux server before the relay does.
    if (relay) {
      const listed = await api("/api/conversations").catch(() => null);
      for (const conversation of listed?.payload?.conversations || []) {
        await api(`/api/conversation/${encodeURIComponent(conversation.id)}`, { method: "DELETE" }).catch(() => {});
      }
    }
    killOwnTmuxServer();
    if (relay) await relay.stop();
    relay = null;
    if (fake) await fake.stop();
    fake = null;
  });

  test("create_session with repo and branch reaches the cloud API, and its reply comes back through the tool", async () => {
    expect((await api("/api/settings/claude-cloud", { method: "POST", body: { enabled: true } })).status).toBe(200);
    expect((await api("/api/settings/pwa-app-name", { method: "POST", body: { appName: "win-test" } })).status).toBe(200);
    expect((await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).payload.enabled).toBe(true);

    // The orchestrating conversation: a cloud chat whose turn stays open.
    const orchestrator = await bootstrapCloudChat(ORCHESTRATOR_REPO, "report builder");
    const first = await api("/api/message", {
      method: "POST",
      body: { conversationId: orchestrator, text: "a slow sample job that hands a part to another session" },
    });
    expect(first.status, JSON.stringify(first.payload)).toBe(200);
    await expect.poll(async () => {
      const detail = await api(`/api/conversation/${orchestrator}?limit=5`);
      return JSON.stringify(detail.payload?.inFlight?.streamEvents || []);
    }, { timeout: TURN_TIMEOUT }).toContain(FAKE_CLOUD_SLOW_FIRST_LINE);
    expect(createsFor(REPO_URL)).toHaveLength(0);

    // Repo and branch go with claude-cloud alone, and that provider needs a repo.
    const wrongProvider = await tool(orchestrator, "create_session", { relay: "this", provider: "claude", repo: "example-org/agent-made", text: "x" });
    expect(wrongProvider.status).toBe(400);
    expect(wrongProvider.payload.code).toBe("REMOTE_RELAY_INVALID_INPUT");
    const noRepo = await tool(orchestrator, "create_session", { relay: "this", text: "nothing to clone" });
    expect(noRepo.status).toBe(400);
    expect(noRepo.payload.error).toContain("needs repo");

    const prompt = "Change the sample banner on feature/agent-run and report what changed.";
    const call = tool(orchestrator, "create_session", {
      relay: "this",
      provider: "claude-cloud",
      repo: "example-org/agent-made",
      branch: BRANCH,
      text: prompt,
      wait_seconds: 60,
    });
    const card = await waitForApprovalCard(api, orchestrator);
    expect(card.prompt).toContain(`This agent wants to start sessions on this relay (claude-cloud, example-org/agent-made, branch ${BRANCH}). Sessions it starts use this relay's accounts.`);
    expect(createsFor(REPO_URL)).toHaveLength(0);
    expect((await answerCard(api, card, "Allow")).status).toBe(200);

    const result = await call;
    expect(result.status, JSON.stringify(result.payload)).toBe(200);
    expect(result.payload).toEqual(expect.objectContaining({
      ok: true,
      relay: "win-test",
      provider: "claude-cloud",
      repo: REPO_URL,
      branch: BRANCH,
      status: "done",
    }));
    // The created session ran its turn in the cloud and the tool waited for it.
    expect(result.payload.reply.text).toContain("Fake cloud reply to:");
    expect(result.payload.reply.text).toContain(prompt);

    // The fake API was asked for exactly this repository and branch, with the
    // account's environment and the Claude Cloud tab's default model.
    const creates = createsFor(REPO_URL);
    expect(creates).toHaveLength(1);
    expect(creates[0].authorized).toBe(true);
    expect(creates[0].body.environment_id).toBe(FAKE_CLOUD_ENVIRONMENTS[0].id);
    expect(creates[0].body.config.sources).toEqual([{ type: "git_repository", url: REPO_URL, revision: BRANCH }]);
    const settings = await api("/api/settings/claude-cloud");
    expect(creates[0].body.config.model).toBe(settings.payload.defaultModel);

    // The conversation is a cloud chat with the local origin.
    const detail = await api(`/api/conversation/${result.payload.session}?limit=5`);
    expect(detail.payload.origin).toEqual(expect.objectContaining({ local: true, conversationId: orchestrator, conversationTitle: "report builder" }));
    expect(detail.payload.cloud).toEqual(expect.objectContaining({ repoUrl: REPO_URL, branch: BRANCH }));
    expect(detail.payload.runtimeSession.providerType).toBe("claude-cloud");

    // The created cloud session cannot create one itself.
    const nested = await tool(result.payload.session, "create_session", {
      relay: "this", provider: "claude-cloud", repo: "example-org/agent-made", text: "one level deeper", wait_seconds: 0,
    });
    expect(nested.status).toBe(403);
    expect(nested.payload.code).toBe("REMOTE_RELAY_NESTED_SESSION");
    expect(createsFor(REPO_URL)).toHaveLength(1);
  });
});
