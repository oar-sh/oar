import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// The otter logo follows the Theme setting: the start screen, the sign-in
// box, the tab icons and the installed app's manifest all name the icon set
// for the stored theme, and only that one is fetched.

const iconRequests = (page) => {
  const seen = [];
  page.on("request", (request) => {
    const match = new URL(request.url()).pathname.match(/app-icon(-light)?\.svg$/);
    if (match) seen.push(match[1] ? "light" : "dark");
  });
  return seen;
};

const logoUrl = (page) => page.evaluate(() => {
  const probe = document.createElement("div");
  probe.className = "brand-logo";
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).backgroundImage;
  probe.remove();
  return value;
});

for (const theme of ["light", "dark"]) {
  test(`${theme} theme: start screen logo, icons and manifest match`, async ({ page, request, baseURL }) => {
    await page.addInitScript((value) => { window.localStorage.setItem("copilot_theme", value); }, theme);
    const seen = iconRequests(page);
    // No token: the page stops at the sign-in box, which carries the logo.
    await page.goto("/");
    await expect(page.locator("#auth-gate .brand-logo")).toBeVisible();

    const light = theme === "light";
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(light ? "light" : null);
    expect(await logoUrl(page)).toContain(light ? "app-icon-light.svg" : "app-icon.svg");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", light ? "#ffffff" : /^#(161b22|0d1117)$/);
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref.includes("theme=light")).toBe(light);
    await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute(
      "href",
      light ? /app-icon-light\.svg/ : /app-icon\.svg/,
    );
    await expect.poll(() => seen.includes(theme)).toBe(true);
    expect(seen.filter((entry) => entry !== theme)).toEqual([]);

    const manifest = await (await request.get(new URL(manifestHref, baseURL).toString())).json();
    expect(manifest.background_color).toBe(light ? "#ffffff" : "#0d1117");
    expect(manifest.icons.every((icon) => icon.src.includes("app-icon-light") === light)).toBe(true);
    for (const icon of manifest.icons) {
      expect((await request.get(`${baseURL}/${icon.src}`)).ok()).toBe(true);
    }
  });
}

test("changing the theme swaps the manifest, the icons and the logo", async ({ page }) => {
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForFunction(() => typeof window.updateTheme === "function");
  await page.evaluate(() => window.updateTheme("light"));
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", /theme=light/);
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#ffffff");
  expect(await logoUrl(page)).toContain("app-icon-light.svg");
  await page.evaluate(() => window.updateTheme("dark"));
  await expect(page.locator('link[rel="manifest"]')).not.toHaveAttribute("href", /theme=light/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /app-icon-192\.png/);
  await expect(page.locator('meta[name="theme-color"]')).not.toHaveAttribute("content", "#ffffff");
  expect(await logoUrl(page)).toContain("app-icon.svg");
});
