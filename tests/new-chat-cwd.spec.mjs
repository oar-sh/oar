import { expect, test } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { relayToken } from "./e2e-env.mjs";

// New Chat modal: the working-directory picker.
//
// The bootstrap POST runs against the real test server (no request stub), so
// these tests cover the whole path: known-CWD list from /api/status recents,
// request body wiring, server-side validation, and the configured root landing
// on the created conversation.
//
// One conversion is unavoidable: the isolated server runs with
// COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN=1, so a fully valid bootstrap still 409s
// at the worker-spawn step — after the conversation and its configured root
// were created. The route tap converts exactly that failure into the success
// payload the browser would receive on a real relay; every other response
// (validation rejections included) passes through untouched.

const FAKE_RECENTS = [
  "C:\\workspaces\\alpha",
  "C:\\workspaces\\beta",
];

test.describe("New Chat modal CWD picker", () => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  let tempDir = "";
  /** Body of the bootstrap request captured by the route tap. */
  let posted = null;
  /** Parsed JSON of the real server response (pre-conversion). */
  let bootstrapResponse = null;

  test.beforeAll(() => {
    tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "new-chat-cwd-")));
  });

  test.afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    posted = null;
    bootstrapResponse = null;

    await page.route("**/api/status", async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      let body = null;
      try {
        body = await response.json();
      } catch {
        return route.fulfill({ response });
      }
      body.recentWorkspaceRoots = [tempDir, ...FAKE_RECENTS];
      return route.fulfill({ response, contentType: "application/json", body: JSON.stringify(body) });
    });

    await page.route("**/api/conversation/bootstrap", async (route) => {
      posted = route.request().postDataJSON();
      const response = await route.fetch();
      const text = await response.text();
      try {
        bootstrapResponse = JSON.parse(text);
      } catch {
        bootstrapResponse = null;
      }
      if (response.status() === 409 && bootstrapResponse?.conversationId) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, conversationId: bootstrapResponse.conversationId }),
        });
      }
      return route.fulfill({ response, body: text });
    });

    await page.addInitScript(() => {
      localStorage.setItem("copilot_model", "gpt-5.4-mini");
      localStorage.removeItem("copilot_new_chat_cwd");
    });
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
  });

  async function openNewChatModal(page) {
    await page.locator("#new-conv-btn").click();
    await expect(page.locator("#new-conversation-model-modal")).toHaveClass(/visible/);
  }

  async function fetchConversationState(request, conversationId) {
    const response = await request.get(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }

  test("lists known CWDs and seeds the selection on the new conversation", async ({ page, request }) => {
    await openNewChatModal(page);

    const cwdSelect = page.locator("#new-conversation-cwd-select");
    const optionTexts = await cwdSelect.locator("option").allTextContents();
    expect(optionTexts[0]).toMatch(/^Default/);
    expect(optionTexts[optionTexts.length - 1]).toBe("Custom path…");
    expect(optionTexts).toContain(tempDir);
    for (const recent of FAKE_RECENTS) {
      expect(optionTexts).toContain(recent);
    }

    await cwdSelect.selectOption(tempDir);
    await expect(page.locator("#new-conversation-cwd-status")).toContainText(tempDir);
    // The manual input belongs to "Custom path…" only.
    await expect(page.locator("#new-conversation-cwd-manual")).toBeHidden();

    await page.locator("#new-conversation-model-confirm").click();
    await expect(page.locator("#new-conversation-model-modal")).not.toHaveClass(/visible/);
    expect(posted?.workspaceRootPath).toBe(tempDir);

    const conversationId = String(bootstrapResponse?.conversationId || "");
    expect(conversationId).toBeTruthy();
    const state = await fetchConversationState(request, conversationId);
    expect(state.configuredWorkspaceRootPath).toBe(tempDir);
  });

  test("custom path reveals the manual input and is submitted", async ({ page, request }) => {
    await openNewChatModal(page);

    const cwdSelect = page.locator("#new-conversation-cwd-select");
    await cwdSelect.selectOption("__custom__");
    const manual = page.locator("#new-conversation-cwd-manual");
    await expect(manual).toBeVisible();
    await manual.fill(tempDir);
    await expect(page.locator("#new-conversation-cwd-status")).toContainText(tempDir);

    await page.locator("#new-conversation-model-confirm").click();
    await expect(page.locator("#new-conversation-model-modal")).not.toHaveClass(/visible/);
    expect(posted?.workspaceRootPath).toBe(tempDir);

    const conversationId = String(bootstrapResponse?.conversationId || "");
    expect(conversationId).toBeTruthy();
    const state = await fetchConversationState(request, conversationId);
    expect(state.configuredWorkspaceRootPath).toBe(tempDir);
  });

  test("a rejected directory keeps the modal open for another attempt", async ({ page }) => {
    await openNewChatModal(page);

    const missingDir = path.join(os.tmpdir(), "new-chat-cwd-missing", "nested");
    await page.locator("#new-conversation-cwd-select").selectOption("__custom__");
    await page.locator("#new-conversation-cwd-manual").fill(missingDir);
    await page.locator("#new-conversation-model-confirm").click();

    // posted is captured before the server round-trip, so poll on the response.
    await expect.poll(() => bootstrapResponse !== null).toBe(true);
    expect(posted?.workspaceRootPath).toBe(missingDir);
    expect(bootstrapResponse?.ok).toBe(false);
    expect(bootstrapResponse?.code).toBe("root-path-not-found");
    // The modal must survive the rejection with the selection intact.
    await expect(page.locator("#new-conversation-model-modal")).toHaveClass(/visible/);
    await expect(page.locator("#new-conversation-cwd-manual")).toHaveValue(missingDir);
  });

  test("the Default option sends no workspace root", async ({ page, request }) => {
    await openNewChatModal(page);

    await page.locator("#new-conversation-cwd-select").selectOption("");
    await page.locator("#new-conversation-model-confirm").click();
    await expect(page.locator("#new-conversation-model-modal")).not.toHaveClass(/visible/);
    expect(posted).not.toBeNull();
    expect(posted.workspaceRootPath).toBeUndefined();

    const conversationId = String(bootstrapResponse?.conversationId || "");
    expect(conversationId).toBeTruthy();
    const state = await fetchConversationState(request, conversationId);
    expect(state.configuredWorkspaceRootPath).toBeNull();
  });
});
