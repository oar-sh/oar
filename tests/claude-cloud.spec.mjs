import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  FAKE_CLOUD_ENVIRONMENTS,
  FAKE_CLOUD_NO_TRAILER,
  FAKE_CLOUD_ORGANIZATION_ID,
  FAKE_CLOUD_REPOSITORIES,
  FAKE_CLOUD_OWN_TRAILER,
  FAKE_CLOUD_PUSHED_BRANCH,
  FAKE_CLOUD_QUESTION,
  FAKE_CLOUD_SANDBOX_LINE,
  FAKE_CLOUD_SLOW_FIRST_LINE,
  FAKE_CLOUD_TOKEN,
  FAKE_CLOUD_TOOL_COMMAND,
  fakeCloudReplyFor,
  fakeCloudTrailerReplyFor,
  startFakeClaudeCloudApi,
} from "./fake-claude-cloud-api.mjs";
import { startRelayServer } from "./relay-server-harness.mjs";

/**
 * Claude Cloud (provider `claude-cloud`), end to end.
 *
 * Everything between the browser and the Anthropic API is real here: the
 * settings tab, the New Chat modal, the composer, the relay's routes and
 * queue, a cloud worker the relay really launches, and the cloud client in
 * both of them. Only the API is a fake (tests/fake-claude-cloud-api.mjs), on a
 * loopback port the relay and its workers are pointed at with
 * OAR_CLAUDE_CLOUD_API_BASE_URL. Nothing in this file can reach Anthropic.
 *
 * The shared e2e relay cannot run this: it never launches a worker and pins
 * session-worker routing off. So the spec boots its own relay (as
 * tests/copilot-engine.spec.mjs does), isolated the same way, with three
 * differences:
 *
 *  - worker launches are allowed and routing is on. Only cloud conversations
 *    are created here, and the Copilot CLI path is pointed at a command that
 *    does nothing, so no other kind of worker can start;
 *  - the relay's port and token are written to its config.json before boot,
 *    because that is where a worker finds its relay;
 *  - tmux gets its own socket directory inside the state root, so the workers
 *    run in a tmux server of their own that is killed afterwards, and nothing
 *    shows up in (or inherits from) the developer's tmux.
 *
 * The login is CLAUDE_CODE_OAUTH_TOKEN with a value only the fake accepts: it
 * reaches the worker through the launch service's secret file, which is the
 * path a relay run on an environment token depends on.
 *
 * One relay and one fake serve both viewports; each viewport runs the whole
 * story on a conversation of its own, in order.
 */

const DEFAULT_MODEL = "claude-sonnet-5-5";
const FOLDER_REPO_URL = "https://github.com/example-org/sample-repo";
const FOLDER_BRANCH = "main";
// What the relay's commit attribution (mode OAR, the default) says for DEFAULT_MODEL.
const OAR_TRAILER = "Co-authored-by: Open Agent Relay (Claude Sonnet 5.5) <no-reply@oar.sh>";

const PROFILES = [
  {
    name: "desktop",
    use: { viewport: { width: 1280, height: 800 } },
    typedRepoUrl: "https://github.com/example-org/typed-desktop",
    typedBranch: "feature/desktop-run",
  },
  {
    name: "phone",
    use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    typedRepoUrl: "https://github.com/example-org/typed-phone",
    typedBranch: "feature/phone-run",
  },
];

// A turn crosses the browser, the relay, a worker process and the fake API;
// on a loaded machine each hop can take seconds.
const TURN_TIMEOUT = 60_000;

let fake = null;
let relay = null;
let repoDir = "";
let tmuxDir = "";

function runGit(args, cwd) {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    // The developer's git configuration (identity, hooks, signing) stays out.
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

/** A git checkout whose `origin` is an invented GitHub repository. */
function createSampleCheckout() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "claude-cloud-e2e-repo-")));
  runGit(["init", "--quiet", "--initial-branch", FOLDER_BRANCH], dir);
  runGit(["-c", "user.name=Dev", "-c", "user.email=dev@example.com", "commit", "--quiet", "--allow-empty", "-m", "Sample commit"], dir);
  runGit(["remote", "add", "origin", `${FOLDER_REPO_URL}.git`], dir);
  return dir;
}

