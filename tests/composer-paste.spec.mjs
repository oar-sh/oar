import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { relayToken, relayBaseUrl, relayDbPath } from "./e2e-env.mjs";

// A 1x1 PNG. Small enough that upload latency never dominates the test, and a
// real image so the composer takes the image branch (thumbnail + vision checks).
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Hh9kAAAAASUVORK5CYII=";

function readDraftAttachments(conversationId) {
  const db = new DatabaseSync(relayDbPath(), { readOnly: true });
  try {
    const row = db
      .prepare(`SELECT draft_attachments FROM conversations WHERE id = ?`)
      .get(conversationId);
    const raw = String(row?.draft_attachments || "").trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  } finally {
    db.close();
  }
}

/**
 * Dispatches a real ClipboardEvent carrying a file, which is the only way to
 * exercise the production paste handler end to end.
 */
async function pasteFileIntoComposer(page, { base64, name, type, text = "" }) {
  await page.evaluate(
    ({ base64, name, type, text }) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], name, { type });

      const transfer = new DataTransfer();
      transfer.items.add(file);
      if (text) transfer.setData("text/plain", text);

      const input = document.getElementById("msg-input");
      input.focus();
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        })
      );
    },
    { base64, name, type, text }
  );
}

async function dropFilesIntoComposer(page, files) {
  await page.evaluate((files) => {
    const transfer = new DataTransfer();
    for (const { base64, name, type } of files) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      transfer.items.add(new File([bytes], name, { type }));
    }
    const zone = document.getElementById("input-area");
    zone.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    zone.dispatchEvent(new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    zone.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, files);
}

async function openRelay(page, token) {
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("#msg-input")).toBeVisible();
}

test("pasting an image attaches it without sending or altering the text", async ({ page }) => {
  const token = relayToken();
  await openRelay(page, token);

  await page.fill("#msg-input", "here is the screenshot");
  await pasteFileIntoComposer(page, {
    base64: ONE_PIXEL_PNG_BASE64,
    name: "image.png",
    type: "image/png",
    text: "clipboard text that must be ignored",
  });

  const chip = page.locator(".attachment-preview-item");
  await expect(chip).toHaveCount(1);
  await expect(page.locator("#attachment-preview")).toHaveClass(/visible/);

  // The image wins: the clipboard's text must not land in the composer.
  await expect(page.locator("#msg-input")).toHaveValue("here is the screenshot");

  // Attaching must never send a message.
  await expect(page.locator(".msg")).toHaveCount(0);

  // Clipboard bitmaps get a timestamped name rather than the generic image.png.
  await expect(chip.locator(".attachment-preview-meta")).toContainText(/^pasted-\d{4}-\d{2}-\d{2}T/);

  // Eager upload: the chip settles into the uploaded state on its own.
  await expect(chip).toHaveClass(/attachment-preview-uploaded/, { timeout: 15000 });
  await expect(chip.locator("img")).toBeVisible();
});

test("pasting plain text keeps native behaviour and attaches nothing", async ({ page }) => {
  const token = relayToken();
  await openRelay(page, token);

  await page.click("#msg-input");
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "just some text");
    const input = document.getElementById("msg-input");
    input.focus();
    input.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })
    );
  });

  await expect(page.locator(".attachment-preview-item")).toHaveCount(0);
  // The handler must not have called preventDefault, so the event stays cancelable.
  const prevented = await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "more text");
    const input = document.getElementById("msg-input");
    const event = new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
});

test("send is disabled until pasted attachments finish uploading", async ({ page }) => {
  const token = relayToken();
  await openRelay(page, token);

  // Hold the upload open so the in-flight state is observable.
  let releaseUpload = () => {};
  const uploadHeld = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  await page.route("**/api/upload", async (route) => {
    await uploadHeld;
    await route.continue();
  });

  await page.fill("#msg-input", "waiting on the upload");
  await pasteFileIntoComposer(page, {
    base64: ONE_PIXEL_PNG_BASE64,
    name: "image.png",
    type: "image/png",
  });

  const sendBtn = page.locator("#send-btn");
  await expect(page.locator(".attachment-preview-uploading")).toHaveCount(1);
  await expect(sendBtn).toBeDisabled();

  releaseUpload();
  await expect(page.locator(".attachment-preview-uploaded")).toHaveCount(1, { timeout: 15000 });
  await expect(sendBtn).toBeEnabled();
});

