import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// The installed app's start screen continues the system launch screen: the
// logo starts at the launch position and size, settles, and only then does
// the screen give way to the app or hand its logo to the sign-in box. A
// browser tab skips all of it.

const asInstalledApp = (page) => page.addInitScript(() => {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query) => (String(query).includes("display-mode: standalone")
    ? { matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
    : original(query));
  window.__startedAt = performance.now();
});

const logoBox = (page, selector) => page.locator(selector).evaluate((node) => {
  const rect = node.getBoundingClientRect();
  return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, width: rect.width };
});

test("installed app: the logo starts at the launch position and the app waits for the animation", async ({ page }) => {
  await asInstalledApp(page);
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`, { waitUntil: "commit" });
  const splash = page.locator("#startup-loading");
  await expect(splash).toHaveClass(/is-animated/);

  // The logo starts as the launch icon: 213 px across (1.44 times its resting
  // 148 px), on the vertical centre line, near mid-screen.
  const launch = await splash.evaluate((node) => {
    const logo = node.querySelector(".brand-logo");
    const resting = { width: logo.offsetWidth, cy: logo.offsetTop + logo.offsetHeight / 2 };
    const read = (name) => parseFloat(node.style.getPropertyValue(name));
    return { resting, dx: read("--startup-dx"), dy: read("--startup-dy"), scale: read("--startup-scale") };
  });
  const viewport = page.viewportSize();
  expect(launch.resting.width).toBe(148);
  expect(launch.resting.width * launch.scale).toBeGreaterThan(212);
  expect(launch.resting.width * launch.scale).toBeLessThan(214);
  expect(Math.abs(launch.dx)).toBeLessThan(1);
  expect(Math.abs(launch.resting.cy + launch.dy - viewport.height / 2)).toBeLessThan(62);
  expect(launch.dy).toBeGreaterThan(20);

  await expect(splash).toHaveCount(0);
  const goneAfter = await page.evaluate(() => performance.now() - window.__startedAt);
  expect(goneAfter).toBeGreaterThan(850);
  await expect(page.locator("#app")).toHaveClass(/visible/);
});

test("installed app without a token: the logo travels into the sign-in box", async ({ page }) => {
  await asInstalledApp(page);
  await page.goto("/");
  const boxLogo = page.locator("#auth-gate .brand-logo");
  await expect(page.locator("#startup-loading")).toHaveCount(0);
  await expect(boxLogo).toBeVisible();
  await expect(page.locator("#auth-gate .auth-box")).toHaveCSS("opacity", "1");
  await expect(page.locator("#token-input")).toBeFocused();
  expect((await logoBox(page, "#auth-gate .brand-logo")).width).toBe(96);
});

test("browser tab: no animation, the start screen leaves at once", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => window.__startupSplash.animated)).toBe(false);
  await expect(page.locator("#startup-loading")).toHaveCount(0);
  await expect(page.locator("#token-input")).toBeFocused();
});
