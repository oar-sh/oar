import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { startRelayServer } from "./relay-server-harness.mjs";

// The database file's full path and the backup folder are the owner's: About
// OAR shows them (GET /api/about), a share viewer never learns them. One relay
// of its own on a temp state root, both sides against it:
//
//  A. the owner's /api/about names `<dataDir>/oar.db` and `<stateRoot>/db-backups`
//     (and the plain text search below finds them there, so it can find them);
//  B. a share link of a conversation with a user message (an uploaded image),
//     a tool line, a sub-agent run and a reply (a generated image), opened in a
//     fresh browser with no owner cookie: the share page, every response it
//     fetches, the share routes called directly with the share token, and a
//     Socket.IO handshake made with the share token carry none of those paths
//     (nor the data dir, nor the state root), and /api/about refuses it.
//
// The shared reader opens no socket (bootstrap.js returns before
// connectSocket for a shared view; the handshake wants the owner token), so
// the socket side is the handshake itself: the owner's gets in, the share
// token's is refused before any event is sent.

let relay;

test.beforeAll(async () => {
  relay = await startRelayServer({ token: randomUUID() });
});

test.afterAll(async () => {
  await relay?.stop();
});

// A 1x1 PNG: the uploaded image and the generated one.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const ownerHeaders = () => ({ Authorization: `Bearer ${relay.token}` });

