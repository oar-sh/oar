import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// Marker annotations on screenshots: the composer thumbnail and the sent-image
// lightbox both open the same editor; accept flattens to a PNG that either
// replaces the pending attachment or joins the composer as a new one. Strokes
// are drawn with real mouse events on the stage — the whole pipeline from
// pointer capture to canvas to export runs.

async function loadApp(page) {
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.openAnnotateEditorForPending === "function");
}

/** Attaches a generated PNG through the production file-input handler. */
async function attachPng(page, { name = "shot.png", size = 64 } = {}) {
  await page.evaluate(async ({ name, size }) => {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000000";
    ctx.fillRect(8, 8, size - 16, 12);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const file = new File([blob], name, { type: "image/png" });
    await window.handleAttachmentInput([file]);
  }, { name, size });
}

async function drawStroke(page, { from = [0.3, 0.4], to = [0.7, 0.4] } = {}) {
  const stage = page.locator("#annotate-stage");
  const box = await stage.boundingBox();
  const point = (frac) => [box.x + box.width * frac[0], box.y + box.height * frac[1]];
  const [x1, y1] = point(from);
  const [x2, y2] = point(to);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
  await page.mouse.move(x2, y2, { steps: 4 });
  await page.mouse.up();
}

test.describe("screenshot annotations", () => {
  test("pending attachment: draw, undo, reset, and accept replaces it", async ({ page }) => {
    await loadApp(page);
    await attachPng(page, { name: "shot.png" });

    const item = page.locator(".attachment-preview-item");
    await expect(item).toHaveCount(1);
    await expect(item.locator(".attachment-preview-annotate")).toBeVisible();

    await item.locator("img").click();
    await expect(page.locator("#image-annotate-modal")).toHaveClass(/visible/);
    await expect(page.locator("#annotate-title")).toContainText("shot.png");

    const undoBtn = page.locator("#annotate-undo-btn");
    const resetBtn = page.locator("#annotate-reset-btn");
    const acceptBtn = page.locator("#annotate-accept-btn");
    await expect(undoBtn).toBeDisabled();
    await expect(acceptBtn).toBeDisabled();

    // One stroke arms undo + accept; undo disarms them again.
    await drawStroke(page);
    await expect(undoBtn).toBeEnabled();
    await expect(acceptBtn).toBeEnabled();
    await undoBtn.click();
    await expect(acceptBtn).toBeDisabled();

    // Reset clears two strokes at once, and is itself undoable.
    await drawStroke(page, { from: [0.3, 0.3], to: [0.7, 0.3] });
    await drawStroke(page, { from: [0.3, 0.6], to: [0.7, 0.6] });
    await resetBtn.click();
    await expect(acceptBtn).toBeDisabled();
    await undoBtn.click();
    await expect(acceptBtn).toBeEnabled();

    await acceptBtn.click();
    await expect(page.locator("#image-annotate-modal")).not.toHaveClass(/visible/);
    await expect(item.locator(".attachment-preview-meta")).toContainText("shot-annotated.png");
    // The replacement upload completes (spinner gone, no error chip).
    await expect(page.locator(".attachment-preview-item.attachment-preview-uploaded")).toHaveCount(1, { timeout: 15_000 });

    // Cleanup for the next test.
    await page.locator(".attachment-preview-remove").click();
    await expect(page.locator(".attachment-preview-item")).toHaveCount(0);
  });

  test("a color and width can be selected before drawing", async ({ page }) => {
    await loadApp(page);
    await attachPng(page);
    await page.locator(".attachment-preview-item img").click();
    await expect(page.locator("#image-annotate-modal")).toHaveClass(/visible/);

    await expect(page.locator('.annotate-color[data-color="yellow"]')).toHaveClass(/active/);
    await page.locator('.annotate-color[data-color="red"]').click();
    await expect(page.locator('.annotate-color[data-color="red"]')).toHaveClass(/active/);
    await expect(page.locator('.annotate-color[data-color="yellow"]')).not.toHaveClass(/active/);

    await expect(page.locator('.annotate-width[data-width="medium"]')).toHaveClass(/active/);
    await page.locator('.annotate-width[data-width="thick"]').click();
    await expect(page.locator('.annotate-width[data-width="thick"]')).toHaveClass(/active/);

    await drawStroke(page);
    await expect(page.locator("#annotate-accept-btn")).toBeEnabled();

    // ✖ with strokes asks for confirmation; accept the discard.
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#annotate-close-btn").click();
    await expect(page.locator("#image-annotate-modal")).not.toHaveClass(/visible/);
    await page.locator(".attachment-preview-remove").click();
  });

  test("sent image: lightbox 🖍️ produces a new composer attachment, message untouched", async ({ page }) => {
    await loadApp(page);
    await attachPng(page, { name: "sent-shot.png" });
    await expect(page.locator(".attachment-preview-item.attachment-preview-uploaded")).toHaveCount(1, { timeout: 15_000 });

    // Send it (the harness has no provider; the user message still renders).
    await page.locator("#msg-input").fill("look at this");
    await page.locator("#send-btn").click();
    await expect(page.locator(".msg-attachment-image img").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".attachment-preview-item")).toHaveCount(0);

    await page.locator(".msg-attachment-image img").first().click();
    await expect(page.locator("#file-preview-modal")).toHaveClass(/visible/);
    await expect(page.locator("#file-preview-annotate-btn")).toBeVisible();
    await page.locator("#file-preview-annotate-btn").click();

    await expect(page.locator("#file-preview-modal")).not.toHaveClass(/visible/);
    await expect(page.locator("#image-annotate-modal")).toHaveClass(/visible/);
    await drawStroke(page);
    await page.locator("#annotate-accept-btn").click();

    await expect(page.locator("#image-annotate-modal")).not.toHaveClass(/visible/);
    // The annotated copy lands in the composer; the sent message keeps its own.
    await expect(page.locator(".attachment-preview-item")).toHaveCount(1);
    await expect(page.locator(".attachment-preview-meta").last()).toContainText("annotated");
    await expect(page.locator(".msg-attachment-image img").first()).toBeVisible();

    await page.locator(".attachment-preview-remove").click();
  });
});
