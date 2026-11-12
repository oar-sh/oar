import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { startRelayServer } from "./relay-server-harness.mjs";
import { localhostOrigin } from "./helpers/browser-signin.mjs";

/**
 * Settings → Security, end to end, on a relay of its own (a new relay token
 * would lock every other spec out of the shared one):
 *
 * - signed in with the relay token, the tab lists this browser, tagged;
 * - Rename stores a name;
 * - a sign-in link signs a second browser in, once: a third one gets the
 *   sign-in box;
 * - signing that second browser out from here gives it "This browser was
 *   signed out";
 * - "Generate new relay token" shows the token once; after the dialog closes
 *   it is nowhere in the page, the old token is refused to a new browser,
 *   and this browser stays signed in.
 * - security UX (agent auth §13.5): the QR code of a sign-in link shows only
 *   after a tap and hides when the link is used and after a minute; the
 *   "Recommended" dot stays on the Security tab until the token is replaced;
 *   the token dialog is a form ("Save in password manager") that leaves no
 *   trace in the address, the history or the storage; it names the old
 *   token's last non-browser use, and each paired relay still on it gets
 *   "Open there" to its Settings → Relays → Add a relay, with no token in it.
 *
 * No screenshot, video or trace: the token and the link must not end up in
 * a test artefact. Their values are only compared, never printed.
 */

const TOKEN_SHAPE = /^oaro1_[A-Za-z0-9_-]{43}$/;
const SIGNIN_LINK_SHAPE = /\/\?signin=oarc1_[A-Za-z0-9_-]{43}$/;

test.use({ screenshot: "off", video: "off", trace: "off" });

