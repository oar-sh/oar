import http from "node:http";
import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";
import { respondAsWorker, settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

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

test("a picture from another port of the relay host never gets the session's proof key, the 🖍️ path included", async ({ page, request, baseURL }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const relay = new URL(baseURL);
  const foreign = await startForeignServer(relay.origin, relay.hostname);
  const pictureUrl = `${foreign.origin}/x.png`;
  let conversationId = "";
  try {
    // Made as the web client makes a chat: bound from the start.
    const started = await startConversation({ text: `Show me the chart ${Date.now()}` });
    conversationId = started.conversationId;
    const messageId = started.messageId;
    await started.worker.take(messageId);
    const answered = await respondAsWorker(messageId, { conversationId, model: "gpt-5.4-mini", mode: "agent", text: `Here it is:\n\n![](${pictureUrl})` });
    expect(answered.ok).toBeTruthy();

    // Signed in in the browser: the cookie and the key.
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => !!window.localStorage.getItem("oar_session_proof")), "the page holds a key").toBe(true);

    // Another port is another origin: the page shows the picture as a link
    // and never loads it (the app shell's policy allows images from its own
    // origin only), so the other port gets no request at all, neither the
    // cookie nor the key.
    const link = page.locator(`.msg.assistant .msg-bubble a[href="${pictureUrl}"]`).last();
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`.msg.assistant .msg-bubble img[src="${pictureUrl}"]`)).toHaveCount(0);

    // Even forced, the 🖍️ editor does not fetch it (nothing is open in the
    // viewer, and the policy refuses a connection to another origin).
    await page.evaluate(() => window.openAnnotateEditorForPreview?.());
    await sleep(1_000);

    expect(foreign.requests, "the page sent no request to the other port").toEqual([]);
    expect(foreign.sawProofHeader(), "no request to the other port carried the session's proof key").toBe(false);
  } finally {
    await foreign.close();
    if (conversationId) await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});
