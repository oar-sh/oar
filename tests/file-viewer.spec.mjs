import fs from "fs";
import os from "os";
import path from "path";
import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// The fullscreen file viewer: every kind fills the screen under floating
// controls that a tap hides, a folder's files are swiped through, the back
// gesture and a swipe down close it, a PDF opens in the browser's own viewer,
// and the media of a conversation is one gallery.
//
// The files live in a temp folder made for the test and are reached through
// the drive route; their paths are only ever handed to the relay.
// platform-agnostic: the path is built by the host's own path module.

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test.describe("fullscreen file viewer", () => {
  const token = relayToken();
  const auth = { Authorization: `Bearer ${token}` };
  let dir = "";
  const web = (name) => path.join(dir, name).replace(/\\/g, "/");

  test.beforeEach(async ({ page }) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oar-e2e-viewer-"));
    fs.writeFileSync(path.join(dir, "picture.png"), PNG_1X1);
    fs.writeFileSync(path.join(dir, "second.png"), PNG_1X1);
    fs.writeFileSync(path.join(dir, "notes.md"), "# Notes\n\nA line of text.\n");
    fs.writeFileSync(path.join(dir, "letter.pdf"), "%PDF-1.4\n%stub\n");
    fs.writeFileSync(path.join(dir, "song.mp3"), Buffer.alloc(512));
    fs.writeFileSync(path.join(dir, "mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#4a8"/></svg>\n');
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
  });

  test.afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const open = (page, name, gallery = null) => page.evaluate(async ({ target, gallery }) => {
    const view = await import("/app/attachments-view.js");
    await view.openDriveFilePreview(target, gallery ? { gallery } : {});
  }, { target: web(name), gallery });

  const galleryOf = (names, index = 0) => ({
    source: "drives",
    items: names.map((name) => ({ path: web(name), name })),
    index,
  });

  // A finger's swipe as the pointer events the viewer listens to.
  const swipe = (page, from, to) => page.evaluate(({ from, to }) => {
    const body = document.getElementById("file-preview-body");
    const target = body.querySelector(".file-preview-image, .file-preview-card, article, .file-preview-code") || body;
    const fire = (type, x, y) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y,
    }));
    fire("pointerdown", from.x, from.y);
    for (let i = 1; i <= 8; i += 1) fire("pointermove", from.x + (to.x - from.x) * (i / 8), from.y + (to.y - from.y) * (i / 8));
    fire("pointerup", to.x, to.y);
  }, { from, to });

  const modal = (page) => page.locator("#file-preview-modal");
  const position = (page) => page.locator("#file-preview-position");

  test("every kind fills the screen, and a tap hides the floating controls", async ({ page }) => {
    await open(page, "picture.png");
    await expect(modal(page)).toHaveClass(/visible/);
    await expect(modal(page)).toHaveClass(/media-mode/);
    await expect(page.locator("#file-preview-body")).toHaveClass(/image-zoom-mode/);
    const box = await page.locator("#file-preview-modal .file-preview-dialog").boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
    await expect(page.locator("#file-preview-chrome-top")).toBeVisible();

    await page.touchscreen.tap(195, 500);
    await expect(modal(page)).toHaveClass(/controls-hidden/);
    await page.touchscreen.tap(195, 500);
    await expect(modal(page)).not.toHaveClass(/controls-hidden/);

    await open(page, "notes.md");
    await expect(modal(page)).not.toHaveClass(/media-mode/);
    await expect(page.locator("#file-preview-body article h1")).toHaveText("Notes");
    await expect(page.locator("#file-preview-mode-raw")).toBeVisible();

    await open(page, "letter.pdf");
    const card = page.locator("#file-preview-body .file-preview-card");
    await expect(card.locator("[data-viewer-open-tab]")).toHaveText("Open in new tab");
    await expect(card.locator("a[download]")).toHaveAttribute("href", /[?&]v=/);
    await expect(page.locator("#file-preview-mode-raw")).toBeHidden();

    await open(page, "song.mp3");
    await expect(page.locator("#file-preview-body")).toHaveClass(/audio-preview-mode/);
    await expect(modal(page)).toHaveClass(/media-mode/);

    // An SVG is a picture here, not plain text: the browser must decode it.
    await open(page, "mark.svg");
    await expect(page.locator("#file-preview-body")).toHaveClass(/image-zoom-mode/);
    await expect.poll(() => page.evaluate(() => {
      const img = document.querySelector("#file-preview-body img");
      return img ? `${img.naturalWidth}x${img.naturalHeight}` : "none";
    })).toBe("40x30");
  });

  test("a folder's files are swiped through, stepped with keys and buttons, and stop at the ends", async ({ page }) => {
    await open(page, "picture.png", galleryOf(["picture.png", "second.png", "notes.md"]));
    await expect(position(page)).toHaveText("1 / 3");
    await expect(page.locator("#file-preview-prev")).toBeDisabled();

    await swipe(page, { x: 300, y: 420 }, { x: 80, y: 420 });
    await expect(position(page)).toHaveText("2 / 3");
    await page.keyboard.press("ArrowRight");
    await expect(position(page)).toHaveText("3 / 3");
    await expect(page.locator("#file-preview-body article h1")).toHaveText("Notes");
    await expect(page.locator("#file-preview-next")).toBeDisabled();
    await page.keyboard.press("ArrowRight");
    await expect(position(page)).toHaveText("3 / 3");

    await page.locator("#file-preview-prev").click();
    await expect(position(page)).toHaveText("2 / 3");
    await swipe(page, { x: 80, y: 420 }, { x: 300, y: 420 });
    await expect(position(page)).toHaveText("1 / 3");
  });

  test("the back gesture closes the viewer and leaves the address as it was", async ({ page }) => {
    const before = page.url();
    await open(page, "picture.png");
    await expect(modal(page)).toHaveClass(/visible/);
    expect(await page.evaluate(() => Boolean(history.state?.oarFileViewer))).toBe(true);

    await page.goBack();
    await expect(modal(page)).not.toHaveClass(/visible/);
    expect(page.url()).toBe(before);
    expect(await page.evaluate(() => Boolean(history.state?.oarFileViewer))).toBe(false);

    // Closed by hand instead: history is left as it was, too.
    await open(page, "picture.png");
    await page.keyboard.press("Escape");
    await expect(modal(page)).not.toHaveClass(/visible/);
    await expect.poll(() => page.evaluate(() => Boolean(history.state?.oarFileViewer))).toBe(false);
    expect(page.url()).toBe(before);
  });

  test("a swipe down dismisses a picture; text scrolls instead", async ({ page }) => {
    await open(page, "picture.png");
    await swipe(page, { x: 195, y: 300 }, { x: 195, y: 540 });
    await expect(modal(page)).not.toHaveClass(/visible/);
    await expect(page.locator("#file-preview-body")).toHaveAttribute("style", "");

    await open(page, "notes.md");
    await swipe(page, { x: 195, y: 300 }, { x: 195, y: 540 });
    await expect(modal(page)).toHaveClass(/visible/);
  });

  test("a PDF is served for the browser's viewer, audio with its type and ranges", async ({ request }) => {
    const pdf = await request.get(`/api/drives/file?path=${encodeURIComponent(web("letter.pdf"))}`, { headers: auth });
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect(pdf.headers()["content-disposition"]).toMatch(/^inline;/);
    expect(pdf.headers()["content-security-policy"]).not.toMatch(/sandbox/);

    const preview = await (await request.get(`/api/drives/files-preview?path=${encodeURIComponent(web("letter.pdf"))}`, { headers: auth })).json();
    expect(preview.kind).toBe("pdf");
    expect(preview.content).toBeUndefined();

    const audio = await request.get(`/api/drives/file?path=${encodeURIComponent(web("song.mp3"))}`, { headers: { ...auth, Range: "bytes=0-99" } });
    expect(audio.status()).toBe(206);
    expect(audio.headers()["content-type"]).toBe("audio/mpeg");
    expect(audio.headers()["content-security-policy"]).toMatch(/sandbox/);
    const audioPreview = await (await request.get(`/api/drives/files-preview?path=${encodeURIComponent(web("song.mp3"))}`, { headers: auth })).json();
    expect(audioPreview.kind).toBe("audio");

    // An SVG keeps its type (an <img> refuses text/plain) and keeps the sandbox.
    const svg = await request.get(`/api/drives/file?path=${encodeURIComponent(web("mark.svg"))}`, { headers: auth });
    expect(svg.headers()["content-type"]).toBe("image/svg+xml");
    expect(svg.headers()["content-disposition"]).toMatch(/^inline;/);
    expect(svg.headers()["content-security-policy"]).toMatch(/sandbox/);
    expect(svg.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("the media of a conversation is one gallery, attachments and embedded pictures alike", async ({ page }) => {
    await page.evaluate(async ({ picture }) => {
      const view = await import("/app/attachments-view.js");
      const { driveFileHrefFromPath } = await import("/app/router.js");
      const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      const attachments = view.renderAttachmentMarkup([
        { name: "shot.png", type: "image/png", size: 68, dataUrl: tiny },
        { name: "notes.pdf", type: "application/pdf", size: 99, dataUrl: "data:application/pdf;base64,JVBERi0=" },
        { name: "voice.mp3", type: "audio/mpeg", size: 512, dataUrl: "data:audio/mpeg;base64,AAAA" },
      ], { messageId: "m1" });
      document.getElementById("messages").innerHTML = `
        <div class="msg user" data-message-id="m1"><div class="msg-bubble">${attachments}</div></div>
        <div class="msg assistant" data-message-id="m2"><div class="msg-bubble"><p>See <img src="${driveFileHrefFromPath(picture)}" alt="picture"></p></div></div>`;
    }, { picture: web("picture.png") });

    // The one-pixel picture is too small to tap; its name opens it just the same.
    await page.locator(".msg-attachment-image [data-media-open]").first().click();
    await expect(modal(page)).toHaveClass(/visible/);
    await expect(position(page)).toHaveText("1 / 3");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#file-preview-body")).toHaveClass(/audio-preview-mode/);
    await expect(position(page)).toHaveText("2 / 3");
    await page.keyboard.press("ArrowRight");
    await expect(position(page)).toHaveText("3 / 3");
    await expect(page.locator("#file-preview-body")).toHaveClass(/image-zoom-mode/);
    await page.keyboard.press("Escape");

    await page.locator('img[alt="picture"]').click();
    await expect(position(page)).toHaveText("3 / 3");
    // The PDF attachment is a plain link, not part of the gallery.
    await expect(page.locator(".msg-attachment:not([data-media-url]) a")).toHaveText("notes.pdf");
  });
});
