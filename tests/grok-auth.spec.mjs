import fs from "fs";

import { expect, test } from "@playwright/test";
import {
  relayBaseUrl,
  relayGrokAuthFile,
  relayGrokLoginAuthorizedFile,
  relayGrokLoginDeniedFile,
  relayToken,
} from "./e2e-env.mjs";

/**
 * Grok account management (Settings → Providers → Grok) end to end through the
 * real UI.
 *
 * The relay talks to `server/services/fixtures/grok-stub.sh` instead of the real
 * CLI (GROK_CLI_COMMAND, wired in tests/relay-server-harness.mjs), so the host's
 * own Grok login is never touched — least of all by `grok logout`, which would
 * sign the developer's machine out. "Signed in" means a fake auth.json exists
 * under the test server's isolated HOME, which is exactly what
 * readGrokCliAuthKey() reads on the relay side.
 *
 * The device-code flow has no code to paste back: the CLI prints a URL carrying
 * the code, polls x.ai itself, and exits when the browser authorises. The stub's
 * stand-in for that browser is a sentinel file — dropping it is what a phone tap
 * looks like from here, and the panel has to flip on its own when it lands.
 */

// Must match GROK_STUB_DEVICE_CODE / GROK_STUB_DEVICE_URL's defaults in the stub.
const STUB_DEVICE_CODE = "D7SV-M4TR";
const STUB_DEVICE_URL = `https://accounts.x.ai/oauth2/device?user_code=${STUB_DEVICE_CODE}`;

function authHeaders() {
  return { Authorization: `Bearer ${relayToken()}` };
}

async function loadApp(page) {
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
}

async function openGrokSettings(page) {
  await page.evaluate(() => window.openSettingsModal("providers", "grok"));
  await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
  await expect(page.locator("#settings-provider-panel-grok")).toBeVisible();
}

// The relay caches the account status for a few seconds, so a change made
// outside the UI needs a re-read rather than a single assertion. Reopening the
// modal re-runs the status fetch that feeds the account row.
async function expectAccountText(page, pattern) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.openSettingsModal("providers", "grok"));
        return page.locator("#grok-auth-account").textContent();
      },
      { timeout: 20_000 },
    )
    .toMatch(pattern);
}

const account = (page) => page.locator("#grok-auth-account");
const signInBtn = (page) => page.locator("#grok-auth-signin-btn");
const logoutBtn = (page) => page.locator("#grok-auth-logout-btn");
const loginArea = (page) => page.locator("#grok-auth-login-area");
const loginStatus = (page) => page.locator("#grok-auth-login-status");
const urlLink = (page) => page.locator("#grok-auth-url-link");
const userCode = (page) => page.locator("#grok-auth-user-code");
const cancelBtn = (page) => page.locator("#grok-auth-cancel-btn");

/** No browser has authorised anything yet: the stub must sit and poll. */
function clearLoginSentinels() {
  fs.rmSync(relayGrokLoginAuthorizedFile(), { force: true });
  fs.rmSync(relayGrokLoginDeniedFile(), { force: true });
}

async function startSignIn(page) {
  await signInBtn(page).click();
  await expect(loginArea(page)).toBeVisible();
  // The stub prints the device banner immediately; the relay pushes
  // awaiting_authorization over the socket as soon as it scrapes the URL.
  await expect(urlLink(page)).toBeVisible();
}

async function cancelSignIn(page) {
  await cancelBtn(page).click();
  await expect(loginArea(page)).toBeHidden();
  await expect(signInBtn(page)).toBeEnabled();
}

