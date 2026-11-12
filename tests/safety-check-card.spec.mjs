import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";
import { createAskUserBridge } from "../shared/ask-user-bridge.mjs";
import { createCanUseTool } from "../server/claude-worker/claude-sdk-adapter.mjs";
import { readRelaySecretsFile, relaySecretsPath } from "../server/services/owner-secret-store.mjs";
import { mintAgentTokenWithKey } from "../shared/relay-credentials.mjs";

// A Claude session's Safety check card: the CLI's canUseTool call is the
// test double, the adapter and the question bridge are the real ones, and the
// relay is an isolated test relay. The card shows in its session and in the
// Inbox, takes no typed reply, and no agent may see it among a session's
// questions or answer it.

const SAMPLE_COMMAND = "rm -rf /srv/sample-app/work";
const SAMPLE_REASON = "Dangerous rm operation on working directory or its ancestor: /srv/sample-app/work";
const PERSON_ONLY_OPTIONS = {
  suggestions: [],
  decisionReason: SAMPLE_REASON,
  decisionReasonType: "safetyCheck",
  suppressAlwaysAllowRule: true,
  toolUseID: "toolu_sample_1",
  requestId: "req-sample-1",
};
// A sensitive-file Safety check: `safetyCheck` without the person-only flag,
// offered with the CLI's "accept edits" switch (which the card ignores).
const SENSITIVE_PATH = "/srv/sample-app/work/.bashrc";
const SENSITIVE_OPTIONS = {
  suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  blockedPath: SENSITIVE_PATH,
  decisionReason: `Claude requested permissions to edit ${SENSITIVE_PATH} which is a sensitive file.`,
  decisionReasonType: "safetyCheck",
  toolUseID: "toolu_sample_2",
  requestId: "req-sample-2",
};

