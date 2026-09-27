import { expect, test } from "@playwright/test";

import { relayBaseUrl, relayToken } from "./e2e-env.mjs";
import { startRelayServer } from "./relay-server-harness.mjs";

/**
 * The composer's @relay popup (server/public/app/mention-autocomplete.mjs)
 * against a real paired relay: "@" lists it, a pick inserts "@name ", @file:
 * tokens are never touched, and the slash menu keeps its own keys.
 *
 * The second relay shares the e2e token, so it is added through the API in
 * one call (no token field, no pair-back); Settings → Relays itself is
 * covered by remote-relays-settings.spec.mjs.
 */

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function api(baseUrl, token, path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: authHeaders(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

async function openComposer(page) {
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.updateComposerSlashMenu === "function");
  const input = page.locator("#msg-input");
  await expect(input).toBeVisible();
  await input.click();
  await input.fill("");
  return input;
}

test.describe.serial("@relay mention autocomplete", () => {
  test.describe.configure({ timeout: 120_000 });

  let relayB = null;
  let remoteId = "";

  test.beforeAll(async () => {
    relayB = await startRelayServer({ token: relayToken() });
    const named = await api(relayB.baseUrl, relayB.token, "/api/settings/pwa-app-name", {
      method: "POST",
      body: { appName: "linux-test" },
    });
    expect(named.status).toBe(200);
    const added = await api(relayBaseUrl(), relayToken(), "/api/remote-relays", {
      method: "POST",
      body: { url: relayB.baseUrl, pairBack: false },
    });
    expect(added.payload?.ok).toBe(true);
    expect(added.payload?.relay?.name).toBe("linux-test");
    remoteId = added.payload.relay.id;
  });

  test.afterAll(async () => {
    if (remoteId) {
      await api(relayBaseUrl(), relayToken(), `/api/remote-relays/${encodeURIComponent(remoteId)}`, { method: "DELETE" }).catch(() => {});
    }
    if (relayB) await relayB.stop();
    relayB = null;
  });

  test('"@" lists the paired relay and Tab inserts "@name "', async ({ page }) => {
    const input = await openComposer(page);
    const popup = page.locator("#mention-autocomplete-popup");

    await input.pressSequentially("ask @");
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute("role", "listbox");
    const option = popup.locator(".mention-item").filter({ hasText: "linux-test" });
    await expect(option).toHaveCount(1);
    await expect(option).toHaveAttribute("role", "option");
    await expect(option.locator(".slash-item-desc")).toHaveText("127.0.0.1");
    await expect(option.locator(".remote-relay-dot")).toHaveAttribute("data-status", /online|unknown/);

    await input.pressSequentially("lin");
    await page.keyboard.press("Tab");
    await expect(input).toHaveValue("ask @linux-test ");
    await expect(popup).toBeHidden();
    // Tab stayed in the composer.
    await expect(input).toBeFocused();
  });

  test("arrow keys select, Enter picks only a selected row, Escape closes", async ({ page }) => {
    const input = await openComposer(page);
    const popup = page.locator("#mention-autocomplete-popup");

    await input.pressSequentially("@");
    await expect(popup).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(popup.locator(".slash-item-selected")).toContainText("linux-test");
    await expect(input).toHaveAttribute("aria-activedescendant", /mention-autocomplete-option-/);
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("@linux-test ");

    await input.pressSequentially("and @");
    await expect(popup).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    await expect(input).toHaveValue("@linux-test and @");
  });

  test("clicking an option picks it", async ({ page }) => {
    const input = await openComposer(page);
    await input.pressSequentially("hi @l");
    await page.locator("#mention-autocomplete-popup .mention-item").filter({ hasText: "linux-test" }).click();
    await expect(input).toHaveValue("hi @linux-test ");
  });

  test("@file: tokens are left alone", async ({ page }) => {
    const input = await openComposer(page);
    const popup = page.locator("#mention-autocomplete-popup");
    await input.pressSequentially("look at @file:src/app.js");
    await expect(popup).toBeHidden();
    await expect(input).toHaveValue("look at @file:src/app.js");
    // A plain e-mail address never opens it either.
    await input.fill("");
    await input.pressSequentially("mail dev@linux");
    await expect(popup).toBeHidden();
  });

  test("the slash menu keeps its keys; only one popup is ever open", async ({ page }) => {
    const input = await openComposer(page);
    const slashPopup = page.locator("#slash-autocomplete-popup");
    const mentionPopup = page.locator("#mention-autocomplete-popup");

    await input.pressSequentially("/");
    await expect(slashPopup).toBeVisible();
    await expect(mentionPopup).toBeHidden();
    await page.keyboard.press("Tab");
    await expect(input).toHaveValue("/compact ");

    await input.pressSequentially("@lin");
    await expect(slashPopup).toBeHidden();
    await expect(mentionPopup).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(input).toHaveValue("/compact @linux-test ");
    // Leave nothing behind that a send could pick up.
    await input.fill("");
  });
});