test.describe.serial("Grok account auth", () => {
  test.beforeAll(() => {
    // Start from a known signed-out host regardless of spec order.
    fs.rmSync(relayGrokAuthFile(), { force: true });
    clearLoginSentinels();
  });

  test.afterAll(async () => {
    clearLoginSentinels();
    await fetch(`${relayBaseUrl()}/api/grok/auth/login/cancel`, {
      method: "POST",
      headers: authHeaders(),
    }).catch(() => {});
  });

  test("the account row reports the signed-out host and offers Sign in", async ({ page }) => {
    await loadApp(page);
    await openGrokSettings(page);

    await expectAccountText(page, /Not signed in/i);
    await expect(account(page)).toHaveAttribute("data-state", "unconfigured");
    await expect(signInBtn(page)).toBeEnabled();
    // Nothing to sign out of yet.
    await expect(logoutBtn(page)).toBeDisabled();
    await expect(loginArea(page)).toBeHidden();
  });

  test("Sign in surfaces the device link, a Copy button and the code to confirm", async ({ page }) => {
    clearLoginSentinels();
    await loadApp(page);
    await openGrokSettings(page);
    await startSignIn(page);

    const href = await urlLink(page).getAttribute("href");
    expect(href).toBe(STUB_DEVICE_URL);
    const shown = (await urlLink(page).textContent()) || "";
    expect(shown.trim()).toBe(STUB_DEVICE_URL);
    // The CLI prints one grey (SGR 90) warning line in the same banner; the
    // relay must strip every escape before the link reaches the browser.
    expect(shown).not.toContain("\u001b");

    // The code is shown so it can be checked against what the browser displays —
    // never typed back, which is the whole state this flow drops versus Claude's.
    await expect(userCode(page)).toHaveText(STUB_DEVICE_CODE);
    await expect(page.locator("#grok-auth-copy-btn")).toBeVisible();
    await expect(page.locator("#grok-auth-code-input")).toHaveCount(0);
    await expect(loginStatus(page)).toContainText(/a phone works/i);

    // A login session owns the CLI: no second sign-in, no sign-out underneath it.
    await expect(signInBtn(page)).toBeDisabled();
    await expect(logoutBtn(page)).toBeDisabled();

    await cancelSignIn(page);
    // Aborting mid-poll leaves no half-written credential behind.
    expect(fs.existsSync(relayGrokAuthFile())).toBe(false);
  });

  test("authorising in the browser flips the panel to signed in on its own", async ({ page }) => {
    clearLoginSentinels();
    await loadApp(page);
    await openGrokSettings(page);
    await startSignIn(page);

    // What a tap on the phone looks like from here: the CLI's poll completes and
    // it exits 0. Nothing is submitted through the relay.
    fs.writeFileSync(relayGrokLoginAuthorizedFile(), "");

    await expect(loginStatus(page)).toContainText(/Signed in to Grok/i, { timeout: 20_000 });
    await expect(loginStatus(page)).toHaveAttribute("data-state", "active");
    // The account row re-reads the host status after a successful sign-in.
    await expect(account(page)).toHaveAttribute("data-state", "active");
    await expect(account(page)).toContainText(/Signed in/i);
    await expect(logoutBtn(page)).toBeEnabled();
    // The CLI really wrote the (fake) host credentials.
    expect(fs.existsSync(relayGrokAuthFile())).toBe(true);

    // The success line lingers briefly and then the login area folds away.
    await expect(loginArea(page)).toBeHidden({ timeout: 10_000 });
  });

  test("Sign out confirms with the running-worker warning before clearing the account", async ({ page }) => {
    await loadApp(page);
    await openGrokSettings(page);
    await expectAccountText(page, /Signed in/i);

    await logoutBtn(page).click();
    const dialog = page.locator("#summary-modal");
    await expect(dialog).toHaveClass(/visible/);
    await expect(page.locator("#summary-modal-title")).toHaveText(/Sign out of Grok/i);
    // Worker count sentence: no Grok workers run in the e2e server, but the
    // assertion also accepts the populated wording.
    await expect(page.locator("#summary-modal-body")).toContainText(
      /No Grok workers are running|Grok workers? (is|are) currently running/,
    );
    await expect(page.locator("#summary-modal-body")).toContainText(
      /new Grok turns will fail until you sign in again/,
    );

    await page.locator("#summary-modal-body button", { hasText: "Sign out" }).click();
    await expect(dialog).not.toHaveClass(/visible/);

    await expect(account(page)).toContainText(/Not signed in/i);
    await expect(logoutBtn(page)).toBeDisabled();
    await expect(signInBtn(page)).toBeEnabled();
    // `grok logout` really ran: the host auth store is gone.
    expect(fs.existsSync(relayGrokAuthFile())).toBe(false);
  });

  test("a refused authorization shows the CLI's own reason and offers Dismiss", async ({ page }) => {
    clearLoginSentinels();
    await loadApp(page);
    await openGrokSettings(page);
    await startSignIn(page);

    // The other half of the browser stand-in: the device code is refused, and
    // the CLI exits non-zero.
    fs.writeFileSync(relayGrokLoginDeniedFile(), "");

    await expect(loginStatus(page)).toHaveAttribute("data-state", "error", { timeout: 20_000 });
    await expect(loginStatus(page)).toContainText(/device code expired/i);
    await expect(signInBtn(page)).toBeEnabled();
    expect(fs.existsSync(relayGrokAuthFile())).toBe(false);

    // The failed session is dismissed through the same route a cancel uses.
    await expect(cancelBtn(page)).toHaveText("Dismiss");
    await cancelSignIn(page);
  });

  test("sign-out is refused with 409 while a login session is active", async ({ request }) => {
    clearLoginSentinels();
    const started = await request.post(`${relayBaseUrl()}/api/grok/auth/login/start`, {
      headers: authHeaders(),
    });
    expect(started.ok()).toBe(true);

    const refused = await request.post(`${relayBaseUrl()}/api/grok/auth/logout`, {
      headers: authHeaders(),
    });
    expect(refused.status()).toBe(409);
    expect(String((await refused.json()).error || "")).toMatch(/login/i);

    const cancelled = await request.post(`${relayBaseUrl()}/api/grok/auth/login/cancel`, {
      headers: authHeaders(),
    });
    expect(cancelled.ok()).toBe(true);
    expect((await cancelled.json()).login.state).toBe("idle");
  });

  test("the Grok auth endpoints reject unauthenticated access", async ({ request }) => {
    const response = await request.get(`${relayBaseUrl()}/api/grok/auth/status`);
    expect(response.status()).toBe(401);
  });
});
