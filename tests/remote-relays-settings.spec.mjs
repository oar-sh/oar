import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { relayBaseUrl, relayToken } from "./e2e-env.mjs";
import { startRelayServer } from "./relay-server-harness.mjs";

/**
 * Settings → Relays against a real second relay (docs/plans/2026-09-27-remote-relays.md §10).
 *
 * The shared e2e relay ("A", named win-test here) pairs with a throwaway relay
 * ("B", linux-test) this spec boots with its OWN token, so the first add
 * attempt is refused with needsToken exactly as it would be between two
 * independently installed relays. Both run on 127.0.0.1, which the URL policy
 * allows over plain http (with a warning). The page is opened on loopback, so
 * the UI cannot guess a public address for A: the spec enters it.
 *
 * Pairing goes both ways again with peer keys: neither relay hands the other
 * its token. A introduces itself to B with B's token, then each relay sends
 * the other a key of its own, and A drops B's token once its key works.
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
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function listRelays(baseUrl, token) {
  const { status, payload } = await api(baseUrl, token, "/api/remote-relays");
  expect(status).toBe(200);
  return payload;
}

async function setRelayName(baseUrl, token, appName) {
  const { status } = await api(baseUrl, token, "/api/settings/pwa-app-name", { method: "POST", body: { appName } });
  expect(status).toBe(200);
}

async function loadApp(page, { baseUrl = "", token = relayToken() } = {}) {
  await page.goto(`${baseUrl}/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");
  // networkidle can fire before the app modules finish binding their globals.
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
}

async function openRelaysTab(page) {
  await page.evaluate(() => window.openSettingsModal("relays"));
  await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
  await expect(page.locator("#settings-panel-relays")).toBeVisible();
}

async function removeAllRemotes(baseUrl, token) {
  const { payload } = await api(baseUrl, token, "/api/remote-relays").catch(() => ({ payload: null }));
  // Inbound-only entries too: relays that added this one one way.
  for (const relay of [...(payload?.relays || []), ...(payload?.inbound || [])]) {
    await api(baseUrl, token, `/api/remote-relays/${encodeURIComponent(relay.id)}`, { method: "DELETE" }).catch(() => {});
  }
}

test.describe.serial("Settings → Relays with a second relay", () => {
  // Booting a relay plus two pairing round trips.
  test.describe.configure({ timeout: 120_000 });

  let relayB = null;

  test.beforeAll(async () => {
    relayB = await startRelayServer({ token: randomUUID() });
    await setRelayName(relayB.baseUrl, relayB.token, "linux-test");
    await setRelayName(relayBaseUrl(), relayToken(), "win-test");
  });

  // Plain fetch: only worker-scoped fixtures are available in afterAll. Every
  // later spec must see the shared relay as it was: no remotes, default name,
  // no public address, inbound on.
  test.afterAll(async () => {
    await removeAllRemotes(relayBaseUrl(), relayToken());
    await api(relayBaseUrl(), relayToken(), "/api/settings/remote-relays", {
      method: "POST",
      body: { publicUrl: "", inboundEnabled: true },
    }).catch(() => {});
    await api(relayBaseUrl(), relayToken(), "/api/settings/pwa-app-name", { method: "POST", body: { appName: "" } }).catch(() => {});
    if (relayB) await relayB.stop();
    relayB = null;
  });

  test.beforeEach(async ({ page }) => {
    // Remove asks with confirm(); a refused action alerts. Unhandled dialogs
    // would hang the click that opened them.
    page.on("dialog", (dialog) => { dialog.accept().catch(() => {}); });
  });

  test("adds the other relay by URL, pairs both ways with keys, changes the permission and removes it", async ({ page, browser }) => {
    await loadApp(page);
    await openRelaysTab(page);

    // This relay: its name (edited here) and the public address.
    await expect(page.locator("#pwa-app-name-input")).toBeVisible();
    await expect(page.locator("#remote-relays-inbound-toggle")).toBeChecked();
    const publicUrl = page.locator("#remote-relays-public-url-input");
    await publicUrl.fill(relayBaseUrl());
    await publicUrl.dispatchEvent("change");
    await expect(page.locator("#remote-relays-self-status")).toHaveAttribute("data-state", "active");

    const status = page.locator("#remote-relays-add-status");
    const tokenRow = page.locator("#remote-relays-add-token-row");
    const tokenInput = page.locator("#remote-relays-add-token-input");
    await expect(tokenRow).toBeHidden();
    await expect(page.locator("#remote-relays-pair-back-toggle")).toBeChecked();

    // B does not take A's token: the answer is "needs token", not an error.
    await page.fill("#remote-relays-add-url-input", relayB.baseUrl);
    await page.click("#remote-relays-add-btn");
    await expect(status).toHaveAttribute("data-state", "needs-token");
    await expect(tokenRow).toBeVisible();
    await expect(tokenInput).toHaveAttribute("type", "password");

    // A wrong token keeps the field up, and never lingers in it.
    await tokenInput.fill("not-the-token");
    await page.click("#remote-relays-add-btn");
    await expect(status).toHaveAttribute("data-state", "needs-token");
    await expect(status).toContainText("did not accept that token either");
    await expect(tokenInput).toHaveValue("");

    await tokenInput.fill(relayB.token);
    await page.click("#remote-relays-add-btn");
    // Both ways: B added A back, and both hold a key of the other's.
    await expect(status).toHaveAttribute("data-state", "paired");
    await expect(status).toContainText("linux-test");
    await expect(status).toContainText("keys of their own");
    await expect(tokenRow).toBeHidden();
    await expect(tokenInput).toHaveValue("");
    await expect(page.locator("#remote-relays-add-url-input")).toHaveValue("");

    const row = page.locator("#remote-relays-list .remote-relay-row").filter({ hasText: "linux-test" });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".remote-relay-dot")).toHaveAttribute("data-status", "online");
    await expect(row.locator(".remote-relay-detail")).toContainText("127.0.0.1");
    await expect(row.locator(".remote-relay-http-warning")).toContainText("Plain http");
    await expect(row.locator("a.remote-relay-open")).toHaveAttribute("href", relayB.baseUrl);
    await expect(row.locator("a.remote-relay-open")).toHaveAttribute("target", "_blank");
    await expect(row.locator("select")).toHaveValue("full");

    // Keyed both ways: A's row says so, B lists A as paired automatically,
    // and no token or key is in either list.
    await expect(row.locator(".remote-relay-key-tag")).toHaveText("Keyed");
    await expect(row.locator(".remote-relay-peer-key")).toContainText("this relay holds its key");
    const onB = await listRelays(relayB.baseUrl, relayB.token);
    const aOnB = (onB.relays || []).find((relay) => relay.name === "win-test");
    expect(aOnB).toBeTruthy();
    expect(aOnB.addedBy).toBe("pairing");
    expect(aOnB.peerKeyConfirmed).toBe(true);
    expect(JSON.stringify(onB)).not.toContain(relayToken());
    expect(JSON.stringify(onB)).not.toContain("oarp1_");
    const onA = await listRelays(relayBaseUrl(), relayToken());
    const bOnA = (onA.relays || []).find((relay) => relay.name === "linux-test");
    expect(bOnA.tokenMode).toBe("peer");
    expect(JSON.stringify(onA)).not.toContain(relayB.token);
    expect(JSON.stringify(onA)).not.toContain("oarp1_");

    const pageB = await browser.newPage();
    try {
      await loadApp(pageB, { baseUrl: relayB.baseUrl, token: relayB.token });
      await openRelaysTab(pageB);
      const rowOnB = pageB.locator("#remote-relays-list .remote-relay-row").filter({ hasText: "win-test" });
      await expect(rowOnB).toHaveCount(1);
      await expect(rowOnB.locator(".remote-relay-tag")).toHaveText("Paired automatically");
      await expect(rowOnB.locator(".remote-relay-key-tag")).toHaveText("Keyed");
    } finally {
      await pageB.close();
    }

    // A claim of B on A's token (B signs in with its key): refused, counted
    // on B's row, and one Inbox notice.
    for (let i = 0; i < 2; i += 1) {
      const claimed = await fetch(`${relayBaseUrl()}/api/message`, {
        method: "POST",
        headers: { ...authHeaders(relayToken()), "x-oar-remote-origin": bOnA.relayId },
        body: JSON.stringify({ text: "claims to be linux-test" }),
      });
      expect(claimed.status).toBe(403);
      expect((await claimed.json()).code).toBe("REMOTE_RELAY_PEER_KEY_REQUIRED");
    }
    await row.locator(".remote-relay-check").click();
    await expect(row.locator(".remote-relay-refused")).toContainText("2 refused claims since start");
    const inbox = await api(relayBaseUrl(), relayToken(), "/api/inbox");
    const notices = (inbox.payload?.relays?.[0]?.items || []).filter((item) => item.kind === "relay_notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].question).toContain("linux-test");
    await api(relayBaseUrl(), relayToken(), `/api/remote-relays/${encodeURIComponent(bOnA.id)}/refusal-notice/dismiss`, { method: "POST", body: {} });

    // One-click Re-pair with keys in place: keys both ways again.
    await row.locator(".remote-relay-repair").click();
    await expect(row.locator(".remote-relay-repair-status")).toContainText("Re-paired with linux-test");

    // Check re-probes; the relay is still up.
    await row.locator(".remote-relay-check").click();
    await expect(row.locator(".remote-relay-check")).toHaveText("Check");
    await expect(row.locator(".remote-relay-dot")).toHaveAttribute("data-status", "online");

    // "Agents may" is stored on A.
    await row.locator("select").selectOption("read");
    await expect.poll(async () => {
      const list = await listRelays(relayBaseUrl(), relayToken());
      return (list.relays || []).find((relay) => relay.name === "linux-test")?.permission;
    }).toBe("read");

    // Remove is local: B keeps its own entry for A.
    await row.locator(".remote-relay-remove").click();
    await expect(row).toHaveCount(0);
    const afterOnA = await listRelays(relayBaseUrl(), relayToken());
    expect((afterOnA.relays || []).some((relay) => relay.name === "linux-test")).toBe(false);
    const afterOnB = await listRelays(relayB.baseUrl, relayB.token);
    expect((afterOnB.relays || []).some((relay) => relay.name === "win-test")).toBe(true);
    await removeAllRemotes(relayB.baseUrl, relayB.token);
  });

  test("one way: an inbound-only key, no token kept; Re-pair opens the pairing-link field, which makes it two-way", async ({ page }) => {
    // One way: B gives A a key of its own and lists A as inbound only; A
    // keeps that key and never B's token. The row says "One way" (a working
    // state, not a fault), and B's Settings shows A as "Inbound only".
    const added = await api(relayBaseUrl(), relayToken(), "/api/remote-relays", {
      method: "POST",
      body: { url: relayB.baseUrl, token: relayB.token, pairBack: false },
    });
    expect(added.payload?.ok).toBe(true);
    expect(added.payload?.oneWay).toBe("inbound-only");
    expect(added.payload?.relay?.tokenMode).toBe("peer");
    const onB = await listRelays(relayB.baseUrl, relayB.token);
    expect((onB.relays || []).length).toBe(0);
    expect((onB.inbound || []).map((relay) => [relay.name, relay.inboundOnly])).toEqual([["win-test", true]]);
    await loadApp(page);
    await openRelaysTab(page);
    const row = page.locator("#remote-relays-list .remote-relay-row").filter({ hasText: "linux-test" });
    await expect(row.locator(".remote-relay-key-tag")).toHaveText("One way");
    await expect(row.locator(".remote-relay-peer-key")).toContainText("lists this relay as inbound only");
    await row.locator(".remote-relay-repair").click();
    await expect(page.locator("#remote-relays-add-token-row")).toBeVisible();
    await expect(page.locator("#remote-relays-add-url-input")).toHaveValue(relayB.baseUrl);
    await expect(page.locator("#remote-relays-add-status")).toContainText("Paste its pairing link");
    // The link updates the entry in place.
    await page.fill("#remote-relays-add-token-input", relayB.token);
    await page.click("#remote-relays-add-btn");
    await expect(page.locator("#remote-relays-add-status")).toContainText("Updated linux-test");
    await expect(page.locator("#remote-relays-list .remote-relay-row")).toHaveCount(1);
    await removeAllRemotes(relayBaseUrl(), relayToken());
    await removeAllRemotes(relayB.baseUrl, relayB.token);
  });

  test("adding this relay's own address is refused", async ({ page }) => {
    await loadApp(page);
    await openRelaysTab(page);
    await page.fill("#remote-relays-add-url-input", relayBaseUrl());
    await page.click("#remote-relays-add-btn");
    const status = page.locator("#remote-relays-add-status");
    await expect(status).toHaveAttribute("data-state", "self");
    await expect(status).toContainText("That address is this relay");
    // The address stays so it can be corrected; nothing was added.
    await expect(page.locator("#remote-relays-add-url-input")).toHaveValue(relayBaseUrl());
    const list = await listRelays(relayBaseUrl(), relayToken());
    expect(list.relays || []).toEqual([]);
  });

  test("a live update from the relay repaints the list without reopening", async ({ page }) => {
    await loadApp(page);
    await openRelaysTab(page);
    await expect(page.locator("#remote-relays-list .remote-relay-row")).toHaveCount(0);
    await expect(page.locator("#remote-relays-empty")).toBeVisible();

    // Added behind the page's back (another device, or the API): the relay's
    // remote_relays_updated event brings it in.
    const added = await api(relayBaseUrl(), relayToken(), "/api/remote-relays", {
      method: "POST",
      body: { url: relayB.baseUrl, token: relayB.token, pairBack: false },
    });
    expect(added.payload?.ok).toBe(true);
    await expect(page.locator("#remote-relays-list .remote-relay-row").filter({ hasText: "linux-test" })).toHaveCount(1);
    await removeAllRemotes(relayBaseUrl(), relayToken());
    await expect(page.locator("#remote-relays-list .remote-relay-row")).toHaveCount(0);
  });
});
