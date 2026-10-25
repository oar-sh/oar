import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * The session header on a phone comes in two rows: ☰, the title and the
 * action buttons on the first, and the origin line, the chips (watching,
 * watched, scheduled) and the folder on a second row that spans the header.
 * A chip wraps as a whole and never breaks inside its own text. On a desktop
 * the header keeps its one row.
 *
 * The conversation on screen is a real one: a lead session starts it with
 * create_session (the origin, "via agent · “…”", and the folder), it watches
 * two sessions, the lead watches it, and it has a schedule. No worker runs:
 * a "turn" is a message the spec took off the queue.
 */

const APPROVAL_TIMEOUT = 20_000;
const PHONE = { width: 390, height: 844 };
const SMALL_PHONE = { width: 360, height: 780 };
const DESKTOP = { width: 1280, height: 800 };
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCREENSHOT = String(process.env.MOBILE_HEADER_SCREENSHOT || "").trim();

test.describe.serial("the session header on a phone", () => {
  test.describe.configure({ timeout: 180_000 });

  let relay = null;
  const suffix = Date.now();
  let lead = "";
  let child = "";

  async function api(route, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  }

  const tool = (conversationId, action, args = {}) => api("/api/remote-relays/tool", {
    method: "POST",
    body: { conversationId, action, args },
  });

  async function take(conversationId, headers = {}) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const dequeued = await api("/api/pending", { headers });
      if (String(dequeued.payload?.message?.conversationId || dequeued.payload?.message?.conversation_id || "") === conversationId) return;
      await sleep(250);
    }
    throw new Error(`No message of ${conversationId.slice(0, 8)} was handed out`);
  }

  async function conversationWithRunningTurn(text) {
    const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    const { conversationId, ownerSessionId } = queued.payload;
    const synced = await api("/api/session-sync", {
      method: "POST",
      body: { sdk_session_id: conversationId, conversation_id: conversationId },
    });
    expect(synced.status, JSON.stringify(synced.payload)).toBe(200);
    await take(conversationId, ownerSessionId ? { "x-relay-session-id": String(ownerSessionId) } : {});
    return conversationId;
  }

  // Runs the tool call; a card it raises on the way is allowed.
  async function allowed(conversationId, action, args) {
    const call = tool(conversationId, action, args);
    let settled = null;
    call.then((result) => { settled = result; });
    const deadline = Date.now() + APPROVAL_TIMEOUT;
    while (!settled && Date.now() < deadline) {
      const { payload } = await api(`/api/relay-questions?status=pending&conversationId=${encodeURIComponent(conversationId)}`);
      const card = (payload?.questions || []).find((question) => question?.context?.source === "remote_relay");
      if (card) {
        const answered = await api(`/api/relay-question/${encodeURIComponent(card.id)}/answer`, {
          method: "POST",
          body: { answer: "Allow", ...(card.sdkSessionId ? { sdk_session_id: card.sdkSessionId } : {}) },
        });
        expect(answered.status).toBe(200);
      }
      await sleep(150);
    }
    const result = await call;
    expect(result.status, `${action}: ${JSON.stringify(result.payload)}`).toBe(200);
    return result.payload;
  }

  async function openChild(page, viewport) {
    await page.setViewportSize(viewport);
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, child);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await expect(page.locator("#chat-title")).toHaveText(/Reviewer/);
    await expect(page.locator("#chat-title-origin")).toContainText("via agent");
    await expect(page.locator("#chat-title-relay-events .relay-watch-chip")).toContainText("watching 2 sessions");
    await expect(page.locator("#chat-title-relay-events .conv-watched-badge")).toBeVisible();
    await expect(page.locator("#chat-title-relay-schedules .relay-schedule-chip")).toContainText("scheduled");
    await expect(page.locator("#chat-title-cwd")).toBeVisible();
  }

  // Every rect a test compares, read in one go once fonts and frames have
  // settled, and again until two reads in a row agree: a late font, a
  // scrollbar or a chip rendering between separate reads would otherwise
  // shift one element after another was measured.
  async function layout(page, selectors) {
    const read = () => page.evaluate(async (wanted) => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return Object.fromEntries(Object.entries(wanted).map(([name, selector]) => {
        const element = document.querySelector(selector);
        if (!element) return [name, null];
        const { x, y, width, height } = element.getBoundingClientRect();
        return [name, { x, y, width, height }];
      }));
    }, selectors);
    let previous = await read();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = await read();
      if (JSON.stringify(current) === JSON.stringify(previous)) {
        for (const [name, rect] of Object.entries(current)) expect(rect, `${name} (${selectors[name]})`).not.toBeNull();
        return current;
      }
      previous = current;
      await sleep(100);
    }
    throw new Error("The header's layout never settled");
  }
  const centreY = (rect) => rect.y + rect.height / 2;

  // How many lines an element's text takes: 1 for a chip that did not break.
  const lineCount = (page, selector) => page.locator(selector).evaluateAll((elements) => elements.map((element) => {
    const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || parseFloat(getComputedStyle(element).fontSize) * 1.2;
    const range = document.createRange();
    range.selectNodeContents(element);
    const tops = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top / (lineHeight / 2))));
    return { text: element.textContent, lines: tops.size, whiteSpace: getComputedStyle(element).whiteSpace };
  }));

  async function checkTwoRows(page, viewport) {
    await openChild(page, viewport);
    const { header, toggle, title, actions, origin, watching, watched, scheduled, cwd } = await layout(page, {
      header: "#chat-header",
      toggle: "#sidebar-toggle",
      title: "#chat-title-primary",
      actions: "#chat-header-actions",
      origin: "#chat-title-origin",
      watching: "#chat-title-relay-events .relay-watch-chip",
      watched: "#chat-title-relay-events .conv-watched-badge",
      scheduled: "#chat-title-relay-schedules .relay-schedule-chip",
      cwd: "#chat-title-cwd",
    });

    // Row 1: ☰, the title and the buttons side by side.
    expect(Math.abs(centreY(title) - centreY(actions))).toBeLessThan(10);
    expect(Math.abs(centreY(toggle) - centreY(actions))).toBeLessThan(10);
    expect(title.x).toBeGreaterThanOrEqual(toggle.x + toggle.width);
    expect(actions.x).toBeGreaterThanOrEqual(title.x + title.width - 1);
    expect(actions.x + actions.width).toBeLessThanOrEqual(viewport.width);
    const rowOneBottom = Math.max(toggle.y + toggle.height, actions.y + actions.height, title.y + title.height);

    // Row 2: below row 1, starting at the header's left edge, laid out horizontally.
    for (const [name, rect] of Object.entries({ origin, watching, watched, scheduled, cwd })) {
      expect(rect.y, name).toBeGreaterThanOrEqual(rowOneBottom - 1);
      expect(rect.x + rect.width, name).toBeLessThanOrEqual(viewport.width);
    }
    expect(origin.x).toBeLessThan(toggle.x + toggle.width);
    expect(Math.abs(centreY(watching) - centreY(origin))).toBeLessThan(10);
    expect(watching.x).toBeGreaterThan(origin.x + origin.width - 1);
    expect(Math.abs(centreY(watched) - centreY(watching))).toBeLessThan(10);
    expect(watched.x).toBeGreaterThan(watching.x + watching.width - 1);

    // No chip breaks inside its text.
    for (const chip of await lineCount(page, "#chat-title-relay-events .relay-watch-chip, #chat-title-relay-events .conv-watched-badge, #chat-title-relay-schedules .relay-schedule-chip")) {
      expect(chip.lines, chip.text).toBe(1);
      expect(chip.whiteSpace, chip.text).toBe("nowrap");
    }
    for (const rect of [watching, watched, scheduled]) expect(rect.height).toBeLessThan(30);

    // The title takes one line and ends in an ellipsis.
    const titleStyle = await page.locator("#chat-title-primary").evaluate((element) => ({
      overflow: element.scrollWidth > element.clientWidth,
      height: element.getBoundingClientRect().height,
    }));
    expect(titleStyle.overflow).toBe(true);
    expect(titleStyle.height).toBeLessThan(30);

    // Clearly shorter than the old stacked column (about 150px at 390px).
    expect(header.height).toBeLessThan(120);
    return header;
  }

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
    expect((await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).status).toBe(200);
    lead = await conversationWithRunningTurn(`Release lead ${suffix}`);
    const other = await conversationWithRunningTurn(`terrain shader rewrite ${suffix}`);
    const created = await allowed(lead, "create_session", {
      relay: "this",
      title: "Reviewer (Opus, judgment for all release checks)",
      text: "keep an eye on the release sessions",
      wait_seconds: 0,
    });
    child = String(created.session || "");
    expect(child).not.toBe("");
    await take(child);
    await allowed(child, "subscribe", { sessions: [lead, other] });
    await allowed(lead, "subscribe", { sessions: [child] });
    await allowed(child, "schedule", { text: "the nightly sweep", at: new Date(Date.now() + 6 * 3600_000).toISOString() });
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  test("390px: title and buttons on one row, the chips in a row below", async ({ page }) => {
    if (SCREENSHOT) {
      // MOBILE_HEADER_SCREENSHOT=tmp/x.png keeps a picture of the header for a review.
      await openChild(page, PHONE);
      const { header } = await layout(page, { header: "#chat-header" });
      const file = path.resolve(repoRoot, SCREENSHOT);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: PHONE.width, height: Math.ceil(header.y + header.height + 40) } });
    }
    await checkTwoRows(page, PHONE);
  });

  test("360px: the same on a narrower phone", async ({ page }) => {
    await checkTwoRows(page, SMALL_PHONE);
  });

  test("no chips, no origin, no folder: no empty second row", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, child);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await expect(page.locator("#chat-title-relay-schedules .relay-schedule-chip")).toBeVisible();
    const { header: withRows } = await layout(page, { header: "#chat-header" });
    // What the header shows when every second-row line is hidden. A style,
    // not the hidden flags: the app's header sync would show them again.
    await page.addStyleTag({ content: "#chat-title-origin, #chat-title-relay-events, #chat-title-relay-schedules, #chat-title-cwd, #chat-title-session-usage { display: none !important; }" });
    const { header, actions } = await layout(page, { header: "#chat-header", actions: "#chat-header-actions" });
    const padding = await page.locator("#chat-header").evaluate((element) => parseFloat(getComputedStyle(element).paddingBottom));
    expect(header.y + header.height - (actions.y + actions.height)).toBeLessThanOrEqual(padding + 2);
    expect(header.height).toBeLessThan(withRows.height);
  });

  test("desktop: the header keeps its one row, the chips under the title", async ({ page }) => {
    await openChild(page, DESKTOP);
    const { toggle, title, actions, watching, cwd, wrap } = await layout(page, {
      toggle: "#sidebar-toggle",
      title: "#chat-title-primary",
      actions: "#chat-header-actions",
      watching: "#chat-title-relay-events .relay-watch-chip",
      cwd: "#chat-title-cwd",
      wrap: "#chat-title-wrap",
    });
    // The title column sits between ☰ and the buttons, and holds the chips and the folder.
    expect(wrap.x).toBeGreaterThanOrEqual(toggle.x + toggle.width);
    expect(actions.x).toBeGreaterThanOrEqual(wrap.x + wrap.width - 1);
    for (const rect of [title, watching, cwd]) {
      expect(rect.x).toBeGreaterThanOrEqual(wrap.x - 1);
      expect(rect.x + rect.width).toBeLessThanOrEqual(wrap.x + wrap.width + 1);
    }
    expect(watching.y).toBeGreaterThan(title.y);
    expect(cwd.y).toBeGreaterThan(watching.y);
    const display = await page.locator("#chat-title-wrap, #chat-title-slot").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).display));
    expect(display).not.toContain("contents");
  });
});