async function ownerJson(method, route, data) {
  const response = await fetch(`${relay.baseUrl}${route}`, {
    method,
    headers: { ...ownerHeaders(), ...(data ? { "content-type": "application/json" } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  expect(response.ok, `${method} ${route} answered ${response.status}`).toBe(true);
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dequeue(messageId, ownerSessionId) {
  const headers = ownerSessionId ? { ...ownerHeaders(), "x-relay-session-id": ownerSessionId } : ownerHeaders();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${relay.baseUrl}/api/pending`, { headers });
    expect(response.ok).toBe(true);
    const message = (await response.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await ownerJson("POST", "/api/requeue", { messageId: String(message.id) }).catch(() => {});
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

// One turn with every kind of content a shared view loads: an uploaded
// image on the user message, a tool line, a sub-agent run with its record,
// and a reply with a generated image.
async function seedConversation() {
  const stamp = Date.now();
  const uploaded = await fetch(`${relay.baseUrl}/api/upload`, {
    method: "POST",
    headers: { ...ownerHeaders(), "content-type": "application/octet-stream", "x-file-name": "tray.png", "x-file-type": "image/png" },
    body: Buffer.from(PNG_BASE64, "base64"),
  });
  expect(uploaded.status).toBe(200);
  const attachment = (await uploaded.json()).attachment;

  const queued = await ownerJson("POST", "/api/message", {
    text: `Where do the seed trays go ${stamp}`,
    relayMode: "agent",
    model: "gpt-5.4-mini",
    attachments: [{ sha256: attachment.sha256, name: "tray.png", type: "image/png" }],
  });
  const conversationId = String(queued.conversationId || "");
  const messageId = String(queued.messageId || "");
  expect(conversationId).toBeTruthy();
  await dequeue(messageId, String(queued.ownerSessionId || ""));
  await ownerJson("POST", "/api/session-sync", { sdk_session_id: `pw-sid-share-privacy-${stamp}`, conversation_id: conversationId });
  await ownerJson("POST", "/api/activity", { messageId, conversationId, mode: "agent", text: "Read the tray notes" });
  const runId = `toolu_share_privacy_${stamp}`;
  await ownerJson("POST", "/api/subagent-run", {
    messageId, conversationId, subagentRunId: runId, displayName: "Count the trays", status: "running", subagentType: "Explore", timelineOwner: "worker",
  });
  await ownerJson("POST", "/api/subagent-timeline", {
    conversationId,
    subagentRunId: runId,
    entries: [
      { key: "w:1", kind: "thought", text: "Count the trays on the top shelf.", done: true },
      { key: "w:2", kind: "text", text: "Twelve trays." },
    ],
    header: { status: "completed" },
  });
  await ownerJson("POST", "/api/response", {
    messageId,
    conversationId,
    text: `The trays go on the top shelf ${stamp}.`,
    model: "gpt-5.4-mini",
    mode: "agent",
    generatedImages: [{ name: "tray-sketch", mimeType: "image/png", data: PNG_BASE64 }],
  });
  return { conversationId, runId, replyText: `The trays go on the top shelf ${stamp}.` };
}

// An Engine.IO polling session and a Socket.IO CONNECT carrying `token`:
// every body the server sent back, in order.
async function socketHandshake(token) {
  const base = `${relay.baseUrl}/socket.io/?EIO=4&transport=polling`;
  const bodies = [];
  const get = async (url, init = {}) => (await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })).text();
  const open = await get(base);
  bodies.push(open);
  const sid = JSON.parse(open.slice(open.indexOf("{"))).sid;
  expect(sid).toBeTruthy();
  bodies.push(await get(`${base}&sid=${encodeURIComponent(sid)}`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: `40${JSON.stringify({ token, clientId: `share-privacy-${randomUUID()}` })}`,
  }));
  bodies.push(await get(`${base}&sid=${encodeURIComponent(sid)}`));
  // Close the session (an Engine.IO "close" packet).
  await fetch(`${base}&sid=${encodeURIComponent(sid)}`, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: "1" }).catch(() => {});
  return bodies;
}

// A path as it can stand in a body: as is, JSON-escaped (backslashes on
// Windows) and URL-encoded.
function forms(value) {
  return [...new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])];
}

function leaksIn(text, needles) {
  return Object.entries(needles)
    .filter(([, value]) => forms(value).some((form) => text.includes(form)))
    .map(([name]) => name);
}

test("the owner's About names the database file and the backup folder; nothing a share viewer gets does", async ({ browser }) => {
  // --- A: the owner ---------------------------------------------------------
  const dbPath = path.join(relay.dataDir, "oar.db");
  const aboutResponse = await fetch(`${relay.baseUrl}/api/about`, { headers: ownerHeaders() });
  expect(aboutResponse.status).toBe(200);
  const aboutText = await aboutResponse.text();
  const about = JSON.parse(aboutText);
  // The full path of the file the relay runs on, and where its backups go.
  expect(about.relay.dbPath).toBe(dbPath);
  expect(about.backups.dir).toBe(relay.dbBackupsDir);
  expect(about.backups.dir).toBe(path.join(relay.stateRoot, "db-backups"));

  // What must not reach a share viewer. The state root holds them all (and is
  // the relay's HOME here, e.g. /home/dev on a real host).
  const needles = {
    dbPath,
    backupsDir: relay.dbBackupsDir,
    dataDir: relay.dataDir,
    stateRoot: relay.stateRoot,
  };
  // The same search finds them in the owner's answer: a clean B below is not
  // a search that cannot match.
  expect(leaksIn(aboutText, needles)).toEqual(["dbPath", "backupsDir", "dataDir", "stateRoot"]);
  // The owner's socket handshake gets in (a CONNECT ack with a sid): the
  // refusal in B is the share token's, not a broken handshake.
  const ownerSocket = (await socketHandshake(relay.token)).join("\n");
  expect(ownerSocket).toMatch(/40\{"sid":"/);

  // --- B: the share viewer --------------------------------------------------
  const { conversationId, runId, replyText } = await seedConversation();
  const share = await ownerJson("POST", `/api/conversation/${conversationId}/share`);
  const shareToken = String(share.token || "");
  expect(shareToken).toMatch(/^[a-f0-9]{32,128}$/);

  // A fresh browser: no owner cookie, no owner token, only the link.
  const context = await browser.newContext({ baseURL: relay.baseUrl });
  const captured = [];
  const pending = [];
  const frames = [];
  const unread = [];
  try {
    const page = await context.newPage();
    page.on("response", (response) => {
      pending.push((async () => {
        // A body that never ends (a stream) is not waited for.
        const body = await Promise.race([response.body(), sleep(3_000).then(() => null)]).catch(() => null);
        if (!body) unread.push(new URL(response.url()).pathname);
        const headers = await response.allHeaders().catch(() => ({}));
        captured.push({ url: response.url(), status: response.status(), text: `${JSON.stringify(headers)}\n${(body || Buffer.alloc(0)).toString("utf8")}` });
      })());
    });
    page.on("websocket", (socket) => {
      frames.push({ url: socket.url(), text: "" });
      socket.on("framereceived", (frame) => frames.push({ url: socket.url(), text: String(frame.payload) }));
      socket.on("framesent", (frame) => frames.push({ url: socket.url(), text: String(frame.payload) }));
    });

    // The share page and what it loads: the transcript, the presence pulse.
    await page.goto(share.path);
    await expect(page.locator("#messages .msg.assistant").last()).toContainText(replyText);
    // The sub-agent's record, read-only, through its share route.
    const row = page.locator(`.msg .subagent-row[data-subagent-row="${runId}"]`);
    await expect(row).toBeVisible();
    await row.locator("[data-subagent-open]").click();
    await expect(page.locator("#subagent-viewer-modal .sav-entry")).toHaveCount(2);
    await page.keyboard.press("Escape");
    const fetchedPaths = () => captured.map((entry) => new URL(entry.url).pathname);
    await expect.poll(fetchedPaths).toContain(`/api/shared/${shareToken}/presence`);
    await expect.poll(fetchedPaths).toContain(`/api/shared/${shareToken}/subagent/${runId}`);
    expect(fetchedPaths()).toContain(`/shared/${shareToken}`);
    expect(fetchedPaths()).toContain(`/api/shared/${shareToken}`);

    // Every share route straight, with the share token only: the payload,
    // presence, the sub-agent record, and each attachment the payload links
    // (the uploaded image and the generated one).
    const direct = [];
    const viewerGet = async (route) => {
      const response = await context.request.get(route);
      direct.push({ url: route, status: response.status(), text: `${JSON.stringify(response.headers())}\n${(await response.body()).toString("utf8")}` });
      return response;
    };
    const payloadResponse = await viewerGet(`/api/shared/${shareToken}?limit=120&open=1`);
    expect(payloadResponse.status()).toBe(200);
    const payloadText = await payloadResponse.text();
    expect(payloadText).toContain(replyText);
    const contentRoutes = [...new Set(payloadText.match(new RegExp(`/api/shared/${shareToken}/(?:upload|generated-image)/[^"\\\\\\s)]+`, "g")) || [])];
    expect(contentRoutes.some((route) => route.includes("/upload/")), "the payload links the uploaded image").toBe(true);
    expect(contentRoutes.some((route) => route.includes("/generated-image/")), "the payload links the generated image").toBe(true);
    for (const route of contentRoutes) expect((await viewerGet(route)).status()).toBe(200);
    expect((await viewerGet(`/api/shared/${shareToken}/subagent/${runId}`)).status()).toBe(200);
    const presence = await context.request.post(`/api/shared/${shareToken}/presence`, { data: { viewerId: `viewer-${randomUUID()}` } });
    expect(presence.status()).toBe(200);
    direct.push({ url: "presence", status: presence.status(), text: (await presence.body()).toString("utf8") });

    // About is the owner's: the share viewer's browser, the share token as a
    // bearer, and as a query parameter are all refused.
    for (const [label, init] of [
      ["no credential", {}],
      ["share token as bearer", { headers: { Authorization: `Bearer ${shareToken}` } }],
    ]) {
      const refused = await context.request.get("/api/about", init);
      expect([401, 403], `/api/about with ${label}`).toContain(refused.status());
      direct.push({ url: `/api/about (${label})`, status: refused.status(), text: await refused.text() });
    }
    const refusedQuery = await context.request.get(`/api/about?token=${shareToken}`);
    expect([401, 403]).toContain(refusedQuery.status());
    direct.push({ url: "/api/about?token", status: refusedQuery.status(), text: await refusedQuery.text() });
    const pageAbout = await page.evaluate(async () => {
      const response = await fetch("/api/about");
      await response.text();
      return response.status;
    });
    expect([401, 403]).toContain(pageAbout);

    // The socket with the share token: refused at CONNECT, no event sent.
    const shareSocket = await socketHandshake(shareToken);
    const shareSocketText = shareSocket.join("\n");
    expect(shareSocketText).toMatch(/44\{"message":"Unauthorized"/);
    expect(shareSocketText).not.toMatch(/40\{"sid"/);
    expect(shareSocketText).not.toMatch(/(^|\x1e)42\[/m);

    await Promise.all(pending);
    // Every body the page got was read (the 401 of /api/about is read
    // straight above as well).
    expect(unread.filter((pathname) => pathname !== "/api/about"), "page responses whose body could not be read").toEqual([]);
    // The shared reader opened no socket of its own.
    expect(frames.filter((frame) => /socket\.io/.test(frame.url))).toEqual([]);

    // Not one of the owner's paths in anything the viewer got.
    const bodies = [
      ...captured,
      ...direct,
      ...frames,
      ...shareSocket.map((text, index) => ({ url: `socket handshake #${index}`, status: 0, text })),
    ];
    expect(bodies.length).toBeGreaterThan(8);
    const leaks = bodies
      .map((entry) => ({ url: entry.url, status: entry.status, leaks: leaksIn(entry.text, needles) }))
      .filter((entry) => entry.leaks.length);
    expect(leaks).toEqual([]);
  } finally {
    await context.close();
    await ownerJson("DELETE", `/api/conversation/${conversationId}/share`).catch(() => {});
  }
});
