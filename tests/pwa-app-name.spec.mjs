import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// The install app name is stored on the relay and baked into every
// /manifest.webmanifest response, because Android's WebAPK update check
// fetches the manifest cold — no page, no localStorage, no auth. These specs
// therefore assert the manifest via plain HTTP fetches, exactly like Android
// does, not through any page state.

const LEGACY_STORAGE_KEY = "copilot_pwa_app_name";

async function loadApp(page) {
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
}

async function fetchManifest(request, baseURL, query = "") {
  const response = await request.get(`${baseURL}/manifest.webmanifest${query}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function setAppNameViaUi(page, value) {
  await page.evaluate(() => window.openSettingsModal("general"));
  await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
  const input = page.locator("#pwa-app-name-input");
  await input.fill(value);
  await input.dispatchEvent("change");
}

test.describe("pwa app name", () => {
  test("a cold manifest fetch serves the default name until one is set", async ({ request, baseURL }) => {
    const manifest = await fetchManifest(request, baseURL);
    expect(manifest.name).toBe("OAR");
    expect(manifest.short_name).toBe("OAR");
  });

  test("a name set in settings reaches cold manifest fetches, shared variant included", async ({ page, request, baseURL }) => {
    await loadApp(page);
    await setAppNameViaUi(page, "My Dev Relay");

    await expect.poll(async () => (await fetchManifest(request, baseURL)).name).toBe("My Dev Relay");
    const manifest = await fetchManifest(request, baseURL);
    expect(manifest.short_name).toBe("My");

    const shared = await fetchManifest(request, baseURL, "?shared=1");
    expect(shared.name).toBe("My Dev Relay");
    expect(shared.display).toBe("browser");
    expect(shared.id).toBe("./__copilot_remote_shared__");

    // A long first word falls back to the 12-char slice.
    await setAppNameViaUi(page, "Supercalifragilistic Relay");
    await expect.poll(async () => (await fetchManifest(request, baseURL)).short_name).toBe("Supercalifra");

    // Clearing the input reverts the manifest to the default name.
    await setAppNameViaUi(page, "");
    await expect.poll(async () => (await fetchManifest(request, baseURL)).name).toBe("OAR");
  });

  test("a legacy per-browser name is adopted by the relay and the key removed", async ({ page, request, baseURL }) => {
    await page.addInitScript(([key]) => {
      localStorage.setItem(key, "Legacy Name");
    }, [LEGACY_STORAGE_KEY]);
    await loadApp(page);

    await expect.poll(async () => (await fetchManifest(request, baseURL)).name).toBe("Legacy Name");
    await expect.poll(() => page.evaluate(([key]) => localStorage.getItem(key), [LEGACY_STORAGE_KEY])).toBe(null);

    // Cleanup so later specs see the default again.
    await setAppNameViaUi(page, "");
    await expect.poll(async () => (await fetchManifest(request, baseURL)).name).toBe("OAR");
  });

  test("adoption never clobbers a name the relay already has", async ({ page, request, baseURL }) => {
    const post = await request.post(`${baseURL}/api/settings/pwa-app-name`, {
      headers: { Authorization: `Bearer ${relayToken()}` },
      data: { appName: "Server Name" },
    });
    expect(post.ok()).toBe(true);

    await page.addInitScript(([key]) => {
      localStorage.setItem(key, "Stale Browser Name");
    }, [LEGACY_STORAGE_KEY]);
    await loadApp(page);

    // The stale key is discarded without overwriting the server's name.
    await expect.poll(() => page.evaluate(([key]) => localStorage.getItem(key), [LEGACY_STORAGE_KEY])).toBe(null);
    expect((await fetchManifest(request, baseURL)).name).toBe("Server Name");

    // Cleanup.
    await setAppNameViaUi(page, "");
    await expect.poll(async () => (await fetchManifest(request, baseURL)).name).toBe("OAR");
  });
});