function killOwnTmuxServer() {
  if (!tmuxDir) return;
  try {
    execFileSync("tmux", ["kill-server"], { stdio: "ignore", env: { ...process.env, TMUX_TMPDIR: tmuxDir, TMUX: "" } });
  } catch {
    // No server (no worker was ever launched, or no tmux on this host).
  }
}

async function relayApi(method, route, body) {
  const response = await fetch(`${relay.baseUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

async function loadApp(page) {
  await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
  await page.waitForLoadState("networkidle");
  // networkidle can fire before the app modules finish binding their globals.
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
}

async function openConversation(page, conversationId) {
  await loadApp(page);
  await page.evaluate((id) => window.openConversation(id), conversationId);
  await expect(page.locator("#cloud-session-line")).toBeVisible();
  await expect(page.locator("#msg-input")).toBeVisible();
}

/** On a phone the sidebar is a drawer that starts closed; ☰ opens it. */
async function showSidebar(page) {
  const button = page.locator("#new-conv-btn");
  const onScreen = await button.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.right > 0 && box.left < window.innerWidth;
  });
  if (!onScreen) await page.locator("#sidebar-toggle").click();
  await expect(button).toBeInViewport();
}

async function openNewChatModal(page) {
  await showSidebar(page);
  const button = page.locator("#new-conv-btn");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator("#new-conversation-model-modal")).toHaveClass(/visible/);
}

async function newChatProviderValues(page) {
  return page.locator("#new-conversation-provider-select option").evaluateAll(
    (options) => options.map((option) => option.value),
  );
}

/** Types into the composer and presses Send, as a user does. */
async function sendFromComposer(page, text) {
  await page.fill("#msg-input", text);
  await expect(page.locator("#send-btn")).toBeEnabled();
  await page.click("#send-btn");
  // The message left the composer and is in the transcript.
  await expect(page.locator("#msg-input")).toHaveValue("");
  await expect(page.locator(".msg.user", { hasText: text })).toBeVisible();
}

/** The finished reply: the live bubble is gone and the transcript holds the text. */
async function expectFinishedReply(page, text) {
  await expect(page.locator(".thinking-bubble")).toHaveCount(0, { timeout: TURN_TIMEOUT });
  const reply = page.locator(".msg.assistant", { hasText: text }).last();
  await expect(reply).toBeVisible({ timeout: TURN_TIMEOUT });
  return reply;
}

/** A "trailer" reply as the chat shows it: the code span without its backticks. */
function shownTrailerReply(trailer) {
  return fakeCloudTrailerReplyFor(trailer).replaceAll("`", "");
}

function createsFor(repoUrl) {
  return fake.requestsTo("POST", "/v1/code/sessions")
    .filter((request) => request.body?.config?.sources?.[0]?.url === repoUrl);
}

function userText(payload) {
  const content = payload?.message?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

test.skip(process.platform === "win32", "the spec isolates its workers in a tmux server of its own");

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fake = await startFakeClaudeCloudApi();
  repoDir = createSampleCheckout();
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
  // Deleting a conversation stops its worker; whatever a failed run left
  // behind goes the same way before the relay does.
  if (relay) {
    const listed = await relayApi("GET", "/api/conversations").catch(() => null);
    const conversations = Array.isArray(listed?.body) ? listed.body : (listed?.body?.conversations || []);
    for (const conversation of conversations) {
      await relayApi("DELETE", `/api/conversation/${encodeURIComponent(conversation.id)}`).catch(() => {});
    }
  }
  killOwnTmuxServer();
  if (relay) await relay.stop();
  relay = null;
  if (fake) await fake.stop();
  fake = null;
  if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  repoDir = "";
});

