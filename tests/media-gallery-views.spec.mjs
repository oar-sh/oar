import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

import { repoRoot, sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * The media gallery beyond its first page, on a relay of its own seeded
 * straight into its database (invented sessions and pictures):
 *
 * - The global Media view stays in place when a question waits in another
 *   session (the poll that opens it with nothing open leaves the view alone)
 *   and when the page goes offline and back (the refresh after a reconnect).
 * - The viewer moves past the last loaded picture into the next page.
 * - Tiles: a video gets its address when in view and carries ▶; a picture
 *   on another site carries 🌐; an archived session's tile is dimmed; a file
 *   deleted since is left out and counted.
 *
 * No worker runs: the question's turn is a message the spec took off the
 * queue (GET /api/pending), as in mobile-session-header.spec.mjs.
 */

const DESKTOP = { width: 1280, height: 800 };
const require = createRequire(path.join(repoRoot, "package.json"));
const Database = require("better-sqlite3");

function png(seed) {
  const width = 64;
  const height = 48;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      raw[offset] = (seed * 37 + x * 3) % 256;
      raw[offset + 1] = (seed * 91 + y * 5) % 256;
      raw[offset + 2] = (seed * 53) % 256;
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
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

// The start of an MP4 file: enough for the relay's type check, not to play.
const MP4_HEAD = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.from([0, 0, 2, 0]),
  Buffer.from("isomiso2", "latin1"), Buffer.alloc(64),
]);

let relay;
const sessions = {};

