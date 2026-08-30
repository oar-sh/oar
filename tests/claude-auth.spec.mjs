import fs from "fs";

import { expect, test } from "@playwright/test";
import { relayBaseUrl, relayClaudeCredFile, relayToken } from "./e2e-env.mjs";

// Claude account management (Settings → Providers → Claude) end to end through
// the real UI. The relay talks to `server/services/fixtures/claude-auth-stub.sh`
// instead of the real CLI (COPILOT_WEB_RELAY_CLAUDE_AUTH_BIN, wired in
// tests/run-e2e.mjs), so the host's own Claude login is never touched: the stub
// treats a file under the test server's isolated CLAUDE_CONFIG_DIR as the
// credentials, accepts the code `goodcode` and rejects everything else.

// Must match CLAUDE_AUTH_STUB_URL's default in the stub script.
const STUB_AUTH_URL_PREFIX = "https://claude.com/oauth/authorize?code=true&client_id=stub-client";
const STUB_EMAIL = "stub@example.com";

function authHeaders() {
  return { Authorization: `Bearer ${relayToken()}` };
}

async function loadApp(page) {
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
}

async function openClaudeSettings(page) {
  await page.evaluate(() => window.openSettingsModal("providers", "claude"));
  await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
  await expect(page.locator("#settings-provider-panel-claude")).toBeVisible();
}

// The relay caches `auth status` for a few seconds, so a credentials change made
// outside the UI needs a re-read rather than a single assertion. Reopening the
// modal re-runs the status fetch that feeds the account row.
async function expectAccountText(page, pattern) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.openSettingsModal("providers", "claude"));
        return page.locator("#claude-auth-account").textContent();
      },
      { timeout: 20_000 },
    )
    .toMatch(pattern);
}

const account = (page) => page.locator("#claude-auth-account");
const reloginBtn = (page) => page.locator("#claude-auth-relogin-btn");
const logoutBtn = (page) => page.locator("#claude-auth-logout-btn");
const loginArea = (page) => page.locator("#claude-auth-login-area");
const loginStatus = (page) => page.locator("#claude-auth-login-status");
const urlLink = (page) => page.locator("#claude-auth-url-link");
const codeInput = (page) => page.locator("#claude-auth-code-input");

async function startRelogin(page) {
  await reloginBtn(page).click();
  await expect(loginArea(page)).toBeVisible();
  // The stub prints the authorize URL immediately; the relay pushes
  // awaiting_code over the socket as soon as it scrapes it.
  await expect(urlLink(page)).toBeVisible();
  await expect(codeInput(page)).toBeVisible();
}

