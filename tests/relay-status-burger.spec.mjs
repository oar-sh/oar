import { devices, expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// The relay status dot (#cli-dot) sits in the sidebar, which is an off-canvas
// drawer on mobile. With the conversation list closed there was no relay signal
// at all, so the burger toggle's bars now carry the same tone.
const OFFLINE = "rgb(110, 118, 129)"; // --relay-tone-offline  #6e7681
const ONLINE = "rgb(63, 185, 80)"; //   --relay-tone-online    #3fb950
const TUNNELLED = "rgb(210, 153, 34)"; // --relay-tone-tunnelled #d29922
const DEFAULT_TEXT = "rgb(230, 237, 243)"; // --text            #e6edf3

test.use({ ...devices["iPhone 12"], browserName: "chromium" });

const burger = (page) => page.locator("#sidebar-toggle");

function burgerStyle(page) {
  return burger(page).evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      color: style.color,
      textShadow: style.textShadow,
      background: style.backgroundColor,
      borderColor: style.borderTopColor,
    };
  });
}

function setTone(page, tone) {
  return page.evaluate((next) => {
    document.getElementById("sidebar-toggle").dataset.relayTone = next;
  }, tone);
}

// The colour and the glow fade over 0.2s, so both are polled rather than
// sampled once: a single read lands on a frame of the transition and returns a
// blend. With a `tone`, every sample first re-applies it, because the app
// republishes the real tone on its status poll (every few seconds) and would
// otherwise undo a hand-set one in the middle of the wait. Re-applying the same
// value does not restart the fade.
function settled(page, property, tone = null) {
  return expect.poll(async () => {
    if (tone) await setTone(page, tone);
    return (await burgerStyle(page))[property];
  });
}
const settledColor = (page, tone = null) => settled(page, "color", tone);
const settledGlow = (page, tone = null) => settled(page, "textShadow", tone);

test.describe("relay status on the mobile burger", () => {
  test("the bars carry the relay tone while the conversation list is closed", async ({ page }) => {
    const token = relayToken();
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");

    // The relay answered, so the dot is green — and the drawer is closed, which
    // is exactly the case the burger tint exists for.
    await expect(page.locator("#cli-dot")).toHaveClass("online");
    await expect(page.locator("#sidebar")).not.toHaveClass(/\bopen\b/);
    await expect(burger(page)).toHaveAttribute("data-relay-tone", "online");

    // The attribute flips the moment the socket connects, which is when the
    // fade from the offline grey STARTS.
    await settledColor(page).toBe(ONLINE);
    await settledGlow(page).toContain("rgba(63, 185, 80, 0.35)");
    const online = await burgerStyle(page);

    // Only the bars are dyed: the button chrome is whatever .header-icon-btn
    // gives every other header button.
    const chrome = await page.locator("#install-btn").evaluate((el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, borderColor: style.borderTopColor };
    });
    expect(online.background).toBe(chrome.background);
    expect(online.borderColor).toBe(chrome.borderColor);
  });

  test("each tone dyes the bars its own colour", async ({ page }) => {
    const token = relayToken();
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");

    await settledColor(page, "offline").toBe(OFFLINE);

    await settledColor(page, "tunnelled").toBe(TUNNELLED);
    await settledGlow(page, "tunnelled").toContain("rgba(210, 153, 34, 0.35)");

    // The three tones must stay visually distinct from each other.
    expect(new Set([OFFLINE, TUNNELLED, ONLINE]).size).toBe(3);
  });

  test("the desktop burger keeps its plain glyph colour", async ({ page }) => {
    const token = relayToken();
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.setViewportSize({ width: 1280, height: 900 });

    // The tone is still published, but the tint is scoped to the mobile
    // breakpoint: on desktop the sidebar dot itself is on screen.
    await expect(burger(page)).toHaveAttribute("data-relay-tone", "online");
    const style = await burgerStyle(page);
    expect(style.color).toBe(DEFAULT_TEXT);
    expect(style.textShadow).toBe("none");
  });
});
