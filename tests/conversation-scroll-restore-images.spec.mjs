import zlib from "node:zlib";
import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

/**
 * Images above the message read arrive after the reading position was put
 * back (a switch back to the conversation, a reload, an older page loaded
 * above it). The message read stays where it was while they grow from
 * nothing to their height, and a reader who scrolls meanwhile is left where
 * they scrolled to.
 *
 * Most of the scenarios turn the browser's own scroll anchoring off in the
 * transcript: browsers without it (iOS Safari) let an image that grows above
 * the view push the text read down, and the transcript must hold it there
 * itself. One scenario keeps it on, so the two never correct the same shift
 * twice.
 *
 * The images are uploads in user messages, generated images in replies and
 * plain-path embeds in a reply's markdown; their bytes are held back by a
 * route for a while after the transcript is drawn.
 *
 * The isolated server runs no CLI, so the turns are dequeued rows answered by
 * the spec in the worker's place.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A solid-colour PNG of the given size, encoded here.
function solidPng(width, height, [red, green, blue]) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + 1 + x * 3;
      raw[at] = red;
      raw[at + 1] = green;
      raw[at + 2] = blue;
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Every image another size and colour, so none shares another's bytes.
function imageFor(index) {
  const width = 220 + ((index * 37) % 140);
  const height = 120 + ((index * 53) % 120);
  return solidPng(width, height, [(index * 61) % 256, (index * 113) % 256, (index * 29 + 90) % 256]);
}

async function upload(request, headers, name, bytes) {
  const response = await request.post("/api/upload", {
    headers: { ...headers, "x-file-name": name, "x-file-type": "image/png", "content-type": "application/octet-stream" },
    data: bytes,
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).attachment;
}

async function dequeue(request, headers, messageId, ownerSessionId = "") {
  const dequeueHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await request.get("/api/pending", { headers: dequeueHeaders });
    expect(response.ok()).toBeTruthy();
    const message = (await response.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(150);
  }
  throw new Error("the queued message was never handed out");
}

async function seedConversation(request, headers, title, stamp) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text: `${title} ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "");
  const messageId = String(body?.messageId || "");
  expect(conversationId).toBeTruthy();
  await dequeue(request, headers, messageId, String(body?.ownerSessionId || ""));
  const synced = await request.post("/api/session-sync", {
    headers,
    data: { sdk_session_id: `pw-sid-images-${stamp}-${conversationId.slice(0, 8)}`, conversation_id: conversationId },
  });
  expect(synced.ok()).toBeTruthy();
  const responded = await request.post("/api/response", {
    headers,
    data: { messageId, conversationId, text: `${title} first reply`, model: "gpt-5.4-mini", mode: "agent" },
  });
  expect(responded.ok()).toBeTruthy();
  return { conversationId, title: `${title} ${stamp}` };
}

async function addTurn(request, headers, conversationId, { text, reply, attachments, generatedImages }) {
  const queued = await request.post("/api/message", {
    headers,
    data: { conversationId, text, relayMode: "agent", model: "gpt-5.4-mini", ...(attachments ? { attachments } : {}) },
  });
  expect(queued.ok()).toBeTruthy();
  const { messageId } = await queued.json();
  const responded = await request.post("/api/response", {
    headers,
    data: { messageId, conversationId, text: reply, model: "gpt-5.4-mini", mode: "agent", ...(generatedImages ? { generatedImages } : {}) },
  });
  expect(responded.ok()).toBeTruthy();
}

const FILLER = "The seed trays go on the top shelf, nearest the glass, and the labels are written in pencil so the rain cannot wash them off. ";

// Turn `index`: an image in one of three ways while `index` is within
// `imageTurns`, plain text otherwise.
async function addImageTurn(request, headers, conversationId, index, stamp, imageTurns) {
  const text = `Question ${index} about the seed trays ${stamp}`;
  const reply = `Tray note ${index} ${stamp}. ${index % 4 === 0 ? FILLER.repeat(4) : "Short answer."}`;
  if (index < imageTurns[0] || index > imageTurns[1]) {
    await addTurn(request, headers, conversationId, { text, reply });
    return;
  }
  const bytes = imageFor(index);
  const name = `tray-${index}.png`;
  if (index % 3 === 0) {
    const attachment = await upload(request, headers, name, bytes);
    await addTurn(request, headers, conversationId, {
      text,
      reply,
      attachments: [{ sha256: attachment.sha256, name, type: "image/png" }],
    });
  } else if (index % 3 === 1) {
    await addTurn(request, headers, conversationId, {
      text,
      reply,
      generatedImages: [{ name: `tray-sketch-${index}`, mimeType: "image/png", data: bytes.toString("base64") }],
    });
  } else {
    const attachment = await upload(request, headers, name, bytes);
    await addTurn(request, headers, conversationId, {
      text,
      reply: `${reply}\n\n![tray ${index}](${attachment.path})\n\nThat is the tray.`,
    });
  }
}

// Holds the image bytes back by `delayMs` while it is set.
async function holdImages(page) {
  const gate = { delayMs: 0, held: 0 };
  const isImage = (url) => /\/api\/(?:upload\/[0-9a-f]{64}\/content|generated-image\/|drives\/file\b)/.test(url.pathname);
  await page.route(isImage, async (route) => {
    if (gate.delayMs > 0) {
      gate.held += 1;
      await sleep(gate.delayMs);
    }
    await route.continue().catch(() => {});
  });
  return gate;
}

const row = (page, id) => page.locator(`#conv-list .conv-item[data-conversation-id="${id}"]`);
const bubble = (page, text) => page.locator("#messages .msg", { hasText: text });

async function offsetOf(page, messageId) {
  return page.evaluate((mid) => {
    const el = document.getElementById("messages");
    const node = el.querySelector(`:scope > .msg[data-message-id="${CSS.escape(mid)}"]`);
    if (!node) return null;
    return Math.round(node.getBoundingClientRect().top - el.getBoundingClientRect().top);
  }, messageId);
}

async function scrollTopOf(page) {
  return page.evaluate(() => Math.round(document.getElementById("messages").scrollTop));
}

// Images in the transcript that are still on their way.
async function pendingImages(page) {
  return page.evaluate(() => [...document.querySelectorAll("#messages img")].filter((img) => !img.complete).length);
}

async function imageCount(page) {
  return page.evaluate(() => document.querySelectorAll("#messages img").length);
}

async function waitForImages(page) {
  await expect.poll(() => pendingImages(page), { timeout: 20_000 }).toBe(0);
  // A frame for the last one to be laid out, and for any correction.
  await sleep(300);
}

async function loadOlderOnce(page) {
  const before = await page.evaluate(() => document.querySelectorAll("#messages .msg[data-message-id]").length);
  await page.evaluate(() => window.loadOlderConversationMessages());
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("#messages .msg[data-message-id]").length)).toBeGreaterThan(before);
}

const TOLERANCE_PX = 2;

async function runScenario({ page, request }, {
  name,
  mode = "switch",
  anchoring = false,
  touch = false,
  userScrolls = false,
  turns = 26,
  imageTurns = [2, 21],
  targetTurn = 23,
  offsetPx = 30,
}) {
  test.setTimeout(240_000);
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = `images-${name}-${Date.now()}`;
  const long = await seedConversation(request, headers, "Plan the seed tray shelf", stamp);
  const short = await seedConversation(request, headers, "Count the plant labels", stamp);
  const report = (line) => console.log(`[scroll-restore-images:${name}] ${line}`);
  try {
    for (let index = 1; index <= turns; index += 1) {
      await addImageTurn(request, headers, long.conversationId, index, stamp, imageTurns);
    }
    const longNewest = `Tray note ${turns} ${stamp}`;
    const shortNewest = `Forty labels left ${stamp}`;
    await addTurn(request, headers, short.conversationId, { text: `How many labels ${stamp}`, reply: shortNewest });

    await page.addInitScript((id) => {
      localStorage.setItem("copilot_last_conv", id);
    }, long.conversationId);
    if (!anchoring) {
      await page.addInitScript(() => {
        // The script runs before the document has an element to hold it.
        const add = () => {
          const style = document.createElement("style");
          style.textContent = "#messages, #messages * { overflow-anchor: none !important; }";
          document.head.appendChild(style);
        };
        if (document.head) add();
        else document.addEventListener("DOMContentLoaded", add, { once: true });
      });
    }
    const gate = await holdImages(page);

    const pick = async (id) => {
      if (touch) {
        await page.evaluate(() => window.toggleSidebar?.(true));
        await row(page, id).tap();
      } else {
        await row(page, id).click();
      }
    };

    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await expect(page.locator("#cli-dot")).toHaveClass("online");
    await expect(page.locator("#chat-title")).toHaveText(long.title);
    await expect(bubble(page, longNewest)).toBeVisible();
    await waitForImages(page);
    const anchorStyle = await page.evaluate(() => getComputedStyle(document.getElementById("messages")).overflowAnchor);
    expect(anchorStyle, "the browser's scroll anchoring in the transcript").toBe(anchoring ? "auto" : "none");

    // Read a message below the images, a little way down from the top.
    const target = await bubble(page, `Tray note ${targetTurn} ${stamp}`).getAttribute("data-message-id");
    expect(target).toBeTruthy();
    await page.evaluate(({ mid, offset }) => {
      const el = document.getElementById("messages");
      const node = el.querySelector(`:scope > .msg[data-message-id="${CSS.escape(mid)}"]`);
      el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - offset;
    }, { mid: target, offset: offsetPx });
    await sleep(800);
    const left = await offsetOf(page, target);
    const imagesAbove = await page.evaluate((mid) => {
      const el = document.getElementById("messages");
      const node = el.querySelector(`:scope > .msg[data-message-id="${CSS.escape(mid)}"]`);
      return [...el.querySelectorAll("img")].filter((img) => img.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).length;
    }, target);
    expect(imagesAbove, "images above the message read").toBeGreaterThan(2);

    gate.delayMs = 1500;
    if (mode === "reload") {
      await page.reload();
      await page.waitForFunction(() => typeof window.openConversation === "function");
      await expect(page.locator("#chat-title")).toHaveText(long.title);
    } else {
      await pick(short.conversationId);
      await expect(page.locator("#chat-title")).toHaveText(short.title);
      await expect(bubble(page, shortNewest)).toBeVisible();
      // The decoded images were dropped while the reader was away (memory
      // pressure on a phone): the drawn copy fetches them again.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.clearBrowserCache");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await sleep(500);
      await pick(long.conversationId);
      await expect(page.locator("#chat-title")).toHaveText(long.title);
    }
    await expect(page.locator(`#messages .msg[data-message-id="${target}"]`)).toBeAttached();
    await sleep(200);
    const restored = await offsetOf(page, target);
    const pendingAtRestore = await pendingImages(page);
    report(`left at ${left}px, restored at ${restored}px with ${pendingAtRestore} of ${await imageCount(page)} images on their way`);
    expect(pendingAtRestore, "images still on their way after the restore").toBeGreaterThan(0);

    if (userScrolls) {
      // The reader scrolls on before the images arrive.
      const box = await page.locator("#messages").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const before = await scrollTopOf(page);
      await page.mouse.wheel(0, 240);
      await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(before + 100);
      await sleep(300);
      const scrolledTo = await scrollTopOf(page);
      const scrolledOffset = await offsetOf(page, target);
      expect(await pendingImages(page), "the images are still on their way after the scroll").toBeGreaterThan(0);
      await waitForImages(page);
      const after = await scrollTopOf(page);
      report(`reader scrolled to ${scrolledTo} (message read at ${scrolledOffset}px); after the images ${after}, message read at ${await offsetOf(page, target)}px`);
      expect(Math.abs(after - scrolledTo), "the scroll position the reader chose stands").toBeLessThanOrEqual(TOLERANCE_PX);
      return;
    }

    await waitForImages(page);
    const settled = await offsetOf(page, target);
    report(`message read at ${settled}px after the images (${gate.held} held back)`);
    expect(Math.abs(restored - left), "the restore put the message read back").toBeLessThanOrEqual(TOLERANCE_PX);
    expect(Math.abs(settled - left), "the message read stays put while the images above it load").toBeLessThanOrEqual(TOLERANCE_PX);

    if (mode === "reload") {
      // An older page above the message read, its images late too.
      const heldBefore = gate.held;
      await loadOlderOnce(page);
      await sleep(200);
      const afterPage = await offsetOf(page, target);
      const pendingOlder = await pendingImages(page);
      await waitForImages(page);
      const afterOlder = await offsetOf(page, target);
      report(`older page: message read at ${afterPage}px with ${pendingOlder} images on their way, ${afterOlder}px after them (${gate.held - heldBefore} held back)`);
      expect(pendingOlder, "the older page's images were late").toBeGreaterThan(0);
      expect(Math.abs(afterOlder - left), "an older page's late images leave the message read in place").toBeLessThanOrEqual(TOLERANCE_PX);
    }
  } finally {
    for (const conversation of [long, short]) {
      await request.delete(`/api/conversation/${conversation.conversationId}`, { headers }).catch(() => {});
    }
  }
}

test.describe("late images above the message read, desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a switch back keeps the message read in place while images above it load", async ({ page, request }) => {
    await runScenario({ page, request }, { name: "switch" });
  });

  test("a reload, then an older page, keep the message read in place while images above it load", async ({ page, request }) => {
    await runScenario({ page, request }, { name: "reload", mode: "reload" });
  });

  test("a reader who scrolls while the images load stays where they scrolled to", async ({ page, request }) => {
    await runScenario({ page, request }, { name: "user-scroll", mode: "reload", userScrolls: true });
  });

  test("with the browser's own scroll anchoring the message read stays in place too", async ({ page, request }) => {
    await runScenario({ page, request }, { name: "anchoring", mode: "reload", anchoring: true });
  });
});

test.describe("late images above the message read, phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a switch back keeps the message read in place while images above it load", async ({ page, request }) => {
    await runScenario({ page, request }, { name: "phone-switch", touch: true });
  });

  test("a reload, then an older page, keep the message read in place while images above it load", async ({ page, request }) => {
    await runScenario({ page, request }, { name: "phone-reload", mode: "reload", touch: true });
  });
});