for (const profile of PROFILES) {
  test.describe.serial(`Claude Cloud on a ${profile.name} viewport`, () => {
    test.describe.configure({ timeout: 120_000 });
    test.use(profile.use);

    const typedSlug = profile.typedRepoUrl.replace("https://github.com/", "");
    let conversationId = "";
    let cloudSessionId = "";

    test.beforeEach(async ({ page }) => {
      // Deleting a conversation asks with a native confirm.
      page.on("dialog", (dialog) => { dialog.accept().catch(() => {}); });
    });

    test("New Chat offers Claude Cloud only once it is enabled, and the tab lists the account's environments", async ({ page }) => {
      // The other viewport's run may have left the provider on.
      expect((await relayApi("POST", "/api/settings/claude-cloud", { enabled: false })).status).toBe(200);
      const listingsWhileOff = fake.requestsTo("GET", "/v1/environment_providers").length;

      await loadApp(page);
      await openNewChatModal(page);
      expect(await newChatProviderValues(page)).not.toContain("claude-cloud");
      await page.evaluate(() => window.closeNewConversationModelModal());
      await expect(page.locator("#new-conversation-model-modal")).not.toHaveClass(/visible/);

      await page.evaluate(() => window.openSettingsModal("providers", "claude-cloud"));
      await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
      await expect(page.locator("#settings-provider-panel-claude-cloud")).toBeVisible();
      const toggle = page.locator("#claude-cloud-enabled-toggle");
      await expect(toggle).toBeEnabled();
      await expect(toggle).not.toBeChecked();
      await expect(page.locator("#claude-cloud-settings-status")).toHaveAttribute("data-state", "unconfigured");
      // Off means nothing is asked of the API: opening the tab lists no environments.
      await expect(page.locator("#claude-cloud-token")).toBeVisible();
      expect(fake.requestsTo("GET", "/v1/environment_providers")).toHaveLength(listingsWhileOff);

      await toggle.click();
      await expect(page.locator("#claude-cloud-settings-status")).toHaveAttribute("data-state", "active");
      await expect(toggle).toBeChecked();
      await expect(page.locator("#claude-cloud-token")).toHaveText("Login: CLAUDE_CODE_OAUTH_TOKEN from the relay environment.");

      const environmentSelect = page.locator("#claude-cloud-environment-select");
      await expect(environmentSelect).toBeEnabled();
      await expect(environmentSelect.locator("option")).toHaveText(
        FAKE_CLOUD_ENVIRONMENTS.map((environment) => `${environment.name} (${environment.id})`),
      );
      // The first active environment is taken and stored without a Save.
      await expect(environmentSelect).toHaveValue(FAKE_CLOUD_ENVIRONMENTS[0].id);
      await expect(page.locator("#claude-cloud-model-select")).toHaveValue(DEFAULT_MODEL);

      const listings = fake.requestsTo("GET", "/v1/environment_providers");
      expect(listings.length).toBeGreaterThan(listingsWhileOff);
      expect(listings.every((request) => request.authorized)).toBe(true);

      await page.evaluate(() => window.closeSettingsModal());
      await expect(page.locator("#settings-modal")).not.toHaveClass(/visible/);
      await openNewChatModal(page);
      expect(await newChatProviderValues(page)).toContain("claude-cloud");
      await expect(page.locator('#new-conversation-provider-select option[value="claude-cloud"]')).toHaveText("Claude Cloud");
    });

    test("New Chat fills repository and branch from the folder, refuses a non-GitHub URL and takes a typed one", async ({ page }) => {
      await loadApp(page);
      await openNewChatModal(page);
      await page.locator("#new-conversation-provider-select").selectOption("claude-cloud");

      const repoInput = page.locator("#new-conversation-cloud-repo");
      const branchInput = page.locator("#new-conversation-cloud-branch");
      const error = page.locator("#new-conversation-cloud-error");
      const confirm = page.locator("#new-conversation-model-confirm");
      const modal = page.locator("#new-conversation-model-modal");
      await expect(page.locator("#new-conversation-cloud-row")).toBeVisible();
      // A cloud session has no effort choice. Its select is emptied, which
      // once kept every message of the chat from being sent.
      await expect(page.locator("#new-conversation-reasoning-row")).toBeHidden();
      await expect(page.locator("#new-conversation-model-select")).toHaveValue(DEFAULT_MODEL);

      // The folder: a checkout with an invented GitHub remote.
      await page.locator("#new-conversation-cwd-select").selectOption("__custom__");
      await page.locator("#new-conversation-cwd-manual").fill(repoDir);
      await expect(repoInput).toHaveValue(FOLDER_REPO_URL);
      await expect(branchInput).toHaveValue(FOLDER_BRANCH);
      await expect(page.locator("#new-conversation-cwd-status")).toContainText(repoDir);
      // The checkout was never pushed, and the cloud only sees GitHub.
      await expect(page.locator('#new-conversation-cloud-warnings [data-kind="no-upstream"]')).toContainText(FOLDER_BRANCH);

      // The Repository field offers what the Claude GitHub app can reach
      // (the fake's list, read through the relay once per open). The folder's
      // repository is on it, so it is the one suggestion while the field
      // names it; emptied, the field offers the whole list.
      const repoList = page.locator("#new-conversation-cloud-repo-list");
      const repoItems = repoList.locator(".new-conversation-cloud-suggest-item");
      await repoInput.focus();
      await expect(repoList).toBeVisible();
      await expect(repoItems).toHaveText([/^example-org\/sample-repo/]);
      await repoInput.fill("");
      const listed = FAKE_CLOUD_REPOSITORIES.filter((entry) => !entry.repo.disabled).map((entry) => `${entry.repo.owner.login}/${entry.repo.name}`);
      await expect(repoItems).toHaveCount(listed.length);
      for (const slug of listed) await expect(repoItems.filter({ hasText: slug })).toHaveCount(1);
      const listBox = await repoList.boundingBox();
      expect(listBox.x + listBox.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
      await repoInput.fill("docs");
      await expect(repoItems).toHaveText([/^example-org\/docs-site/]);
      await repoItems.first().click();
      await expect(repoInput).toHaveValue("example-org/docs-site");
      await expect(repoList).toBeHidden();
      // The default branch is preselected. The host's branch lookup is off
      // in this harness, so the Branch field stays a plain text field.
      await expect(branchInput).toHaveValue("trunk");
      await branchInput.focus();
      await expect(page.locator("#new-conversation-cloud-branch-list")).toBeHidden();
      expect(fake.requestsTo("GET", `/api/oauth/organizations/${FAKE_CLOUD_ORGANIZATION_ID}/code/repos`).length).toBeGreaterThan(0);

      // A repository that is not on GitHub is refused in place.
      await repoInput.fill("https://gitlab.example.com/example-org/sample-repo");
      await confirm.click();
      await expect(error).toBeVisible();
      await expect(error).toHaveText("Not a GitHub repository. Use owner/repo or a github.com URL.");
      await expect(repoInput).toHaveAttribute("aria-invalid", "true");
      await expect(modal).toHaveClass(/visible/);

      // Typed by hand: another repository and branch than the folder's. It is
      // not on the list, which the modal says before the first message; the
      // chat can still be started with it.
      await repoInput.fill(profile.typedRepoUrl);
      await expect(error).toBeHidden();
      await expect(page.locator('#new-conversation-cloud-warnings [data-kind="not-accessible"]')).toContainText(typedSlug);
      await branchInput.fill(profile.typedBranch);
      const [bootstrap] = await Promise.all([
        page.waitForResponse((response) => response.url().endsWith("/api/conversation/bootstrap"), { timeout: TURN_TIMEOUT }),
        confirm.click(),
      ]);
      expect(bootstrap.status()).toBe(200);
      expect(bootstrap.request().postDataJSON().cloudSource).toEqual({
        repoUrl: profile.typedRepoUrl,
        branch: profile.typedBranch,
      });
      conversationId = String((await bootstrap.json())?.conversationId || "");
      expect(conversationId).toBeTruthy();
      await expect(modal).not.toHaveClass(/visible/, { timeout: TURN_TIMEOUT });

      // The chat is open and says where it will run.
      const cloudLine = page.locator("#cloud-session-line");
      await expect(cloudLine).toBeVisible();
      await expect(cloudLine.locator(".cloud-line-repo")).toHaveText(`☁ ${typedSlug}`);
      await expect(cloudLine.locator(".cloud-line-branch")).toHaveText(profile.typedBranch);
      // The cloud session is created by the first message, not by the chat.
      expect(createsFor(profile.typedRepoUrl)).toHaveLength(0);
    });

    test("the first message from the composer creates the cloud session and its reply arrives with activity lines", async ({ page }) => {
      await openConversation(page, conversationId);
      // No mode, effort or context choice in a cloud chat.
      await expect(page.locator("#reasoning-effort-select")).toBeHidden();
      await expect(page.locator("#mode-select")).toBeHidden();

      const text = `First ${profile.name} message for the sample repo`;
      await sendFromComposer(page, text);
      const reply = await expectFinishedReply(page, fakeCloudReplyFor(text));

      // What the turn did is kept with the reply.
      await expect(reply.locator(".msg-activity-item", { hasText: `model ${DEFAULT_MODEL}` })).toHaveCount(1);
      await expect(reply.locator(".msg-activity-item", { hasText: FAKE_CLOUD_SANDBOX_LINE })).toHaveCount(1);
      await expect(reply.locator(".msg-activity-item", { hasText: FAKE_CLOUD_TOOL_COMMAND })).toHaveCount(1);

      const creates = createsFor(profile.typedRepoUrl);
      expect(creates).toHaveLength(1);
      const [create] = creates;
      expect(create.authorized).toBe(true);
      expect(create.body.environment_id).toBe(FAKE_CLOUD_ENVIRONMENTS[0].id);
      expect(create.body.config).toEqual({
        model: DEFAULT_MODEL,
        sources: [{ type: "git_repository", url: profile.typedRepoUrl, revision: profile.typedBranch }],
      });
      // The relay's commit attribution reaches the sandbox before the message does.
      expect(create.body.events).toHaveLength(2);
      expect(create.body.events[0].event_type).toBe("control_request");
      expect(create.body.events[0].payload.request).toEqual({
        subtype: "apply_flag_settings",
        settings: {
          attribution: { commit: OAR_TRAILER, pr: "🤖 Generated with [Open Agent Relay](https://oar.sh)", sessionUrl: false },
        },
      });
      expect(create.body.events[1].payload.type).toBe("user");
      expect(userText(create.body.events[1].payload)).toContain(text);

      const session = fake.sessions().find((entry) => entry.source.url === profile.typedRepoUrl);
      cloudSessionId = session.id;
      // The session link and what the session has cost so far.
      const cloudLine = page.locator("#cloud-session-line");
      await expect(cloudLine.locator(".cloud-line-session")).toHaveAttribute("href", `https://claude.ai/code/${cloudSessionId}`);
      await expect(cloudLine.locator(".cloud-line-cost")).toHaveText("$0.42");
    });

    test("a second message goes into the same session", async ({ page }) => {
      await openConversation(page, conversationId);
      const text = `Second ${profile.name} message`;
      await sendFromComposer(page, text);
      await expectFinishedReply(page, fakeCloudReplyFor(text));

      expect(createsFor(profile.typedRepoUrl)).toHaveLength(1);
      const sent = fake.postedEvents("user").filter((event) => event.sessionId === cloudSessionId);
      expect(sent).toHaveLength(1);
      expect(sent[0].payload.session_id).toBe(cloudSessionId);
      expect(userText(sent[0].payload)).toContain(text);
      await expect(page.locator("#cloud-session-line .cloud-line-cost")).toHaveText("$0.84");
    });

    test("a turn started on claude.ai shows up in the chat as a continuation", async ({ page }) => {
      await openConversation(page, conversationId);
      // Another client of the session sends a message: the session takes a
      // turn nobody here asked for. The worker follows it on the stream it
      // keeps open and registers it as a continuation row.
      const text = `Sent from claude.ai on the ${profile.name} side`;
      fake.sendFromOtherClient(cloudSessionId, text);
      const reply = page.locator(".msg.assistant", { hasText: fakeCloudReplyFor(text) }).last();
      await expect(reply).toBeVisible({ timeout: TURN_TIMEOUT });
      await expect(reply.locator(".msg-continuation")).toHaveCount(1);
      await expect(reply.locator(".msg-activity-item", { hasText: `message sent on claude.ai: ${text}` })).toHaveCount(1);
      await expect(page.locator(".thinking-bubble")).toHaveCount(0, { timeout: TURN_TIMEOUT });
      // No request of the relay's went to the cloud for it.
      expect(fake.postedEvents("user").filter((event) => event.sessionId === cloudSessionId && userText(event.payload).includes(text))).toHaveLength(0);
    });

    test("commits in the sandbox follow the relay's attribution setting, and a change reaches it with the next message", async ({ page }) => {
      const settingsRequests = () => fake.postedEvents("control_request")
        .filter((event) => event.sessionId === cloudSessionId && event.payload?.request?.subtype === "apply_flag_settings")
        .map((event) => event.payload.request.settings);
      await openConversation(page, conversationId);

      // In place since the session was created: nothing is sent again.
      await sendFromComposer(page, `Which trailer does a ${profile.name} commit get?`);
      await expectFinishedReply(page, shownTrailerReply(OAR_TRAILER));
      expect(settingsRequests()).toEqual([]);

      try {
        expect((await relayApi("POST", "/api/settings/claude", { attributionMode: "off" })).status).toBe(200);
        await sendFromComposer(page, `And which trailer now, ${profile.name}?`);
        await expectFinishedReply(page, shownTrailerReply(FAKE_CLOUD_NO_TRAILER));

        // Vanilla takes the setting out again: the sandbox writes its own lines.
        expect((await relayApi("POST", "/api/settings/claude", { attributionMode: "vanilla" })).status).toBe(200);
        await sendFromComposer(page, `One more ${profile.name} trailer, please`);
        await expectFinishedReply(page, shownTrailerReply(FAKE_CLOUD_OWN_TRAILER));
        expect(settingsRequests()).toEqual([
          { attribution: { commit: "", pr: "", sessionUrl: false } },
          { attribution: null },
        ]);
      } finally {
        await relayApi("POST", "/api/settings/claude", { attributionMode: "oar" });
      }

      // The chat was started from a folder, so its 🧠 modal has that folder's override.
      await page.evaluate(() => window.showContext());
      const select = page.locator("#ctx-attribution-select");
      await expect(select).toBeVisible({ timeout: TURN_TIMEOUT });
      await expect(select).toHaveValue("");
      await expect(page.locator(".ctx-attribution-note")).toContainText(OAR_TRAILER);
      const noteBox = await page.locator(".ctx-attribution").boundingBox();
      expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
    });

    test("a question of the cloud agent is a card, and the answer resumes the turn", async ({ page }) => {
      await openConversation(page, conversationId);
      await sendFromComposer(page, `Please ask me before the ${profile.name} change`);

      const card = page.locator(".relay-question-container", { hasText: FAKE_CLOUD_QUESTION.text });
      await expect(card).toBeVisible({ timeout: TURN_TIMEOUT });
      for (const label of FAKE_CLOUD_QUESTION.labels) {
        await expect(card.getByRole("button", { name: label })).toBeVisible();
      }
      const chosen = FAKE_CLOUD_QUESTION.labels[1];
      await card.getByRole("button", { name: chosen }).click();
      await expect(card).not.toBeVisible({ timeout: TURN_TIMEOUT });
      await expectFinishedReply(page, `You chose ${chosen}.`);

      const answers = fake.postedEvents("control_response").filter((event) => event.sessionId === cloudSessionId);
      expect(answers).toHaveLength(1);
      const { response } = answers[0].payload;
      expect(response.subtype).toBe("success");
      expect(response.request_id).toBeTruthy();
      expect(response.response.behavior).toBe("allow");
      expect(response.response.updatedInput.answers).toEqual({ [FAKE_CLOUD_QUESTION.text]: chosen });
      // The questions the agent asked travel back with the answer.
      expect(response.response.updatedInput.questions[0].question).toBe(FAKE_CLOUD_QUESTION.text);
    });

    test("Stop ends a running turn with an interrupt", async ({ page }) => {
      await openConversation(page, conversationId);
      await sendFromComposer(page, `Run the slow ${profile.name} job`);

      // The reply so far is on screen while the turn is still running.
      await expect(page.locator("#thinking-stream")).toContainText(FAKE_CLOUD_SLOW_FIRST_LINE, { timeout: TURN_TIMEOUT });
      expect(fake.sessions().find((entry) => entry.id === cloudSessionId).workerStatus).toBe("running");

      await page.locator('.thinking-bubble [data-action="stop-turn"]').click();
      await page.locator('[data-stop-turn-confirm="1"]').click();
      await expect(page.locator(".thinking-bubble")).toHaveCount(0, { timeout: TURN_TIMEOUT });

      // The relay ends the row on its side; the interrupt is the worker's part
      // and what actually stops the agent in the cloud.
      const interrupts = () => fake.postedEvents("control_request")
        .filter((event) => event.sessionId === cloudSessionId && event.payload?.request?.subtype === "interrupt");
      await expect.poll(() => interrupts().length, { timeout: TURN_TIMEOUT }).toBe(1);
      expect(interrupts()[0].payload.session_id).toBe(cloudSessionId);
      await expect
        .poll(() => fake.sessions().find((entry) => entry.id === cloudSessionId).workerStatus, { timeout: TURN_TIMEOUT })
        .toBe("idle");
      // The row ends as a stopped turn, as it does for every provider.
      await expect(page.locator(".msg.assistant", { hasText: "This turn was stopped from the relay UI" })).toBeVisible();
    });

    test("a pushed branch becomes a link in the cloud line", async ({ page }) => {
      await openConversation(page, conversationId);
      // The turn after a stopped one: the session is usable again.
      await sendFromComposer(page, `Now push the ${profile.name} change`);
      const reply = await expectFinishedReply(page, `Pushed ${FAKE_CLOUD_PUSHED_BRANCH}.`);
      await expect(reply.locator(".msg-activity-item", { hasText: `pushed branch ${FAKE_CLOUD_PUSHED_BRANCH}` })).toHaveCount(1);

      const pushLink = page.locator("#cloud-session-line .cloud-line-push");
      await expect(pushLink).toHaveText(`⇡ ${FAKE_CLOUD_PUSHED_BRANCH}`);
      await expect(pushLink).toHaveAttribute(
        "href",
        `${profile.typedRepoUrl}/compare/${profile.typedBranch}...${FAKE_CLOUD_PUSHED_BRANCH}`,
      );
      // The line wraps instead of widening the composer.
      const lineBox = await page.locator("#cloud-session-line").boundingBox();
      expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(page.viewportSize().width + 1);

      // Stored, not only pushed over the socket: a reload shows it again.
      await openConversation(page, conversationId);
      await expect(page.locator("#cloud-session-line .cloud-line-push")).toHaveText(`⇡ ${FAKE_CLOUD_PUSHED_BRANCH}`);
      expect(createsFor(profile.typedRepoUrl)).toHaveLength(1);
    });

    test("a turn refused at the usage limit is paused with the reset time, like a local Claude turn", async ({ page }) => {
      await openConversation(page, conversationId);
      try {
        await sendFromComposer(page, `Hit the usage limit, ${profile.name}`);
        const banner = page.locator("#usage-limit-banner");
        await expect(banner).toBeVisible({ timeout: TURN_TIMEOUT });
        await expect(banner.locator(".usage-limit-text")).toContainText("Paused at the Claude 5-hour limit");
        await expect(banner.locator("button")).toHaveText(["Resume now", "Cancel"]);
        // The row ends with the relay's note, and the held follow-up is queued.
        await expect(page.locator(".msg.assistant", { hasText: "⏸ Paused: the Claude 5-hour limit is reached" }).last()).toBeVisible();
        const status = await relayApi("GET", "/api/status");
        expect(status.body.usageLimit.pauses.some((pause) => pause.conversationId === conversationId)).toBe(true);
      } finally {
        // Nothing may resume behind the next tests.
        await relayApi("POST", "/api/usage-limit/cancel", { conversationId });
      }
      await expect(page.locator("#usage-limit-banner")).toBeHidden({ timeout: TURN_TIMEOUT });
    });

    test("Check Usage has a Claude Cloud tab with the account's credit", async ({ page }) => {
      await openConversation(page, conversationId);
      await page.locator("#chat-actions-menu-btn").click();
      await page.locator("#chat-menu-usage").click();
      await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
      await expect(page.locator("#summary-modal-title")).toHaveText("Plan usage");

      const tab = page.locator('#summary-modal-body [data-usage-tab="claude-cloud"]');
      await expect(tab).toHaveText("Claude Cloud");
      await tab.click();
      const card = page.locator('#summary-modal-body [data-provider="claude-cloud"]');
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("data-status", "ok");

      // The dollar bucket of the fake usage body, as a meter with its expiry.
      const credit = card.locator('[data-meter-id="claude-cloud-credit-iguana_necktie"]');
      await expect(credit.locator(".plan-usage-meter-label")).toHaveText("Cloud sessions credit");
      await expect(credit.locator(".plan-usage-meter-pct")).toHaveText("15%");
      await expect(credit.locator(".plan-usage-meter-meta")).toContainText("$7.50 of $50.00 used · $42.50 left");
      await expect(credit.locator(".plan-usage-meter-meta")).toContainText("expires 2031-06-01");
      // And what this relay's cloud conversations have cost.
      await expect(card.locator('[data-meter-id="claude-cloud-spend"] .plan-usage-meter-label')).toHaveText("Cloud spend (OAR sessions)");

      const usageReads = fake.requestsTo("GET", "/api/oauth/usage");
      expect(usageReads.length).toBeGreaterThan(0);
      expect(usageReads.every((request) => request.authorized)).toBe(true);
    });

    test("deleting the conversation archives its cloud session and stops its worker", async ({ page }) => {
      await openConversation(page, conversationId);
      await showSidebar(page);
      const item = page.locator("#conv-list .conv-item.active");
      await expect(item.locator('.conv-provider-indicator[data-provider="claude-cloud"]')).toBeVisible();
      await item.hover();
      await item.locator(".conv-delete").click();

      await expect(page.locator("#chat-title")).toHaveText("Select or start a conversation", { timeout: TURN_TIMEOUT });
      await expect
        .poll(() => fake.requestsTo("POST", `/v1/code/sessions/${cloudSessionId}/archive`).length, { timeout: TURN_TIMEOUT })
        .toBe(1);
      expect(fake.sessions().find((entry) => entry.id === cloudSessionId).status).toBe("archived");
      expect((await relayApi("GET", `/api/conversation/${encodeURIComponent(conversationId)}`)).status).toBe(404);
      conversationId = "";

      // Every call of this run carried the test login and nothing else did.
      expect(fake.requests.every((request) => request.authorized)).toBe(true);
    });
  });
}
