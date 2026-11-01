import { expect } from "@playwright/test";

/**
 * The chat header's priority+ actions (server/public/app/header-priority-actions.mjs):
 * each one is a header button while the header has room, and a twin entry in
 * the ︙ menu once it does not fit. Which one shows depends on the viewport, so
 * a spec that just wants the action uses these helpers instead of an id.
 */
export const HEADER_ACTIONS = Object.freeze({
  pins: { inline: "#pinned-messages-btn", menu: "#chat-menu-pins" },
  hidden: { inline: "#hidden-messages-btn", menu: "#chat-menu-hidden" },
  search: { inline: "#message-search-btn", menu: "#chat-menu-search" },
  context: { inline: "#context-btn", menu: "#chat-menu-context" },
  usage: { inline: "#usage-btn", menu: "#chat-menu-usage" },
  theme: { inline: "#theme-toggle-btn", menu: "#chat-menu-theme-toggle" },
  fullscreen: { inline: "#fullscreen-btn", menu: "#chat-menu-fullscreen" },
});

function actionOf(key) {
  const action = HEADER_ACTIONS[key];
  if (!action) throw new Error(`Unknown header action: ${key}`);
  return action;
}

/** Waits for the header's first fit pass (it marks #chat-header-actions). */
export async function waitForHeaderFit(page) {
  await expect(page.locator("#chat-header-actions[data-header-fit]")).toHaveCount(1);
}

/** Opens the ︙ menu unless it is open already. */
export async function openChatActionsMenu(page) {
  const menu = page.locator("#chat-actions-menu");
  if (!(await menu.isVisible())) {
    await expect(page.locator("#chat-actions-menu-btn")).toBeEnabled();
    await page.locator("#chat-actions-menu-btn").click();
  }
  await expect(menu).toBeVisible();
}

/**
 * Clicks a header action: the header button when it shows, otherwise ︙ and
 * then its twin. Returns "inline" or "menu", whichever was used.
 */
export async function clickHeaderAction(page, key) {
  const action = actionOf(key);
  await waitForHeaderFit(page);
  const inline = page.locator(action.inline);
  if (await inline.isVisible()) {
    await inline.click();
    return "inline";
  }
  await openChatActionsMenu(page);
  const twin = page.locator(action.menu);
  await expect(twin).toBeVisible();
  await twin.click();
  return "menu";
}

/**
 * Whether an action is offered at all: its header button shows, or its twin
 * is not hidden AND ︙ itself shows (a twin behind a hidden ︙ is unreachable).
 */
export async function isHeaderActionAvailable(page, key) {
  const action = actionOf(key);
  await waitForHeaderFit(page);
  if (await page.locator(action.inline).isVisible()) return true;
  if (!(await page.locator("#chat-actions-menu-btn").isVisible())) return false;
  return (await page.locator(action.menu).getAttribute("hidden")) === null;
}

/**
 * Asserts a user can reach the action: its header button shows, or ︙ opens
 * and the twin is visible in it. The menu is closed again afterwards.
 * Returns "inline" or "menu".
 */
export async function expectHeaderActionReachable(page, key) {
  const action = actionOf(key);
  await waitForHeaderFit(page);
  if (await page.locator(action.inline).isVisible()) return "inline";
  await openChatActionsMenu(page);
  await expect(page.locator(action.menu)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#chat-actions-menu")).toBeHidden();
  return "menu";
}

/** Asserts an action is offered nowhere: no header button and a hidden twin. */
export async function expectHeaderActionUnavailable(page, key) {
  const action = actionOf(key);
  await expect(page.locator(action.inline)).toBeHidden();
  await expect(page.locator(action.menu)).toHaveAttribute("hidden", "");
}

/** The copy of an action a user sees now (header button or twin), for text checks. */
export async function headerActionLocator(page, key) {
  const action = actionOf(key);
  await waitForHeaderFit(page);
  const inline = page.locator(action.inline);
  return (await inline.isVisible()) ? inline : page.locator(action.menu);
}
