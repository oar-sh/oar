import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * The 28px floor for tap targets, at 100 % on a phone (390), a phone on its
 * side (844×390) and a desktop (1280): the sidebar head's buttons, every
 * field, select, checkbox and radio label, slider and button in Settings
 * (General, each provider tab, Relays, a Previews row, Sharing,
 * Notifications, Features;
 * buttons 28 wide too), DeepSeek's "Advanced", Relays' "Add", a Sharing
 * row's title and buttons, the ︙ menu's "Empty queue", the repo browser's
 * toolbar, Focus, crumbs and tree root, the group picker's rows and its
 * name field, the × and ↻ of search, git changes and the sub-agent viewer,
 * the header's chips and origin, Unsubscribe and Cancel in the watching
 * and schedules lists, the transcript's agent-exchange row, the Context
 * plan-only switch, a group head's waiting pill, and the live bubble's Stop
 * and 💭 📃 🛠️ follow buttons (28 wide too).
 * A target is the box a finger hits (from the centre out, as far as the
 * point still lands on it); a checkbox counts through its label.
 *
 * Also here: the "1 open" pill keeps its whole text inside its row (desktop
 * at 100 %, a phone at 150 %), a group head's meta line never shows a
 * half-cut message count, the provider tabs' key and number fields look
 * like the other fields, the light theme's danger buttons read at 4.5:1 or
 * more, and a dialog of the shared details modal keeps its title and a
 * 28×28 × at 390.
 *
 * No worker runs: a "turn" is a message the spec took off the queue.
 */

const LAYOUTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  landscape: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 } },
};
const FLOOR = 28;

