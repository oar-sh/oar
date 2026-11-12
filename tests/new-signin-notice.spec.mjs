import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { startRelayServer } from "./relay-server-harness.mjs";
import { apiOf, cliAgentToken, pageApi, signInByCode, waitForApp } from "./helpers/browser-signin.mjs";

/**
 * New sign-in notices in the page (agent auth §13.2, 2d), on a relay of its
 * own:
 *
 * - browser 2 signs in with a sign-in link: browser 1's banner shows it at
 *   once ("New browser signed in: …, via a sign-in link"), and its "Sign it
 *   out" signs browser 2 out;
 * - an old browser's owner-token cookie becoming a session makes no notice;
 * - a terminal sign-in code (`oar url --sign-in`'s route) makes one "via the
 *   terminal", and the list of browsers says "from the terminal";
 * - "Got it" is per browser, and a browser that signs in later still sees
 *   the others' notices, never its own;
 * - however many sign in, they are one row of one height ("5 new browsers
 *   signed in (latest: …)"), the list behind "Show all" lies over the
 *   transcript, and one "Got it" dismisses them all.
 *
 * No screenshot, video or trace: codes and tokens must not end up in a test
 * artefact.
 */

test.use({ screenshot: "off", video: "off", trace: "off" });

test.describe.serial("new sign-in notices", () => {
  test.describe.configure({ timeout: 150_000, retries: 0 });

  let relay = null;
  let first = null;
  let firstPage = null;
  const others = [];

  const banner = (page) => page.locator("#security-notice-banner");
  const signinRows = (page) => banner(page).locator(".security-signin-notice");
  // The page's own call: its cookie and the session's key.
  const noticesOf = async (page) => (await pageApi(page, "api/auth/notices")).payload.signins;

  test.beforeAll(async ({ browser }) => {
    relay = await startRelayServer({ token: randomUUID() });
    expect((await apiOf(relay)("/api/settings/pwa-app-name", { method: "POST", body: { appName: "bench-relay" } })).status).toBe(200);
    first = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    firstPage = await first.newPage();
    await signInByCode(firstPage, relay);
  });

  test.afterAll(async () => {
    for (const context of others) await context.close().catch(() => {});
    await first?.close().catch(() => {});
    if (relay) await relay.stop();
    relay = null;
  });

  test("a second browser signs in with a link: the first sees it at once, and Sign it out works", async ({ browser }) => {
    await expect(signinRows(firstPage)).toHaveCount(0);
    const second = await browser.newContext({ viewport: { width: 390, height: 844 } });
    others.push(second);
    const secondPage = await second.newPage();
    await signInByCode(secondPage, relay);
    // The new browser is not told about itself, only about the first one.
    await expect(signinRows(secondPage)).toHaveCount(1);

    // Live, without a reload (Socket.IO auth_new_signin).
    const row = signinRows(firstPage).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator(".security-notice-text")).toHaveText(/^New browser signed in: .+, via a sign-in link$/);
    await expect(row).toHaveAttribute("data-via", "code");
    await expect(row.locator("button")).toHaveText(["Sign it out", "Got it"]);

    await row.locator(".security-signin-signout").click();
    await expect(row.locator(".security-notice-text")).toHaveText(/\(signed out\)$/);
    await expect(firstPage.locator("#relay-toast")).toContainText("Signed out");
    await expect(firstPage.locator("#auth-gate")).toBeHidden();

    // The second browser's next call is refused: the sign-in box.
    await secondPage.evaluate(() => window.openSettingsModal("security"));
    await expect(secondPage.locator("#auth-gate")).toBeVisible();
    await expect(secondPage.locator("#auth-error")).toHaveText("This browser was signed out");

    // Got it: gone here, for this browser only.
    await row.locator(".security-notice-dismiss").click();
    await expect(signinRows(firstPage)).toHaveCount(0);
    expect((await noticesOf(firstPage)).length).toBe(0);
  });

  test("an old browser's owner-token cookie becoming a session makes no notice", async () => {
    const before = (await noticesOf(firstPage)).length;
    // A browser from before sessions: its cookie held the relay token. It
    // opens no route; its page trades it at the sign-in route.
    const old = { Cookie: `copilot_auth=${encodeURIComponent(relay.token)}` };
    const refused = await fetch(`${relay.baseUrl}/api/status`, { headers: old });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("AUTH_COOKIE_UPGRADE");
    const upgraded = await fetch(`${relay.baseUrl}/api/auth/session`, {
      method: "POST",
      headers: { ...old, "content-type": "application/json" },
      body: JSON.stringify({ deviceId: `old-browser-${randomUUID()}` }),
    });
    expect(upgraded.status).toBe(200);
    expect(upgraded.headers.get("set-cookie") || "", "it got a session").toContain("copilot_auth=oars1_");
    expect(/^oark1_/.test((await upgraded.json()).proof || ""), "and its key").toBe(true);
    await firstPage.waitForTimeout(1_500);
    await expect(signinRows(firstPage)).toHaveCount(0);
    expect((await noticesOf(firstPage)).length).toBe(before);
  });

  test("a terminal sign-in code: \"via the terminal\", and the list says \"from the terminal\"", async ({ browser }) => {
    // What `oar url --sign-in` calls: the oar command's own token, straight over loopback.
    const minted = await fetch(`${relay.baseUrl}/api/auth/signin-codes/terminal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cliAgentToken(relay)}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(minted.status).toBe(200);
    const { code } = await minted.json();
    const third = await browser.newContext();
    others.push(third);
    const thirdPage = await third.newPage();
    await thirdPage.goto(`${relay.baseUrl}/?signin=${encodeURIComponent(code)}`);
    await waitForApp(thirdPage);
    // The terminal code's sign-in answered the session's key, and the page kept it.
    expect(await thirdPage.evaluate(() => /^oark1_/.test(localStorage.getItem("oar_session_proof") || ""))).toBe(true);

    const row = signinRows(firstPage).filter({ hasText: "via the terminal" });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row.locator(".security-notice-text")).toHaveText(/^New browser signed in: .+, via the terminal$/);
    await expect(row).toHaveAttribute("data-via", "terminal");

    await firstPage.evaluate(() => window.openSettingsModal("security"));
    const listed = firstPage.locator('#security-session-list .security-session-row[data-via="terminal"]');
    await expect(listed).toHaveCount(1);
    await expect(listed.locator(".security-session-meta")).toContainText("from the terminal (oar url --sign-in)");
    await firstPage.evaluate(() => window.closeSettingsModal());

    // A browser that signs in later sees the notices of the others it has
    // not dismissed (the first's and the second's sign-ins; the first
    // dismissed the second's for itself only), never its own.
    await expect(signinRows(thirdPage)).toHaveCount(1);
    await expect(signinRows(thirdPage)).toHaveAttribute("data-count", "2");
    await signinRows(thirdPage).locator(".security-signin-toggle").click();
    const entries = banner(thirdPage).locator("#security-signin-list .security-signin-entry");
    await expect(entries).toHaveCount(2);
    await expect(entries.filter({ hasText: "via the terminal" })).toHaveCount(0);
  });

  test("five sign-ins are one row of one height; the list lies over the transcript; one Got it for all", async () => {
    const row = signinRows(firstPage);
    // The terminal sign-in's notice from before: acknowledged first.
    if (await row.count()) {
      await row.locator(".security-notice-dismiss").click();
      await expect(row).toHaveCount(0);
    }
    const signInOnce = async (index) => {
      const answer = await fetch(`${relay.baseUrl}/api/auth/session`, {
        method: "POST",
        headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", "user-agent": `Mozilla/5.0 (X11; Linux x86_64) Firefox/140.${index}` },
        body: JSON.stringify({ deviceId: `pile-device-${index}-${randomUUID()}` }),
      });
      expect(answer.status, `sign-in ${index}`).toBe(200);
    };
    const messages = firstPage.locator("#messages");
    const composer = firstPage.locator("#input-area");

    await signInOnce(1);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-count", "1");
    const bannerBox = await banner(firstPage).boundingBox();
    const messagesBox = await messages.boundingBox();
    const composerBox = await composer.boundingBox();

    for (let index = 2; index <= 5; index += 1) await signInOnce(index);
    await expect(row).toHaveAttribute("data-count", "5");
    await expect(signinRows(firstPage)).toHaveCount(1);
    await expect(row.locator(".security-notice-text")).toHaveText(/^5 new browsers signed in \(latest: .+, via the relay token\)$/);
    expect((await banner(firstPage).boundingBox()).height).toBe(bannerBox.height);
    expect(await messages.boundingBox()).toEqual(messagesBox);
    expect(await composer.boundingBox()).toEqual(composerBox);

    await row.locator(".security-signin-toggle").click();
    const entries = banner(firstPage).locator("#security-signin-list .security-signin-entry");
    await expect(entries).toHaveCount(5);
    await expect(entries.locator(".security-signin-signout")).toHaveCount(5);
    // Open, it lies over the transcript: nothing below moved.
    expect((await banner(firstPage).boundingBox()).height).toBe(bannerBox.height);
    expect(await messages.boundingBox()).toEqual(messagesBox);

    await row.locator(".security-notice-dismiss").click();
    await expect(signinRows(firstPage)).toHaveCount(0);
    await expect(banner(firstPage)).toBeHidden();
    expect((await noticesOf(firstPage)).length).toBe(0);
    await firstPage.reload();
    await waitForApp(firstPage);
    await expect(signinRows(firstPage)).toHaveCount(0);
  });
});
