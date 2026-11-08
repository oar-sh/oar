import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

import { repoRoot, startRelayServer } from "./relay-server-harness.mjs";

/**
 * The media gallery on a relay of its own, seeded straight into its database:
 * two invented sessions with pictures an agent embedded (local files written
 * here), one picture the owner uploaded, a remote-free set so nothing leaves
 * the machine.
 *
 * - 🧠 opens on Context; the Media tab shows the session's count and grid.
 * - A tile opens the file viewer over the gallery: arrows move on, the caption
 *   names the session, "Open in session" jumps to the message.
 * - ︙ → 🖼️ Media shows every session under month headers with filters; on a
 *   phone the grid has 3 columns.
 *
 * MEDIA_GALLERY_SCREENSHOT_DIR, when set, receives the screenshots.
 */

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const SHOTS = process.env.MEDIA_GALLERY_SCREENSHOT_DIR || "";
const require = createRequire(path.join(repoRoot, "package.json"));
const Database = require("better-sqlite3");

// A PNG of one colour band per row, written with zlib only.
function png(width, height, colorAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colorAt(x, y);
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PALETTE = [
  [[255, 183, 77], [244, 81, 30]],
  [[129, 199, 132], [27, 94, 32]],
  [[100, 181, 246], [13, 71, 161]],
  [[206, 147, 216], [74, 20, 140]],
  [[255, 241, 118], [245, 127, 23]],
  [[128, 222, 234], [0, 96, 100]],
  [[239, 154, 154], [183, 28, 28]],
  [[188, 170, 164], [62, 39, 35]],
];

function picture(index, { stripes = false } = {}) {
  const [top, bottom] = PALETTE[index % PALETTE.length];
  return png(240, 180, (x, y) => {
    const t = y / 179;
    const ring = stripes ? Math.floor((x + y) / 20) % 2 === 0 : Math.hypot(x - 120, y - 90) < 30 + (index % 4) * 8;
    const mix = (a, b) => Math.round(a + (b - a) * t);
    const base = [mix(top[0], bottom[0]), mix(top[1], bottom[1]), mix(top[2], bottom[2])];
    return ring ? base.map((v) => 255 - v) : base;
  });
}

let relay;
let sessions;

test.beforeAll(async () => {
  relay = await startRelayServer({ token: randomUUID() });
  const pictures = path.join(relay.stateRoot, "pictures");
  fs.mkdirSync(pictures, { recursive: true });
  const db = new Database(path.join(relay.dataDir, "oar.db"));
  const conv = db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)");
  const msg = db.prepare("INSERT INTO messages (id, conversation_id, role, text, attachments, timestamp) VALUES (?, ?, ?, ?, ?, ?)");
  sessions = { garden: randomUUID(), kitchen: randomUUID() };
  const at = (day, hour) => new Date(Date.UTC(2026, day < 0 ? 9 : 10, day < 0 ? 28 + day : day, hour)).toISOString();
  conv.run(sessions.garden, "Garden planning", at(1, 8), at(6, 9));
  conv.run(sessions.kitchen, "Kitchen tiles", at(-3, 8), at(-1, 9));
  const file = (name, index) => {
    const target = path.join(pictures, name);
    fs.writeFileSync(target, picture(index));
    return target.replace(/\\/g, "/");
  };
  msg.run(randomUUID(), sessions.garden, "user", "Plan the beds for spring.", null, at(1, 9));
  for (let i = 0; i < 9; i += 1) {
    msg.run(`garden-${i}`, sessions.garden, "assistant", `Sketch ${i + 1}: ![bed ${i + 1}](${file(`bed-${i + 1}.png`, i)})`, null, at(2 + (i % 4), 10 + i));
  }
  msg.run("garden-repeat", sessions.garden, "assistant", `The first sketch again: ![bed 1](${file("bed-1.png", 0)})`, null, at(6, 8));
  for (let i = 0; i < 5; i += 1) {
    msg.run(`kitchen-${i}`, sessions.kitchen, "assistant", `Tile idea ${i + 1}: ![tile ${i + 1}](${file(`tile-${i + 1}.png`, i + 3)})`, null, at(-3 + (i % 3), 11 + i));
  }
  db.close();

  // One picture the owner uploads, as the composer does.
  const bytes = picture(7, { stripes: true });
  const upload = await fetch(`${relay.baseUrl}/api/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${relay.token}`, "x-file-name": "my-sketch.png", "x-file-type": "image/png", "content-type": "application/octet-stream" },
    body: bytes,
  }).then((response) => response.json());
  const db2 = new Database(path.join(relay.dataDir, "oar.db"));
  db2.prepare("INSERT INTO messages (id, conversation_id, role, text, attachments, timestamp) VALUES (?, ?, 'user', ?, ?, ?)")
    .run("garden-upload", sessions.garden, "My own sketch", JSON.stringify([upload.attachment]), at(6, 7));
  db2.close();
});