test.describe.serial("tap targets keep the 28px floor", () => {
  test.describe.configure({ timeout: 180_000 });

  let relay = null;
  const suffix = Date.now();
  let lead = "";
  let child = "";
  let asking = "";

  async function api(route, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  }

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

  // Runs the tool call; a card it raises on the way is allowed.
  async function allowed(conversationId, action, args) {
    const call = api("/api/remote-relays/tool", { method: "POST", body: { conversationId, action, args } });
    let settled = null;
    call.then((result) => { settled = result; });
    const deadline = Date.now() + 20_000;
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

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
    expect((await api("/api/settings/pwa-app-name", { method: "POST", body: { appName: "canal-relay" } })).status).toBe(200);
    expect((await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).status).toBe(200);
    // A group: the lead created the child, so the lead heads it.
    const leadTurn = await runningTurn(`Canal survey lead ${suffix}`);
    lead = leadTurn.conversationId;
    const created = await allowed(lead, "create_session", {
      relay: "this",
      title: "Lock gate inspection",
      text: "check the lock gates along the canal",
      wait_seconds: 0,
    });
    child = String(created.session || "");
    expect(child).not.toBe("");
    await take(child);
    // A row with one open question: long enough to be cut in a 316px sidebar.
    const turn = await runningTurn(`Towpath erosion question round ${suffix}`);
    asking = turn.conversationId;
    const asked = await api("/api/relay-question", {
      method: "POST",
      body: { queueId: turn.messageId, prompt: "Which bank is surveyed first?", choices: ["East bank", "West bank"], timeout_ms: 600_000 },
    });
    expect(asked.status, JSON.stringify(asked.payload)).toBe(200);
    // The child watches the lead and has a schedule: the header's chips and
    // the two lists with Unsubscribe and Cancel.
    await allowed(child, "subscribe", { sessions: [lead] });
    await allowed(child, "schedule", { text: "the weekly towpath sweep", at: new Date(Date.now() + 6 * 3600_000).toISOString() });
    // A card in the lead: the head row's pill gets its "waiting" part.
    const leadAsked = await api("/api/relay-question", {
      method: "POST",
      body: { queueId: leadTurn.messageId, prompt: "Survey the weir as well?", choices: ["Yes", "No"], timeout_ms: 600_000 },
    });
    expect(leadAsked.status, JSON.stringify(leadAsked.payload)).toBe(200);
    // A shared conversation: Settings → Sharing has a row with its buttons.
    expect((await api(`/api/conversation/${asking}/share`, { method: "POST" })).status).toBe(200);
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  async function openApp(browser, layout, { scale = 1, theme = "dark", conversation = child } = {}) {
    const context = await browser.newContext(LAYOUTS[layout]);
    const page = await context.newPage();
    await page.addInitScript(([id, fontScale, themeName]) => {
      window.localStorage.setItem("copilot_last_conv", id);
      window.localStorage.setItem("copilot_font_scale", String(fontScale));
      window.localStorage.setItem("copilot_theme", themeName);
    }, [conversation, scale, theme]);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function" && typeof window.openSettingsModal === "function");
    await expect(page.locator("#chat-title")).not.toHaveText("");
    // The list has loaded (the group picker reads it).
    await expect(page.locator(`#conv-list .conv-item[data-conversation-id="${child}"]`)).toHaveCount(1);
    return { context, page };
  }

  // The box a finger hits: the element scrolled into view, then from its
  // centre outwards as far as the point still lands on it. A label's box
  // counts for the control it is for.
  const hitBox = (page, selector, { index = 0 } = {}) => page.evaluate(async ([wanted, nth]) => {
    // Drawn: not inside a closed <details> either.
    const element = [...document.querySelectorAll(wanted)].filter((node) => node.checkVisibility({ visibilityProperty: true }))[nth];
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const hits = (x, y) => {
      const target = document.elementFromPoint(x, y);
      return !!target && element.contains(target);
    };
    const reach = (dx, dy) => {
      let step = 0;
      while (step < 80 && hits(cx + dx * (step + 1), cy + dy * (step + 1))) step += 1;
      return step;
    };
    const name = element.id || element.getAttribute("aria-label") || element.textContent.trim().slice(0, 40);
    // Drawn again under the measurement (a list the relay's answer redraws).
    if (!element.isConnected) return { name, stale: true };
    if (!hits(cx, cy)) {
      const over = document.elementFromPoint(cx, cy);
      return { name: `${name} (under ${over ? `${over.tagName.toLowerCase()}#${over.id}.${over.className}` : "nothing"})`, width: 0, height: 0 };
    }
    const width = reach(-1, 0) + reach(1, 0) + 1;
    const height = reach(0, -1) + reach(0, 1) + 1;
    return { name, width, height, stale: !element.isConnected };
  }, [selector, index]);

  async function expectTargets(page, selector, { minWidth = 0, label = selector } = {}) {
    const count = await page.locator(selector).evaluateAll((nodes) => nodes.filter((node) => node.checkVisibility({ visibilityProperty: true })).length);
    expect(count, `${label}: none drawn`).toBeGreaterThan(0);
    const boxes = [];
    for (let index = 0; index < count; index += 1) {
      let box = await hitBox(page, selector, { index });
      for (let attempt = 0; box?.stale && attempt < 10; attempt += 1) {
        await sleep(300);
        box = await hitBox(page, selector, { index });
      }
      expect(box, `${label} #${index}`).not.toBeNull();
      expect(box.stale, `${label}: ${box.name} is drawn again and again`).toBe(false);
      expect(box.height, `${label}: ${box.name} is ${box.width}×${box.height}`).toBeGreaterThanOrEqual(FLOOR);
      if (minWidth) expect(box.width, `${label}: ${box.name} is ${box.width}×${box.height}`).toBeGreaterThanOrEqual(minWidth);
      boxes.push(box);
    }
    return boxes;
  }

  // Settings: every field, select, checkbox (through its label) and slider
  // of the panel on screen.
  async function expectSettingsPanel(page, panel) {
    const fields = `${panel} :is(select, input[type="text"], input[type="password"], input[type="number"], input[type="url"])`;
    if (await page.locator(fields).count()) await expectTargets(page, fields, { label: `${panel} fields` });
    const labels = await page.locator(`${panel} input[type="checkbox"]`).evaluateAll((boxes) => boxes
      .filter((box) => box.checkVisibility({ visibilityProperty: true }))
      .map((box) => {
        if (!box.id) return null;
        // The label around it, else the one beside it in its row.
        return [`label:has(> #${box.id})`, `.settings-row:has(> #${box.id}) > label[for="${box.id}"]`, `label[for="${box.id}"]`]
          .find((selector) => document.querySelector(selector)) || null;
      }));
    for (const label of labels) {
      expect(label, `${panel}: a checkbox without a label`).not.toBeNull();
      await expectTargets(page, `${panel} ${label}`, { label: `${panel} ${label}` });
    }
    const sliders = `${panel} input[type="range"]`;
    if (await page.locator(sliders).count()) await expectTargets(page, sliders, { label: `${panel} sliders` });
    // A radio counts through the label around it.
    const radios = `${panel} label:has(> input[type="radio"])`;
    if (await visibleCount(page, radios)) await expectTargets(page, radios, { label: `${panel} radios` });
    // Every button drawn: 28 wide as well as tall.
    const buttons = `${panel} button`;
    if (await visibleCount(page, buttons)) await expectTargets(page, buttons, { minWidth: FLOOR, label: `${panel} buttons` });
  }

  // A list drawn again once the relay's answer is in: wait until its first
  // element is the same node twice in a row.
  const settled = (page, selector) => page.waitForFunction((wanted) => {
    const node = document.querySelector(wanted);
    const same = !!node && node === window.__hitTargetsSettled;
    window.__hitTargetsSettled = node;
    return same;
  }, selector, { polling: 400 });

  const visibleCount = (page, selector) => page.locator(selector)
    .evaluateAll((nodes) => nodes.filter((node) => node.checkVisibility({ visibilityProperty: true })).length);

  async function openSidebar(page) {
    // Off-canvas on a phone: drawn, but left of the screen.
    // A tap during the first load can go unseen: tap again until it opens.
    await expect(async () => {
      const box = await page.locator("#new-conv-btn").boundingBox();
      if (!box || box.x + box.width <= 0) await page.locator("#sidebar-toggle").tap();
      await expect(page.locator("#new-conv-btn")).toBeInViewport({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    // Once the sidebar has slid in.
    await page.waitForFunction(() => {
      const box = document.getElementById("new-conv-btn").getBoundingClientRect();
      const previous = window.__hitTargetsLastX;
      window.__hitTargetsLastX = box.x;
      return previous === box.x && box.x >= 0;
    }, null, { polling: 100 });
  }

  for (const layout of Object.keys(LAYOUTS)) {
    test(`${layout} at 100 %: the sidebar head, Settings and the ︙ menu`, async ({ browser }) => {
      const { context, page } = await openApp(browser, layout);
      try {
        await openSidebar(page);
        await expectTargets(page, "#new-conv-btn, #status-btn, #inbox-btn", { label: "sidebar head" });
        if (layout === "phone") await page.evaluate(() => window.closeSidebar());

        await page.evaluate(() => window.openSettingsModal("general"));
        await expect(page.locator("#settings-panel-general")).toBeVisible();
        await expectSettingsPanel(page, "#settings-panel-general");
        await page.evaluate(() => window.openSettingsModal("appearance"));
        await expect(page.locator("#settings-panel-appearance")).toBeVisible();
        await expectSettingsPanel(page, "#settings-panel-appearance");
        for (const provider of ["copilot", "openai", "claude", "claude-api", "claude-cloud", "grok", "cursor", "deepseek"]) {
          await page.evaluate((tab) => window.openSettingsModal("providers", tab), provider);
          await expect(page.locator(`#settings-provider-panel-${provider}`)).toBeVisible();
          await expectSettingsPanel(page, `#settings-provider-panel-${provider}`);
          if (provider === "deepseek") await expectTargets(page, "#deepseek-advanced > summary", { label: "DeepSeek Advanced" });
        }
        await page.evaluate(() => window.openSettingsModal("relays"));
        await expect(page.locator("#settings-panel-relays")).toBeVisible();
        await expectTargets(page, "#remote-relays-use-token-btn", { label: "Use a different token" });
        await expectTargets(page, "#remote-relays-add-btn", { minWidth: FLOOR, label: "Relays Add" });
        await expectSettingsPanel(page, "#settings-panel-relays");

        // Previews: the throwaway relay publishes none, so the list the panel
        // reads (and any read after it) answers with one row.
        const preview = {
          token: "pv-heron-docs",
          label: "Heron docs dev server",
          targetHost: "127.0.0.1",
          targetPort: 4173,
          url: "http://preview.example.test/p/pv-heron-docs/",
          createdAt: Date.now() - 3600_000,
          online: true,
        };
        await page.route("**/api/previews", (route) => (route.request().method() === "GET"
          ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ previews: [preview] }) })
          : route.continue()));
        await page.evaluate(() => window.openSettingsModal("previews"));
        await expect(page.locator("#settings-panel-previews")).toBeVisible();
        await expect(page.locator("#settings-previews-list .preview-row")).toHaveCount(1);
        await settled(page, "#settings-previews-list .preview-open");
        await expectTargets(page, "#settings-previews-list .preview-open", { minWidth: FLOOR, label: "Previews Open" });
        await expectSettingsPanel(page, "#settings-panel-previews");

        // Sharing: the row's title and its buttons (Copy link, Renew link,
        // Stop sharing, Access log).
        await page.evaluate(() => window.openSettingsModal("shares"));
        await expect(page.locator("#settings-panel-shares")).toBeVisible();
        await expect(page.locator(`#settings-shares-list .share-row[data-conversation-id="${asking}"]`)).toHaveCount(1);
        await settled(page, "#settings-shares-list .share-row");
        expect(await visibleCount(page, ".share-row-actions button")).toBeGreaterThanOrEqual(4);
        await expectTargets(page, ".share-row-actions button", { minWidth: FLOOR, label: "Sharing row buttons" });
        await expectTargets(page, ".share-row-title", { label: "Sharing row title" });
        await expectSettingsPanel(page, "#settings-panel-shares");

        for (const tab of ["notifications", "features"]) {
          await page.evaluate((name) => window.openSettingsModal(name), tab);
          await expect(page.locator(`#settings-panel-${tab}`)).toBeVisible();
          if (tab === "features") await settled(page, "#features-flag-list input");
          await expectSettingsPanel(page, `#settings-panel-${tab}`);
        }
        await page.evaluate(() => window.closeSettingsModal());

        // ︙ → Empty queue.
        if (LAYOUTS[layout].hasTouch) await page.locator("#chat-actions-menu-btn").tap();
        else await page.locator("#chat-actions-menu-btn").click();
        await expect(page.locator("#chat-actions-menu")).toBeVisible();
        await expectTargets(page, "#chat-menu-empty-queue", { label: "Empty queue" });
      } finally {
        await context.close();
      }
    });

    test(`${layout} at 100 %: the repo browser, the group picker, search, git changes and the sub-agent viewer`, async ({ browser }) => {
      const { context, page } = await openApp(browser, layout);
      try {
        await page.evaluate(() => window.openRepoBrowser());
        await expect(page.locator(".repo-browser-toolbar")).toBeVisible();
        await expectTargets(page, ".repo-browser-toolbar .repo-browser-btn", { label: "repo browser toolbar" });
        await settled(page, "#repo-tree .repo-tree-summary");
        await settled(page, "#repo-folder-breadcrumb .repo-crumb");
        await expectTargets(page, ".repo-tree-focus-btn", { label: "repo tree Focus" });
        await expectTargets(page, "#repo-folder-breadcrumb .repo-crumb", { minWidth: FLOOR, label: "repo crumbs" });
        // The workspace root's row (the folders under it change while tests
        // run): the shallowest row drawn, however the workspace's tree nests.
        const rows = "#repo-tree .repo-tree-summary";
        let root = null;
        for (let attempt = 0; attempt < 10 && (!root || root.stale); attempt += 1) {
          if (attempt) await sleep(300);
          const rootIndex = await page.locator(rows).evaluateAll((nodes) => {
            const drawn = nodes.filter((node) => node.checkVisibility({ visibilityProperty: true }));
            const depth = (node) => {
              let steps = 0;
              for (let at = node; at && at.id !== "repo-tree"; at = at.parentElement) steps += 1;
              return steps;
            };
            let best = -1;
            drawn.forEach((node, index) => { if (best < 0 || depth(node) < depth(drawn[best])) best = index; });
            return best;
          });
          expect(rootIndex, "repo tree root: none drawn").toBeGreaterThanOrEqual(0);
          root = await hitBox(page, rows, { index: rootIndex });
        }
        expect(root, "repo tree root").not.toBeNull();
        expect(root.stale, `repo tree root: ${root.name} is drawn again and again`).toBe(false);
        expect(root.height, `repo tree root: ${root.name} is ${root.width}×${root.height}`).toBeGreaterThanOrEqual(FLOOR);
        await page.evaluate(() => window.closeRepoBrowser());

        await page.evaluate((id) => window.openConversationGroupPicker(id), child);
        await expect(page.locator("#conv-group-picker")).toBeVisible();
        await expectTargets(page, ".conv-group-choice", { label: "group picker rows" });
        await expectTargets(page, "#conv-group-create-input", { label: "group name field" });
        await page.evaluate(() => window.closeSummaryModal());

        await page.evaluate(() => window.openMessageSearchModal());
        await expect(page.locator("#message-search-modal")).toBeVisible();
        await expectTargets(page, "#message-search-close", { minWidth: FLOOR, label: "search ×" });
        await page.keyboard.press("Escape");

        await page.evaluate(() => window.openGitChangesModal());
        await expect(page.locator("#git-changes-modal")).toBeVisible();
        await expectTargets(page, "#git-changes-refresh, #git-changes-close", { minWidth: FLOOR, label: "git changes ↻ and ×" });
        await page.evaluate(() => document.getElementById("git-changes-close").click());

        // The viewer's header as it is drawn, without a sub-agent to load.
        await page.evaluate(() => {
          const modal = document.getElementById("subagent-viewer-modal");
          modal.classList.add("visible");
          modal.setAttribute("aria-hidden", "false");
        });
        await expectTargets(page, "#subagent-viewer-modal .subagent-viewer-close", { minWidth: FLOOR, label: "sub-agent viewer ×" });
      } finally {
        await context.close();
      }
    });

    test(`${layout} at 100 %: the header's chips, the watching and schedules lists, the waiting pill, plan only and the exchange row`, async ({ browser }) => {
      const { context, page } = await openApp(browser, layout);
      const touch = !!LAYOUTS[layout].hasTouch;
      const press = (locator) => (touch ? locator.tap() : locator.click());
      try {
        const watchChip = page.locator("#chat-title-relay-events .relay-watch-chip");
        const scheduleChip = page.locator("#chat-title-relay-schedules .relay-watch-chip");
        await expect(watchChip).toHaveCount(1);
        await expect(scheduleChip).toHaveCount(1);
        // A phone on its side draws no meta line: the lists open from ︙.
        const chipsDrawn = layout !== "landscape";
        if (chipsDrawn) {
          await expectTargets(page, "#chat-title-relay-events .relay-watch-chip, #chat-title-relay-schedules .relay-watch-chip", { minWidth: FLOOR, label: "header chips" });
          await expectTargets(page, "#chat-title-origin .conv-origin-agent", { label: "header origin" });
        }
        const openList = async (chip, entry, panel) => {
          if (chipsDrawn) await press(chip);
          else {
            await press(page.locator("#chat-actions-menu-btn"));
            await press(page.locator(entry));
          }
          await expect(page.locator(panel)).toBeVisible();
        };
        await openList(watchChip, "#chat-menu-watching", "#relay-watch-panel");
        await expectTargets(page, "#relay-watch-panel .relay-watch-unsubscribe", { minWidth: FLOOR, label: "Unsubscribe" });
        await page.keyboard.press("Escape");
        await expect(page.locator("#relay-watch-panel")).toBeHidden();
        await openList(scheduleChip, "#chat-menu-schedules", "#relay-schedule-panel");
        await expectTargets(page, "#relay-schedule-panel .relay-schedule-cancel", { minWidth: FLOOR, label: "schedule Cancel" });
        await page.keyboard.press("Escape");
        await expect(page.locator("#relay-schedule-panel")).toBeHidden();
        if (await page.locator("#chat-actions-menu").isVisible()) await page.keyboard.press("Escape");
        await expect(page.locator("#chat-actions-menu-backdrop")).toBeHidden();

        // The transcript's agent exchange (the lead's prompt) folds open from its summary.
        await expect(page.locator("#messages .agent-exchange-summary").first()).toBeVisible();
        await expectTargets(page, "#messages .agent-exchange-summary", { label: "agent exchange row" });

        // Context: the plan-only switch counts through its label.
        await page.evaluate(() => window.showContext());
        await expect(page.locator("#ctx-plan-only")).toBeAttached();
        await expectTargets(page, "label:has(> #ctx-plan-only)", { label: "plan only" });
        await page.evaluate(() => window.closeSummaryModal());

        // The group head's pill opens the session that waits.
        if (layout === "phone") await openSidebar(page);
        const pill = `#conv-list .conv-item.conv-group-head[data-conversation-id="${lead}"] .conv-group-summary[data-open-waiting]`;
        await expect(page.locator(pill)).toHaveCount(1);
        await expectTargets(page, pill, { label: "waiting pill" });
      } finally {
        await context.close();
      }
    });

    test(`${layout} at 100 %: 📓's list (every button, a card's Details, ✕) and an ask's stub`, async ({ browser }) => {
      const queued = await api("/api/message", { method: "POST", body: { text: `Culvert inspection ${layout} ${suffix}`, relayMode: "agent", model: "gpt-5.4-mini" } });
      expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
      const { conversationId } = queued.payload;
      const asked = await api("/api/remote-relays/tool", {
        method: "POST",
        body: { conversationId, action: "ask", args: { question: "Clear the culvert grate first?", options: ["Clear it", "Leave it"], detail: "Leaves have piled up since the last sweep." } },
      });
      expect(asked.status, JSON.stringify(asked.payload)).toBe(200);
      const { context, page } = await openApp(browser, layout, { conversation: conversationId });
      const touch = !!LAYOUTS[layout].hasTouch;
      const press = (locator) => (touch ? locator.tap() : locator.click());
      try {
        await expect(page.locator(".msg-ask-stub")).toHaveCount(1);
        await expectTargets(page, "#messages .msg-ask-stub", { label: "📓 stub" });
        await expect(page.locator("#questions-btn")).toHaveAttribute("data-count", "1");
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (await page.locator("#questions-btn").isVisible()) await press(page.locator("#questions-btn"));
        else {
          await press(page.locator("#chat-actions-menu-btn"));
          await press(page.locator("#chat-menu-questions"));
        }
        await expect(page.locator("#questions-panel")).toBeVisible();
        await expectTargets(page, "#questions-panel button", { minWidth: FLOOR, label: "📓 buttons" });
        await expectTargets(page, "#questions-panel details.inbox-item-detail > summary", { label: "📓 Details" });
        await page.keyboard.press("Escape");
        await expect(page.locator("#questions-panel")).toBeHidden();
      } finally {
        await context.close();
      }
    });

    test(`${layout} at 100 %: the live bubble's Stop and its 💭 📃 🛠️ follow buttons`, async ({ browser }) => {
      // A turn of its own: the fixture's ones change state while the suite runs.
      const live = await runningTurn(`Sluice gauge reading ${layout} ${suffix}`);
      const { context, page } = await openApp(browser, layout, { conversation: live.conversationId });
      try {
        await expect(page.locator("#thinking-indicator")).toBeVisible();
        await expectTargets(page, '#thinking-indicator [data-action="stop-turn"]', { minWidth: FLOOR, label: "live Stop" });
        expect(await visibleCount(page, "#thinking-indicator .thinking-follow-btn")).toBe(3);
        await expectTargets(page, "#thinking-indicator .thinking-follow-btn", { minWidth: FLOOR, label: "follow buttons" });
      } finally {
        await context.close();
      }
    });
  }

  // The pill sits inside its row, whole and on one line, clear of the
  // archive icon; the title before it gives way instead.
  async function expectWholePill(page) {
    const row = `#conv-list .conv-item[data-conversation-id="${asking}"]`;
    await expect(page.locator(`${row} .conv-open-questions`)).toHaveText("1 open");
    const report = await page.locator(row).evaluate((node) => {
      const pill = node.querySelector(".conv-open-questions");
      const title = node.querySelector(".conv-title");
      const archive = node.querySelector(".conv-archive").getBoundingClientRect();
      const box = pill.getBoundingClientRect();
      // Cut by a clipping ancestor inside the row?
      let clipped = false;
      for (let parent = pill.parentElement; parent && parent !== node; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const p = parent.getBoundingClientRect();
        if (box.left < p.left - 0.5 || box.right > p.right + 0.5 || box.top < p.top - 0.5 || box.bottom > p.bottom + 0.5) clipped = true;
      }
      const rowBox = node.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(pill).lineHeight) || parseFloat(getComputedStyle(pill).fontSize) * 1.2;
      return {
        clipped,
        inside: box.left >= rowBox.left && box.right <= rowBox.right && box.top >= rowBox.top && box.bottom <= rowBox.bottom,
        clearOfArchive: box.right <= archive.left + 0.5,
        oneLine: box.height < lineHeight * 1.9,
        whiteSpace: getComputedStyle(pill).whiteSpace,
        titleCut: title.scrollWidth > title.clientWidth + 0.5 || title.scrollHeight > title.clientHeight + 0.5,
      };
    });
    expect(report.clipped, "the pill is cut").toBe(false);
    expect(report.inside, "the pill leaves its row").toBe(true);
    expect(report.clearOfArchive, "the pill runs under the archive icon").toBe(true);
    expect(report.oneLine, "the pill wraps").toBe(true);
    expect(report.whiteSpace).toBe("nowrap");
    return report;
  }

  // The head row's meta line: the message count is drawn whole or not at all.
  async function expectWholeCount(page) {
    const head = `#conv-list .conv-item.conv-group-head[data-conversation-id="${lead}"]`;
    await expect(page.locator(`${head} .conv-meta-count`)).toHaveCount(1);
    const shown = await page.locator(head).evaluate((node) => {
      const primary = node.querySelector(".conv-meta-primary").getBoundingClientRect();
      const count = node.querySelector(".conv-meta-count").getBoundingClientRect();
      const inside = count.left >= primary.left - 0.5 && count.right <= primary.right + 0.5 && count.top >= primary.top - 0.5 && count.bottom <= primary.bottom + 0.5;
      const outside = count.top >= primary.bottom - 0.5 || count.left >= primary.right - 0.5;
      return { inside, outside };
    });
    expect(shown.inside || shown.outside, "the message count is half drawn").toBe(true);
  }

  test("desktop at 100 %: the \"1 open\" pill is whole, the group head's count too", async ({ browser }) => {
    const { context, page } = await openApp(browser, "desktop");
    try {
      await expectWholePill(page);
      await expectWholeCount(page);
    } finally {
      await context.close();
    }
  });

  test("a phone at 150 %: the \"1 open\" pill stays on one line, inside its row", async ({ browser }) => {
    const { context, page } = await openApp(browser, "phone", { scale: 1.5 });
    try {
      await openSidebar(page);
      await expectWholePill(page);
      await expectWholeCount(page);
    } finally {
      await context.close();
    }
  });

  test("dark theme: the OpenAI, Grok and Cursor key and number fields look like the other fields", async ({ browser }) => {
    const { context, page } = await openApp(browser, "phone");
    try {
      const look = (selector) => page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color, border: style.borderTopColor };
      });
      await page.evaluate(() => window.openSettingsModal("providers", "deepseek"));
      const reference = await look("#deepseek-api-key-input");
      for (const [provider, selector] of [
        ["openai", "#openai-api-key-input"],
        ["grok", "#grok-allowance-monthly-input"],
        ["grok", "#grok-allowance-reset-day-input"],
        ["cursor", "#cursor-api-key-input"],
        ["cursor", "#cursor-allowance-cursor-models-input"],
        ["cursor", "#cursor-dashboard-token-input"],
      ]) {
        await page.evaluate((tab) => window.openSettingsModal("providers", tab), provider);
        expect(await look(selector), selector).toEqual(reference);
      }
    } finally {
      await context.close();
    }
  });

  const contrast = (page, selector) => page.locator(selector).evaluate((element) => {
    const parse = (value) => {
      const probe = document.createElement("canvas").getContext("2d");
      probe.fillStyle = value;
      probe.fillRect(0, 0, 1, 1);
      return [...probe.getImageData(0, 0, 1, 1).data];
    };
    // The first opaque background behind the element.
    let background = null;
    for (let node = element; node && !background; node = node.parentElement) {
      const [r, g, b, a] = parse(getComputedStyle(node).backgroundColor);
      if (a === 255) background = [r, g, b];
    }
    background ||= [255, 255, 255];
    const [r, g, b] = parse(getComputedStyle(element).color);
    const lum = (rgb) => {
      const [lr, lg, lb] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    const [hi, lo] = [lum([r, g, b]), lum(background)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  });

  test("light theme: the danger buttons read at 4.5:1 or more", async ({ browser }) => {
    const { context, page } = await openApp(browser, "desktop", { theme: "light" });
    try {
      await page.locator("#chat-actions-menu-btn").click();
      await page.locator("#chat-menu-empty-queue").click();
      const button = "#summary-modal .danger-btn";
      await expect(page.locator(button)).toBeVisible();
      expect(await contrast(page, button)).toBeGreaterThanOrEqual(4.5);
    } finally {
      await context.close();
    }
  });

  test("dark theme: Grok's console.x.ai link reads at 4.5:1 or more", async ({ browser }) => {
    const { context, page } = await openApp(browser, "desktop");
    try {
      await page.evaluate(() => window.openSettingsModal("providers", "grok"));
      const link = '#settings-provider-panel-grok a[href="https://console.x.ai"]';
      await page.locator(link).scrollIntoViewIfNeeded();
      expect(await contrast(page, link)).toBeGreaterThanOrEqual(4.5);
    } finally {
      await context.close();
    }
  });

  test("390px: the shared details dialog keeps its title and a 28×28 ×", async ({ browser }) => {
    const { context, page } = await openApp(browser, "phone");
    try {
      await page.evaluate((id) => window.openConversationGroupPicker(id), child);
      await expect(page.locator("#conv-group-picker")).toBeVisible();
      const title = await page.locator("#summary-modal-title").boundingBox();
      expect(title.width).toBeGreaterThan(0);
      await expect(page.locator("#summary-modal-title")).toHaveText(/group/);
      const close = await hitBox(page, "#summary-modal .summary-close");
      expect(close.width).toBeGreaterThanOrEqual(FLOOR);
      expect(close.height).toBeGreaterThanOrEqual(FLOOR);
    } finally {
      await context.close();
    }
  });
});