test("dropping several files attaches all of them", async ({ page }) => {
  const token = relayToken();
  await openRelay(page, token);

  await dropFilesIntoComposer(page, [
    { base64: ONE_PIXEL_PNG_BASE64, name: "first.png", type: "image/png" },
    { base64: ONE_PIXEL_PNG_BASE64, name: "second.png", type: "image/png" },
  ]);

  const chips = page.locator(".attachment-preview-item");
  await expect(chips).toHaveCount(2);
  // Named files keep their own names.
  await expect(chips.nth(0).locator(".attachment-preview-meta")).toContainText("first.png");
  await expect(chips.nth(1).locator(".attachment-preview-meta")).toContainText("second.png");
  await expect(page.locator(".attachment-preview-uploaded")).toHaveCount(2, { timeout: 15000 });
});

test("attachments survive switching away and back to a conversation", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };

  const first = await request.post("/api/message", {
    headers,
    data: { text: "first conversation", relayMode: "ask", model: "gpt-5.4-mini" },
  });
  expect(first.ok()).toBeTruthy();
  const firstId = String((await first.json())?.conversationId || "");

  const second = await request.post("/api/message", {
    headers,
    data: { text: "second conversation", relayMode: "ask", model: "gpt-5.4-mini" },
  });
  expect(second.ok()).toBeTruthy();
  const secondId = String((await second.json())?.conversationId || "");

  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();
  expect(firstId).not.toEqual(secondId);

  await page.addInitScript((id) => {
    localStorage.setItem("copilot_last_conv", id);
  }, firstId);
  await openRelay(page, token);

  await pasteFileIntoComposer(page, {
    base64: ONE_PIXEL_PNG_BASE64,
    name: "image.png",
    type: "image/png",
  });
  await expect(page.locator(".attachment-preview-uploaded")).toHaveCount(1, { timeout: 15000 });

  // The cache is what makes the attachment survive; wait for it to be persisted.
  await expect
    .poll(() => readDraftAttachments(firstId).length, { timeout: 15000 })
    .toBe(1);

  await page.evaluate((id) => window.openConversation(id), secondId);
  await expect(page.locator(".attachment-preview-item")).toHaveCount(0);

  await page.evaluate((id) => window.openConversation(id), firstId);
  await expect(page.locator(".attachment-preview-item")).toHaveCount(1);
  await expect(page.locator(".attachment-preview-item img")).toBeVisible();
});

test("removing an attachment clears it from the persisted draft", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };

  const created = await request.post("/api/message", {
    headers,
    data: { text: "removal target", relayMode: "ask", model: "gpt-5.4-mini" },
  });
  expect(created.ok()).toBeTruthy();
  const conversationId = String((await created.json())?.conversationId || "");
  expect(conversationId).toBeTruthy();

  await page.addInitScript((id) => {
    localStorage.setItem("copilot_last_conv", id);
  }, conversationId);
  await openRelay(page, token);

  await pasteFileIntoComposer(page, {
    base64: ONE_PIXEL_PNG_BASE64,
    name: "image.png",
    type: "image/png",
  });
  await expect(page.locator(".attachment-preview-uploaded")).toHaveCount(1, { timeout: 15000 });
  await expect
    .poll(() => readDraftAttachments(conversationId).length, { timeout: 15000 })
    .toBe(1);

  await page.click(".attachment-preview-remove");
  await expect(page.locator(".attachment-preview-item")).toHaveCount(0);
  await expect
    .poll(() => readDraftAttachments(conversationId).length, { timeout: 15000 })
    .toBe(0);

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".attachment-preview-item")).toHaveCount(0);
});