test.describe.serial("Settings → Security", () => {
  test.describe.configure({ timeout: 120_000, retries: 0 });

  let relay = null;
  let main = null;
  let mainPage = null;
  let signinLink = "";
  let second = null;
  let secondPage = null;

  test.beforeAll(async ({ browser }) => {
    relay = await startRelayServer({ token: randomUUID() });
    main = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    mainPage = await main.newPage();
  });

  test.afterAll(async () => {
    signinLink = "";
    await second?.close().catch(() => {});
    await main?.close().catch(() => {});
    if (relay) await relay.stop();
    relay = null;
  });

  async function waitForApp(page) {
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await expect(page.locator("#app")).toHaveClass(/visible/);
    await expect(page.locator("#auth-gate")).toBeHidden();
  }

  async function openSecurity(page) {
    const loaded = page.waitForResponse((response) => response.url().endsWith("/api/auth/sessions")
      && response.request().method() === "GET");
    await page.evaluate(() => window.openSettingsModal("security"));
    await loaded;
    await expect(page.locator("#settings-panel-security")).toBeVisible();
  }

  const sessionRows = (page) => page.locator("#security-session-list .security-session-row");

  test("signed in with the relay token, the Security tab lists this browser", async () => {
    await mainPage.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await waitForApp(mainPage);
    // The token left the address.
    expect(new URL(mainPage.url()).search).toBe("");
    await openSecurity(mainPage);
    await expect(sessionRows(mainPage)).toHaveCount(1);
    const mine = sessionRows(mainPage).first();
    await expect(mine).toHaveAttribute("data-current", "true");
    await expect(mine.locator(".security-current-tag")).toHaveText("this browser");
    await expect(mine.locator(".security-session-meta")).toContainText("with the relay token");
    await expect(mine.locator(".security-session-meta")).toContainText("last seen just now");
    await expect(mainPage.locator("#security-token-status")).toContainText("Set, stored as a hash.");
    await expect(mainPage.locator("#security-signout-others-btn")).toBeDisabled();
    // 3b: given its token on the command line, the relay recommends a new
    // one; its banner was dismissed (the harness), the quiet dot stays.
    const dot = mainPage.locator("#settings-tab-security .settings-tab-dot");
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute("aria-label", "Recommended");
    await expect(mainPage.locator("#security-token-recommended")).toBeVisible();
  });

  test("Rename stores a name for this browser", async () => {
    await sessionRows(mainPage).first().locator(".security-rename-btn").click();
    const input = mainPage.locator("#security-rename-input");
    await expect(input).toBeVisible();
    await input.fill("Desk browser");
    await mainPage.locator("#security-rename-save").click();
    await expect(mainPage.locator("#summary-modal")).not.toHaveClass(/visible/);
    await expect(sessionRows(mainPage).first().locator(".security-session-name")).toHaveText(/^Desk browser this browser$/);
    // Stored by the relay: a fresh read has it.
    const names = await mainPage.evaluate(async () => {
      // The cookie alone is refused (a page on another port gets it too): the session's key goes along.
      const response = await fetch("api/auth/sessions", { credentials: "same-origin", headers: { "X-OAR-Session-Proof": localStorage.getItem("oar_session_proof") || "" } });
      return (await response.json()).sessions.map((row) => row.label);
    });
    expect(names).toEqual(["Desk browser"]);
  });

  test("a sign-in link signs a second browser in, once", async ({ browser }) => {
    await mainPage.locator("#security-signin-code-btn").click();
    await expect(mainPage.locator("#security-signin-code")).toBeVisible();
    await expect(mainPage.locator("#security-signin-expiry")).toHaveText(/^Works once, until .+ \((10|9) min left\)\.$/);
    signinLink = await mainPage.locator("#security-signin-link").inputValue();
    expect(SIGNIN_LINK_SHAPE.test(signinLink), "the field holds a sign-in link").toBe(true);
    // The QR code: only after a tap, drawn with its quiet zone.
    const qrButton = mainPage.locator("#security-signin-qr-btn");
    await expect(mainPage.locator("#security-signin-qr")).toBeHidden();
    await expect(qrButton).toHaveAttribute("aria-expanded", "false");
    await qrButton.click();
    await expect(qrButton).toHaveAttribute("aria-expanded", "true");
    await expect(mainPage.locator("#security-signin-qr")).toBeVisible();
    expect(await mainPage.locator("#security-signin-qr-canvas").evaluate((canvas) => canvas.width)).toBeGreaterThan(0);

    second = await browser.newContext({ viewport: { width: 390, height: 844 } });
    secondPage = await second.newPage();
    await secondPage.goto(signinLink);
    await waitForApp(secondPage);
    expect(new URL(secondPage.url()).search, "the code left the address").toBe("");
    // Used: the link and its QR code leave this page.
    await expect(mainPage.locator("#security-signin-qr")).toBeHidden({ timeout: 15_000 });
    await expect(mainPage.locator("#security-signin-code")).toBeHidden();
    expect(await mainPage.locator("#security-signin-qr-canvas").evaluate((canvas) => canvas.width)).toBe(0);

    // Used: a third browser with the same link gets the sign-in box.
    const third = await browser.newContext();
    try {
      const thirdPage = await third.newPage();
      await thirdPage.goto(signinLink);
      await expect(thirdPage.locator("#auth-gate")).toBeVisible();
      await expect(thirdPage.locator("#app")).not.toHaveClass(/visible/);
    } finally {
      await third.close();
    }
    signinLink = "";

    // Listed here, signed in with the link.
    await openSecurity(mainPage);
    await expect(sessionRows(mainPage)).toHaveCount(2);
    const other = sessionRows(mainPage).nth(1);
    await expect(other).not.toHaveAttribute("data-current", "true");
    await expect(other.locator(".security-session-meta")).toContainText("with a sign-in link");
  });

  test("signing the second browser out from here gives it the signed-out gate", async () => {
    const other = sessionRows(mainPage).nth(1);
    await other.locator(".security-signout-btn").click();
    await expect(mainPage.locator("#summary-modal-title")).toHaveText("Sign out browser");
    await mainPage.locator("#security-confirm-btn").click();
    await expect(sessionRows(mainPage)).toHaveCount(1);
    await expect(mainPage.locator("#relay-toast")).toContainText("Signed out");

    // Its next call is refused: the sign-in box, with the reason, over an
    // open Settings dialog too.
    await secondPage.evaluate(() => window.openSettingsModal("security"));
    await expect(secondPage.locator("#auth-gate")).toBeVisible();
    await expect(secondPage.locator("#auth-error")).toHaveText("This browser was signed out");
    await expect(secondPage.locator("#settings-modal")).not.toHaveClass(/visible/);
    await expect(secondPage.locator("#app")).not.toHaveClass(/visible/);
    // This browser is not affected.
    await expect(mainPage.locator("#auth-gate")).toBeHidden();
  });

  test("a new relay token: shown once, the old one refused, this browser stays signed in", async ({ browser }) => {
    const oldToken = relay.token;
    await mainPage.locator("#security-rotate-btn").click();
    await expect(mainPage.locator("#summary-modal-body")).toContainText(
      "The current token stops working at once. Signed-in browsers stay signed in; agents keep working.",
    );
    await mainPage.locator("#security-confirm-btn").click();
    await expect(mainPage.locator("#summary-modal-title")).toHaveText("New relay token");
    await expect(mainPage.locator("#summary-modal-body")).toContainText("Shown once. Keep it in your password manager.");
    await expect(mainPage.locator("#summary-modal-body")).toContainText("No paired relay uses this relay's token.");
    // The harness's own calls used the token without a browser page.
    await expect(mainPage.locator(".security-token-last-use")).toHaveText(/^Owner token last used by a non-browser client: .+, from .+\.$/);
    await expect(mainPage.locator("#security-new-token")).toHaveAttribute("type", "password");
    expect(await mainPage.locator("#security-new-token").evaluate((input) => input.hasAttribute("name"))).toBe(false);
    let newToken = await mainPage.locator("#security-new-token").inputValue();
    expect(TOKEN_SHAPE.test(newToken), "the dialog shows a relay token").toBe(true);
    expect(newToken === oldToken).toBe(false);
    const pairingLinkHasToken = await mainPage.locator("#security-pairing-link")
      .evaluate((input, value) => input.value.endsWith(`/?token=${encodeURIComponent(value)}`), newToken);
    expect(pairingLinkHasToken).toBe(true);

    await mainPage.locator("#security-token-done-btn").click();
    await expect(mainPage.locator("#summary-modal")).not.toHaveClass(/visible/);
    const leftInPage = await mainPage.evaluate((value) => document.documentElement.outerHTML.includes(value)
      || [...document.querySelectorAll("input, textarea")].some((field) => field.value.includes(value)), newToken);
    expect(leftInPage, "the token is gone from the page").toBe(false);
    const leftElsewhere = await mainPage.evaluate((value) => location.href.includes(value)
      || JSON.stringify(history.state ?? null).includes(value)
      || JSON.stringify({ ...localStorage }).includes(value)
      || JSON.stringify({ ...sessionStorage }).includes(value), newToken);
    expect(leftElsewhere, "nor in the address, the history state or the storage").toBe(false);
    // 3b: replaced, so no longer recommended.
    await expect(mainPage.locator("#settings-tab-security .settings-tab-dot")).toHaveCount(0);
    await expect(mainPage.locator("#security-token-recommended")).toBeHidden();
    await expect(mainPage.locator("#security-token-status")).toContainText("Last replaced just now.");

    // The old token: refused to a new browser and to a script.
    const fresh = await browser.newContext();
    try {
      const freshPage = await fresh.newPage();
      await freshPage.goto(`${relay.baseUrl}/?token=${encodeURIComponent(oldToken)}`);
      await expect(freshPage.locator("#auth-gate")).toBeVisible();
      await expect(freshPage.locator("#app")).not.toHaveClass(/visible/);
    } finally {
      await fresh.close();
    }
    const byScript = await fetch(`${relay.baseUrl}/api/status`, { headers: { Authorization: `Bearer ${oldToken}` } });
    expect(byScript.status).toBe(401);
    const withNew = await fetch(`${relay.baseUrl}/api/status`, { headers: { Authorization: `Bearer ${newToken}` } });
    expect(withNew.status).toBe(200);
    // The harness stops the relay with its process; nothing else needs it.
    newToken = "";

    // This browser: still signed in, after a reload too.
    await mainPage.reload();
    await waitForApp(mainPage);
    await openSecurity(mainPage);
    await expect(sessionRows(mainPage)).toHaveCount(1);
    await expect(sessionRows(mainPage).first().locator(".security-session-name")).toHaveText(/^Desk browser this browser$/);
  });
});

