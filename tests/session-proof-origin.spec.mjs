import http from "node:http";
import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// The session's proof key goes to this relay's own /api and nowhere else.
// An agent can put any picture address in a reply; a server on another port
// of the relay's host gets the session cookie with the picture (cookies are
// per host, not per port) and, after a CORS preflight that allows the
// header, would get the key too if the page fetched the picture with it
// (the 🖍️ marker editor reads the bytes of the picture it opens). With both
// it would hold a full session.
//
// A plain server on another port answers every preflight with "the header is
// allowed", serves a PNG, and records only whether a request carried the
// header (never its value).

const PROOF_HEADER = "x-oar-session-proof";
// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The other port's server: `{ origin, requests, sawProofHeader(), close() }`. */
async function startForeignServer(relayOrigin, hostname) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, withProofHeader: PROOF_HEADER in req.headers });
    res.setHeader("Access-Control-Allow-Origin", relayOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Headers", PROOF_HEADER);
      res.setHeader("Access-Control-Allow-Methods", "GET");
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
    res.end(PNG);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return {
    origin: `http://${hostname}:${port}`,
    requests,
    sawProofHeader: () => requests.some((entry) => entry.withProofHeader),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function dequeue(request, headers, messageId, ownerSessionId) {
  const dequeueHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const dequeued = await request.get("/api/pending", { headers: dequeueHeaders });
    expect(dequeued.ok()).toBeTruthy();
    const message = (await dequeued.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

test("a picture from another port of the relay host never gets the session's proof key, the 🖍️ path included", async ({ page, request, baseURL }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const relay = new URL(baseURL);
  const foreign = await startForeignServer(relay.origin, relay.hostname);
  const pictureUrl = `${foreign.origin}/x.png`;
  let conversationId = "";
  try {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `Show me the chart ${Date.now()}`, relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    const body = await queued.json();
    conversationId = String(body?.conversationId || "");
    const messageId = String(body?.messageId || "");
    await dequeue(request, headers, messageId, String(body?.ownerSessionId || ""));
    const answered = await request.post("/api/response", {
      headers,
      data: { messageId, conversationId, model: "gpt-5.4-mini", mode: "agent", text: `Here it is:\n\n![](${pictureUrl})` },
    });
    expect(answered.ok()).toBeTruthy();

    // Signed in in the browser: the cookie and the key.
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => !!window.localStorage.getItem("oar_session_proof")), "the page holds a key").toBe(true);

    const picture = page.locator(`.msg.assistant .msg-bubble img[src="${pictureUrl}"]`).last();
    await expect(picture).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => foreign.requests.some((entry) => entry.method === "GET"), { message: "the picture was loaded from the other port" }).toBe(true);

    // Open it in the viewer and try to mark it up.
    await picture.click();
    await expect(page.locator("#file-preview-modal")).toHaveClass(/visible/);
    const annotate = page.locator("#file-preview-annotate-btn");
    // The choice: a picture from another address has no 🖍️ (the editor
    // would have to fetch it).
    await expect(annotate).toBeHidden();
    // Even forced, the editor does not fetch it with the key.
    await page.evaluate(() => window.openAnnotateEditorForPreview?.());
    await sleep(1_000);

    expect(foreign.sawProofHeader(), "no request to the other port carried the session's proof key").toBe(false);
  } finally {
    await foreign.close();
    if (conversationId) await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});
