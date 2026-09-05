import http from "node:http";
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { startRelayServer } from "./relay-server-harness.mjs";

/**
 * The opt-in update mechanism, end to end against a local stub manifest server
 * — the relay must never reach the real oar.sh from tests (the shared harness
 * pins OAR_NO_UPDATE_CHECK=1; this spec boots its own relay, un-pins it, and
 * points OAR_UPDATE_MANIFEST_URL at the stub). This checkout is a git repo, so
 * the install method is git-checkout: the card must offer the pull hint, never
 * the Update button, and the apply route must refuse.
 */

test.describe.serial("opt-in update checks", () => {
  test.describe.configure({ timeout: 120_000 });

  let relay = null;
  let manifestServer = null;
  let manifestUrl = "";
  // Mutable so individual tests can stage new versions / critical flags.
  const manifest = {
    schemaVersion: 1,
    channels: {
      stable: {
        version: "9.9.9",
        publishedAt: "2026-09-05T00:00:00Z",
        notesUrl: "https://github.com/oar-sh/oar/releases/tag/v9.9.9",
        critical: false,
      },
    },
  };
  let manifestEtag = '"m1"';
  const manifestRequests = [];

  test.beforeAll(async () => {
    manifestServer = http.createServer((req, res) => {
      manifestRequests.push(String(req.headers["if-none-match"] || ""));
      if (req.headers["if-none-match"] === manifestEtag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.setHeader("ETag", manifestEtag);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(manifest));
    });
    await new Promise((resolve) => manifestServer.listen(0, "127.0.0.1", resolve));
    manifestUrl = `http://127.0.0.1:${manifestServer.address().port}/latest.json`;

    relay = await startRelayServer({
      token: randomUUID(),
      overrides: {
        OAR_NO_UPDATE_CHECK: "",
        OAR_UPDATE_MANIFEST_URL: manifestUrl,
      },
    });
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
    if (manifestServer) {
      manifestServer.closeAllConnections?.();
      await new Promise((resolve) => manifestServer.close(resolve));
    }
    manifestServer = null;
  });

  function authHeaders() {
    return { Authorization: `Bearer ${relay.token}` };
  }

  async function loadApp(page) {
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await page.evaluate(() => window.openSettingsModal("general"));
    await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
  }

  async function fetchUpdateState(request) {
    const response = await request.get(`${relay.baseUrl}/api/update/state`, { headers: authHeaders() });
    expect(response.ok()).toBe(true);
    return (await response.json()).update;
  }

  test("no opt-in means no traffic: the relay boots without touching the manifest", async ({ request }) => {
    const status = await request.get(`${relay.baseUrl}/api/status`, { headers: authHeaders() });
    expect(status.ok()).toBe(true);
    const payload = await status.json();
    expect(typeof payload.version).toBe("string");
    expect(payload.version.length).toBeGreaterThan(0);
    expect(payload.update.checkKilled).toBe(false);
    expect(payload.update.installMethod).toBe("git-checkout");
    expect(payload.update.check.autoCheckEnabled).toBe(false);
    expect(payload.update.check.available).toBe(false);
    expect(payload.update.check.lastCheckedAt).toBe(null);
    expect(manifestRequests.length).toBe(0);
  });

  test("a manual check finds the staged version; checkouts get the pull hint, not the button", async ({ page, request }) => {
    await loadApp(page);
    await expect(page.locator("#update-last-checked")).toHaveText("Never checked.");
    await expect(page.locator("#update-available-card")).toBeHidden();

    await page.locator("#update-check-now-btn").click();
    await expect(page.locator("#update-available-card")).toBeVisible();
    await expect(page.locator("#update-available-text")).toContainText("OAR 9.9.9 available");
    await expect(page.locator("#update-notes-link")).toHaveAttribute("href", "https://github.com/oar-sh/oar/releases/tag/v9.9.9");
    await expect(page.locator("#update-git-hint")).toBeVisible();
    await expect(page.locator("#update-apply-btn")).toBeHidden();
    await expect(page.locator("#update-last-checked")).toContainText("Last checked");
    expect(manifestRequests.length).toBe(1);

    // The server guard mirrors the hidden button.
    const apply = await request.post(`${relay.baseUrl}/api/update/apply`, {
      headers: authHeaders(),
      data: { version: "9.9.9" },
    });
    expect(apply.status()).toBe(400);
    expect((await apply.json()).error).toContain("git checkout");
  });

  test("a second check rides the ETag and still reports availability", async ({ page }) => {
    await loadApp(page);
    await page.locator("#update-check-now-btn").click();
    await expect(page.locator("#update-available-card")).toBeVisible();
    expect(manifestRequests[manifestRequests.length - 1]).toBe('"m1"', "If-None-Match was sent");
  });

  test("dismissal hides the card per version and survives reload", async ({ page, request }) => {
    await loadApp(page);
    await expect(page.locator("#update-available-card")).toBeVisible();
    await page.locator("#update-dismiss-btn").click();
    await expect(page.locator("#update-available-card")).toBeHidden();

    const state = await fetchUpdateState(request);
    expect(state.check.dismissed).toBe(true);

    await page.reload();
    await loadApp(page);
    await expect(page.locator("#update-available-card")).toBeHidden();
  });

  test("a critical release overrides dismissal and cannot be dismissed", async ({ page, request }) => {
    manifest.channels.stable = {
      version: "9.9.10",
      publishedAt: "2026-09-05T01:00:00Z",
      notesUrl: "https://github.com/oar-sh/oar/releases/tag/v9.9.10",
      critical: true,
    };
    manifestEtag = '"m2"';

    await loadApp(page);
    await page.locator("#update-check-now-btn").click();
    await expect(page.locator("#update-available-card")).toBeVisible();
    await expect(page.locator("#update-available-text")).toContainText("critical update");
    await expect(page.locator("#update-dismiss-btn")).toBeHidden();

    const dismiss = await request.post(`${relay.baseUrl}/api/update/dismiss`, {
      headers: authHeaders(),
      data: { version: "9.9.10" },
    });
    expect(dismiss.status()).toBe(400);
    expect((await dismiss.json()).error).toContain("critical");
  });

  test("the auto-check toggle opts in, persists, and opts back out", async ({ page, request }) => {
    await loadApp(page);
    const toggle = page.locator("#update-auto-check-toggle");
    await expect(toggle).not.toBeChecked();

    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(async () => (await fetchUpdateState(request)).check.autoCheckEnabled).toBe(true);

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(async () => (await fetchUpdateState(request)).check.autoCheckEnabled).toBe(false);
  });
});
