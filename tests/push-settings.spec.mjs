import { expect, test } from "@playwright/test";
import { relayBaseUrl, relayToken } from "./e2e-env.mjs";

// Subscribe flow and settings UI for Web Push. Real push delivery needs a
// push service (FCM) and cannot run here, so PushManager is stubbed via
// addInitScript and the assertions check what actually matters server-side:
// the subscription row and its preferences landing in the database, observed
// through the /api/push endpoints.

const FAKE_ENDPOINT = "https://push.example.test/subscription/e2e-device";

async function installPushStubs(page) {
  await page.addInitScript((endpoint) => {
    const fakeSubscription = {
      endpoint,
      toJSON: () => ({
        endpoint,
        keys: { p256dh: "stub-p256dh-key", auth: "stub-auth-key" },
      }),
      unsubscribe: async () => true,
    };
    let subscribed = false;
    const fakePushManager = {
      getSubscription: async () => (subscribed ? fakeSubscription : null),
      subscribe: async () => {
        subscribed = true;
        return fakeSubscription;
      },
    };
    Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
      configurable: true,
      get: () => fakePushManager,
    });
    // Permission is granted only through the explicit toggle click; the stub
    // records whether the app ever asked outside of that.
    window.__permissionRequests = 0;
    Notification.requestPermission = async () => {
      window.__permissionRequests += 1;
      return "granted";
    };
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => "granted",
    });
  }, FAKE_ENDPOINT);
}

function authHeaders() {
  return { Authorization: `Bearer ${relayToken()}` };
}

// networkidle can fire before the app modules finish binding their globals;
// wait for the settings modal entry point before poking it.
async function openSettings(page) {
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
  await page.evaluate(() => window.openSettingsModal());
}

test.describe.serial("push notification settings", () => {
  test("renders disabled with an explanation when push is unsupported", async ({ page }) => {
    await page.addInitScript(() => {
      delete window.PushManager;
    });
    await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
    await page.waitForLoadState("networkidle");
    await openSettings(page);

    await expect(page.locator("#push-enabled-toggle")).toBeDisabled();
    await expect(page.locator("#push-settings-status")).toContainText("does not support Web Push");
  });

  test("permission prompt does not fire on page load", async ({ page }) => {
    await installPushStubs(page);
    await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
    await page.waitForLoadState("networkidle");
    await openSettings(page);
    await expect(page.locator("#push-enabled-toggle")).toBeEnabled();
    expect(await page.evaluate(() => window.__permissionRequests)).toBe(0);
  });

  test("enabling the toggle subscribes and persists a device row", async ({ page, request }) => {
    await installPushStubs(page);
    await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
    await page.waitForLoadState("networkidle");
    await openSettings(page);

    const toggle = page.locator("#push-enabled-toggle");
    await expect(toggle).toBeEnabled();
    await toggle.check();

    await expect(page.locator("#push-settings-status")).toContainText("enabled on this device");
    await expect(page.locator("#push-device-list")).toContainText("(this device)");
    expect(await page.evaluate(() => window.__permissionRequests)).toBe(1);

    const response = await request.get(`${relayBaseUrl()}/api/push/devices`, { headers: authHeaders() });
    expect(response.ok()).toBe(true);
    const { devices } = await response.json();
    const device = devices.find((entry) => entry.endpoint === FAKE_ENDPOINT);
    expect(device).toBeTruthy();
    expect(device.preferences.enabled).toBe(true);
    expect(device.preferences.content.preview).toBe("none");

    // Content preference controls should now be live; switching the preview
    // mode PATCHes the device row.
    await page.locator("#push-preview-select").selectOption("truncated");
    await expect(page.locator("#push-preview-chars-input")).toBeEnabled();
    await expect
      .poll(async () => {
        const check = await request.get(`${relayBaseUrl()}/api/push/devices`, { headers: authHeaders() });
        const payload = await check.json();
        return payload.devices.find((entry) => entry.endpoint === FAKE_ENDPOINT)?.preferences?.content?.preview;
      })
      .toBe("truncated");
  });

  test("revoking a device deletes the subscription row", async ({ page, request }) => {
    await installPushStubs(page);
    await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
    await page.waitForLoadState("networkidle");
    await openSettings(page);

    // This test runs in a fresh browser context, so the row subscribed by the
    // previous test belongs to "another" device — which is exactly the
    // management case the device list exists for.
    await expect(page.locator("#push-device-list .push-device-row")).toHaveCount(1);
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator("#push-device-list button", { hasText: "Revoke" }).first().click();

    await expect
      .poll(async () => {
        const check = await request.get(`${relayBaseUrl()}/api/push/devices`, { headers: authHeaders() });
        const payload = await check.json();
        return payload.devices.length;
      })
      .toBe(0);
  });

  test("push endpoints reject unauthenticated access", async ({ request }) => {
    const response = await request.get(`${relayBaseUrl()}/api/push/devices`);
    expect(response.status()).toBe(401);
  });

  // The server ages a visibility report out after 90s, so reporting only on
  // transitions meant a user reading for longer than that stopped counting as
  // active and got pushed mid-session. The heartbeat has to keep repeating for
  // as long as the page is foregrounded.
  test("a foregrounded page keeps re-asserting its visibility", async ({ page }) => {
    await page.addInitScript(() => {
      window.__COPILOT_VISIBILITY_HEARTBEAT_MS = 150;
    });
    await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
    await page.waitForLoadState("networkidle");

    await page.evaluate(async () => {
      const socket = await window.connectSocket();
      window.__visibilityBeats = [];
      const emit = socket.emit.bind(socket);
      socket.emit = (event, ...args) => {
        if (event === "device_visibility") window.__visibilityBeats.push(args[0]);
        return emit(event, ...args);
      };
    });

    await expect
      .poll(() => page.evaluate(() => window.__visibilityBeats.length), { timeout: 10_000 })
      .toBeGreaterThan(2);
    const beats = await page.evaluate(() => window.__visibilityBeats);
    expect(beats.every((beat) => beat?.visible === true)).toBe(true);
    expect(beats.every((beat) => typeof beat?.deviceId === "string" && beat.deviceId.length > 0)).toBe(true);
  });
});
