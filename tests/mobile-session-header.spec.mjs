import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { clickHeaderAction, openChatActionsMenu, waitForHeaderFit } from "./header-actions-helpers.mjs";
import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * The session header on a phone comes in two rows: ☰, the title and the
 * action buttons on the first, and the meta line on a second row that spans
 * the header: the origin, the chips (watching, watched, scheduled) and the
 * folder, with their short labels ("↗ title", "👁 2", "⏰ 04:15", the folder's
 * last name), in ONE row that never wraps and scrolls sideways. A tap on the
 * folder shows its whole path. On a desktop the header keeps its one row and
 * the long labels.
 *
 * The conversation on screen is a real one: a lead session starts it with
 * create_session (the origin, "via agent · “…”", and the folder), it watches
 * two sessions, the lead watches it, and it has a schedule. No worker runs:
 * a "turn" is a message the spec took off the queue.
 *
 * The last tests add a pin and an open question (its banner shows relay-wide)
 * and check ︙: the question banner takes a row of its own on a phone, the
 * open menu stays inside the screen (390px, desktop at 150 %), a narrow
 * header puts actions into ︙ and they work from there, and a phone on its
 * side (no meta line) reaches the chips' lists and the origin through ︙,
 * whose menu scrolls to its last entry. At 390px every meta chip, the banner
 * and the sidebar's ⓘ, fold, archive and delete are 28px targets that stay
 * inside their row and off their neighbours.
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

  async function runningTurn(text) {
    const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    const { conversationId, ownerSessionId, messageId } = queued.payload;
    const synced = await api("/api/session-sync", {
      method: "POST",
      body: { sdk_session_id: conversationId, conversation_id: conversationId },
    });
    expect(synced.status, JSON.stringify(synced.payload)).toBe(200);
    await take(conversationId, ownerSessionId ? { "x-relay-session-id": String(ownerSessionId) } : {});
    return { conversationId, messageId };
  }

  async function conversationWithRunningTurn(text) {
    return (await runningTurn(text)).conversationId;
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

    // Row 2: below row 1, starting at the header's left edge, ONE row in DOM
    // order. The row itself fits the header; its items may run past the edge,
    // where the row scrolls sideways (no visible scrollbar, no wrap).
    const meta = await layout(page, { row: "#chat-title-meta" });
    expect(meta.row.x + meta.row.width).toBeLessThanOrEqual(viewport.width);
    for (const [name, rect] of Object.entries({ origin, watching, watched, scheduled, cwd })) {
      expect(rect.y, name).toBeGreaterThanOrEqual(rowOneBottom - 1);
      expect(Math.abs(centreY(rect) - centreY(origin)), name).toBeLessThan(10);
    }
    expect(origin.x).toBeLessThan(toggle.x + toggle.width);
    expect(watching.x).toBeGreaterThan(origin.x + origin.width - 1);
    expect(watched.x).toBeGreaterThan(watching.x + watching.width - 1);
    expect(scheduled.x).toBeGreaterThan(watched.x + watched.width - 1);
    expect(cwd.x).toBeGreaterThan(scheduled.x + scheduled.width - 1);
    const rowStyle = await page.locator("#chat-title-meta").evaluate((element) => {
      const style = getComputedStyle(element);
      return { overflowX: style.overflowX, flexWrap: style.flexWrap, scrollbarWidth: style.scrollbarWidth };
    });
    expect(rowStyle).toEqual({ overflowX: "auto", flexWrap: "nowrap", scrollbarWidth: "none" });

    // The short labels show, the long ones do not.
    const shown = (selector) => page.locator(selector).evaluate((element) => element.innerText.trim());
    expect(await shown("#chat-title-origin")).toMatch(/^↗ Release lead/);
    expect(await shown("#chat-title-relay-events .relay-watch-chip")).toBe("👁 2");
    expect(await shown("#chat-title-relay-events .conv-watched-badge")).toBe("watched");
    expect(await shown("#chat-title-relay-schedules .relay-schedule-chip")).toMatch(/^⏰ \d{1,2}:\d{2}/);
    const cwdPath = await page.locator("#chat-title-cwd").getAttribute("title");
    expect(cwdPath).toBeTruthy();
    const folder = cwdPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    expect(await shown("#chat-title-cwd")).toBe(folder);
    // A tap shows the whole path; another folds it again.
    await page.locator("#chat-title-cwd").click();
    expect(await shown("#chat-title-cwd")).toBe(cwdPath);
    await page.locator("#chat-title-cwd").click();
    expect(await shown("#chat-title-cwd")).toBe(folder);

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

    // Two compact rows: far below the old stacked column (about 150px at
    // 390px) and the old wrapping two rows (up to 120px). With the meta line
    // as a 28px row of tap targets the header measures about 68px.
    expect(header.height).toBeLessThan(76);
    // Tap targets stay at least 28px.
    for (const box of await page.locator("#chat-header-actions .header-icon-btn:visible, #sidebar-toggle").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))) {
      expect(box).toBeGreaterThanOrEqual(28);
    }
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
    // The long labels on a desktop.
    const shown = (selector) => page.locator(selector).evaluate((element) => element.innerText.trim());
    expect(await shown("#chat-title-origin")).toMatch(/^via agent · “Release lead/);
    expect(await shown("#chat-title-relay-events .relay-watch-chip")).toBe("👁 watching 2 sessions");
    expect(await shown("#chat-title-cwd")).toBe(await page.locator("#chat-title-cwd").getAttribute("title"));
    const display = await page.locator("#chat-title-wrap, #chat-title-slot").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).display));
    expect(display).not.toContain("contents");
  });

  // ── ︙ with a pin and an open question ──
  // From here on the child has a pin and another conversation has an open
  // question, so the banner shows on every page.
  let questionOpen = false;
  async function addPinAndQuestion() {
    if (questionOpen) return;
    const { payload } = await api(`/api/conversation/${encodeURIComponent(child)}`);
    const message = (payload?.messages || []).find((entry) => entry?.id);
    expect(message, "a message of the child to pin").toBeTruthy();
    const pinned = await api(`/api/conversation/${encodeURIComponent(child)}/message/${encodeURIComponent(message.id)}/pin`, { method: "PATCH", body: { pinned: true } });
    expect(pinned.status, JSON.stringify(pinned.payload)).toBe(200);
    // A long title: the banner's "latest in …" tail must give way, never the actions.
    const turn = await runningTurn(`Beetle trap tally ${suffix} along the east hedge, second count of the season`);
    const asked = await api("/api/relay-question", {
      method: "POST",
      body: { queueId: turn.messageId, prompt: "Which plot is counted first?", choices: ["North plot", "South plot"], timeout_ms: 600_000 },
    });
    expect(asked.status, JSON.stringify(asked.payload)).toBe(200);
    questionOpen = true;
  }

  // The open ︙ menu's box, once it has been placed.
  async function openMenuBox(page) {
    await openChatActionsMenu(page);
    const { menu, main } = await layout(page, { menu: "#chat-actions-menu", main: "#main" });
    return { menu, main };
  }

  function expectInside(box, viewport, main = null) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
    if (main) {
      expect(box.x).toBeGreaterThanOrEqual(main.x - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 0.5);
    }
  }

  test("a narrow #main at 150 % (sidebar open): the title gives way, ︙ stays on the screen", async ({ page }) => {
    expect(questionOpen).toBe(false);
    await page.addInitScript(() => { window.localStorage.setItem("copilot_font_scale", "1.5"); });
    for (const width of [681, 700]) {
      const viewport = { width, height: 800 };
      await openChild(page, viewport);
      await waitForHeaderFit(page);
      const { header, menuButton, wrap } = await layout(page, { header: "#chat-header", menuButton: "#chat-actions-menu-btn", wrap: "#chat-title-wrap" });
      expect(header.x, "the sidebar is open").toBeGreaterThan(0);
      expect(menuButton.x + menuButton.width, `${width}px`).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(wrap.width, `${width}px`).toBeGreaterThan(0);
    }
  });

  test("360px with a pin and a question: the banner has its own row, the actions use ︙", async ({ page }) => {
    await addPinAndQuestion();
    // At 150 % the narrow header surely puts search into ︙.
    await page.addInitScript(() => { window.localStorage.setItem("copilot_font_scale", "1.5"); });
    await openChild(page, SMALL_PHONE);
    await expect(page.locator("#pending-question-banner")).toBeVisible();
    await expect(page.locator("#pinned-messages-btn, #chat-menu-pins")).not.toHaveCount(0);
    const { actions, banner, meta } = await layout(page, { actions: "#chat-header-actions", banner: "#pending-question-banner", meta: "#chat-title-meta" });
    // Below the first row and below the meta line, inside the screen.
    expect(banner.y).toBeGreaterThanOrEqual(actions.y + actions.height - 1);
    expect(banner.y).toBeGreaterThanOrEqual(meta.y + meta.height - 1);
    expect(banner.x + banner.width).toBeLessThanOrEqual(SMALL_PHONE.width);
    await waitForHeaderFit(page);
    await expect(page.locator("#message-search-btn")).toBeHidden();
    expect(await clickHeaderAction(page, "search")).toBe("menu");
    await expect(page.locator("#message-search-modal")).toBeVisible();
  });

  test("390px with a question: the ︙ menu stays on the screen", async ({ page }) => {
    await addPinAndQuestion();
    await openChild(page, PHONE);
    await expect(page.locator("#pending-question-banner")).toBeVisible();
    const { menu } = await openMenuBox(page);
    expectInside(menu, PHONE);
    // Its first entry is readable: it starts inside the menu.
    const first = await page.locator("#chat-actions-menu > :visible").first().boundingBox();
    expect(first.x).toBeGreaterThanOrEqual(0);
  });

  // The box a finger hits: from the element's centre outwards, as far as
  // the point still lands on the element (its ::before target included).
  const hitBoxes = (page, selectors) => page.evaluate((wanted) => Object.fromEntries(Object.entries(wanted).map(([name, selector]) => {
    const element = [...document.querySelectorAll(selector)].find((node) => node.getClientRects().length > 0);
    if (!element) return [name, null];
    const rect = element.getBoundingClientRect();
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const hits = (x, y) => {
      const target = document.elementFromPoint(x, y);
      return !!target && element.contains(target);
    };
    const reach = (dx, dy) => {
      let step = 0;
      while (step < 60 && hits(cx + dx * (step + 1), cy + dy * (step + 1))) step += 1;
      return step;
    };
    if (!hits(cx, cy)) return [name, { left: cx, right: cx, top: cy, bottom: cy, width: 0, height: 0 }];
    const left = cx - reach(-1, 0);
    const right = cx + reach(1, 0) + 1;
    const top = cy - reach(0, -1);
    const bottom = cy + reach(0, 1) + 1;
    return [name, { left, right, top, bottom, width: right - left, height: bottom - top }];
  })), selectors);

  test("390px: the meta chips, the question banner and the sidebar's row buttons are 28px targets", async ({ page }) => {
    await addPinAndQuestion();
    await openChild(page, PHONE);
    await expect(page.locator("#pending-question-banner")).toBeVisible();
    await layout(page, { meta: "#chat-title-meta", banner: "#pending-question-banner" });
    const header = await hitBoxes(page, {
      origin: "#chat-title-origin .conv-origin-agent",
      watching: "#chat-title-relay-events .relay-watch-chip",
      watched: "#chat-title-relay-events .conv-watched-badge",
      scheduled: "#chat-title-relay-schedules .relay-schedule-chip",
      cwd: "#chat-title-cwd",
      banner: "#pending-question-banner",
      toggle: "#sidebar-toggle",
    });
    for (const [name, box] of Object.entries(header)) {
      expect(box, name).not.toBeNull();
      expect(box.width, name).toBeGreaterThanOrEqual(28);
      expect(box.height, name).toBeGreaterThanOrEqual(28);
    }
    // The chips' targets stay below ☰ (they never take its taps).
    expect(header.origin.top).toBeGreaterThanOrEqual(header.toggle.bottom - 1);

    await page.locator("#sidebar-toggle").click();
    await expect(page.locator(`#conv-list .conv-item[data-conversation-id="${lead}"] .conv-group-fold`)).toBeVisible();
    // The lead heads the group (fold) and watches the child, so the child's
    // row has an ⓘ (watched); every row has archive and delete.
    const leadRow = `#conv-list .conv-item[data-conversation-id="${lead}"]`;
    const childRow = `#conv-list .conv-item[data-conversation-id="${child}"]`;
    // Once the sidebar has slid in.
    await layout(page, { lead: leadRow, child: childRow });
    const sidebar = await hitBoxes(page, {
      info: `${childRow} .conv-info-btn`,
      fold: `${leadRow} .conv-group-fold`,
      archive: `${childRow} .conv-archive`,
      remove: `${childRow} .conv-delete`,
      provider: `${childRow} .conv-provider-indicator`,
    });
    for (const name of ["info", "fold", "archive", "remove"]) {
      expect(sidebar[name], name).not.toBeNull();
      expect(sidebar[name].width, name).toBeGreaterThanOrEqual(28);
      expect(sidebar[name].height, name).toBeGreaterThanOrEqual(28);
    }
    const rects = await page.evaluate(([childSelector, leadSelector]) => Object.fromEntries([
      ["child", childSelector], ["lead", leadSelector],
    ].map(([name, selector]) => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return [name, { left: x, top: y, right: x + width, bottom: y + height }];
    })), [childRow, leadRow]);
    // Each target stays inside its row: a neighbouring row keeps its taps.
    for (const [name, rowRect] of [["info", rects.child], ["archive", rects.child], ["remove", rects.child], ["fold", rects.lead]]) {
      expect(sidebar[name].top, name).toBeGreaterThanOrEqual(rowRect.top - 1);
      expect(sidebar[name].bottom, name).toBeLessThanOrEqual(rowRect.bottom + 1);
    }
    // Archive and delete sit side by side; the ⓘ leaves the provider pill
    // its own taps; the fold ends where the title's text begins.
    expect(sidebar.archive.right).toBeLessThanOrEqual(sidebar.remove.left + 1);
    expect(sidebar.provider.width).toBeGreaterThan(20);
    expect(sidebar.info.right).toBeLessThanOrEqual(sidebar.provider.left + 1);
    const titleTextLeft = await page.locator(`${leadRow} .conv-title`).evaluate((title) => {
      const range = document.createRange();
      const text = [...title.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      range.selectNodeContents(text);
      return range.getClientRects()[0].left;
    });
    expect(sidebar.fold.right).toBeLessThanOrEqual(titleTextLeft + 1);
  });

  test("desktop at 150 % with a question: the ︙ menu stays out of the sidebar and on the screen", async ({ page }) => {
    await addPinAndQuestion();
    await page.addInitScript(() => { window.localStorage.setItem("copilot_font_scale", "1.5"); });
    await openChild(page, DESKTOP);
    await expect(page.locator("#pending-question-banner")).toBeVisible();
    const { menu, main } = await openMenuBox(page);
    expectInside(menu, DESKTOP, main);
    // Taller than the room below it: it scrolls, and its last entry can be reached.
    const scroll = await page.locator("#chat-actions-menu").evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      scrollable: element.scrollHeight > element.clientHeight,
    }));
    expect(scroll.overflowY).toBe("auto");
    if (scroll.scrollable) {
      await page.locator("#chat-menu-kill-session").scrollIntoViewIfNeeded();
      await expect(page.locator("#chat-menu-kill-session")).toBeInViewport();
    }
  });

  // ── The question banner on the header's one row ──
  // It sits between the title and the actions: ︙ keeps the row's right end
  // with the actions just left of it, the title keeps its 8rem, and the ︙
  // menu opens on the screen. Where not even its chip fits next to ☰, the
  // title's 8rem and ︙ (`ownRow`), it takes a row of its own below them
  // instead. Returns the banner's shown text.
  async function checkBannerBetweenTitleAndActions(page, viewport, { ownRow = false } = {}) {
    await expect(page.locator("#pending-question-banner")).toBeVisible();
    await waitForHeaderFit(page);
    const { header, menuButton, banner, title, wrap } = await layout(page, {
      header: "#chat-header",
      menuButton: "#chat-actions-menu-btn",
      banner: "#pending-question-banner",
      title: "#chat-title-primary",
      wrap: "#chat-title-wrap",
    });
    const { paddingRight, rootFont, firstAction } = await page.evaluate(() => {
      const visible = [...document.querySelectorAll("#chat-header-actions > .header-icon-btn")].find((button) => button.offsetWidth > 0);
      const rect = visible ? visible.getBoundingClientRect() : null;
      return {
        paddingRight: parseFloat(getComputedStyle(document.getElementById("chat-header")).paddingRight) || 0,
        rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
        firstAction: rect ? { x: rect.x, width: rect.width } : null,
      };
    });
    // ︙ ends the row: within 12px of the header's right edge (inside its padding).
    const rowEnd = header.x + header.width - paddingRight;
    expect(rowEnd - (menuButton.x + menuButton.width)).toBeLessThanOrEqual(12);
    expect(menuButton.x + menuButton.width).toBeLessThanOrEqual(rowEnd + 0.5);
    expect(menuButton.x + menuButton.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(await page.locator("#pending-question-banner").evaluate((element) => element.hasAttribute("data-own-row"))).toBe(ownRow);
    if (ownRow) {
      // Below the title column, inside the header's padding.
      expect(banner.y).toBeGreaterThanOrEqual(wrap.y + wrap.height - 0.5);
      expect(banner.y).toBeGreaterThanOrEqual(menuButton.y + menuButton.height - 0.5);
      expect(banner.x).toBeGreaterThanOrEqual(header.x - 0.5);
      expect(banner.x + banner.width).toBeLessThanOrEqual(rowEnd + 0.5);
      expect(banner.y + banner.height).toBeLessThanOrEqual(header.y + header.height + 0.5);
    } else {
      // The banner ends before the first inline action (or ︙ when all are in
      // it), on the same row, after the title.
      const firstRight = firstAction || menuButton;
      expect(banner.x + banner.width).toBeLessThanOrEqual(firstRight.x + 0.5);
      expect(banner.x).toBeGreaterThanOrEqual(wrap.x + wrap.width - 0.5);
      expect(Math.abs(centreY(banner) - centreY(menuButton))).toBeLessThan(10);
    }
    // The title shows and keeps its 8rem.
    expect(title.width).toBeGreaterThan(0);
    expect(wrap.width).toBeGreaterThanOrEqual(8 * rootFont - 1);
    // The ︙ menu opens on the screen.
    const { menu, main } = await openMenuBox(page);
    expectInside(menu, viewport, main);
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-actions-menu")).toBeHidden();
    // Its name is always the whole text.
    await expect(page.locator("#pending-question-banner")).toHaveAttribute("aria-label", /open question.* · latest in Beetle trap tally/);
    return page.locator("#pending-question-banner").evaluate((element) => element.innerText.trim());
  }

  test("desktop with a question: the banner sits between the title and the actions, ︙ at the right end", async ({ page }) => {
    await addPinAndQuestion();
    await openChild(page, DESKTOP);
    const shown = await checkBannerBetweenTitleAndActions(page, DESKTOP);
    // Room enough for the whole text (it may end in an ellipsis).
    expect(shown).toMatch(/^❓ \d+ open questions? · latest in /);
  });

  test("a narrow desktop at 150 % with a question: the same order, the banner shrinks to its chip", async ({ page }) => {
    await addPinAndQuestion();
    const NARROW = { width: 1024, height: 700 };
    await page.addInitScript(() => { window.localStorage.setItem("copilot_font_scale", "1.5"); });
    await openChild(page, NARROW);
    const shown = await checkBannerBetweenTitleAndActions(page, NARROW);
    // Not even "❓ N open questions" fits next to the title's 8rem: the chip.
    expect(shown).toMatch(/^❓ \d+$/);
  });

  // The sidebar open leaves #main a narrow column: ☰, the title's 8rem, the
  // chip and ︙ would overflow the window, so the banner takes its own row.
  for (const [viewport, scale] of [[{ width: 768, height: 800 }, "1.5"], [{ width: 700, height: 800 }, "1.25"]]) {
    test(`${viewport.width}px at ${Number(scale) * 100} % with the sidebar open and a question: the banner has its own row, ︙ stays on the screen`, async ({ page }) => {
      await addPinAndQuestion();
      await page.addInitScript((value) => { window.localStorage.setItem("copilot_font_scale", value); }, scale);
      await openChild(page, viewport);
      await expect(page.locator("#sidebar")).toBeInViewport();
      const shown = await checkBannerBetweenTitleAndActions(page, viewport, { ownRow: true });
      expect(shown).toMatch(/^❓ \d+ open questions? · latest in /);
    });
  }

  test("a phone on its side with a question: the chip between the title and the actions, a tap opens it", async ({ browser }) => {
    await addPinAndQuestion();
    const SIDEWAYS = { width: 900, height: 400 };
    const context = await browser.newContext({ viewport: SIDEWAYS, screen: SIDEWAYS, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, child);
      await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
      await page.waitForFunction(() => typeof window.openConversation === "function");
      await expect(page.locator("#chat-title")).toHaveText(/Reviewer/);
      expect(await page.evaluate(() => document.documentElement.hasAttribute("data-phone-landscape"))).toBe(true);
      const shown = await checkBannerBetweenTitleAndActions(page, SIDEWAYS);
      expect(shown).toMatch(/^❓ \d+$/);
      // A tap opens the latest question's conversation.
      await page.locator("#pending-question-banner").tap();
      await expect(page.locator("#chat-title")).toHaveText(/^Beetle trap tally/);
    } finally {
      await context.close();
    }
  });

  test("a phone on its side: ︙ reaches the chips' lists and the origin, and scrolls", async ({ browser }) => {
    await addPinAndQuestion();
    const LANDSCAPE = { width: 844, height: 390 };
    const context = await browser.newContext({ viewport: LANDSCAPE, screen: LANDSCAPE, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      // Not openChild: the chips are in the DOM but not drawn here.
      await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, child);
      await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
      await page.waitForFunction(() => typeof window.openConversation === "function");
      await expect(page.locator("#chat-title")).toHaveText(/Reviewer/);
      await expect(page.locator("#chat-title-relay-schedules .relay-schedule-chip")).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.hasAttribute("data-phone-landscape"))).toBe(true);
      // The meta line is not drawn: its chips have no box.
      await expect(page.locator("#chat-title-meta")).toBeHidden();

      // The menu with the question open: inside the screen and #main, and it scrolls to Kill session.
      const { menu, main } = await openMenuBox(page);
      expectInside(menu, LANDSCAPE, main);
      await expect(page.locator("#chat-menu-watching")).toHaveText("👁 Watching 2 sessions…");
      await expect(page.locator("#chat-menu-schedules")).toHaveText("⏰ Schedules…");
      await expect(page.locator("#chat-menu-origin")).toHaveText(/^↗ Started by an agent in “Release lead/);
      const scrolls = await page.locator("#chat-actions-menu").evaluate((element) => element.scrollHeight > element.clientHeight);
      expect(scrolls).toBe(true);
      await page.locator("#chat-menu-kill-session").scrollIntoViewIfNeeded();
      await expect(page.locator("#chat-menu-kill-session")).toBeInViewport();
      await page.keyboard.press("Escape");

      // Watching… opens the list with its Unsubscribe buttons, on the screen.
      // A tap, not a click: the touch's compatibility click comes after the
      // entry ran on pointerup, lands on ︙'s shield and must not close the list.
      await openChatActionsMenu(page);
      await page.locator("#chat-menu-watching").tap();
      const watchPanel = page.locator("#relay-watch-panel");
      await expect(watchPanel).toBeVisible();
      await expect(watchPanel.locator(".relay-watch-unsubscribe").first()).toBeVisible();
      expectInside(await watchPanel.boundingBox(), LANDSCAPE);
      await page.keyboard.press("Escape");
      await expect(watchPanel).toBeHidden();

      // Schedules… opens the list with its Cancel button.
      await openChatActionsMenu(page);
      await page.locator("#chat-menu-schedules").tap();
      const schedulePanel = page.locator("#relay-schedule-panel");
      await expect(schedulePanel).toBeVisible();
      await expect(schedulePanel.locator(".relay-schedule-cancel").first()).toBeVisible();
      expectInside(await schedulePanel.boundingBox(), LANDSCAPE);
      await page.keyboard.press("Escape");
      await expect(schedulePanel).toBeHidden();

      // A dialog a tap opens stays open: that click lands on its backdrop.
      await openChatActionsMenu(page);
      await page.locator("#chat-menu-about").tap();
      await expect(page.locator("#summary-modal")).toBeVisible();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.locator("#summary-modal")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#summary-modal")).toBeHidden();

      // The origin opens the conversation that started this one.
      await openChatActionsMenu(page);
      await page.locator("#chat-menu-origin").tap();
      await expect(page.locator("#chat-title")).toHaveText(/^Release lead/);
    } finally {
      await context.close();
    }
  });
});
