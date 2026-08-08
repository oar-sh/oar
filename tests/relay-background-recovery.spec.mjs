import { devices, expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// Regression cover for the Android Chrome PWA bug where backgrounding the app
// during a foreground recovery pass left the relay permanently unreachable
// ("Web relay unreachable", grey #cli-dot) until the PWA was restarted.
test.use({ ...devices["Pixel 5"], browserName: "chromium" });

// The renderer's real visibility is not scriptable, so the app's own read of
// document.visibilityState is overridden and the event dispatched by hand. This is
// what the lifecycle handlers in bootstrap.js actually consume.
async function installVisibilityControl(page) {
  await page.addInitScript(() => {
    let state = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => state === "hidden",
    });
    window.__setVisibility = (next) => {
      state = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
}

function setVisibility(page, state) {
  return page.evaluate((next) => window.__setVisibility(next), state);
}

const relayDot = (page) => page.locator("#cli-dot");

test.describe.serial("relay recovery after backgrounding", () => {
  test("reconnects when a foreground recovery pass never settles", async ({ page }) => {
    const token = relayToken();
    await installVisibilityControl(page);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await expect(relayDot(page)).toHaveClass("online");

    // Hang every status request. This is the mobile failure being reproduced: a
    // request issued as the app is backgrounded that neither resolves nor rejects.
    const hangingRequests = [];
    await page.route("**/api/status*", (route) => {
      hangingRequests.push(route);
    });

    // Background, then foreground so a recovery pass starts and immediately stalls
    // on the hung status request.
    await setVisibility(page, "hidden");
    await expect(relayDot(page)).toHaveClass("offline");
    await setVisibility(page, "visible");
    await page.waitForTimeout(2000);
    expect(hangingRequests.length).toBeGreaterThan(0);

    // Background and foreground again while the previous pass still holds the
    // in-flight latch. Before the fix, the second foreground transition was
    // swallowed by the latch and the socket was never reconnected.
    await setVisibility(page, "hidden");
    await expect(relayDot(page)).toHaveClass("offline");
    await setVisibility(page, "visible");

    // The socket does not depend on /api/status, so the relay must come back even
    // while those requests are still hanging.
    await expect(relayDot(page)).toHaveClass("online", { timeout: 15_000 });

    await page.unroute("**/api/status*");
    await Promise.all(hangingRequests.map((route) => route.abort().catch(() => {})));
  });

  test("backgrounding leaves a recoverable session so state is replayed", async ({ page }) => {
    const token = relayToken();
    await installVisibilityControl(page);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await expect(relayDot(page)).toHaveClass("online");

    await setVisibility(page, "hidden");
    await expect(relayDot(page)).toHaveClass("offline");
    await page.waitForTimeout(1000);
    await setVisibility(page, "visible");
    await expect(relayDot(page)).toHaveClass("online", { timeout: 15_000 });

    // socket.disconnect() would report "client namespace disconnect", which is not
    // a recoverable reason, so the server would drop the session and replay
    // nothing. Backgrounding must close the transport instead.
    const state = await page.evaluate(async () => {
      const socket = await window.connectSocket();
      return { connected: socket.connected, recovered: socket.recovered };
    });
    expect(state.connected).toBe(true);
    expect(state.recovered).toBe(true);
  });

  test("watchdog reconnects a dropped socket with no visibility change", async ({ page }) => {
    const token = relayToken();
    await installVisibilityControl(page);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await expect(relayDot(page)).toHaveClass("online");

    // An explicit disconnect() destroys the socket, which clears socket.io's own
    // reconnect subscriptions. Only the watchdog can bring this back.
    await page.evaluate(async () => {
      const socket = await window.connectSocket();
      socket.disconnect();
    });
    await expect(relayDot(page)).toHaveClass("offline");

    await expect(relayDot(page)).toHaveClass("online", { timeout: 20_000 });
  });
});
