import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { startRelayServer } from "./relay-server-harness.mjs";
import { apiOf, localhostOrigin, signInByCode, waitForApp } from "./helpers/browser-signin.mjs";

/**
 * Settings → Relays → "This browser on your paired relays" (agent auth
 * §13.2, 1b/1c). The browser is on relay A as `localhost`; A knows B as
 * `127.0.0.1` (another site, its own cookie jar) and C as `localhost` on
 * another port (the same host: one cookie jar with A).
 *
 * - per relay, "Sign in there" (`<B>/`) and "Turn on push there"
 *   (`<B>/?settings=notifications`), new windows without an opener, and
 *   the note that this page cannot see the sign-in there;
 * - "Turn on push there" opens B's sign-in box, then B's Settings at
 *   Notifications, the parameter gone from the address;
 * - C, on A's host with another port, carries the warning; B does not;
 * - `?settings=relays&add-relay=1` opens the Add a relay form, empty, and
 *   an unknown tab opens nothing.
 */

test.use({ screenshot: "off", video: "off", trace: "off" });

test.describe.serial("this browser on the paired relays", () => {
  test.describe.configure({ timeout: 150_000, retries: 0 });

  let relayA = null;
  let relayB = null;
  let relayC = null;
  let context = null;
  let page = null;

  const apiA = (...args) => apiOf(relayA)(...args);

  test.beforeAll(async ({ browser }) => {
    [relayA, relayB, relayC] = await Promise.all([
      startRelayServer({ token: randomUUID() }),
      startRelayServer({ token: randomUUID() }),
      startRelayServer({ token: randomUUID() }),
    ]);
    expect((await apiOf(relayB)("/api/settings/pwa-app-name", { method: "POST", body: { appName: "linux-test" } })).status).toBe(200);
    expect((await apiOf(relayC)("/api/settings/pwa-app-name", { method: "POST", body: { appName: "mac-test" } })).status).toBe(200);
    for (const [relay, url] of [[relayB, relayB.baseUrl], [relayC, localhostOrigin(relayC)]]) {
      const added = await apiA("/api/remote-relays", { method: "POST", body: { url, token: relay.token, pairBack: false } });
      expect(added.payload?.ok, JSON.stringify(added.payload)).toBe(true);
    }
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    await signInByCode(page, relayA, { origin: localhostOrigin(relayA) });
  });

  test.afterAll(async () => {
    await context?.close().catch(() => {});
    await Promise.all([relayA?.stop(), relayB?.stop(), relayC?.stop()]);
    relayA = null;
    relayB = null;
    relayC = null;
  });

  const rowOf = (name) => page.locator("#remote-relays-browser-list .remote-relays-browser-row", { hasText: name });

  test("one row per paired relay with its two links, and the note", async () => {
    await page.evaluate(() => window.openSettingsModal("relays"));
    const section = page.locator("#remote-relays-browser-section");
    await expect(section).toBeVisible();
    await expect(page.locator("#remote-relays-browser-title")).toHaveText("This browser on your paired relays");
    await expect(section).toContainText("Each relay keeps its own sign-in; this page cannot see it.");
    await expect(page.locator("#remote-relays-browser-list .remote-relays-browser-row")).toHaveCount(2);

    const b = rowOf("linux-test");
    await expect(b.locator(".remote-relays-browser-signin")).toHaveAttribute("href", `${relayB.baseUrl}/`);
    await expect(b.locator(".remote-relays-browser-push")).toHaveAttribute("href", `${relayB.baseUrl}/?settings=notifications`);
    for (const link of [b.locator(".remote-relays-browser-signin"), b.locator(".remote-relays-browser-push")]) {
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    // Another host than this page's: no warning.
    await expect(b.locator(".remote-relays-browser-warning")).toHaveCount(0);
  });

  test("a relay on this page's host with another port is warned about", async () => {
    const c = rowOf("mac-test");
    await expect(c.locator(".remote-relays-browser-signin")).toHaveAttribute("href", `${localhostOrigin(relayC)}/`);
    await expect(c.locator(".remote-relays-browser-warning")).toBeVisible();
    await expect(c.locator(".remote-relays-browser-warning")).toContainText("sign each other out");
  });

  test("Turn on push there: B's sign-in box, then B's Settings at Notifications", async () => {
    const opened = context.waitForEvent("page");
    await rowOf("linux-test").locator(".remote-relays-browser-push").click();
    const there = await opened;
    try {
      await there.waitForLoadState("domcontentloaded");
      expect(await there.evaluate(() => window.opener === null)).toBe(true);
      // Signed out on B (another site): the sign-in box, the link kept.
      await expect(there.locator("#auth-gate")).toBeVisible();
      expect(new URL(there.url()).searchParams.get("settings")).toBe("notifications");
      await there.locator("#token-input").fill(relayB.token);
      await there.locator("#auth-connect-btn").click();
      await waitForApp(there);
      await expect(there.locator("#settings-modal")).toHaveClass(/visible/);
      await expect(there.locator("#settings-panel-notifications")).toBeVisible();
      await expect(there.locator("#push-event-new-signin-toggle")).toHaveCount(1);
      expect(new URL(there.url()).searchParams.has("settings"), "the link left the address").toBe(false);
    } finally {
      await there.close();
    }
    // A's own page is still signed in: B's sign-in is B's alone.
    await expect(page.locator("#auth-gate")).toBeHidden();
  });

  test("?settings=relays&add-relay=1 opens the Add a relay form, empty; an unknown tab nothing", async () => {
    const other = await context.newPage();
    try {
      await other.goto(`${localhostOrigin(relayA)}/?settings=relays&add-relay=1`);
      await waitForApp(other);
      await expect(other.locator("#settings-panel-relays")).toBeVisible();
      const field = other.locator("#remote-relays-add-url-input");
      await expect(field).toBeFocused();
      await expect(field).toHaveValue("");
      expect(new URL(other.url()).search).toBe("");

      await other.goto(`${localhostOrigin(relayA)}/?settings=nope`);
      await waitForApp(other);
      // The app reads the link once it has loaded the conversations, a moment
      // after it shows: the address loses it, and nothing opened.
      await expect.poll(() => new URL(other.url()).search).toBe("");
      await expect(other.locator("#settings-modal")).not.toHaveClass(/visible/);
    } finally {
      await other.close();
    }
  });
});