test.afterAll(async () => {
  await relay?.stop();
});

async function openApp(page, viewport, conversationId = "") {
  await page.setViewportSize(viewport);
  if (conversationId) {
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
  }
  await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
  await expect(page.locator("#chat-actions-menu-btn")).toBeVisible();
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  // The tiles in view have loaded (lazy pictures arrive a moment after the grid).
  await page.waitForFunction(() => [...document.querySelectorAll('.media-tile img')]
    .filter((img) => { const box = img.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight; })
    .every((img) => img.complete && img.naturalWidth > 0), null, { timeout: 5000 }).catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test("🧠 opens on Context; its Media tab shows the session's pictures and opens the viewer", async ({ page }) => {
  await openApp(page, DESKTOP, sessions.garden);
  await expect(page.locator('#messages .msg[data-message-id="garden-repeat"]')).toBeVisible();
  await page.evaluate(() => window.showContext());
  const modal = page.locator("#summary-modal");
  await expect(modal.locator('[data-context-tab="context"]')).toHaveAttribute("aria-selected", "true");
  await expect(modal.locator("[data-context-media-count]")).toHaveText("10");
  await modal.locator('[data-context-tab="media"]').click();
  const tiles = modal.locator(".media-tile");
  await expect(tiles).toHaveCount(10);
  // Newest first: the sketch shown again, then the owner's upload.
  await expect(tiles.nth(0).locator(".media-tile-badge")).toHaveText("🤖");
  await expect(tiles.nth(1).locator(".media-tile-badge")).toHaveText("👤");
  await expect(modal.locator(".media-month-label").first()).toHaveText("November 2026");
  await shot(page, "context-media-tab");

  await tiles.nth(0).click();
  const viewer = page.locator("#file-preview-modal");
  await expect(viewer).toHaveClass(/visible/);
  await expect(page.locator("#file-preview-gallery-caption")).toContainText("Garden planning");
  await expect(page.locator("#file-preview-gallery-caption")).toContainText("in 2 messages");
  await expect(page.locator("#file-preview-position")).toHaveText("1 / 10");
  // Opened from the 🧠 modal, the viewer lies above it.
  expect(await page.evaluate(() => Boolean(document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('#file-preview-modal')))).toBe(true);
  await shot(page, "viewer");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#file-preview-position")).toHaveText("2 / 10");
  await page.keyboard.press("Escape");
  await expect(viewer).not.toHaveClass(/visible/);
  await expect(viewer).not.toHaveClass(/over-summary/);
});

test("︙ → 🖼️ Media shows every session with filters; Open in session jumps to the message", async ({ page }) => {
  await openApp(page, DESKTOP, sessions.kitchen);
  await expect(page.locator('#messages .msg[data-message-id="kitchen-2"]')).toBeVisible();
  await page.evaluate(() => window.toggleMediaView());
  const view = page.locator('#messages .media-gallery[data-scope="global"]');
  await expect(view).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/media-view-active/);
  await expect(view.locator(".media-tile")).toHaveCount(15);
  await expect(view.locator(".media-month-label")).toHaveText(["November 2026", "October 2026"]);
  await expect(page.locator("#input-area")).toBeHidden();
  await shot(page, "global-desktop");

  await view.locator('[data-media-source="mine"]').click();
  await expect(view.locator(".media-tile")).toHaveCount(1);
  await view.locator('[data-media-source="all"]').click();
  await view.locator('[data-media-filter="q"]').fill("kitchen");
  await expect(view.locator(".media-tile")).toHaveCount(5);

  await view.locator(".media-tile").first().click();
  await page.locator('[data-gallery-action="open-in-session"]').click();
  await expect(page.locator("body")).not.toHaveClass(/media-view-active/);
  await expect(page.locator('#messages .msg[data-message-id="kitchen-2"]')).toBeVisible();
});

test("on a phone the global Media view is a 3-column grid", async ({ page }) => {
  await openApp(page, PHONE);
  await page.locator("#chat-actions-menu-btn").click();
  await page.locator("#chat-menu-media").click();
  const grid = page.locator('#messages .media-gallery[data-scope="global"] .media-grid').first();
  await expect(grid).toBeVisible();
  const columns = await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length);
  expect(columns).toBe(3);
  await shot(page, "global-phone");
  await page.goBack();
  await expect(page.locator("body")).not.toHaveClass(/media-view-active/);
});