test.describe.serial("Settings → Security: the QR code and the rotation dialog's relays", () => {
  test.describe.configure({ timeout: 150_000, retries: 0 });

  let relay = null;
  let relayB = null;
  let context = null;
  let page = null;

  test.beforeAll(async ({ browser }) => {
    relay = await startRelayServer({ token: randomUUID() });
    relayB = await startRelayServer({ token: randomUUID() });
    const named = await fetch(`${relayB.baseUrl}/api/settings/pwa-app-name`, {
      method: "POST",
      headers: { Authorization: `Bearer ${relayB.token}`, "content-type": "application/json" },
      body: JSON.stringify({ appName: "linux-test" }),
    });
    expect(named.status).toBe(200);
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    // Signed in with a sign-in link, on `localhost`.
    const minted = await fetch(`${relay.baseUrl}/api/auth/signin-codes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
      body: "{}",
    });
    const { code } = await minted.json();
    await page.goto(`${localhostOrigin(relay)}/?signin=${encodeURIComponent(code)}`);
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await expect(page.locator("#app")).toHaveClass(/visible/);
  });

  test.afterAll(async () => {
    await context?.close().catch(() => {});
    await Promise.all([relay?.stop(), relayB?.stop()]);
    relay = null;
    relayB = null;
  });

  test("the QR code hides after a minute, and when the page goes to the background", async () => {
    test.setTimeout(150_000);
    await page.evaluate(() => window.openSettingsModal("security"));
    await page.locator("#security-signin-code-btn").click();
    await expect(page.locator("#security-signin-code")).toBeVisible();
    const qr = page.locator("#security-signin-qr");
    await page.locator("#security-signin-qr-btn").click();
    await expect(qr).toBeVisible();
    // Another tab or app.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      delete document.visibilityState;
    });
    await expect(qr).toBeHidden();
    // A minute on screen.
    await page.locator("#security-signin-qr-btn").click();
    await expect(qr).toBeVisible();
    await page.waitForTimeout(55_000);
    await expect(qr).toBeVisible();
    await expect(qr).toBeHidden({ timeout: 15_000 });
    await expect(page.locator("#security-signin-qr-btn")).toHaveAttribute("aria-expanded", "false");
    // Hide by hand.
    await page.locator("#security-signin-qr-btn").click();
    await expect(qr).toBeVisible();
    await page.locator("#security-signin-qr-btn").click();
    await expect(qr).toBeHidden();
  });

  test("the rotation dialog: Open there for a relay still on the token, no token in it; Save in password manager leaves no trace", async () => {
    // B is added here without pairing back: it signs in with no key of this
    // relay's, so a new token leaves it on the old one.
    // The add probes B with B's token, sent once and never kept in the page.
    const added = await page.evaluate(async ({ url, token }) => {
      const response = await fetch("api/remote-relays", {
        method: "POST",
        credentials: "same-origin",
        // The cookie alone is refused: the session's key goes along.
        headers: { "content-type": "application/json", "X-OAR-Session-Proof": localStorage.getItem("oar_session_proof") || "" },
        body: JSON.stringify({ url, token, pairBack: false }),
      });
      return { status: response.status, ok: (await response.json().catch(() => null))?.ok === true };
    }, { url: relayB.baseUrl, token: relayB.token });
    expect(added.ok, `adding B: ${added.status}`).toBe(true);
    await page.evaluate(() => window.openSettingsModal("security"));
    await page.locator("#security-rotate-btn").click();
    await page.locator("#security-confirm-btn").click();
    await expect(page.locator("#summary-modal-title")).toHaveText("New relay token");
    const body = page.locator("#summary-modal-body");
    await expect(body.locator(".security-token-last-use")).toHaveText(/^Owner token last used by a non-browser client: .+\.$/);
    const item = body.locator(".security-affected-relays li", { hasText: "linux-test" });
    await expect(item).toHaveCount(1);
    const open = item.locator(".security-affected-open");
    await expect(open).toHaveText("Open there");
    await expect(open).toHaveAttribute("href", `${relayB.baseUrl}/?settings=relays&add-relay=1`);
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("rel", "noopener noreferrer");
    await expect(body.locator(".security-clipboard-hint")).toContainText("clear it once you have pasted it");
    await expect(page.locator("#security-token-user")).toHaveValue(/.+/);

    const token = await page.locator("#security-new-token").inputValue();
    expect(TOKEN_SHAPE.test(token)).toBe(true);
    const href = await open.getAttribute("href");
    expect(href.includes(token), "Open there carries no token").toBe(false);

    // Open there: B's Settings → Relays with the Add a relay form, nothing filled in.
    const opened = context.waitForEvent("page");
    await open.click();
    const there = await opened;
    try {
      await there.waitForLoadState("domcontentloaded");
      expect(new URL(there.url()).searchParams.get("add-relay")).toBe("1");
      expect(there.url().includes(token)).toBe(false);
    } finally {
      await there.close();
    }

    await page.bringToFront();
    const before = page.url();
    const historyLength = await page.evaluate(() => history.length);
    await page.locator("#security-save-token-btn").click();
    await expect(page.locator("#summary-modal")).not.toHaveClass(/visible/);
    await expect(page.locator("#security-new-token")).toHaveCount(0);
    const trace = await page.evaluate((value) => ({
      url: location.href,
      history: history.length,
      inPage: document.documentElement.outerHTML.includes(value)
        || [...document.querySelectorAll("input, textarea")].some((field) => field.value.includes(value)),
      inStorage: JSON.stringify({ ...localStorage }).includes(value) || JSON.stringify({ ...sessionStorage }).includes(value),
      inState: JSON.stringify(history.state ?? null).includes(value),
    }), token);
    expect(trace.url).toBe(before);
    expect(trace.history).toBe(historyLength);
    expect(trace.inPage).toBe(false);
    expect(trace.inStorage).toBe(false);
    expect(trace.inState).toBe(false);
  });
});