async function api(route, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${relay.baseUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

test.beforeAll(async () => {
  relay = await startRelayServer({ token: randomUUID() });
  const pictures = path.join(relay.stateRoot, "pictures");
  fs.mkdirSync(pictures, { recursive: true });
  const file = (name, bytes) => {
    const target = path.join(pictures, name);
    fs.writeFileSync(target, bytes);
    return target.replace(/\\/g, "/");
  };
  const db = new Database(path.join(relay.dataDir, "oar.db"));
  const conv = db.prepare("INSERT INTO conversations (id, title, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  const msg = db.prepare("INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, 'assistant', ?, ?)");
  const at = (minute) => new Date(Date.UTC(2026, 10, 2, 8, minute)).toISOString();
  sessions.paging = randomUUID();
  sessions.kinds = randomUUID();
  sessions.old = randomUUID();
  conv.run(sessions.paging, "Seed catalogue", 0, at(0), at(0));
  conv.run(sessions.kinds, "Odds and ends", 0, at(0), at(0));
  conv.run(sessions.old, "Last year's beds", 1, at(0), at(0));
  for (let i = 0; i < 65; i += 1) {
    msg.run(`seed-${i}`, sessions.paging, `Packet ${i + 1}: ![packet ${i + 1}](${file(`packet-${i + 1}.png`, png(i + 1))})`, at(100 + i));
  }
  msg.run("kinds-video", sessions.kinds, `A clip: ![clip](${file("clip.mp4", MP4_HEAD)})`, at(300));
  msg.run("kinds-remote", sessions.kinds, "From the web: ![remote](http://127.0.0.1:9/remote-sketch.png)", at(301));
  const gone = file("gone.png", png(200));
  msg.run("kinds-gone", sessions.kinds, `Deleted later: ![gone](${gone})`, at(302));
  fs.rmSync(gone);
  msg.run("old-1", sessions.old, `An old bed: ![old](${file("old-bed.png", png(300))})`, at(10));
  db.close();
});

test.afterAll(async () => {
  await relay?.stop();
});

async function openMediaView(page, { from = '' } = {}) {
  await page.setViewportSize(DESKTOP);
  if (from) await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, from);
  await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
  await expect(page.locator("#chat-actions-menu-btn")).toBeVisible();
  if (from) await expect(page.locator('#messages .msg[data-message-id]').first()).toBeVisible();
  await page.evaluate(() => window.toggleMediaView());
  const view = page.locator('#messages .media-gallery[data-scope="global"]');
  await expect(view.locator(".media-tile").first()).toBeVisible();
  return view;
}

test("tiles: a video gets its address in view, remote and archived are marked, a deleted file is left out", async ({ page }) => {
  const view = await openMediaView(page);
  await view.locator('[data-media-filter="session"]').selectOption(sessions.kinds);
  await expect(view.locator(".media-tile")).toHaveCount(2);
  const video = view.locator(".media-tile video");
  await expect(video).toHaveAttribute("src", /\/api\/media\/\d+\/content#t=0\.1$/);
  await expect(view.locator(".media-tile-play")).toHaveCount(1);
  await expect(view.locator(".media-tile img")).toHaveAttribute("src", "http://127.0.0.1:9/remote-sketch.png");
  await expect(view.locator(".media-tile-badge").filter({ hasText: "🌐" })).toHaveCount(1);
  await expect(view.locator(".media-gallery-status")).toContainText("1 missing file is not shown.");

  await view.locator('[data-media-filter="session"]').selectOption(sessions.old);
  await expect(view.locator(".media-tile")).toHaveCount(1);
  await expect(view.locator(".media-tile").first()).toHaveClass(/media-tile-archived/);
  await view.locator('[data-media-filter="archived"]').check();
  await expect(view.locator(".media-tile")).toHaveCount(0);
});

test("the viewer moves past the last loaded picture into the next page", async ({ page }) => {
  const view = await openMediaView(page);
  await view.locator('[data-media-filter="session"]').selectOption(sessions.paging);
  await expect(view.locator(".media-tile")).toHaveCount(60);
  await view.locator(".media-tile").nth(59).click();
  await expect(page.locator("#file-preview-position")).toHaveText("60 / 60+");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#file-preview-position")).toHaveText("61 / 65");
  await expect(page.locator("#file-preview-gallery-caption")).toContainText("Seed catalogue");
  await page.keyboard.press("Escape");
  await expect(view.locator(".media-tile")).toHaveCount(65);
});

test("offline and back: the refresh after the reconnect leaves the Media view in place", async ({ page, context }) => {
  // Opened from a session, as usual: the transcript that was shown differs from
  // the empty one a refresh with nothing open renders.
  const view = await openMediaView(page, { from: sessions.kinds });
  const tiles = await view.locator(".media-tile").count();
  await context.setOffline(true);
  await sleep(1500);
  await context.setOffline(false);
  // The CLI comes online (a client polls for work): the page refreshes its view,
  // as it does after every reconnect.
  await api("/api/pending");
  await sleep(5000);
  await expect(page.locator("body")).toHaveClass(/media-view-active/);
  await expect(view.locator(".media-tile")).toHaveCount(tiles);
});

test("a question waiting in another session does not pull the reader out of the Media view", async ({ page }) => {
  const view = await openMediaView(page);
  const queued = await api("/api/message", { method: "POST", body: { text: "Which bed first?", relayMode: "agent", model: "gpt-5.4-mini" } });
  expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
  const { conversationId, ownerSessionId, messageId } = queued.payload;
  await api("/api/session-sync", { method: "POST", body: { sdk_session_id: conversationId, conversation_id: conversationId } });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const dequeued = await api("/api/pending", { headers: ownerSessionId ? { "x-relay-session-id": String(ownerSessionId) } : {} });
    if (String(dequeued.payload?.message?.conversationId || dequeued.payload?.message?.conversation_id || "") === conversationId) break;
    await sleep(250);
  }
  const asked = await api("/api/relay-question", {
    method: "POST",
    body: { queueId: messageId, prompt: "Which bed is planted first?", choices: ["North", "South"], timeout_ms: 600_000 },
  });
  expect(asked.status, JSON.stringify(asked.payload)).toBe(200);
  // The questions poll runs every 3 s; with nothing open it would open the asking session.
  await sleep(7000);
  await expect(page.locator("body")).toHaveClass(/media-view-active/);
  await expect(view.locator(".media-tile").first()).toBeVisible();
});

test("tiles that failed while the relay was away load after the reconnect", async ({ page }) => {
  test.setTimeout(120_000);
  // The relay's pictures cannot be reached (as when it is away), then it
  // really goes away and comes back: the socket reconnects.
  await page.route(/\/api\/media\/\d+\/content/, (route) => route.abort("connectionrefused"));
  const view = await openMediaView(page);
  await view.locator('[data-media-filter="session"]').selectOption(sessions.paging);
  await expect(view.locator(".media-tile")).toHaveCount(60);
  await expect.poll(() => page.locator(".media-tile-failed").count(), { timeout: 20_000 }).toBeGreaterThan(5);
  const { port, state, token } = { port: Number(new URL(relay.baseUrl).port), state: relay.state, token: relay.token };
  await relay.kill();
  await page.unroute(/\/api\/media\/\d+\/content/);
  relay = await startRelayServer({ token, port, state });
  // After the reconnect the failed tiles in view load; the ones out of view wait.
  await expect.poll(async () => page.evaluate(() => {
    const visible = [...document.querySelectorAll("#messages .media-tile img")].filter((img) => {
      const box = img.getBoundingClientRect();
      return box.bottom > 0 && box.top < innerHeight;
    });
    return visible.length > 0 && visible.every((img) => img.complete && img.naturalWidth > 0);
  }), { timeout: 45_000 }).toBe(true);
  const retried = await page.evaluate(() => [...document.querySelectorAll("#messages .media-tile img")]
    .filter((img) => /retry=\d+$/.test(img.getAttribute("src") || "")).length);
  expect(retried).toBeGreaterThan(0);
  expect(retried).toBeLessThan(60);
});