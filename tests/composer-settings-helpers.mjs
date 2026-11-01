import { expect } from "@playwright/test";

// The composer's selects (#mode-select, #model-select, #reasoning-effort-select,
// #context-tier-select) and the billing toggle (#claude-billing-toggle) live in
// the ⚙ panel (#composer-settings), closed by default. Playwright clicks and
// selectOption need them visible: these open the panel first.
//
// Reading `.value` (toHaveValue, inputValue) works on a closed panel and needs
// none of this.

/** Opens the ⚙ panel unless it is open already. */
export async function openComposerSettings(page) {
  const panel = page.locator("#composer-settings");
  if (await panel.isVisible().catch(() => false)) return panel;
  await page.locator("#composer-settings-btn").click();
  await expect(panel).toBeVisible();
  return panel;
}

/** Closes the ⚙ panel if it is open. */
export async function closeComposerSettings(page) {
  const panel = page.locator("#composer-settings");
  if (!(await panel.isVisible().catch(() => false))) return;
  await page.locator("#composer-settings-btn").click();
  await expect(panel).toBeHidden();
}

/**
 * The control (a selector or a locator), with the ⚙ panel opened when the
 * control is not visible yet.
 */
export async function composerControl(page, control) {
  const locator = typeof control === "string" ? page.locator(control) : control;
  if (!(await locator.isVisible().catch(() => false))) await openComposerSettings(page);
  return locator;
}

/** selectOption on a composer select, opening the ⚙ panel when needed. */
export async function selectComposerOption(page, selector, value) {
  const select = await composerControl(page, selector);
  return select.selectOption(value);
}
