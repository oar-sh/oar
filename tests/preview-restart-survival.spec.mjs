import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { reserveFreePort, sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * A preview link survives a relay restart. The spec boots its own relay with
 * the preview lane on, publishes a folder from inside a turn (so the
 * transcript gets a preview card), checks the public link answers, restarts
 * the relay on the same state and preview port, and finds the same link
 * answering and the card still offering Open with that link.
 *
 * No worker runs: the turn is a message the spec took off the queue (GET
 * /api/pending) and answered (POST /api/response).
 */

const PUBLIC_BASE_URL = "http://preview.example.test";

function previewOverrides(previewPort) {
  return ({ stateRoot }) => {
    const workspace = path.join(stateRoot, "workspace");
    const site = path.join(workspace, "site");
    fs.mkdirSync(site, { recursive: true });
    fs.writeFileSync(path.join(site, "index.html"), "<!doctype html><title>Kept site</title><p>kept across restarts</p>\n");
    return {
      COPILOT_WORKSPACE_ROOT: workspace,
      COPILOT_PREVIEWS_ENABLED: "1",
      COPILOT_PREVIEWS_PORT: String(previewPort),
      COPILOT_PREVIEWS_PUBLIC_BASE_URL: PUBLIC_BASE_URL,
    };
  };
}

function createApi(getRelay) {
  return async function api(route, { method = "GET", body, headers = {} } = {}) {
    const relay = getRelay();
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  };
}

async function dequeue(api, messageId, ownerSessionId) {
  const headers = ownerSessionId ? { "x-relay-session-id": ownerSessionId } : {};
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { status, payload } = await api("/api/pending", { headers });
    expect(status).toBe(200);
    const message = payload?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await api("/api/requeue", { method: "POST", body: { messageId: String(message.id) } }).catch(() => {});
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

async function fetchPreview(previewPort, basePath) {
  const response = await fetch(`http://127.0.0.1:${previewPort}${basePath}`, {
    headers: { host: new URL(PUBLIC_BASE_URL).host },
  });
  return { status: response.status, text: await response.text() };
}

test.describe.configure({ mode: "serial" });

test.describe("previews across a relay restart", () => {
  let relay = null;
  let previewPort = 0;
  const api = createApi(() => relay);

  test.beforeAll(async () => {
    previewPort = await reserveFreePort();
    relay = await startRelayServer({ token: "e2e-preview-restart-token", overrides: previewOverrides(previewPort) });
  });

  test.afterAll(async () => {
    await relay?.stop();
  });

  test("a folder preview keeps its link and its card after the relay restarts", async ({ page }) => {
    const stamp = Date.now();
    const queued = await api("/api/message", {
      method: "POST",
      body: { text: `Publish the site ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    const conversationId = String(queued.payload?.conversationId || "");
    const messageId = String(queued.payload?.messageId || "");
    await dequeue(api, messageId, String(queued.payload?.ownerSessionId || ""));

    const created = await api("/api/previews", {
      method: "POST",
      body: { conversationId, dir: "site", label: "kept site" },
    });
    expect(created.status, JSON.stringify(created.payload)).toBe(200);
    const { url, basePath } = created.payload;
    expect(url).toBe(`${PUBLIC_BASE_URL}${basePath}`);

    const answered = await api("/api/response", {
      method: "POST",
      body: { messageId, conversationId, text: `Published ${stamp}`, model: "gpt-5.4-mini", mode: "agent" },
    });
    expect(answered.status, JSON.stringify(answered.payload)).toBe(200);

    const before = await fetchPreview(previewPort, basePath);
    expect(before.status).toBe(200);
    expect(before.text).toContain("kept across restarts");

    // The restart: same database, same settings, same preview port.
    await relay.kill();
    expect((await fetchPreview(previewPort, basePath).catch(() => ({ status: 0 }))).status).toBe(0);
    relay = await startRelayServer({
      token: relay.token,
      port: relay.port,
      state: relay.state,
      overrides: previewOverrides(previewPort),
    });

    const after = await fetchPreview(previewPort, basePath);
    expect(after.status).toBe(200);
    expect(after.text).toContain("kept across restarts");

    const listed = await api(`/api/previews?conversationId=${encodeURIComponent(conversationId)}`);
    expect(listed.status).toBe(200);
    expect(listed.payload.previews.map((preview) => preview.url)).toEqual([url]);

    // Publishing the same folder again gives the same link back.
    const again = await api("/api/previews", {
      method: "POST",
      body: { conversationId, dir: "site", label: "another label" },
    });
    expect(again.status, JSON.stringify(again.payload)).toBeLessThan(300);
    expect(again.payload.existing).toBe(true);
    expect(again.payload.url).toBe(url);
    expect(again.payload.preview.label).toBe("kept site");

    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    const reply = page.locator(".msg.assistant", { hasText: `Published ${stamp}` });
    await expect(reply).toBeVisible({ timeout: 20_000 });
    const card = reply.locator(".msg-preview-card");
    await expect(card).toHaveCount(1);
    await expect(card).not.toHaveClass(/msg-preview-card-closed/);
    await expect(card.locator(".preview-label")).toHaveText("kept site");
    await expect(card.locator("a.preview-open")).toHaveAttribute("href", url);
  });
});