test.describe.serial("the Safety check card", () => {
  test.describe.configure({ timeout: 120_000 });

  let relay = null;
  const suffix = Date.now();
  const sessions = {};

  async function api(route, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, payload };
  }
  const tool = (conversationId, action, args = {}) => api("/api/remote-relays/tool", { method: "POST", body: { conversationId, action, args } });

  // The worker-side api helper the bridge calls: JSON or a thrown error.
  async function workerApi(method, route, body) {
    const { status, payload } = await api(route, { method, body });
    if (status < 200 || status >= 300) {
      const error = new Error(`${method} ${route} ${status}`);
      error.status = status;
      throw error;
    }
    return payload;
  }

  async function conversationWithRunningTurn(text) {
    const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    const { conversationId, messageId, ownerSessionId } = queued.payload;
    const headers = ownerSessionId ? { "x-relay-session-id": String(ownerSessionId) } : {};
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const dequeued = await api("/api/pending", { headers });
      if (String(dequeued.payload?.message?.id || "") === messageId) return { conversationId, messageId };
      await sleep(250);
    }
    throw new Error("The message was never handed out");
  }

  function canUseToolFor(turn) {
    const bridge = createAskUserBridge({
      api: workerApi,
      getActiveMessage: () => ({ id: turn.messageId, conversationId: turn.conversationId, relayMode: "agent" }),
      sdkSessionId: turn.conversationId,
      questionPollMs: 200,
    });
    return createCanUseTool({ askUserBridge: bridge });
  }

  async function pendingCard(conversationId) {
    let card = null;
    await expect.poll(async () => {
      const { payload } = await api(`/api/relay-questions?conversationId=${encodeURIComponent(conversationId)}&status=pending`);
      card = (payload?.questions || []).find((question) => question?.context?.source === "ClaudeSafetyCheck") || null;
      return Boolean(card);
    }, { timeout: 15_000 }).toBe(true);
    return card;
  }

  // A session's agent token, as its worker gets it (OAR_AGENT_TOKEN): made
  // from the test relay's agent key. Never printed.
  function sessionAgentToken(conversationId) {
    const { secrets } = readRelaySecretsFile(relaySecretsPath(relay.dataDir));
    expect(Boolean(secrets?.agentKey), "the test relay has an agent key").toBe(true);
    return mintAgentTokenWithKey(secrets.agentKey, { kind: "session", subject: conversationId });
  }

  // Signs the page in as the person with a single-use sign-in link, so it
  // holds a browser session (an oars1_ cookie) and never the relay token.
  async function signInPage(page, conversationId) {
    const minted = await api("/api/auth/signin-codes", { method: "POST", body: {} });
    expect(minted.status).toBe(200);
    await page.goto(`${relay.baseUrl}/?signin=${encodeURIComponent(minted.payload.code)}&conv=${encodeURIComponent(conversationId)}`);
    await page.waitForFunction(() => typeof window.toggleInboxView === "function");
    await expect(page.locator("#app")).toHaveClass(/visible/);
    await expect(page.locator("#auth-gate")).toBeHidden();
    expect(new URL(page.url()).searchParams.has("signin"), "the code left the address").toBe(false);
    const cookies = await page.context().cookies(relay.baseUrl);
    expect(cookies.some((cookie) => cookie.value.startsWith("oars1_")), "a browser session cookie").toBe(true);
    expect(cookies.some((cookie) => cookie.value.includes(relay.token)), "never the relay token").toBe(false);
  }

  async function openInbox(page) {
    const button = page.locator("#inbox-btn");
    const reachable = () => button.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || rect.left < 0 || rect.right > window.innerWidth) return false;
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(top && (top === node || node.contains(top)));
    });
    // On a phone the page may open the waiting session on load, which shuts
    // the drawer again: open it until the button stays reachable.
    await expect(async () => {
      if (!(await reachable())) await page.locator("#sidebar-toggle").click();
      await expect.poll(reachable, { timeout: 2_000 }).toBe(true);
    }).toPass({ timeout: 20_000 });
    // A phone's drawer may still be sliding: click once the button stands still.
    const left = () => button.evaluate((node) => node.getBoundingClientRect().left);
    await expect.poll(async () => {
      const before = await left();
      await sleep(150);
      return before === await left();
    }).toBe(true);
    await button.click();
    await expect(page.locator(".inbox-view")).toBeVisible();
  }

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
    expect((await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).status).toBe(200);
    sessions.other = (await api("/api/message", { method: "POST", body: { text: `sample orchestrator ${suffix}`, relayMode: "agent", model: "gpt-5.4-mini" } })).payload.conversationId;
  });

  test.afterAll(async () => {
    await relay?.stop();
    relay = null;
  });

  test("desktop: the card in its session and the Inbox, no reply box, agents refused, Allow once allows", async ({ page }) => {
    const turn = await conversationWithRunningTurn(`clean up the sample build folder ${suffix}`);
    const input = { command: SAMPLE_COMMAND, description: "Remove the work folder" };
    const decision = canUseToolFor(turn)("Bash", input, { ...PERSON_ONLY_OPTIONS, signal: new AbortController().signal });
    const card = await pendingCard(turn.conversationId);
    expect(card.choices).toEqual(["Allow once", "Deny"]);

    // No agent sees it among the session's questions, or may answer it.
    const read = await tool(sessions.other, "read_session", { relay: "this", session: turn.conversationId });
    expect(read.status, JSON.stringify(read.payload)).toBe(200);
    expect((read.payload?.pendingQuestions || []).map((question) => question.id)).not.toContain(card.id);
    const agentAnswer = await tool(sessions.other, "answer_question", { relay: "this", question_id: card.id, choices: ["Allow once"] });
    expect(agentAnswer.status).toBe(403);
    // No agent answers any card (agent auth), this one least of all.
    expect(agentAnswer.payload?.code).toBe("AUTH_PERSON_REQUIRED");
    expect(String(agentAnswer.payload?.error || "")).toMatch(/Only the person can answer questions; ask them in the relay UI\./);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}&conv=${encodeURIComponent(turn.conversationId)}`);
    await page.waitForFunction(() => typeof window.toggleInboxView === "function");

    // In its session: header, reason before the fenced command, two choices, no reply box.
    const inSession = page.locator(".relay-question-container", { hasText: "Safety check" });
    await expect(inSession).toBeVisible();
    const body = await inSession.locator(".relay-question-body").innerText();
    expect(body.indexOf(`Reason: ${SAMPLE_REASON}`)).toBeGreaterThan(-1);
    expect(body.indexOf(`Reason: ${SAMPLE_REASON}`)).toBeLessThan(body.indexOf(`│ ${SAMPLE_COMMAND}`));
    await expect(inSession.getByRole("button", { name: "Allow once" })).toBeVisible();
    await expect(inSession.getByRole("button", { name: "Deny" })).toBeVisible();
    await expect(inSession.locator("textarea")).toHaveCount(0);

    // In the Inbox: the same card, answered there.
    await openInbox(page);
    const inInbox = page.locator(`.inbox-card[data-item-id="${card.id}"]`);
    await expect(inInbox).toBeVisible();
    await expect(inInbox.locator(".inbox-item-header")).toHaveText("Safety check");
    await expect(inInbox.locator(".inbox-answer-text")).toHaveCount(0);
    await inInbox.locator('.inbox-choice[data-choice="Allow once"]').click();
    expect(await decision).toEqual({ behavior: "allow", updatedInput: input });
  });

  test("desktop: a sensitive-file card shows the file and the change, agents refused, Allow once allows once", async ({ page }) => {
    const turn = await conversationWithRunningTurn(`add an alias to the sample shell profile ${suffix}`);
    const input = { file_path: SENSITIVE_PATH, content: 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -l"' };
    const decision = canUseToolFor(turn)("Write", input, { ...SENSITIVE_OPTIONS, signal: new AbortController().signal });
    const card = await pendingCard(turn.conversationId);
    expect(card.choices).toEqual(["Allow once", "Deny"]);
    expect(card.context.kind).toBe("sensitive-file");
    expect(card.context.personOnly).toBe(true);

    // No agent answers it: not another session's relay_tool, and not the
    // card's own session with its worker's agent token, on the answer route
    // or by dismissing it.
    const agentAnswer = await tool(sessions.other, "answer_question", { relay: "this", question_id: card.id, choices: ["Allow once"] });
    expect(agentAnswer.status).toBe(403);
    expect(agentAnswer.payload?.code).toBe("AUTH_PERSON_REQUIRED");
    const ownAgent = { Authorization: `Bearer ${sessionAgentToken(turn.conversationId)}` };
    for (const action of ["answer", "dismiss"]) {
      const refused = await api(`/api/relay-question/${encodeURIComponent(card.id)}/${action}`, { method: "POST", headers: ownAgent, body: { answer: "Allow once" } });
      expect(refused.status, action).toBe(403);
      expect(refused.payload?.code, action).toBe("AUTH_PERSON_REQUIRED");
    }

    // The person answers in a signed-in page: a browser session, never the
    // relay token in the address.
    await page.setViewportSize({ width: 1280, height: 900 });
    await signInPage(page, turn.conversationId);

    // Reason, then the file, then the fenced change; two choices, no reply box.
    const inSession = page.locator(".relay-question-container", { hasText: "Safety check" });
    await expect(inSession).toBeVisible();
    const body = await inSession.locator(".relay-question-body").innerText();
    expect(body).toContain("Claude Code marks this file as sensitive");
    const reasonAt = body.indexOf(`Reason: ${SENSITIVE_OPTIONS.decisionReason}`);
    const fileAt = body.indexOf(`File: ${SENSITIVE_PATH}`);
    const changeAt = body.indexOf("Change, 2 lines:");
    expect(reasonAt).toBeGreaterThan(-1);
    expect(fileAt).toBeGreaterThan(reasonAt);
    expect(changeAt).toBeGreaterThan(fileAt);
    expect(body).toContain('│ export PATH="$HOME/bin:$PATH" ⏎');
    expect(body).toContain('│ alias ll="ls -l"');
    await expect(inSession.locator("textarea")).toHaveCount(0);
    const answerSent = page.waitForRequest((request) => request.method() === "POST"
      && new URL(request.url()).pathname.endsWith(`/api/relay-question/${encodeURIComponent(card.id)}/answer`));
    await inSession.getByRole("button", { name: "Allow once" }).click();
    const sent = await answerSent;
    expect("authorization" in sent.headers(), "answered with the browser session, no Bearer").toBe(false);
    expect(/^oark1_/.test(sent.headers()["x-oar-session-proof"] || ""), "the session's proof key went with the cookie").toBe(true);
    expect((await sent.response())?.status()).toBe(200);
    const allowed = await decision;
    expect(allowed).toEqual({ behavior: "allow", updatedInput: input });
    expect("updatedPermissions" in allowed).toBe(false);
  });

  test("phone: the Inbox card denies on Deny", async ({ page }) => {
    const turn = await conversationWithRunningTurn(`clean up the sample cache folder ${suffix}`);
    const decision = canUseToolFor(turn)("Bash", { command: SAMPLE_COMMAND }, { ...PERSON_ONLY_OPTIONS, signal: new AbortController().signal });
    const card = await pendingCard(turn.conversationId);

    await page.setViewportSize({ width: 390, height: 844 });
    // Opened on the waiting session itself: the page would switch to it on
    // load and shut the drawer under the Inbox button.
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}&conv=${encodeURIComponent(turn.conversationId)}`);
    await page.waitForFunction(() => typeof window.toggleInboxView === "function");
    await expect(page.locator(".relay-question-container", { hasText: "Safety check" })).toBeVisible();
    await openInbox(page);
    const inInbox = page.locator(`.inbox-card[data-item-id="${card.id}"]`);
    await expect(inInbox).toBeVisible();
    await expect(inInbox.locator(".inbox-answer-text")).toHaveCount(0);
    await inInbox.locator('.inbox-choice[data-choice="Deny"]').click();
    const denied = await decision;
    expect(denied.behavior).toBe("deny");
    expect(denied.message).toMatch(/the user denied it/);
  });
});