test.describe.serial("Claude account auth", () => {
  test.beforeAll(() => {
    // Start from a known logged-out host regardless of spec order.
    fs.rmSync(relayClaudeCredFile(), { force: true });
  });

  test("the account row reports the logged-out host and offers Relogin", async ({ page }) => {
    await loadApp(page);
    await openClaudeSettings(page);

    await expectAccountText(page, /Not logged in/i);
    await expect(reloginBtn(page)).toBeEnabled();
    // Nothing to log out of yet.
    await expect(logoutBtn(page)).toBeDisabled();
    await expect(loginArea(page)).toBeHidden();
  });

  test("Relogin surfaces the authorize link, a Copy button and a code input", async ({ page }) => {
    await loadApp(page);
    await openClaudeSettings(page);
    await startRelogin(page);

    const href = await urlLink(page).getAttribute("href");
    expect(href).toContain(STUB_AUTH_URL_PREFIX);
    // The CLI wraps the URL in OSC-8 + SGR escapes; the relay must strip them
    // before the link ever reaches the browser.
    const shown = (await urlLink(page).textContent()) || "";
    expect(shown).toContain(STUB_AUTH_URL_PREFIX);
    expect(shown).not.toContain("\u001b");
    expect(shown).not.toContain("\u0007");
    expect(shown.trim()).toBe(href?.trim());

    await expect(page.locator("#claude-auth-copy-btn")).toBeVisible();
    await expect(page.locator("#claude-auth-submit-btn")).toBeVisible();
    await expect(page.locator("#claude-auth-cancel-btn")).toBeVisible();
    await expect(loginStatus(page)).toContainText(/paste the code/i);
    // A login session owns the CLI: no second login, no logout underneath it.
    await expect(reloginBtn(page)).toBeDisabled();
    await expect(logoutBtn(page)).toBeDisabled();

    await page.locator("#claude-auth-cancel-btn").click();
    await expect(loginArea(page)).toBeHidden();
    await expect(reloginBtn(page)).toBeEnabled();
  });

  test("a rejected code shows the error and re-enables Relogin", async ({ page }) => {
    await loadApp(page);
    await openClaudeSettings(page);
    await startRelogin(page);

    await codeInput(page).fill("wrongcode");
    await page.locator("#claude-auth-submit-btn").click();

    await expect(loginStatus(page)).toHaveAttribute("data-state", "error");
    await expect(loginStatus(page)).toContainText(/invalid|expired|failed/i);
    await expect(reloginBtn(page)).toBeEnabled();
    // The rejected code is not left sitting in the DOM.
    await expect(codeInput(page)).toHaveValue("");
    expect(fs.existsSync(relayClaudeCredFile())).toBe(false);
  });

  test("submitting the valid code logs in and refreshes the account row", async ({ page }) => {
    await loadApp(page);
    await openClaudeSettings(page);
    await startRelogin(page);

    await codeInput(page).fill("goodcode");
    await page.locator("#claude-auth-submit-btn").click();

    await expect(loginStatus(page)).toContainText(new RegExp(`Logged in as ${STUB_EMAIL}`, "i"));
    await expect(loginStatus(page)).toHaveAttribute("data-state", "active");
    // The account row re-reads the host status after a successful login.
    await expect(account(page)).toContainText(STUB_EMAIL);
    await expect(account(page)).toContainText(/Max plan/i);
    await expect(account(page)).toHaveAttribute("data-state", "active");
    await expect(logoutBtn(page)).toBeEnabled();
    // The CLI really wrote the (fake) host credentials.
    expect(fs.existsSync(relayClaudeCredFile())).toBe(true);

    // The success line lingers briefly and then the login area folds away.
    await expect(loginArea(page)).toBeHidden({ timeout: 10_000 });
  });

  test("Logout confirms with the running-worker warning before clearing the account", async ({ page }) => {
    await loadApp(page);
    await openClaudeSettings(page);
    await expectAccountText(page, new RegExp(STUB_EMAIL));

    await logoutBtn(page).click();
    const dialog = page.locator("#summary-modal");
    await expect(dialog).toHaveClass(/visible/);
    await expect(page.locator("#summary-modal-title")).toContainText(/Log out of Claude/i);
    await expect(page.locator("#summary-modal-body")).toContainText(STUB_EMAIL);
    // Worker count sentence: no Claude workers run in the e2e server, but the
    // assertion also accepts the populated wording.
    await expect(page.locator("#summary-modal-body")).toContainText(
      /No Claude workers are running|Claude workers? (is|are) currently running/,
    );

    await page.locator("#summary-modal-body button", { hasText: "Log out" }).click();
    await expect(dialog).not.toHaveClass(/visible/);

    await expect(account(page)).toContainText(/Not logged in/i);
    await expect(logoutBtn(page)).toBeDisabled();
    await expect(reloginBtn(page)).toBeEnabled();
    expect(fs.existsSync(relayClaudeCredFile())).toBe(false);
  });

  test("logout is refused with 409 while a login session is active", async ({ request }) => {
    const started = await request.post(`${relayBaseUrl()}/api/claude/auth/login/start`, {
      headers: authHeaders(),
    });
    expect(started.ok()).toBe(true);

    const refused = await request.post(`${relayBaseUrl()}/api/claude/auth/logout`, {
      headers: authHeaders(),
    });
    expect(refused.status()).toBe(409);
    expect(String((await refused.json()).error || "")).toMatch(/login/i);

    const cancelled = await request.post(`${relayBaseUrl()}/api/claude/auth/login/cancel`, {
      headers: authHeaders(),
    });
    expect(cancelled.ok()).toBe(true);
    expect((await cancelled.json()).login.state).toBe("idle");
  });

  test("the Claude auth endpoints reject unauthenticated access", async ({ request }) => {
    const response = await request.get(`${relayBaseUrl()}/api/claude/auth/status`);
    expect(response.status()).toBe(401);
  });
});
